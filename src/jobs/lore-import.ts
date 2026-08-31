// STEP 0/0.5 복원 — 로어북 임포트 + 콜드 스타트 (HANDOFF §1.B).
//   importLorebookToNodes (원본 L5674–5829)
//   coldStartFromHistory (원본 L8337–8430, MODULE 10)
//
// 의도적 차이:
//  - CBS 해석(stripCBS)·로어북 수집은 플러그인 몫 — 서버는 해석 완료 엔트리만 받는다
//    (PLAN §8 "서버에 CBS 지식 금지"). getActiveLorebookEntries/_buildVarResolver 제거
//  - processingTracker UI 갱신 제거 (서버는 콘솔 로그 + 잡 상태로 대체)
//  - 콜드 스타트 완료 시 ns._ltmConvertedUpTo = 처리 메시지 수 설정 — 원본은 워터마크를
//    올리지 않아 이후 턴의 LTM 변환이 콜드 스타트가 이미 처리한 메시지를 처음부터
//    재변환한다 (이중 기억 형성 — 원본 버그 4호 후보, 원작자 제보 예정)
//  - RPM 배치(L5734)는 유지하되 rpm=0이면 전량 병렬 (원본 동일)
import type { OmniNodeStore, OmniNode } from '../core/node-store.js';
import type { DiffManager } from '../core/diff-manager.js';
import { LOG_PREFIX, contentHash, robustParseJSON, repairTruncatedJson, normalizeRelType, clampStrength, defaultDirectionForType } from '../core/util.js';
import { callLLM, type LlmConfig } from '../llm/client.js';
import { extractNodeKeywords, splitAtTurnBoundary, getShortTermWindowValue, type NodeEditAgentDeps } from '../pipeline/helpers.js';
import type { OmniConfig } from '../config-store.js';

export interface LorebookEntryInput {
  content: string; // CBS 해석 완료 텍스트
  key?: string | string[];
  secondkey?: string;
  comment?: string;
  alwaysActive?: boolean;
}

export interface ImportResult {
  imported: number;
  keywordsGenerated: number;
  linked: number;
  nodeCount: number;
}

// 관계 분석 (임포트 마지막 단계 — 백필용으로도 단독 호출 가능)
export async function analyzeLoreRelationships(ns: OmniNodeStore, config: OmniConfig): Promise<number> {
  let linked = 0;
  const allNodes = ns.getAllNodes();
  if (allNodes.length >= 2) {
    try {
      const idxMap = new Map<number, string>();
      const lines: string[] = [];
      for (let i = 0; i < allNodes.length; i++) {
        idxMap.set(i, allNodes[i].id);
        // 의도적 차이 (2026-08-01): 원본은 content 전문 — 로어 전문 저장 후 입력이 136k tok까지
        // 부풀어 출력도 절단됨(실측). 관계 추론엔 이름+키워드+앞부분이면 충분 → 500자 캡
        const _c = allNodes[i].content || '';
        lines.push(`#${i} "${allNodes[i].name || ''}" [${allNodes[i].keywords.join(', ')}]: ${_c.length > 500 ? _c.substring(0, 500) + '…' : _c}`);
      }

      const relResult = await callLLM([
        {
          role: 'system',
          content: `You are a lorebook relationship analyzer. Given numbered lorebook entries, identify ALL meaningful relationships between them.

Return a JSON array:
[{"from": 0, "to": 3, "direction": "bi", "type": "related", "strength": 3}]

Rules:
- "from" and "to" are the # numbers of entries
- direction: "bi" (mutual) or "uni" (one-way from→to)
- type MUST be one of: "causes" (A directly causes B), "enables" (A makes B possible), "prevents" (A blocks B), "contradicts" (A conflicts with B), "develops" (A evolves from B), "related" (general association)
- strength: 1-5 (1=weak/tangential, 2=minor, 3=moderate, 4=strong, 5=very strong/critical)
- Only clearly meaningful connections (family, location, faction, rivalry, friendship, ownership, cause-effect, etc.)
- Do NOT create vague or speculative connections
- Be thorough — find all real connections`,
        },
        { role: 'user', content: lines.join('\n') },
      ], { _config: config as unknown as LlmConfig, _label: 'lore relationships' });

      let rels = robustParseJSON(relResult);
      if (!Array.isArray(rels)) {
        // 출력 절단 복구 — 완성된 관계 엔트리까지 구제
        rels = repairTruncatedJson(relResult);
        if (Array.isArray(rels)) {
          console.log(`${LOG_PREFIX} Lore relationships: parse failed but truncation repair salvaged ${rels.length} entries`);
        }
      }
      if (Array.isArray(rels)) {
        for (const rel of rels) {
          const fromIdx = typeof rel.from === 'number' ? rel.from : parseInt(rel.from);
          const toIdx = typeof rel.to === 'number' ? rel.to : parseInt(rel.to);
          const fromId = idxMap.get(fromIdx);
          const toId = idxMap.get(toIdx);
          if (!fromId || !toId) continue;
          const fromNode = ns.getNode(fromId);
          const toNode = ns.getNode(toId);
          if (!fromNode || !toNode) continue;
          if (fromNode.relationships.some(r => r.targetId === toId)) continue;

          const relType = normalizeRelType(rel.type);
          const dir = rel.direction || defaultDirectionForType(relType);
          const str = clampStrength(rel.strength ?? 3);
          fromNode.relationships.push({ targetId: toId, direction: dir, type: relType, strength: str, createdAtTurn: ns.currentTurn });
          if (dir !== 'uni') {
            toNode.relationships.push({ targetId: fromId, direction: 'bi', type: relType, strength: str, createdAtTurn: ns.currentTurn });
          }
          linked++;
        }
      }
      console.log(`${LOG_PREFIX} Connected ${linked} relationships across ${allNodes.length} nodes`);
    } catch (e) {
      console.log(`${LOG_PREFIX} Relationship linking error: ${(e as Error).message}`);
    }
  }

  return linked;
}

