// Phase 4 파이프라인 통합 테스트 — 모의 LLM/임베딩으로 12스텝 전체 경로 검증.
// (원본 파이프라인은 Risuai API에 엮여 있어 차분 테스트 불가 — 행동 명세 테스트로 검증)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDbFile, type Db } from '../src/db.js';
import { ChatStateRepo } from '../src/persistence/chat-state-repo.js';
import { SessionManager } from '../src/pipeline/session.js';
import { runPipeline } from '../src/pipeline/pipeline.js';
import type { PipelineMessage, NodeEditAgentDeps } from '../src/pipeline/helpers.js';
import { DEFAULT_CONFIG, type OmniConfig } from '../src/config-store.js';
import { DEFAULT_PROMPTS } from '../src/llm/prompts.js';
import { mulberry32 } from './fixture.js';

let db: Db;
let repo: ChatStateRepo;
let sessions: SessionManager;

// 결정적 모의 임베딩: 텍스트 해시 → 시드 벡터
function textToVec(text: string, dim = 8): number[] {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
  const rand = mulberry32(h >>> 0);
  return Array.from({ length: dim }, () => rand() * 2 - 1);
}

function setupMockFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init.body));
    if (u.includes('/embeddings')) {
      const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((t, index) => ({ index, embedding: textToVec(t) })),
      }), { status: 200 });
    }
    // chat completions — 시스템 프롬프트로 태스크 판별
    const sys = body.messages?.[0]?.content ?? '';
    let content = 'ok';
    if (sys.includes('Extract the 8-12')) content = '["마법", "용", "왕국"]';
    else if (sys.includes('Summarize the following conversation')) content = '요약: 마법사가 용과 계약했다.';
    else if (sys.includes('memory node usefulness') || sys.includes('CUSTOM MEMRL SYSTEM')) {
      const nodeId = String(body.messages?.[1]?.content ?? '').match(/\[([^\]]+)\]/)?.[1];
      content = JSON.stringify(nodeId ? [{ nodeId, useful: true, confidence: 0.9 }] : []);
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  }));
}

function testConfig(): OmniConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    customLlm: { ...DEFAULT_CONFIG.customLlm, apiUrl: 'https://mock.llm/v1/chat/completions', apiKey: 'k', model: 'mock-main' },
    auxiliaryLlm: { ...DEFAULT_CONFIG.auxiliaryLlm!, apiUrl: 'https://mock.llm/v1/chat/completions', apiKey: 'k', model: 'mock-aux' },
    embeddingEnabled: true,
    embeddingEndpoint: 'https://mock.emb/v1/embeddings',
    embeddingApiKey: 'k',
    maxRetries: 0,
    shortTermWindow: 9,
  };
}

