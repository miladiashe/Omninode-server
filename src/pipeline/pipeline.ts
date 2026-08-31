// 원본 beforeRequest 파이프라인 (L7078–7732)의 서버 이식 — 12스텝 로직 동일 유지.
// 원본과의 의도적 차이:
//  - Risuai 접근 제거: 채팅/페르소나/토큰 예산은 플러그인이 요청 본문으로 전달
//  - STEP 0(로어북 임포트)/0.5(콜드 스타트): 요청 경로에서 제거 — 별도 엔드포인트로 (Phase 5/7)
//  - 오토드림 스케줄러 조율(_pipelineEpoch/타이머 일시정지): Phase 6 잡 시스템에서 재구현
//  - 200ms 지연 저장 → 즉시 repo.flush (postMessage 병목이 없고 트랜잭션이 ms 단위)
//  - 노드 편집 에이전트(LTM 변환)는 주입식 — Phase 4b 전까지 스텁
//  - UI(processingTracker/플로팅 패널) 제거
import { LOG_PREFIX, contentHash, estimateMessagesTokens, estimateTokens, _extractCompactTs, stripThoughtBlocks } from '../core/util.js';
import type { JobEnqueuer } from '../jobs/runner.js';
import type { OmniNode } from '../core/node-store.js';
import {
  rankNodes, reciprocalRankFusion, typeDiversityDecay, DEFAULT_DIVERSITY_DECAY,
} from '../core/scoring.js';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../llm/client.js';
import { getNodeEmbeddings, getChatEmbeddings, getCachedTextEmbeddings, applyChatRegexFilters } from '../llm/embeddings.js';
import { llmDeps } from '../llm/index.js';
import type { OmniConfig } from '../config-store.js';
import type { ChatStateRepo } from '../persistence/chat-state-repo.js';
import type { ChatSession } from './session.js';
import {
  type PipelineMessage, type NodeEditAgentDeps, type LorePart,
  getChatIndices, countTurns, getShortTermWindowValue, injectPlaceholder,
  extractKeywords, summarizeCutTurns, convertToLTMNodes, orderLoreByReranker,
} from './helpers.js';

export interface PipelineRequest {
  messages: PipelineMessage[];
  personaName?: string;
  charName?: string;
  maxContext?: number;
  maxResponse?: number;
  // 플러그인이 계산해 보내는 전체 채팅 메시지 수 (원본 currentMsgCount, 그리팅 +1 포함).
  // 미제공 시 removable 메시지 수로 추정.
  currentMsgCount?: number;
  // LTM 배치용 전체 채팅 (플러그인이 보냄; 미제공 시 messages의 removable로 대체)
  allChatMessages?: Array<{ role: string; content: string }>;
}

export interface PipelineStats {
  turn: number;
  injectedCount: number;
  nodeCount: number;
  budgetUsed: number;
  nodeBudget: number;
  keywords: string[];
  promoted: number;
  unarchived: number;
  isReroll: boolean;
  isRollback: boolean;
  droppedCount: number;
  trimmedCount: number;
  summaryInserted: boolean;
  ltmConverted: boolean;
  ltmQueued: boolean;
}

export interface PipelineResult {
  messages: PipelineMessage[];
  loreCtx: string;
  memCtx: string;
  stats: PipelineStats;
  // 주입 내역 (플러그인 플로팅 패널용 — 전문 포함. 별도 조회는 last-injection API)
  injection: {
    turn: number;
    keywords: string[];
    summary: string;
    nodes: Array<{ type: string; name: string; content: string }>;
  };
  // 챗 복사 자동 감지 결과 (이번 요청에서 그래프를 승계했을 때만 — 플러그인 알림용)
  inherited?: { from: string; matchedMessages: number; nodes: number };
  // 복사본으로 감지됐지만 분기점이 스냅샷 밖이라 승계를 포기 — 플러그인이 콜드 스타트 권유
  inheritSkipped?: { from: string; reason: string };
  skipped?: 'disabled' | 'llm-not-configured';
}

function skippedResult(
  session: ChatSession,
  messages: PipelineMessage[],
  skipped: NonNullable<PipelineResult['skipped']>,
): PipelineResult {
  const turn = session.store.currentTurn;
  return {
    messages,
    loreCtx: '',
    memCtx: '',
    skipped,
    injection: { turn, keywords: [], summary: '', nodes: [] },
    stats: {
      turn,
      injectedCount: 0,
      nodeCount: session.store.getNodeCount(),
      budgetUsed: 0,
      nodeBudget: 0,
      keywords: [],
      promoted: 0,
      unarchived: 0,
      isReroll: false,
      isRollback: false,
      droppedCount: 0,
      trimmedCount: 0,
      summaryInserted: false,
      ltmConverted: false,
      ltmQueued: false,
    },
  };
}