export async function importLorebookToNodes(
  ns: OmniNodeStore,
  config: OmniConfig,
  entries: LorebookEntryInput[],
): Promise<ImportResult> {
  const result: ImportResult = { imported: 0, keywordsGenerated: 0, linked: 0, nodeCount: 0 };
  if (entries.length === 0) {
    console.log(`${LOG_PREFIX} No active lorebook entries found`);
    return result;
  }

  console.log(`${LOG_PREFIX} Importing ${entries.length} lorebook entries`);

  const keylessNodes: OmniNode[] = [];
  for (const entry of entries) {
    const content = entry.content || '';
    if (!content.trim()) continue;

    const keys: string[] = [];
    const keyStr = typeof entry.key === 'string' ? entry.key : Array.isArray(entry.key) ? entry.key.join(',') : '';
    if (keyStr) keys.push(...keyStr.split(',').map(k => k.trim()).filter(Boolean));
    if (entry.secondkey) keys.push(...entry.secondkey.split(',').map(k => k.trim()).filter(Boolean));

    const node = ns.addLoreNode({
      name: entry.comment || '',
      content,
      keywords: keys.length > 0 ? keys : [],
      creationTurn: ns.currentTurn,
      relationships: [],
      alwaysActive: !!entry.alwaysActive,
    });

    if (keys.length === 0) keylessNodes.push(node);
    result.imported++;
  }

  // Generate activation keywords in parallel batches respecting RPM
  if (keylessNodes.length > 0) {
    console.log(`${LOG_PREFIX} Generating keywords for ${keylessNodes.length} keyless entries...`);
    const rpm = config.rpm || 0;
    const batchSize = rpm > 0 ? Math.min(keylessNodes.length, rpm) : keylessNodes.length;

    for (let i = 0; i < keylessNodes.length; i += batchSize) {
      const batch = keylessNodes.slice(i, i + batchSize);
      const promises = batch.map(async (node) => {
        try {
          const genKeys = await extractNodeKeywords(node.content, config);
          if (genKeys.length > 0) {
            node.keywords = genKeys;
          } else {
            node.keywords = ['lore'];
          }
          result.keywordsGenerated++;
        } catch (e) {
          console.log(`${LOG_PREFIX} Key generation error for node ${node.id}: ${(e as Error).message}`);
          node.keywords = ['lore'];
        }
      });
      await Promise.all(promises);
    }
  }

  // Connect relationships via sub-model (single call) — 분리 함수 재사용
  result.linked = await analyzeLoreRelationships(ns, config);

  result.nodeCount = ns.getNodeCount();
  console.log(`${LOG_PREFIX} Import complete: ${result.nodeCount} nodes`);
  return result;
}