// 시스템 프롬프트(placeholder 포함) + N개의 removable 채팅 메시지
function makeMessages(chatTurns: number): PipelineMessage[] {
  const msgs: PipelineMessage[] = [
    {
      role: 'system',
      content: '설정: 로어는 여기에 →[omninode.lore]← 기억은 여기에 →[omninode.memory]←' +
        ' MD →[omninode.writer.md][omninode.chat.md][omninode.preferences.md]←',
    },
  ];
  for (let i = 0; i < chatTurns; i++) {
    msgs.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}번째 턴: ${i % 3 === 0 ? '마법' : '모험'} 이야기를 나눈다.`,
      removable: true,
    });
  }
  return msgs;
}

function seedNodes(chatKey: string) {
  const session = sessions.get(chatKey);
  session.store.addLoreNode({ name: '마법 체계', content: '이 세계의 마법은 계약 기반이다.', keywords: ['마법'] });
  session.store.addExtraLoreNode({ name: '용의 산', content: '북쪽 산맥에 고대 용이 산다.', keywords: ['용'], importance: 4 });
  session.store.addLongTermMemoryNode({ name: '첫 만남', content: '### 첫 만남\n둘은 시장에서 처음 만났다.', keywords: ['시장'], timestamp: '2601011200' });
  repo.flush(chatKey, session.store, session.diffManager);
  return session;
}

beforeEach(() => {
  db = openDbFile(':memory:');
  repo = new ChatStateRepo(db.sqlite);
  sessions = new SessionManager(repo);
  setupMockFetch();
});
afterEach(() => vi.unstubAllGlobals());

const agentSpy = (): NodeEditAgentDeps & { calls: number } => {
  const deps = {
    calls: 0,
    async runNodeEditAgent() {
      deps.calls++;
      return { totalActions: 0, createdExtraLoreIds: [] };
    },
  };
  return deps;
};

function seedMemrlFeedback(chatKey: string) {
  const session = sessions.get(chatKey);
  const node = session.store.addLoreNode({
    name: 'MemRL 기준 기억',
    content: '응답 생성에 도움이 되는 장기 설정이다.',
    keywords: ['기억'],
  });
  node.embedding = new Float32Array(textToVec(node.content));
  session.prevInjectedNodeIds = [node.id];
  const messages = makeMessages(4);
  const responseText = `MemRL 응답 전문 ${'응답-'.repeat(800)}`;
  messages[messages.length - 1].content = responseText;
  return { session, node, messages, responseText };
}

function fetchRequestBodies(): Array<Record<string, any>> {
  const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return fetchMock.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)));
}

describe('챗별 OmniNode 옵트인 게이트', () => {
  it('explicit enabled=false면 로그·노드 캡처·복사 탐색 없이 disabled로 통과한다', async () => {
    const chatKey = 'gate-explicit-off';
    const session = sessions.get(chatKey);
    session.enabled = false;
    repo.flush(chatKey, session.store, session.diffManager, session.simulBot, session.enabled);
    const history = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content: `비활성 메시지 ${i}`,
    }));
    const messages: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...history.map(message => ({ ...message, removable: true } as PipelineMessage)),
    ];
    const findCopySource = vi.spyOn(repo, 'findCopySource');
    const syncMessages = vi.spyOn(repo, 'syncMessages');
    const agent = agentSpy();

    const result = await runPipeline(session, {
      messages, currentMsgCount: 25, allChatMessages: history,
    }, testConfig(), repo, agent);

    expect(result.skipped).toBe('disabled');
    expect(result.messages).toBe(messages);
    expect(findCopySource).not.toHaveBeenCalled();
    expect(syncMessages).not.toHaveBeenCalled();
    expect(agent.calls).toBe(0);
    expect(session.store.getNodeCount()).toBe(0);
    expect(session.store.currentTurn).toBe(0);
    expect(session.lastInjection).toBeNull();
    const logged = db.sqlite.prepare('SELECT COUNT(*) AS count FROM messages WHERE chat_key = ?')
      .get(chatKey) as { count: number };
    expect(logged.count).toBe(0);
  });

  it('노드가 있는 기존 채팅은 enabled 명시값이 없어도 grandfather 규칙으로 처리한다', async () => {
    const chatKey = 'gate-grandfather';
    const session = sessions.get(chatKey);
    session.store.addLoreNode({ name: '기존 기억', content: '마법 설정', keywords: ['마법'] });
    repo.flush(chatKey, session.store, session.diffManager);
    const stored = db.sqlite.prepare('SELECT meta_json FROM chats WHERE chat_key = ?')
      .get(chatKey) as { meta_json: string };
    expect(JSON.parse(stored.meta_json)).not.toHaveProperty('enabled');

    const result = await runPipeline(session, {
      messages: makeMessages(4), currentMsgCount: 5,
    }, testConfig(), repo, agentSpy());

    expect(result.skipped).toBeUndefined();
    expect(session.enabled).toBeUndefined();
    expect(session.store.currentTurn).toBe(5);
    const after = db.sqlite.prepare('SELECT meta_json FROM chats WHERE chat_key = ?')
      .get(chatKey) as { meta_json: string };
    expect(JSON.parse(after.meta_json)).not.toHaveProperty('enabled');
  });

  it('unset+빈 채팅은 복사 hit 시 enabled=true를 저장하고 miss 시 한 번만 탐색하며 unset을 유지한다', async () => {
    const sourceKey = 'gate-copy-source';
    const source = sessions.get(sourceKey);
    source.store.currentTurn = 8;
    source.store.addLoreNode({ name: '승계 로어', content: '승계된 설정', keywords: ['설정'] });
    repo.flush(sourceKey, source.store, source.diffManager);
    const sharedHistory = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content: `승계 히스토리 ${i}`,
    }));
    repo.syncMessages(sourceKey, sharedHistory);

    const inheritedSession = sessions.get('gate-copy-hit');
    const hit = await runPipeline(inheritedSession, {
      messages: [
        { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
        ...sharedHistory.map(message => ({ ...message, removable: true } as PipelineMessage)),
      ],
      currentMsgCount: 8,
      allChatMessages: sharedHistory,
    }, testConfig(), repo, agentSpy());
    expect(hit.inherited?.from).toBe(sourceKey);
    expect(inheritedSession.enabled).toBe(true);
    const hitMeta = db.sqlite.prepare('SELECT meta_json FROM chats WHERE chat_key = ?')
      .get('gate-copy-hit') as { meta_json: string };
    expect(JSON.parse(hitMeta.meta_json).enabled).toBe(true);

    const missKey = 'gate-copy-miss';
    const missSession = sessions.get(missKey);
    repo.flush(missKey, missSession.store, missSession.diffManager);
    const missHistory = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content: `일치하지 않는 히스토리 ${i}`,
    }));
    const missMessages: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...missHistory.map(message => ({ ...message, removable: true } as PipelineMessage)),
    ];
    const findCopySource = vi.spyOn(repo, 'findCopySource');
    const firstMiss = await runPipeline(missSession, {
      messages: missMessages, currentMsgCount: 8, allChatMessages: missHistory,
    }, testConfig(), repo, agentSpy());
    const secondMiss = await runPipeline(missSession, {
      messages: missMessages, currentMsgCount: 8, allChatMessages: missHistory,
    }, testConfig(), repo, agentSpy());

    expect(firstMiss.skipped).toBe('disabled');
    expect(secondMiss.skipped).toBe('disabled');
    expect(findCopySource).toHaveBeenCalledTimes(1);
    expect(missSession.enabled).toBeUndefined();
    const missMeta = db.sqlite.prepare('SELECT meta_json FROM chats WHERE chat_key = ?')
      .get(missKey) as { meta_json: string };
    expect(JSON.parse(missMeta.meta_json)).not.toHaveProperty('enabled');
  });
});

describe('MemRL 모드 스위치', () => {
  it('memrlMode=off면 유틸리티 업데이트를 모두 건너뛴다', async () => {
    const { session, messages } = seedMemrlFeedback('memrl-off');
    const embeddingUpdate = vi.spyOn(session.store, 'updateUtilityScores');
    const llmUpdate = vi.spyOn(session.store, 'updateUtilityScoresLLM');

    await runPipeline(session, { messages, currentMsgCount: 5 }, {
      ...testConfig(), memrlMode: 'off',
    }, repo, agentSpy());

    expect(embeddingUpdate).not.toHaveBeenCalled();
    expect(llmUpdate).not.toHaveBeenCalled();
  });

  it('memrlMode=embedding이면 임베딩 유틸리티 경로만 호출한다', async () => {
    const { session, node, messages } = seedMemrlFeedback('memrl-embedding');
    const embeddingUpdate = vi.spyOn(session.store, 'updateUtilityScores');
    const llmUpdate = vi.spyOn(session.store, 'updateUtilityScoresLLM');

    await runPipeline(session, { messages, currentMsgCount: 5 }, {
      ...testConfig(), memrlMode: 'embedding', embeddingEnabled: true,
    }, repo, agentSpy());

    expect(embeddingUpdate).toHaveBeenCalledTimes(1);
    expect([...(embeddingUpdate.mock.calls[0][0] as Set<string>)]).toEqual([node.id]);
    expect(embeddingUpdate.mock.calls[0][1]).toBeInstanceOf(Float32Array);
    expect(llmUpdate).not.toHaveBeenCalled();
  });

  it('memrlMode=embedding이어도 임베딩이 비활성화되면 유틸리티 업데이트를 건너뛴다', async () => {
    const { session, messages } = seedMemrlFeedback('memrl-embedding-disabled');
    const embeddingUpdate = vi.spyOn(session.store, 'updateUtilityScores');
    const llmUpdate = vi.spyOn(session.store, 'updateUtilityScoresLLM');

    await runPipeline(session, { messages, currentMsgCount: 5 }, {
      ...testConfig(), memrlMode: 'embedding', embeddingEnabled: false,
    }, repo, agentSpy());

    expect(embeddingUpdate).not.toHaveBeenCalled();
    expect(llmUpdate).not.toHaveBeenCalled();
  });

  it('memrlMode=llm이면 설정된 프롬프트와 응답 전문으로 LLM 경로를 호출한다', async () => {
    const { session, node, messages, responseText } = seedMemrlFeedback('memrl-llm-configured');
    const embeddingUpdate = vi.spyOn(session.store, 'updateUtilityScores');
    const llmUpdate = vi.spyOn(session.store, 'updateUtilityScoresLLM');
    const systemPrompt = 'CUSTOM MEMRL SYSTEM';
    const userTemplate = 'CUSTOM RESPONSE={{responseExcerpt}}\nCUSTOM NODES={{nodeDescriptions}}';
    const config = {
      ...testConfig(),
      memrlMode: 'llm' as const,
      embeddingEnabled: false,
      memrlSystemPrompt: systemPrompt,
      memrlUserPromptTemplate: userTemplate,
    };

    await runPipeline(session, { messages, currentMsgCount: 5 }, config, repo, agentSpy());

    expect(embeddingUpdate).not.toHaveBeenCalled();
    expect(llmUpdate).toHaveBeenCalledTimes(1);
    expect([...(llmUpdate.mock.calls[0][0] as Set<string>)]).toEqual([node.id]);
    expect(llmUpdate.mock.calls[0][1]).toBe(responseText);
    expect(responseText.length).toBeGreaterThan(2000);
    expect(llmUpdate.mock.calls[0][2]).toBe(config);
    expect(llmUpdate.mock.calls[0][3].defaultPrompts).toBe(DEFAULT_PROMPTS);

    const body = fetchRequestBodies().find(candidate => candidate.messages?.[0]?.content === systemPrompt);
    expect(body).toBeDefined();
    const nodeDescriptions = `1. [${node.id}] "${node.name}": ${node.content.slice(0, 200)}`;
    expect(body.messages[1].content).toBe(userTemplate
      .replace('{{responseExcerpt}}', responseText.slice(0, 500))
      .replace('{{nodeDescriptions}}', nodeDescriptions));
  });

  it('memrlMode=llm이면 프롬프트 미설정 시 DEFAULT_PROMPTS를 사용한다', async () => {
    const { session, node, messages, responseText } = seedMemrlFeedback('memrl-llm-defaults');
    const llmUpdate = vi.spyOn(session.store, 'updateUtilityScoresLLM');
    const config = {
      ...testConfig(),
      memrlMode: 'llm' as const,
      embeddingEnabled: false,
      memrlSystemPrompt: null,
      memrlUserPromptTemplate: null,
    };

    await runPipeline(session, { messages, currentMsgCount: 5 }, config, repo, agentSpy());

    expect(llmUpdate).toHaveBeenCalledTimes(1);
    expect(llmUpdate.mock.calls[0][1]).toBe(responseText);
    const body = fetchRequestBodies().find(candidate => candidate.messages?.[0]?.content === DEFAULT_PROMPTS.memrlSystem);
    expect(body).toBeDefined();
    const nodeDescriptions = `1. [${node.id}] "${node.name}": ${node.content.slice(0, 200)}`;
    expect(body.messages[1].content).toBe(DEFAULT_PROMPTS.memrlUserTemplate
      .replace('{{responseExcerpt}}', responseText.slice(0, 500))
      .replace('{{nodeDescriptions}}', nodeDescriptions));
  });
});

describe('파이프라인 통합', () => {
  it('12스텝 전체: 트림/드롭·요약 삽입·플레이스홀더 주입·영속화까지', async () => {
    const chatKey = 'it-full';
    const session = seedNodes(chatKey);
    const messages = makeMessages(25); // 9 kept + 9 trimmed + 7 dropped
    const agent = agentSpy();

    const result = await runPipeline(session, { messages, currentMsgCount: 26, personaName: '유저' }, testConfig(), repo, agent);

    // 키워드 "마법" 매칭 → 로어 노드가 플레이스홀더 자리에 주입됨
    const sys = result.messages.find(m => m.role === 'system')!;
    expect(sys.content).toContain('계약 기반');
    expect(sys.content).not.toContain('[omninode.lore]');
    expect(sys.content).not.toContain('[omninode.memory]');
    expect(sys.content).not.toContain('[omninode.writer.md]');
    expect(sys.content).not.toContain('[omninode.chat.md]');
    expect(sys.content).not.toContain('[omninode.preferences.md]');
    expect(result.loreCtx).toContain('계약 기반');

    // 트림/드롭: removable 25개 중 kept 9개만 생존 + 요약 1개 삽입
    const removableLeft = result.messages.filter(m => m.removable === true);
    expect(removableLeft).toHaveLength(9);
    expect(result.stats.droppedCount).toBe(7);
    expect(result.stats.trimmedCount).toBe(9);
    expect(result.stats.summaryInserted).toBe(true);
    const summaryMsg = result.messages.find(m => typeof m.content === 'string' && m.content.includes('요약: 마법사가'));
    expect(summaryMsg).toBeTruthy();
    expect(summaryMsg!.removable).toBeUndefined(); // 합성 메시지

    // 상태: 턴 갱신, MemRL용 주입 기록, 활성도 EMA 반영
    expect(session.store.currentTurn).toBe(26);
    expect(session.prevInjectedNodeIds.length).toBeGreaterThan(0);
    expect(result.stats.injectedCount).toBeGreaterThan(0);

    // LTM 배치: keptStart(25-9=16) ≥ 8 → 에이전트 호출 + 워터마크 전진
    expect(agent.calls).toBe(1);
    expect(session.store._ltmConvertedUpTo).toBe(8);
    expect(result.stats.ltmConverted).toBe(true);

    // 영속화: 콜드 로드로 상태 복원 확인 (diff 스냅샷 포함)
    const fresh = new ChatStateRepo(db.sqlite).load(chatKey);
    expect(fresh.store.currentTurn).toBe(26);
    expect(fresh.diffManager.getSnapshotCount()).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(fresh.store.serialize())).toBe(JSON.stringify(session.store.serialize()));
  });

  it('짧은 채팅: 트림 없음·요약 없음·통과 동작', async () => {
    const chatKey = 'it-short';
    const session = seedNodes(chatKey);
    const messages = makeMessages(4);
    const result = await runPipeline(session, { messages, currentMsgCount: 5 }, testConfig(), repo, agentSpy());

    expect(result.messages.filter(m => m.removable === true)).toHaveLength(4);
    expect(result.stats.summaryInserted).toBe(false);
    expect(result.stats.droppedCount).toBe(0);
    expect(result.stats.trimmedCount).toBe(0);
  });

  it('리롤 감지: 이전 스냅샷으로 롤백 후 재실행하며 MemRL 피드백은 건너뛴다', async () => {
    const chatKey = 'it-reroll';
    const session = seedNodes(chatKey);
    const config = testConfig();

    // 턴 26 → 턴 28 두 번 진행 (리롤이 돌아갈 "이전 시점" 스냅샷 확보)
    await runPipeline(session, { messages: makeMessages(25), currentMsgCount: 26 }, config, repo, agentSpy());
    const msgs28 = makeMessages(27);
    await runPipeline(session, { messages: msgs28, currentMsgCount: 28 }, config, repo, agentSpy());
    const snapTurns = session.diffManager.snapshots.map(s => s.turn);
    expect(snapTurns).toEqual([26, 28]);
    // MemRL 제외 비교용 (리롤은 의도적으로 MemRL을 건너뛰므로 utilityScore는 달라질 수 있음)
    const stripUtility = () => JSON.stringify(session.store.serialize(), (k, v) => (k === 'utilityScore' ? undefined : v));
    const afterFirst28 = stripUtility();

    // 같은 currentMsgCount로 재요청 = 리롤 → 턴 26 스냅샷으로 롤백 후 재실행
    const reroll = await runPipeline(session, { messages: msgs28, currentMsgCount: 28 }, config, repo, agentSpy());
    expect(reroll.stats.isReroll).toBe(true);
    expect(session.store.currentTurn).toBe(28);
    // 롤백이 실제로 일어났다면 활성도 EMA가 이중 적용되지 않아 (utility 제외) 상태 동등
    expect(stripUtility()).toBe(afterFirst28);
    expect(session.diffManager.snapshots.map(s => s.turn)).toEqual([26, 28]);

    // 롤백 감지 (메시지 수 감소)
    const third = await runPipeline(session, { messages: makeMessages(20), currentMsgCount: 21 }, config, repo, agentSpy());
    expect(third.stats.isRollback).toBe(true);
  });

  it('리롤 오인 방지: 메시지 수가 같아도 마지막 메시지 내용이 다르면 리롤로 취급하지 않는다', async () => {
    // HANDOFF §1.5 챗 복사 사고 방어 — 별개 채팅이 같은 chatKey를 차지했을 때
    // 수만 같다고 롤백→재형성으로 그래프를 파괴하지 않아야 한다
    const chatKey = 'it-not-reroll';
    const session = seedNodes(chatKey);
    const config = testConfig();

    const msgs = makeMessages(27);
    await runPipeline(session, { messages: msgs, currentMsgCount: 28 }, config, repo, agentSpy());
    const snapsBefore = session.diffManager.snapshots.map(s => s.turn);

    // 같은 수, 다른 마지막 메시지 = 별개 채팅 의심 → isReroll false, 롤백 없음
    const other = makeMessages(27);
    other[other.length - 1].content = '전혀 다른 채팅의 마지막 메시지';
    const result = await runPipeline(session, { messages: other, currentMsgCount: 28 }, config, repo, agentSpy());
    expect(result.stats.isReroll).toBe(false);
    expect(result.stats.isRollback).toBe(false);
    expect(session.diffManager.snapshots.map(s => s.turn).slice(0, snapsBefore.length)).toEqual(snapsBefore);

    // 그 다음 진짜 리롤(동일 메시지 재요청)은 여전히 감지된다
    const reroll = await runPipeline(session, { messages: other, currentMsgCount: 28 }, config, repo, agentSpy());
    expect(reroll.stats.isReroll).toBe(true);
  });

  it('임베딩 비활성 시에도 키워드 경로만으로 동작한다', async () => {
    const chatKey = 'it-noemb';
    const session = seedNodes(chatKey);
    const config = { ...testConfig(), embeddingEnabled: false };
    const result = await runPipeline(session, { messages: makeMessages(12), currentMsgCount: 13 }, config, repo, agentSpy());
    expect(result.stats.injectedCount).toBeGreaterThan(0);
    expect(result.loreCtx).toContain('계약 기반'); // 키워드 "마법" 매칭
  });

  it('alwaysActive 노드는 예산과 무관하게 항상 주입된다', async () => {
    const chatKey = 'it-always';
    const session = sessions.get(chatKey);
    session.store.addLoreNode({ name: '절대 설정', content: '항상 주입되어야 하는 설정.', keywords: ['없는키워드'], alwaysActive: true });
    repo.flush(chatKey, session.store, session.diffManager);

    const result = await runPipeline(session, { messages: makeMessages(4), currentMsgCount: 5 }, testConfig(), repo, agentSpy());
    expect(result.loreCtx).toContain('항상 주입되어야');
  });

  it('주입 디버그 플래그가 켜진 경우에만 낙선 후보를 기록한다', async () => {
    const seedOversizedLore = (chatKey: string) => {
      const session = sessions.get(chatKey);
      session.store.addLoreNode({
        name: '예산 초과 로어 A', content: `DEBUG_REJECT_A ${'A'.repeat(2200)}`, keywords: ['마법'],
      });
      session.store.addLoreNode({
        name: '예산 초과 로어 B', content: `DEBUG_REJECT_B ${'B'.repeat(2200)}`, keywords: ['마법'],
      });
      repo.flush(chatKey, session.store, session.diffManager);
      return session;
    };

    const disabledSession = seedOversizedLore('injection-debug-off');
    await runPipeline(disabledSession, {
      messages: makeMessages(2), currentMsgCount: 3, maxContext: 1, maxResponse: 1,
    }, { ...testConfig(), embeddingEnabled: false, injectionDebugEnabled: false }, repo, agentSpy());
    expect(disabledSession.lastInjection).not.toHaveProperty('rejected');

    const enabledSession = seedOversizedLore('injection-debug-on');
    await runPipeline(enabledSession, {
      messages: makeMessages(2), currentMsgCount: 3, maxContext: 1, maxResponse: 1,
    }, { ...testConfig(), embeddingEnabled: false, injectionDebugEnabled: true }, repo, agentSpy());
    const debugRecord = enabledSession.lastInjection as typeof enabledSession.lastInjection & {
      rejected: Array<Record<string, unknown>>;
    };
    expect(debugRecord.rejected.length).toBeGreaterThan(0);
    expect(debugRecord.rejected[0]).toEqual(expect.objectContaining({
      name: expect.any(String),
      id: expect.any(String),
      type: 'lore',
      chars: expect.any(Number),
      activation: expect.any(Number),
      importance: expect.any(Number),
      baseScore: expect.any(Number),
      breakdown: expect.objectContaining({
        final: expect.any(Number),
        baseRelevance: expect.any(Number),
        contextMultiplier: expect.any(Number),
        recencyDecay: expect.any(Number),
      }),
      decayMultiplier: expect.any(Number),
      effScore: expect.any(Number),
      reason: 'budget-break',
    }));
  });

  it('플레이스홀더가 없으면 컨텍스트는 버려지고 메시지는 온전하다', async () => {
    const chatKey = 'it-noph';
    const session = seedNodes(chatKey);
    const messages: PipelineMessage[] = [
      { role: 'system', content: '플레이스홀더 없는 시스템 프롬프트' },
      ...makeMessages(4).slice(1),
    ];
    const result = await runPipeline(session, { messages, currentMsgCount: 5 }, testConfig(), repo, agentSpy());
    expect(result.messages[0].content).toBe('플레이스홀더 없는 시스템 프롬프트');
    expect(result.loreCtx.length).toBeGreaterThan(0); // 컨텍스트는 생성됐지만 주입처 없음
  });

  it('빈 그래프 + LTM 배치 없음이면 LLM/임베딩 호출이 0회다', async () => {
    const chatKey = 'it-empty';
    const session = sessions.get(chatKey); // 노드 시딩 안 함
    session.enabled = true; // 빈 그래프 최적화 자체를 검증하므로 명시적으로 사용
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const result = await runPipeline(session, { messages: makeMessages(4), currentMsgCount: 5 }, testConfig(), repo, agentSpy());
    expect(fetchMock).not.toHaveBeenCalled(); // 키워드·임베딩 헛호출 없음
    expect(result.stats.keywords).toEqual([]);
    expect(result.stats.injectedCount).toBe(0);

    // 노드가 있으면 정상적으로 호출된다 (가드가 과잉 차단하지 않는지)
    seedNodes('it-nonempty');
    const s2 = sessions.get('it-nonempty');
    await runPipeline(s2, { messages: makeMessages(4), currentMsgCount: 5 }, testConfig(), repo, agentSpy());
    expect(fetchMock).toHaveBeenCalled();
  });

  it('세션 락: 동시 요청이 직렬화된다', async () => {
    const chatKey = 'it-lock';
    const session = seedNodes(chatKey);
    const config = testConfig();
    const order: number[] = [];
    const run = (n: number) => session.runExclusive(async () => {
      order.push(n);
      await new Promise(r => setTimeout(r, 5));
      order.push(n * 10);
    });
    await Promise.all([run(1), run(2)]);
    expect(order).toEqual([1, 10, 2, 20]); // 교차 없음
  });
});

describe('로어북 키 직격 매칭 (원작 이탈, 2026-08-02)', () => {
  it('LLM 키워드가 놓친 이름도 채팅 텍스트 substring으로 후보에 올린다', async () => {
    const chatKey = 'direct-key';
    const session = sessions.get(chatKey);
    // 모의 LLM 키워드 추출은 ["마법","용","왕국"]만 반환 — '에릭'은 못 뽑는 상황 재현
    session.store.addLoreNode({ name: '에릭 프로필', content: '에릭은 평민 지구의 대장장이다.', keywords: ['에릭'] });
    session.store.addLoreNode({ name: '한글자 키', content: '외자 키 내용', keywords: ['이'] }); // 1자 가드 검증용
    repo.flush(chatKey, session.store, session.diffManager);

    const logSpy = vi.spyOn(console, 'log');
    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      { role: 'user', content: '오늘은 에릭을 만나러 간다. 이 이야기의 시작.', removable: true },
    ];
    const result = await runPipeline(session, { messages: msgs, currentMsgCount: 2 }, testConfig(), repo, agentSpy());

    // '에릭'(2자)만 직격 매치 — '이'(1자)는 가드에 걸려 제외
    const directLog = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('Direct key match'));
    expect(directLog).toContain('+1');
    expect(result.loreCtx).toContain('에릭은 평민 지구의 대장장이다');
    logSpy.mockRestore();
  });

  it('directKeyMatchEnabled=false면 채널이 비활성화된다', async () => {
    const chatKey = 'direct-key-off';
    const session = sessions.get(chatKey);
    session.store.addLoreNode({ name: '에릭 프로필', content: '에릭 설명', keywords: ['에릭'] });
    repo.flush(chatKey, session.store, session.diffManager);

    const logSpy = vi.spyOn(console, 'log');
    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      { role: 'user', content: '에릭을 만나러 간다.', removable: true },
    ];
    await runPipeline(session, { messages: msgs, currentMsgCount: 2 }, { ...testConfig(), directKeyMatchEnabled: false }, repo, agentSpy());
    const directLog = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('Direct key match'));
    expect(directLog).toBeUndefined();
    logSpy.mockRestore();
  });
});

describe('로어 키워드 매칭 활성도 소생 (원작 이탈, 2026-08-08)', () => {
  it('활성도 1인 lore 직격 매칭을 30으로 소생해 같은 턴 점수에 반영한다', async () => {
    const chatKey = 'keyword-revival-lore';
    const session = sessions.get(chatKey);
    const lore = session.store.addLoreNode({
      name: '에릭 프로필',
      content: `REVIVED_LORE ${'L'.repeat(1190)}`,
      keywords: ['에릭'],
    });
    lore.activationScore = 1;
    session.store.addCommunityNode({
      name: '경쟁 요약',
      content: `COMPETING_SUMMARY ${'C'.repeat(1190)}`,
      keywords: ['마법'],
      importance: 5,
      activationScore: 15,
    });
    repo.flush(chatKey, session.store, session.diffManager);

    // STEP 10의 후속 EMA를 막아 STEP 8에 실제로 전달된 소생 값을 관찰한다.
    vi.spyOn(session.store, 'updateActivationScores').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log');
    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      { role: 'user', content: '에릭을 다시 만나러 간다.', removable: true },
    ];
    const result = await runPipeline(session, {
      messages: msgs, currentMsgCount: 2, maxContext: 1, maxResponse: 1,
    }, { ...testConfig(), embeddingEnabled: false }, repo, agentSpy());

    const revivalLog = logSpy.mock.calls.map(c => String(c[0])).find(l => l.includes('Keyword revival'));
    logSpy.mockRestore();
    expect(lore.activationScore).toBe(30);
    expect(revivalLog).toContain('1 lore nodes (에릭 프로필)');
    // 500토큰 예산에는 한 노드만 들어간다. 소생 후 multiplier(1.62)가 경쟁 요약(1.56)을
    // 앞서야 로어가 같은 턴에 먼저 주입된다.
    expect(result.loreCtx).toContain('REVIVED_LORE');
    expect(result.memCtx).not.toContain('COMPETING_SUMMARY');
  });

  it('로컬 키워드가 일치해도 longTermMemory 활성도는 소생하지 않는다', async () => {
    const chatKey = 'keyword-revival-ltm';
    const session = sessions.get(chatKey);
    const ltm = session.store.addLongTermMemoryNode({
      name: '마법 사건 기억', content: '마법 사건의 장기 기억', keywords: ['마법'], activationScore: 1,
    });
    repo.flush(chatKey, session.store, session.diffManager);
    vi.spyOn(session.store, 'updateActivationScores').mockImplementation(() => {});

    await runPipeline(session, { messages: makeMessages(2), currentMsgCount: 3 }, {
      ...testConfig(), embeddingEnabled: false,
    }, repo, agentSpy());

    expect(ltm.activationScore).toBe(1);
  });

  it('keywordRevivalEnabled=false면 직격 매칭 lore 활성도를 소생하지 않는다', async () => {
    const chatKey = 'keyword-revival-off';
    const session = sessions.get(chatKey);
    const lore = session.store.addLoreNode({ name: '에릭 프로필', content: '에릭 설명', keywords: ['에릭'] });
    lore.activationScore = 1;
    repo.flush(chatKey, session.store, session.diffManager);
    vi.spyOn(session.store, 'updateActivationScores').mockImplementation(() => {});
    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      { role: 'user', content: '에릭을 다시 만난다.', removable: true },
    ];

    await runPipeline(session, { messages: msgs, currentMsgCount: 2 }, {
      ...testConfig(), embeddingEnabled: false, keywordRevivalEnabled: false,
    }, repo, agentSpy());

    expect(lore.activationScore).toBe(1);
  });
});

describe('챗 복사 자동 감지 (HANDOFF §G 필수 — 2026-08-04)', () => {
  function seedSourceChat(chatKey: string, msgCount: number) {
    const session = sessions.get(chatKey);
    session.store.currentTurn = msgCount;
    session.store.addLoreNode({ name: '원본 로어', content: '설정', keywords: ['설정'] });
    session.store.addLongTermMemoryNode({ name: '원본 기억', content: '### 원본 기억\n사건', keywords: ['사건'] });
    repo.flush(chatKey, session.store, session.diffManager);
    const history = Array.from({ length: msgCount }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `공유 히스토리 메시지 ${i}`,
    }));
    repo.syncMessages(chatKey, history);
    return history;
  }

  it('복사된 히스토리를 감지해 그래프를 승계한다', async () => {
    const history = seedSourceChat('copy-src', 12);
    const copyKey = 'copy-dst';
    const session = sessions.get(copyKey);
    expect(session.store.getNodeCount()).toBe(0);

    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...history.map(h => ({ ...h, removable: true } as PipelineMessage)),
    ];
    const result = await runPipeline(session, {
      messages: msgs, currentMsgCount: 12, allChatMessages: history,
    }, testConfig(), repo, agentSpy());

    expect(result.inherited).toBeDefined();
    expect(result.inherited!.from).toBe('copy-src');
    expect(result.inherited!.matchedMessages).toBe(12);
    expect(session.store.getNodeCount()).toBeGreaterThanOrEqual(2); // 로어+LTM 승계
    expect(result.loreCtx).toContain('설정'); // 승계된 로어가 주입까지 이어짐
  });

  it('프리픽스가 짧으면(인사말 수준) 승계하지 않는다', async () => {
    seedSourceChat('copy-src2', 20);
    const session = sessions.get('copy-short');
    const shortHistory = [
      { role: 'user', content: '공유 히스토리 메시지 0' },
      { role: 'assistant', content: '공유 히스토리 메시지 1' },
    ];
    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...shortHistory.map(h => ({ ...h, removable: true } as PipelineMessage)),
    ];
    const result = await runPipeline(session, {
      messages: msgs, currentMsgCount: 2, allChatMessages: shortHistory,
    }, testConfig(), repo, agentSpy());
    expect(result.inherited).toBeUndefined();
    expect(session.store.getNodeCount()).toBe(0);
  });

  it('목적지에 이미 그래프가 있으면 건드리지 않는다', async () => {
    const history = seedSourceChat('copy-src3', 12);
    const session = sessions.get('copy-existing');
    session.store.addLongTermMemoryNode({ name: '내 기억', content: 'x', keywords: ['x'] });
    const before = session.store.getNodeCount();
    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...history.map(h => ({ ...h, removable: true } as PipelineMessage)),
    ];
    const result = await runPipeline(session, {
      messages: msgs, currentMsgCount: 12, allChatMessages: history,
    }, testConfig(), repo, agentSpy());
    expect(result.inherited).toBeUndefined();
    expect(session.store.getNode('내 기억' as any) ?? before).toBeTruthy();
  });

  it('소스가 앞서 있으면 복사 시점 턴으로 롤백해 유령 기억을 제거한다', async () => {
    const history = seedSourceChat('copy-src5', 30);
    const srcSession = sessions.get('copy-src5');
    // 12메시지 시점 스냅샷 → 이후 "미래 기억" 추가 → 최신 스냅샷
    srcSession.store.currentTurn = 12;
    await srcSession.diffManager.takeDiff(srcSession.store, 'BASE');
    srcSession.store.currentTurn = 30;
    srcSession.store.addLongTermMemoryNode({ name: '미래 사건', content: '분기 이후에 일어난 일', keywords: ['미래'] });
    await srcSession.diffManager.takeDiff(srcSession.store);
    repo.flush('copy-src5', srcSession.store, srcSession.diffManager);

    const partial = history.slice(0, 12);
    const session = sessions.get('copy-rollback');
    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...partial.map(h => ({ ...h, removable: true } as PipelineMessage)),
    ];
    const result = await runPipeline(session, {
      messages: msgs, currentMsgCount: 12, allChatMessages: partial,
    }, testConfig(), repo, agentSpy());
    expect(result.inherited).toBeDefined();
    // 유령 기억이 롤백으로 사라졌는지
    const names = [...session.store.longTermMemoryNodes.values()].map(n => n.name);
    expect(names).not.toContain('미래 사건');
    expect(names).toContain('원본 기억'); // 복사 시점 이전 기억은 유지
  });

  it('소스가 앞서 있는데 스냅샷이 없으면 승계를 포기하고 콜드스타트를 권유한다', async () => {
    const history = seedSourceChat('copy-src4', 30);
    const srcSession = sessions.get('copy-src4');
    srcSession.store._ltmConvertedUpTo = 24; // 소스는 24까지 변환됨, 스냅샷은 없음
    repo.flush('copy-src4', srcSession.store, srcSession.diffManager);

    const partial = history.slice(0, 12); // 복사는 12메시지 시점에 이뤄짐
    const session = sessions.get('copy-abandon');
    const msgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...partial.map(h => ({ ...h, removable: true } as PipelineMessage)),
    ];
    const result = await runPipeline(session, {
      messages: msgs, currentMsgCount: 12, allChatMessages: partial,
    }, testConfig(), repo, agentSpy());
    expect(result.inherited).toBeUndefined();
    expect(result.inheritSkipped).toBeDefined();
    expect(result.inheritSkipped!.from).toBe('copy-src4');
    expect(session.store.getNodeCount()).toBe(0); // 유령 기억 없이 빈 그래프
    // 다음 턴에서는 클론 재시도를 하지 않는다
    const again = await runPipeline(session, {
      messages: msgs, currentMsgCount: 12, allChatMessages: partial,
    }, testConfig(), repo, agentSpy());
    expect(again.inherited).toBeUndefined();
    expect(again.inheritSkipped).toBeUndefined();
  });
});