export async function runPipeline(
  session: ChatSession,
  req: PipelineRequest,
  config: OmniConfig,
  repo: ChatStateRepo,
  agentDeps: NodeEditAgentDeps,
  jobs?: JobEnqueuer, // Phase 6: 있으면 LTM 변환을 동기 실행 대신 잡으로 등록
): Promise<PipelineResult> {
  const messages = req.messages;

  // 명시적 OFF는 최우선 게이트다. 로그·노드·복사 탐색을 포함해 어떤 상태도 건드리지 않는다.
  if (session.enabled === false) return skippedResult(session, messages, 'disabled');

  // 명시 설정이 없는 빈 채팅은 복사 승계 여부만 RAM 세션당 한 번 확인한다. miss를
  // enabled=false로 저장하지 않아 이후 수동 옵트인/임포트가 명시 상태를 온전히 설정한다.
  const needsOptInCopyProbe = session.enabled === undefined && session.store.getNodeCount() === 0;
  if (needsOptInCopyProbe && session.copyOptInChecked) {
    return skippedResult(session, messages, 'disabled');
  }
  if (needsOptInCopyProbe) session.copyOptInChecked = true;

  // ── 챗 복사 자동 감지 (HANDOFF §G [필수], 사용자 결정 2026-08-04: 수동 진입점 대신 자동) ──
  // "빈 그래프 + 긴 히스토리"는 복사본의 시그니처 — 기존 채팅 로그(D2 messages 테이블)와
  // 프리픽스 해시를 대조해 일치하면 그래프를 자동 승계한다. 오판 방어: ①목적지에 그래프가
  // 있으면 미적용 ②소스는 그래프 보유 채팅만 ③공통 프리픽스 ≥ copyDetectMinPrefix
  let inherited: PipelineResult['inherited'];
  let inheritSkipped: PipelineResult['inheritSkipped'];
  const mayDetectCopy = needsOptInCopyProbe
    || (session.enabled === true && session.store.currentTurn === 0);
  if (config.copyDetectEnabled !== false && mayDetectCopy && !session.copyInheritSkipped
    && session.store.getNodeCount() === 0
    && Array.isArray(req.allChatMessages)) {
    const minPrefix = Math.max(4, Math.trunc(Number(config.copyDetectMinPrefix)) || 8);
    if (req.allChatMessages.length >= minPrefix) {
      const src = repo.findCopySource(session.chatKey, req.allChatMessages, minPrefix);
      if (src) {
        repo.deleteChat(session.chatKey); // 빈 껍데기 행 제거 (clone INSERT 충돌 방지)
        repo.cloneChat(src.chatKey, session.chatKey);
        const loaded = repo.load(session.chatKey);
        session.store = loaded.store;
        session.diffManager = loaded.diffManager;
        session.simulBot = loaded.simulBot;
        session.enabled = loaded.enabled;
        // 소스가 복사 시점 이후 더 진행된 경우(복사 후 메시지 삭제 포함): 그래프에
        // 이 분기에서 일어나지 않은 "유령 기억"이 섞여 있다 — diff 스냅샷으로 복사
        // 시점 턴까지 롤백해 제거 (리롤 롤백과 동일 메커니즘). 롤백 불가(분기점이
        // 스냅샷 한도 밖 = 그래프 대부분이 유령)면 승계 자체를 포기하고 빈 그래프로
        // 시작 — 플러그인이 콜드 스타트를 권유한다 (사용자 결정 2026-08-04)
        let abandoned = false;
        if (session.store.currentTurn > req.allChatMessages.length) {
          const rolled = session.diffManager.rollbackTo(req.allChatMessages.length, session.store, false);
          if (!rolled) {
            repo.deleteChat(session.chatKey);
            const empty = repo.load(session.chatKey);
            session.store = empty.store;
            session.diffManager = empty.diffManager;
            session.simulBot = empty.simulBot;
            session.enabled = empty.enabled;
            session.copyInheritSkipped = true; // 턴마다 재시도 방지 (비영속)
            abandoned = true;
            inheritSkipped = { from: src.chatKey, reason: 'branch-too-old' };
            console.log(`${LOG_PREFIX} Copy inherit abandoned: source ahead but no snapshot reaches msg ${req.allChatMessages.length} — cold start recommended`);
          } else {
            console.log(`${LOG_PREFIX} Copy inherit: source was ahead — rolled back to copy point (${req.allChatMessages.length} msgs)`);
          }
        }
        if (!abandoned) {
          // 워터마크가 incoming 길이를 넘으면 존재하지 않는 메시지를 가리켜 LTM 변환이
          // 영구 정지 — 길이로 클램프 (롤백이 부분적으로만 돌아간 경우의 폴백)
          if (session.store._ltmConvertedUpTo > req.allChatMessages.length) {
            session.store._ltmConvertedUpTo = req.allChatMessages.length;
            session.store._ltmWatermarkHash = ''; // 다음 배치에서 재확립
          }
          inherited = { from: src.chatKey, matchedMessages: src.lcp, nodes: session.store.getNodeCount() };
          console.log(`${LOG_PREFIX} Copy detected: inherited ${inherited.nodes} nodes from ${src.chatKey} (prefix ${src.lcp}/${req.allChatMessages.length} msgs)`);
        }
        // 승계가 감지된 채팅은 분기점 롤백 가능 여부와 무관하게 소스의 옵트인을
        // 이어받는다. 즉시 flush해 뒤 단계 실패 시에도 명시값이 남게 한다.
        session.enabled = true;
        repo.flush(session.chatKey, session.store, session.diffManager, session.simulBot, session.enabled);
      }
    }
  }

  // 신규 빈 채팅에서 복사 승계가 없었다면 파생 기본값은 OFF다. 이 경로는 저장하지 않는다.
  if (!session.isEnabled()) return skippedResult(session, messages, 'disabled');

  // 활성 채팅만 LLM 설정 게이트까지 도달한다.
  if (!config.customLlm?.apiUrl || !config.customLlm?.model) {
    return skippedResult(session, messages, 'llm-not-configured');
  }

  const nodeStore = session.store;
  const diffManager = session.diffManager;

  // Sync type diversity decay from config (원본 L7116)
  Object.keys(typeDiversityDecay).forEach(k => delete typeDiversityDecay[k]);
  Object.assign(typeDiversityDecay, DEFAULT_DIVERSITY_DECAY);
  for (const nodeType of Object.keys(DEFAULT_DIVERSITY_DECAY)) {
    const configured = config.typeDiversityDecay?.[nodeType];
    if (configured !== undefined) typeDiversityDecay[nodeType] = configured;
  }

  const _personaName = req.personaName || '';
  session.lastPersonaName = _personaName; // 백그라운드 잡(월드심/LTM)이 재사용
  const _characterName = req.charName || '';
  session.lastCharName = _characterName; // 백그라운드 LTM 잡이 재사용

  const removableChatMsgs = messages.filter(
    m => (m.role === 'user' || m.role === 'assistant') && m.removable === true,
  );
  const currentMsgCount = req.currentMsgCount ?? removableChatMsgs.length;

  // ── Rollback & Reroll detection (원본 L7146–7168) ──
  // 의도적 차이: 메시지 수 대조에 마지막 메시지 내용 해시 대조를 추가.
  // 수가 같아도 내용이 다르면 리롤이 아님 — 별개 채팅이 같은 chatKey를 차지한
  // 상황(챗 복사 사고, HANDOFF §1.5)에서 롤백→재형성으로 그래프를 파괴하는 것을 방지.
  const lastMsgContent = removableChatMsgs.length > 0
    ? removableChatMsgs[removableChatMsgs.length - 1].content || ''
    : '';
  const lastMsgHash = contentHash(lastMsgContent);
  const countMatchesReroll = currentMsgCount === session.lastKnownMsgCount && session.lastKnownMsgCount > 0;
  const hashMismatch = session.lastKnownLastMsgHash !== '' && lastMsgHash !== session.lastKnownLastMsgHash;
  const isReroll = countMatchesReroll && !hashMismatch;
  const isRollback = currentMsgCount < session.lastKnownMsgCount;

  if (countMatchesReroll && hashMismatch) {
    console.warn(`${LOG_PREFIX} Same msg count but last message differs — not a reroll (possible distinct chat on same chatKey). Skipping rollback.`);
  }

  if (diffManager && (isRollback || isReroll)) {
    if (isReroll) {
      console.log(`${LOG_PREFIX} Reroll/Swipe detected at turn ${currentMsgCount}`);
    } else {
      console.log(`${LOG_PREFIX} Rollback/Deletion detected: ${session.lastKnownMsgCount} → ${currentMsgCount}`);
    }
    const estimatedTurn = Math.max(0, currentMsgCount);
    if (!diffManager.rollbackTo(estimatedTurn, nodeStore, isReroll)) {
      console.log(`${LOG_PREFIX} Rollback failed, continuing with current state`);
    }
    // Clear stale MemRL state — rejected response should not feed back
    session.prevInjectedNodeIds = [];
  }
  session.lastKnownMsgCount = currentMsgCount;
  session.lastKnownLastMsgHash = lastMsgHash;

  // ═══════════ STEP 1-2: Identify chat messages & determine trim ranges ═══════════
  const chatIndices = getChatIndices(messages);
  const chatMsgs = chatIndices.map(i => messages[i]);

  const shortTermKept = getShortTermWindowValue(config);
  // 원작 버그 7호: processedWindow 설정은 선언만 있고 파이프라인이 이 로컬 변수로 가려 영영 안 읽혔음 (beta21~281 전부).
  // 설정 제거(2026-08-28) — kept 창 위의 요약 완충 9개는 원작 그대로 상수. LTM 배치 8개(아래)와는 별개 시스템.
  const shortTermGiven = shortTermKept + 9;
  const processedWindow = shortTermKept;

  let keptChatIndices = chatIndices;
  let trimmedIndices: number[] = []; // indices removed from given→kept trim (for summarization)
  let droppedIndices: number[] = []; // indices beyond given-turn window (dropped entirely)

  if (countTurns(chatMsgs) > shortTermGiven) {
    const splitIdx = chatIndices.length - shortTermGiven;
    droppedIndices = chatIndices.slice(0, splitIdx);
    keptChatIndices = chatIndices.slice(splitIdx);
  }

  const keptChatMsgs = keptChatIndices.map(i => messages[i]);

  let cutMsgs: PipelineMessage[] = [];
  let keptMsgs = keptChatMsgs;
  if (countTurns(keptChatMsgs) > processedWindow) {
    const splitIdx = keptChatIndices.length - processedWindow;
    trimmedIndices = keptChatIndices.slice(0, splitIdx);
    cutMsgs = trimmedIndices.map(i => messages[i]);
    keptMsgs = keptChatIndices.slice(splitIdx).map(i => messages[i]);
  }

  // ═══════════ STEP 3: Calculate token budget ═══════════
  const mainMaxContext = req.maxContext || DEFAULT_CONTEXT_WINDOW;
  const mainMaxResponse = req.maxResponse || DEFAULT_MAX_TOKENS;

  const nonChatTokens = estimateMessagesTokens(messages.filter(m => !m.removable));
  const chatTokens = estimateMessagesTokens(keptMsgs);
  const reserveForResponse = mainMaxResponse;
  const totalBudget = mainMaxContext - reserveForResponse;
  const remainingBudget = Math.max(500, totalBudget - nonChatTokens - chatTokens);
  const nodeBudget = remainingBudget;

  // ═══════════ STEP 4: Parallel tasks ═══════════
  nodeStore.currentTurn = currentMsgCount;
  const currentTurn = nodeStore.currentTurn;

  // 빈 그래프 가드 (서버판 추가 최적화 — 원본은 STEP 0 로어북 임포트가 강제라
  // 빈 그래프 상태가 거의 없었음): 노드가 0개이고 이번 턴 LTM 변환도 없다면
  // 키워드 추출·임베딩은 매칭/랭킹 대상이 없어 순수 낭비 → 스킵.
  const ltmSource = req.allChatMessages && req.allChatMessages.length > 0 ? req.allChatMessages : chatMsgs;
  const ltmWillConvert = (ltmSource.length - shortTermKept) - nodeStore._ltmConvertedUpTo >= 8;
  // 잡 모드에선 LTM 변환이 이 요청 안에서 노드를 만들지 않으므로 빈 그래프면 무조건 스킵
  const skipScoringPrep = nodeStore.isEmpty() && (jobs ? true : !ltmWillConvert);
  if (skipScoringPrep) {
    console.log(`${LOG_PREFIX} Empty graph, no LTM batch due — skipping keyword/embedding calls`);
  }

  const taskPromises: Record<string, Promise<unknown>> = {};

  // 4a: Summarize cut turns
  if (cutMsgs.length > 0) {
    taskPromises.summary = summarizeCutTurns(cutMsgs, config);
  }

  // 4b: Keywords (needed for scoring — 빈 그래프 가드 시 생략)
  const kwMsgCount = config.keywordRecentMessages || 3;
  if (!skipScoringPrep) {
    taskPromises.keywords = extractKeywords(keptMsgs.slice(-kwMsgCount), config, nodeStore.atlasMd, currentTurn);
  }

  const taskKeys = Object.keys(taskPromises);
  const settled = await Promise.allSettled(taskKeys.map(k => taskPromises[k]));
  const resolved: Record<string, unknown> = {};
  for (let i = 0; i < taskKeys.length; i++) {
    const s = settled[i];
    resolved[taskKeys[i]] = s.status === 'fulfilled' ? s.value : null;
  }

  const summary = (resolved.summary as string) || '';
  const keywords = Array.isArray(resolved.keywords) ? resolved.keywords as string[] : [];

  // ═══════════ STEP 4.5: Sync dreaming — ensure memory freshness ═══════════
  let ltmConverted = false;
  let ltmQueued = false;
  {
    const _syncDreamPromises: Promise<void>[] = [];

    // MemRL feedback for previous turn → updates utility scores before ranking
    if (session.prevInjectedNodeIds.length > 0 && !isReroll && !isRollback) {
      if (config.memrlMode === 'off') {
        console.log(`${LOG_PREFIX} Sync dream: MemRL feedback skipped (mode=off)`);
      } else {
        const _memrlLastAssistant = keptMsgs.filter(m => m.role === 'assistant').slice(-1)[0];
        if (_memrlLastAssistant) {
          const _memrlContent = typeof _memrlLastAssistant.content === 'string'
            ? _memrlLastAssistant.content
            : JSON.stringify(_memrlLastAssistant.content);
          const _memrlPrevIds = new Set(session.prevInjectedNodeIds);
          _syncDreamPromises.push((async () => {
            try {
              if (config.memrlMode === 'llm') {
                await nodeStore.updateUtilityScoresLLM(_memrlPrevIds, _memrlContent, config, llmDeps);
              } else if (config.memrlMode === 'embedding' && config.embeddingEnabled) {
                const respEmbs = await getCachedTextEmbeddings([_memrlContent.substring(0, 2000)], config, nodeStore);
                if (respEmbs && respEmbs.length > 0 && respEmbs[0]) {
                  nodeStore.updateUtilityScores(_memrlPrevIds, respEmbs[0]);
                }
              }
              console.log(`${LOG_PREFIX} Sync dream: MemRL feedback done`);
            } catch (e) {
              console.log(`${LOG_PREFIX} Sync dream: MemRL error: ${(e as Error).message}`);
            }
          })());
        }
      }
    }

    // Community detection — deferred to autodream only (too LLM-heavy for sync path)

    // LTM conversion — index-based batch: convert 8 messages at a time.
    // Phase 6 의도적 차이: 잡 러너가 주입되면 요청 경로에서 변환하지 않고 잡으로 등록
    // (E2E에서 동기 변환이 플러그인/프록시 타임아웃을 유발한 실증 — HANDOFF §1.C).
    // 새 노드는 다음 턴부터 주입 대상이 된다.
    {
      const totalChat = ltmSource.length;
      const keptStart = totalChat - shortTermKept; // index where kept window starts

      // D2 워터마크 해시 검증 (beta27 L16992 방향, 단 되감기/유지 의미론):
      // 워터마크 직전 메시지의 내용이 기록된 해시와 다르면 편집/삭제로 인덱스가 밀린 것 —
      // ±5 창에서 재탐색해 보정, 미발견이면 인덱스를 신뢰하고 경고만 (전진 스킵 금지)
      if (nodeStore._ltmWatermarkHash && nodeStore._ltmConvertedUpTo > 0
        && nodeStore._ltmConvertedUpTo <= totalChat) {
        const wm = nodeStore._ltmConvertedUpTo;
        const expected = contentHash(String(ltmSource[wm - 1]?.content ?? ''));
        if (expected !== nodeStore._ltmWatermarkHash) {
          let found = -1;
          for (let i = Math.max(1, wm - 5); i <= Math.min(totalChat, wm + 5); i++) {
            if (contentHash(String(ltmSource[i - 1]?.content ?? '')) === nodeStore._ltmWatermarkHash) { found = i; break; }
          }
          if (found >= 0) {
            console.log(`${LOG_PREFIX} LTM watermark drift: ${wm} → ${found} (hash re-sync)`);
            nodeStore._ltmConvertedUpTo = found;
          } else {
            console.warn(`${LOG_PREFIX} LTM watermark hash mismatch at ${wm} — keeping index (no skip-forward)`);
          }
        }
      }

      const unconverted = keptStart - nodeStore._ltmConvertedUpTo;
      if (unconverted >= 8) {
        const batchStart = nodeStore._ltmConvertedUpTo;
        const batchEnd = batchStart + 8;
        const _ltmBatch = ltmSource.slice(batchStart, batchEnd);
        if (jobs) {
          console.log(`${LOG_PREFIX} LTM batch [${batchStart}..${batchEnd}) due — enqueued as background job`);
          jobs.enqueue(session.chatKey, 'ltm', {
            batchStart, batchEnd, messages: _ltmBatch, personaName: _personaName,
            charName: _characterName, simulBot: session.simulBot,
          }, { delayMs: 3000 });
          ltmQueued = true;
        } else {
          console.log(`${LOG_PREFIX} LTM conversion triggered: batch [${batchStart}..${batchEnd}), unconverted=${unconverted}, turn=${currentTurn}`);
          _syncDreamPromises.push((async () => {
            try {
              const _conv = await convertToLTMNodes(
                _ltmBatch, config, _personaName, _characterName, session.simulBot, nodeStore, agentDeps,
              );
              if (!_conv.ok) { console.log(`${LOG_PREFIX} Sync dream: LTM conversion failed — watermark kept for retry`); return; }
              for (const _id of _conv.affectedNodeIds) { // D2: 발췌 앵커
                const _n = nodeStore.getNode(_id);
                if (_n && _n.type === 'longTermMemory' && _n.sourceTurnStart === undefined) {
                  _n.sourceTurnStart = batchStart; _n.sourceTurnEnd = batchEnd - 1;
                }
              }
              nodeStore._ltmConvertedUpTo = batchEnd;
              nodeStore._ltmWatermarkHash = contentHash(String(_ltmBatch[_ltmBatch.length - 1]?.content ?? ''));
              ltmConverted = true;
              console.log(`${LOG_PREFIX} Sync dream: LTM conversion done (watermark → ${batchEnd})`);
            } catch (e) {
              console.log(`${LOG_PREFIX} Sync dream: LTM conversion error: ${(e as Error).message}`);
            }
          })());
        }
      }
    }

    if (_syncDreamPromises.length > 0) {
      console.log(`${LOG_PREFIX} Sync dreaming: ${_syncDreamPromises.length} tasks before context build`);
      await Promise.allSettled(_syncDreamPromises);
    }
  }

  // ═══════════ STEP 6: Keyword search ═══════════
  const keywordMatchedIds = new Set<string>();
  const localMatchedIds = new Set<string>();
  const globalOnlyMatchedIds = new Set<string>();
  for (const kw of keywords) {
    for (const { node: n, level } of nodeStore.findByKeyword(kw)) {
      keywordMatchedIds.add(n.id);
      if (level === 'local') localMatchedIds.add(n.id);
    }
  }

  // 로어북 키 직격 매칭 (원작 이탈, 사용자 승인 2026-08-02) — LLM 키워드 추출이
  // 이름을 놓치면 로어가 검색 채널을 아예 못 타는 문제 보완 (에릭 프로필 사건).
  // Risu 네이티브 로어북과 같은 단방향 substring(채팅 텍스트 ⊇ 키). 로어 키는
  // 사용자가 그 매칭을 전제로 설계한 것이라 lore/extraLore만 대상 (LTM 키워드는
  // LLM 생성이라 제외). 후보 명단+PPR 시드까지만 — 주입 보장은 아님.
  if (config.directKeyMatchEnabled !== false) {
    const _directText = keptMsgs.slice(-kwMsgCount)
      .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n').toLowerCase();
    let _directHits = 0;
    for (const n of nodeStore.getActiveNodes()) {
      if (n.type !== 'lore' && n.type !== 'extraLore') continue;
      if (keywordMatchedIds.has(n.id)) continue;
      for (const kw of n.keywords) {
        const k = kw.toLowerCase().trim();
        if (k.length >= 2 && _directText.includes(k)) {
          keywordMatchedIds.add(n.id);
          localMatchedIds.add(n.id);
          _directHits++;
          break;
        }
      }
    }
    if (_directHits > 0) console.log(`${LOG_PREFIX} Direct key match: +${_directHits} lore nodes`);
  }

  for (const id of keywordMatchedIds) {
    if (!localMatchedIds.has(id)) globalOnlyMatchedIds.add(id);
  }

  // 로컬 키워드로 직접 재등장한 활성 로어는 같은 턴의 점수 계산 전에 소생시킨다.
  // LTM/communitySummary는 키워드가 있어도 의도된 사건 기억의 망각 곡선을
  // 유지해야 하므로 제외한다. archived extraLore는 tick()의 별도 부활 경로만 사용한다.
  if (config.keywordRevivalEnabled !== false) {
    const _revivedNames: string[] = [];
    for (const id of localMatchedIds) {
      const n = nodeStore.getNode(id);
      if (!n || n.archived || (n.type !== 'lore' && n.type !== 'extraLore')) continue;
      const revivedScore = Math.max(n.activationScore, 30);
      if (revivedScore > n.activationScore) {
        n.activationScore = revivedScore;
        _revivedNames.push(n.name || n.id);
      }
    }
    if (_revivedNames.length > 0) {
      console.log(`${LOG_PREFIX} Keyword revival: ${_revivedNames.length} lore nodes (${_revivedNames.join(', ')})`);
    }
  }

  // ═══════════ STEP 7: Embeddings ═══════════
  const allNodes = nodeStore.getActiveNodes();
  let recentChatEmbeddings: Float32Array[] = [];

  if (config.embeddingEnabled && !skipScoringPrep) {
    try {
      await getNodeEmbeddings(allNodes, nodeStore, config);
      const recentMsgs = keptMsgs.slice(-5).map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      }));
      recentChatEmbeddings = await getChatEmbeddings(recentMsgs, config, nodeStore);
    } catch (e) {
      console.log(`${LOG_PREFIX} Embedding step error: ${(e as Error).message}`);
    }
  }

  // ═══════════ STEP 8: Score all nodes (with RRF when embeddings available) ═══════════
  const seedNodeIds = keywordMatchedIds;
  let rankedNodes;
  const _useRRF = config.embeddingEnabled && recentChatEmbeddings.length > 0 && keywordMatchedIds.size > 0;

  if (_useRRF) {
    const kwNodes = allNodes.filter(n => keywordMatchedIds.has(n.id));
    const keywordRanked = rankNodes(kwNodes, recentChatEmbeddings, seedNodeIds, nodeStore, nodeStore.currentTurn, config, keywordMatchedIds, globalOnlyMatchedIds);
    const vectorRanked = rankNodes(allNodes, recentChatEmbeddings, seedNodeIds, nodeStore, nodeStore.currentTurn, config, keywordMatchedIds, globalOnlyMatchedIds);
    const rrfK = config.rrfK || 60;
    rankedNodes = reciprocalRankFusion(keywordRanked, vectorRanked, rrfK);
    console.log(`${LOG_PREFIX} RRF fusion: ${kwNodes.length} keyword + ${allNodes.length} vector → ${rankedNodes.length} fused (k=${rrfK})`);
  } else {
    rankedNodes = rankNodes(allNodes, recentChatEmbeddings, seedNodeIds, nodeStore, nodeStore.currentTurn, config, keywordMatchedIds, globalOnlyMatchedIds);
  }

  // ═══════════ STEP 9: Inject by score into context ═══════════
  const loreContextParts: LorePart[] = [];
  const memoryContextParts: Array<{ content: string; creationTurn: number; timestamp?: string | null; nodeId?: string }> = [];
  let budgetUsed = 0;
  const injectedNodeIds = new Set<string>();

  // Build community→member LTM map
  const communityMemberMap = new Map<string, string[]>();
  const memberToCommunity = new Map<string, OmniNode>();
  for (const node of allNodes) {
    if (node.type === 'communitySummary' && !node.archived) {
      const memberIds = node.memberNodeIds || [];
      communityMemberMap.set(node.id, memberIds);
      for (const mid of memberIds) {
        const member = nodeStore.getNode(mid);
        if (member?.type === 'longTermMemory' && !member.archived) {
          if (!memberToCommunity.has(mid)) memberToCommunity.set(mid, node);
        }
      }
    }
  }

  // 원문 발췌: LTM에 원문 로그 슬라이스를 동반 주입한다.
  // 총량은 노드 예산의 share 비율로 캡 — 대사 비중을 늘리면 다른 주입이 줄어드는 트레이드오프를
  // 설정으로 노출 (dynamicExcerpt* 4종, 기본값은 beta27 원작자 값)
  const _excerptEnabled = config.dynamicExcerptEnabled !== false;
  const _excerptCap = Math.max(0, Math.floor(nodeBudget * (Number(config.dynamicExcerptBudgetShare) || 0.25)));
  const _excerptImportanceBase = Number(config.dynamicExcerptImportanceBase) || 4;
  const _excerptMaxChars = Number(config.dynamicExcerptMaxCharsPerMsg) || 400;
  let _excerptUsed = 0;
  let _excerptCount = 0; // 관측용 — 이번 턴 발췌 부착 수

  const buildLtmContext = (ltmNode: OmniNode) => {
    let text = ltmNode.content;
    // 원문 발췌 (sourceTurn 앵커가 있는 LTM — D2 이후 생성분)
    if (_excerptEnabled && ltmNode.sourceTurnStart !== undefined
      && (ltmNode.importance || 3) >= _excerptImportanceBase && _excerptUsed < _excerptCap) {
      const endIdx = (ltmNode.sourceTurnEnd ?? ltmNode.sourceTurnStart) + 1;
      const rows = repo.getMessageRange(session.chatKey, ltmNode.sourceTurnStart, endIdx);
      if (rows.length > 0) {
        const lines = rows.map(r => {
          // 사고 블록 + 사용자 정규식(이미지 명령 등) 제거 후 캡 적용 (2026-08-05 —
          // 발췌는 applyChatRegexFilters 경로 밖이라 별도 적용 필요, 실측: <img=…> 인용됨)
          const cleaned = applyChatRegexFilters(stripThoughtBlocks(r.content), config);
          if (!cleaned) return null;
          const c = cleaned.length > _excerptMaxChars ? cleaned.substring(0, _excerptMaxChars) + '…' : cleaned;
          return `> ${r.role === 'user' ? 'User' : 'Assistant'}: ${c.replace(/\n/g, '\n> ')}`;
        }).filter((l): l is string => l !== null);
        const block = `\n\n#### Source excerpt (messages ${ltmNode.sourceTurnStart + 1}–${endIdx})\n${lines.join('\n')}`;
        const t = estimateTokens(block);
        if (budgetUsed + t <= nodeBudget && _excerptUsed + t <= _excerptCap) {
          text += block;
          budgetUsed += t;
          _excerptUsed += t;
          _excerptCount++;
        }
      }
    }
    return { content: text, creationTurn: ltmNode.creationTurn, timestamp: ltmNode.timestamp, nodeId: ltmNode.id };
  };

  const communityCoveredIds = new Set<string>();
  const nodeScoreMap = new Map<string, number>();
  for (const r of rankedNodes) nodeScoreMap.set(r.node.id, r.score);

  const injectNode = (node: OmniNode): boolean => {
    // Community-covered nodes: allow high-scoring members to bypass summary
    if (communityCoveredIds.has(node.id)) {
      const commNode = memberToCommunity.get(node.id);
      if (commNode) {
        const commScore = nodeScoreMap.get(commNode.id) ?? 0;
        const nodeScore = nodeScoreMap.get(node.id) ?? 0;
        if (nodeScore < commScore * 1.5) return true; // covered by community summary
        // Score 1.5x+ higher → inject directly despite community coverage
      } else {
        return true;
      }
    }
    const baseTokens = estimateTokens(node.content);
    if (budgetUsed + baseTokens > nodeBudget) return false;
    if (node.type === 'longTermMemory') {
      budgetUsed += baseTokens;
      injectedNodeIds.add(node.id);
      memoryContextParts.push(buildLtmContext(node));
    } else if (node.type === 'lore' || node.type === 'extraLore') {
      budgetUsed += baseTokens;
      injectedNodeIds.add(node.id);
      loreContextParts.push({ nodeId: node.id, name: node.name || '', content: node.content });
    } else if (node.type === 'communitySummary') {
      budgetUsed += baseTokens;
      injectedNodeIds.add(node.id);
      memoryContextParts.push({ content: node.content, creationTurn: node.creationTurn, timestamp: node.timestamp });
      const memberIds = communityMemberMap.get(node.id) || [];
      for (const mid of memberIds) {
        if (!injectedNodeIds.has(mid)) communityCoveredIds.add(mid);
      }
    }
    return true;
  };

  // Always-active nodes first (no budget skip — always injected)
  for (const node of allNodes) {
    if (node.alwaysActive) {
      const tokens = estimateTokens(node.content);
      if (node.type === 'longTermMemory') {
        budgetUsed += tokens;
        injectedNodeIds.add(node.id);
        memoryContextParts.push(buildLtmContext(node));
      } else if (node.type === 'lore' || node.type === 'extraLore') {
        budgetUsed += tokens;
        injectedNodeIds.add(node.id);
        loreContextParts.push({ nodeId: node.id, name: node.name || '', content: node.content });
      } else if (node.type === 'communitySummary') {
        budgetUsed += tokens;
        injectedNodeIds.add(node.id);
        memoryContextParts.push({ content: node.content, creationTurn: node.creationTurn, timestamp: node.timestamp });
        const memberIds = communityMemberMap.get(node.id) || [];
        for (const mid of memberIds) {
          if (!injectedNodeIds.has(mid)) communityCoveredIds.add(mid);
        }
      }
    }
  }

  // Unified score-based injection with type-diversity diminishing returns
  const unifiedRanked = rankedNodes.filter(r => !injectedNodeIds.has(r.node.id));
  const _remaining = unifiedRanked.slice();
  const _typeCount: Record<string, number> = {};
  let _endedOnBudgetBreak = false;

  while (_remaining.length > 0 && budgetUsed < nodeBudget) {
    let bestIdx = -1, bestEff = -Infinity;
    for (let i = 0; i < _remaining.length; i++) {
      const { node, score } = _remaining[i];
      const d = typeDiversityDecay[node.type] || 0.85;
      const eff = score * Math.pow(d, _typeCount[node.type] || 0);
      if (eff > bestEff) { bestEff = eff; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const { node } = _remaining.splice(bestIdx, 1)[0];
    const prevSize = injectedNodeIds.size;
    const ok = injectNode(node);
    if (ok === false) {
      _endedOnBudgetBreak = true;
      break;
    }
    if (injectedNodeIds.size > prevSize) {
      _typeCount[node.type] = (_typeCount[node.type] || 0) + 1;
    }
  }
  const _typeCountAtLoopEnd = { ..._typeCount };
  const _rejectionReason = _endedOnBudgetBreak
    ? 'budget-break' as const
    : budgetUsed >= nodeBudget
      ? 'budget-full' as const
      : 'outranked' as const;
  console.log(`${LOG_PREFIX} Type diversity injection: ${JSON.stringify(_typeCount)}`);

  // 실제로 주입되지 않은 후보만 기록한다. 점수 계산에는 위 fill loop가
  // 끝난 순간의 타입별 카운트를 사용하므로 이 관측 로직은 선택 순서/예산 동작에 영향이 없다.
  const _rejectedCandidates = config.injectionDebugEnabled === true
    ? unifiedRanked
      .filter(({ node }) => !injectedNodeIds.has(node.id))
      .map(({ node, score, breakdown }) => {
        const decay = typeDiversityDecay[node.type] || 0.85;
        const decayMultiplier = Math.pow(decay, _typeCountAtLoopEnd[node.type] || 0);
        return {
          name: node.name || '',
          id: node.id,
          type: node.type,
          chars: (node.content || '').length,
          activation: node.activationScore,
          importance: node.importance,
          baseScore: score,
          breakdown,
          decayMultiplier,
          effScore: score * decayMultiplier,
          reason: _rejectionReason,
        };
      })
      .sort((a, b) => b.effScore - a.effScore)
      .slice(0, 15)
    : undefined;

  const orderedLoreContextParts = await orderLoreByReranker(loreContextParts, keywords, config, nodeStore);
  memoryContextParts.sort((a, b) => (_extractCompactTs(a.timestamp) || '').localeCompare(_extractCompactTs(b.timestamp) || '') || (a.creationTurn ?? 0) - (b.creationTurn ?? 0));

  const loreCtx = orderedLoreContextParts.map(p => p.content).join('\n\n');
  const memCtx = memoryContextParts.map(p => p.content).join('\n\n');

  // ═══════════ STEP 10: Update activation scores ═══════════
  nodeStore.updateActivationScores(injectedNodeIds);
  const { promoted, unarchived } = nodeStore.tick(keywords);

  // MemRL: store injected node IDs for next-turn utility feedback
  session.prevInjectedNodeIds = [...injectedNodeIds];

  // 회상 검증용 주입 내역 기록 (서버판 추가 — GET /api/chats/:chatKey/last-injection)
  // LTM은 실제 주입된 조립 텍스트(원문 발췌 포함)를 기록 — 원본 노드 내용만
  // 보여주면 발췌가 필에서 영원히 안 보이는 관측 사각지대가 생긴다 (2026-08-05 실측)
  if (_excerptCount > 0) console.log(`${LOG_PREFIX} Dynamic excerpt: ${_excerptCount} attached (${_excerptUsed} tokens)`);
  const _assembledById = new Map<string, string>();
  for (const part of memoryContextParts) {
    if (part.nodeId) _assembledById.set(part.nodeId, part.content);
  }
  const injectionRecord = {
    turn: nodeStore.currentTurn,
    at: Date.now(),
    keywords,
    nodes: [...injectedNodeIds].map(id => {
      const n = nodeStore.getNode(id);
      return n ? { id: n.id, type: n.type, name: n.name || '', content: _assembledById.get(id) || n.content || '' } : null;
    }).filter((n): n is NonNullable<typeof n> => !!n),
    summary,
    ...(config.injectionDebugEnabled === true ? { rejected: _rejectedCandidates! } : {}),
  };
  session.lastInjection = injectionRecord;

  // 원문 로그 동기화 (진화 트랙 D2 — canonical source, 해시 대조 증분이라 턴당 수 행)
  if (req.allChatMessages && req.allChatMessages.length > 0) {
    const msgSync = repo.syncMessages(session.chatKey, req.allChatMessages);
    if (msgSync.upserted > 0 || msgSync.deleted > 0) {
      console.log(`${LOG_PREFIX} Message log sync: +${msgSync.upserted} / -${msgSync.deleted}`);
    }
  }

  // Save diff & state — 원본의 200ms 지연 저장 대신 즉시 flush (트랜잭션, ms 단위)
  if (diffManager) await diffManager.takeDiff(nodeStore);
  const flushStats = repo.flush(session.chatKey, nodeStore, diffManager, session.simulBot, session.enabled);
  console.log(`${LOG_PREFIX} Flushed: ${flushStats.nodesUpserted} upserted, ${flushStats.scoresUpdated} scores, diff=${flushStats.diffsRewritten}`);

  // ═══════════ STEP 11: In-place modification — preserve original order ═══════════
  const removeSet = new Set([...droppedIndices, ...trimmedIndices]);
  const finalMessages: PipelineMessage[] = [];
  let summaryInserted = false;

  for (let i = 0; i < messages.length; i++) {
    if (removeSet.has(i)) {
      if (!summaryInserted && summary && trimmedIndices.includes(i)) {
        finalMessages.push({ role: 'assistant', content: `\n${summary}` });
        summaryInserted = true;
      }
      continue;
    }
    finalMessages.push(messages[i]);
  }

  if (!summaryInserted && summary) {
    const firstChat = finalMessages.findIndex(m => m.removable === true);
    if (firstChat > 0) {
      finalMessages.splice(firstChat, 0, { role: 'assistant', content: `${summary}` });
    } else {
      finalMessages.unshift({ role: 'assistant', content: `${summary}` });
    }
    summaryInserted = true;
  }

  // ═══════════ STEP 12: Placeholder injection on final output ═══════════
  // 원작 템플릿 호환 — 기능은 제외됐고 플레이스홀더만 지운다.
  injectPlaceholder(finalMessages, '[omninode.writer.md]', '');
  injectPlaceholder(finalMessages, '[omninode.chat.md]', '');
  injectPlaceholder(finalMessages, '[omninode.preferences.md]', '');

  const loreOk = injectPlaceholder(finalMessages, '[omninode.lore]', loreCtx);
  const memOk = injectPlaceholder(finalMessages, '[omninode.memory]', memCtx);

  if (!loreOk && loreCtx) {
    console.log(`${LOG_PREFIX} Placeholder [omninode.lore] not found — skipping lore injection`);
  }
  if (!memOk && memCtx) {
    console.log(`${LOG_PREFIX} Placeholder [omninode.memory] not found — skipping memory injection`);
  }

  console.log(
    `${LOG_PREFIX} Pipeline complete: turn ${nodeStore.currentTurn}, ` +
    `${injectedNodeIds.size}/${allNodes.length} nodes injected, ` +
    `${budgetUsed} tokens, ${keywords.length} kw` +
    (promoted.length ? `, ${promoted.length} promo` : ''),
  );

  return {
    messages: finalMessages,
    loreCtx,
    memCtx,
    ...(inherited ? { inherited } : {}),
    ...(inheritSkipped ? { inheritSkipped } : {}),
    injection: {
      turn: nodeStore.currentTurn,
      keywords,
      summary,
      nodes: injectionRecord.nodes.map(n => ({ type: n.type, name: n.name, content: n.content })),
    },
    stats: {
      turn: nodeStore.currentTurn,
      injectedCount: injectedNodeIds.size,
      nodeCount: allNodes.length,
      budgetUsed,
      nodeBudget,
      keywords,
      promoted: promoted.length,
      unarchived: unarchived.length,
      isReroll,
      isRollback,
      droppedCount: droppedIndices.length,
      trimmedCount: trimmedIndices.length,
      summaryInserted,
      ltmConverted,
      ltmQueued,
    },
  };
}