// ── MODULE 10: 콜드 스타트 (원본 L8337) ─────────────────────────────
// 전체 채팅에서 숏텀 창 밖 메시지를 8메시지 청크로 노드 편집 에이전트에 반복 투입.
export async function coldStartFromHistory(
  chatMessages: Array<{ role: string; content: string }>,
  ns: OmniNodeStore,
  config: OmniConfig,
  personaName: string,
  characterName: string,
  simulBot: boolean,
  agentDeps: NodeEditAgentDeps,
  diffManager?: DiffManager,
): Promise<{ processed: number; chunks: number; nodeCount: number; failedChunks: number }> {
  console.log(`${LOG_PREFIX} Cold start: processing existing chat...`);

  const msgs = chatMessages.filter(m => m.role === 'user' || m.role === 'assistant');
  if (msgs.length < 4) {
    console.log(`${LOG_PREFIX} Cold start: not enough messages`);
    return { processed: 0, chunks: 0, nodeCount: ns.getNodeCount(), failedChunks: 0 };
  }

  // Chunk into groups FIRST (before any filtering)
  const chunkSize = 8;
  const chunks: Array<Array<{ role: string; content: string }>> = [];
  for (let i = 0; i < msgs.length; i += chunkSize) {
    chunks.push(msgs.slice(i, i + chunkSize));
  }
  console.log(`${LOG_PREFIX} Cold start: ${chunks.length} chunks (${chunkSize} msgs each)`);

  // Collect all created extraLore IDs across chunks for final merge
  const allCreatedExtraLoreIds: string[] = [];
  // 청크 실패 집계 (2026-08-31 GLM 제보): 전 청크가 조용히 실패해도 잡이 done으로 보여
  // 유저가 "완료됐는데 노드 0개"를 겪음 — 실패 수를 결과에 실어 러너가 판정하게 한다.
  let failedChunks = 0;

  // Process chunks sequentially (원본 concurrency = 1)
  for (let ci = 0; ci < chunks.length; ci++) {
    let chunk = chunks[ci];
    if (config.useOnlyAssistantRole) {
      chunk = chunk.filter(m => m.role === 'assistant');
    }
    if (chunk.length > 0) {
      const text = chunk.map(m =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
      ).join('\n\n');

      try {
        const r = await agentDeps.runNodeEditAgent(
          text, chunk, config, personaName, characterName, simulBot, ns,
        );
        if (r && (r as { ok?: boolean }).ok === false) failedChunks++;
        if (r && r.createdExtraLoreIds) allCreatedExtraLoreIds.push(...r.createdExtraLoreIds);
        // D2: 이 청크에서 생성된 LTM에 원문 구간 앵커 (청크 i는 [i*8, i*8+len) 구간)
        for (const id of r?.affectedNodeIds || []) {
          const n = ns.getNode(id);
          if (n && n.type === 'longTermMemory' && n.sourceTurnStart === undefined) {
            n.sourceTurnStart = ci * chunkSize;
            n.sourceTurnEnd = ci * chunkSize + chunks[ci].length - 1;
          }
        }
        const ctxIds = (r as { contextInjectedIds?: string[] }).contextInjectedIds;
        if (ctxIds && ctxIds.length > 0) {
          ns.updateActivationScores(ctxIds);
        }
      } catch (e) {
        failedChunks++;
        console.log(`${LOG_PREFIX} Cold start chunk ${ci + 1}/${chunks.length} error: ${(e as Error).message}`);
      }
    }

    ns.tick();

    // Update turn counter
    let processedMsgs = 0;
    for (let i = 0; i <= ci; i++) processedMsgs += chunks[i].length;
    ns.currentTurn = processedMsgs;
    ns._ltmConvertedUpTo = processedMsgs;
    ns._ltmWatermarkHash = contentHash(String(chunks[ci][chunks[ci].length - 1]?.content ?? ''));
    console.log(`${LOG_PREFIX} Cold start: ${ci + 1}/${chunks.length} chunks (${Math.round(((ci + 1) / chunks.length) * 100)}%)`);

    // Take a diff snapshot after each batch
    if (diffManager) await diffManager.takeDiff(ns);
  }

  // Post-process merge for all extraLore created during cold start
  if (allCreatedExtraLoreIds.length > 0 && agentDeps.postProcessExtraLoreMerge) {
    await agentDeps.postProcessExtraLoreMerge(allCreatedExtraLoreIds, config, ns);
  }

  // 의도적 차이 (원본 버그 4호 후보 수정): 처리한 메시지 범위를 LTM 워터마크에 반영 —
  // 원본은 워터마크를 0에 둬서 이후 턴의 LTM 변환이 같은 메시지를 재변환(이중 기억)
  ns._ltmConvertedUpTo = msgs.length;
  ns._ltmWatermarkHash = contentHash(String(msgs[msgs.length - 1]?.content ?? ''));

  console.log(`${LOG_PREFIX} Cold start done: ${ns.getNodeCount()} nodes, turn ${ns.currentTurn}`
    + (failedChunks > 0 ? ` (${failedChunks}/${chunks.length} chunks FAILED)` : ''));
  return { processed: msgs.length, chunks: chunks.length, nodeCount: ns.getNodeCount(), failedChunks };
}

// STEP 0.5의 분할 규칙 (원본 L7210–7220): 숏텀 창은 남기고 그 밖만 콜드 스타트 대상으로.
// 마지막 메시지가 어시스턴트면 창을 1 줄여 짝수 보정.
export function splitForColdStart<T extends { role: string }>(
  allChatMsgs: T[],
  config: OmniConfig,
): { cut: T[]; kept: T[] } {
  const lastMsg = allChatMsgs[allChatMsgs.length - 1];
  const isLastAssistant = !!lastMsg && lastMsg.role === 'assistant';
  const baseWindow = getShortTermWindowValue(config);
  const keepTurns = isLastAssistant ? Math.max(1, baseWindow - 1) : baseWindow;
  return splitAtTurnBoundary(allChatMsgs, keepTurns);
}
