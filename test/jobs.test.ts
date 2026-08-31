// Phase 6 백그라운드 잡 테스트 — LTM 이관·활동 게이트·에이전트 실행·디바운스
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDbFile, type Db } from '../src/db.js';
import { ChatStateRepo } from '../src/persistence/chat-state-repo.js';
import { SessionManager } from '../src/pipeline/session.js';
import { runPipeline } from '../src/pipeline/pipeline.js';
import type { PipelineMessage, NodeEditAgentDeps } from '../src/pipeline/helpers.js';
import { DEFAULT_CONFIG, type OmniConfig, ConfigStore } from '../src/config-store.js';
import { JobRunner, type JobRow } from '../src/jobs/runner.js';
import { coldStartFromHistory } from '../src/jobs/lore-import.js';
import { OmniNodeStore } from '../src/core/node-store.js';
import { mulberry32 } from './fixture.js';

let db: Db;
let repo: ChatStateRepo;
let sessions: SessionManager;
let configStore: ConfigStore;

function textToVec(text: string, dim = 8): number[] {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
  const rand = mulberry32(h >>> 0);
  return Array.from({ length: dim }, () => rand() * 2 - 1);
}

let compactionResponse = '';
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
    const sys = body.messages?.[0]?.content ?? '';
    let content = 'ok';
    if (sys.includes('Extract the 8-12')) content = '["마법", "용", "왕국"]';
    else if (sys.includes('Summarize the following conversation')) content = '요약: 마법사가 용과 계약했다.';
    else if (sys.includes('knowledge graph relationship analyzer')) {
      // 고아 링킹: 첫 후보로 링크 생성
      const userMsg = body.messages?.[1]?.content ?? '';
      const m = userMsg.match(/"candidates":\s*\[\s*\{\s*"id":\s*"([^"]+)"/);
      content = m ? JSON.stringify({ links: [{ targetId: m[1], type: 'related', strength: 3, direction: 'bi' }] })
        : JSON.stringify({ links: [] });
    }
    else if (sys.includes('cluster of related memory nodes')) {
      content = JSON.stringify({ title: '모의 커뮤니티', summary: '### 모의\n- Description: 요약', keywords: ['모의'], timestamp: '2607290000' });
    }
    else if (sys.includes('world simulation engine')) {
      content = JSON.stringify({ events: [{ name: '북쪽 상단이 가격을 올린다', content: '### 사건\n설명', keywords: ['상단'], importance: 2, timestamp: '2607290100' }] });
    }
    else if (sys.includes('memory consolidation engine') || sys.includes('lore correction-note consolidation engine')) content = compactionResponse;
    else if (sys.includes('knowledge atlas')) content = '## Characters\n- 마법사: 용과 계약함';
    else if (sys.includes('keyword extraction assistant')) content = '["생성키워드", "로어"]';
    else if (sys.includes('lorebook relationship analyzer')) {
      content = JSON.stringify([{ from: 0, to: 1, direction: 'bi', type: 'related', strength: 3 }]);
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
    useGliner: false, // 테스트는 LLM 키워드 경로 (GLiNER 엔드포인트 없음)
  };
}

function makeMessages(chatTurns: number): PipelineMessage[] {
  const msgs: PipelineMessage[] = [
    { role: 'system', content: '설정: →[omninode.lore]← →[omninode.memory]←' },
  ];
  for (let i = 0; i < chatTurns; i++) {
    msgs.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}번째 턴: ${i % 3 === 0 ? '마법' : '모험'} 이야기.`,
      removable: true,
    });
  }
  return msgs;
}

const agentSpy = (): NodeEditAgentDeps & { calls: number } => {
  const deps = {
    calls: 0,
    async runNodeEditAgent(
      _text: string, _msgs: unknown, _config: OmniConfig, _persona: string,
      _character: string, _simulBot: boolean, ns: any,
    ) {
      deps.calls++;
      const node = ns.addLongTermMemoryNode({ name: `잡생성기억${deps.calls}`, content: `### 기억 ${deps.calls}`, keywords: ['마법'] });
      return { totalActions: 1, createdExtraLoreIds: [], affectedNodeIds: [node.id] };
    },
  };
  return deps;
};

function makeRunner(deps: NodeEditAgentDeps) {
  return new JobRunner(db.sqlite, repo, sessions, configStore, deps);
}

function forceDue() {
  db.sqlite.prepare(`UPDATE jobs SET run_after = 0 WHERE status = 'pending'`).run();
}

function jobRows(): JobRow[] {
  return db.sqlite.prepare('SELECT * FROM jobs ORDER BY id').all() as JobRow[];
}

beforeEach(() => {
  db = openDbFile(':memory:');
  repo = new ChatStateRepo(db.sqlite);
  sessions = new SessionManager(repo);
  configStore = new ConfigStore(db.sqlite);
  configStore.save(testConfig() as unknown as Record<string, unknown>);
  setupMockFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('JobRunner', () => {
  it('파이프라인이 LTM 배치를 잡으로 등록하고, 러너 실행 시 기억이 형성된다', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('job-ltm');
    session.enabled = true;
    const config = testConfig();

    const result = await runPipeline(session, { messages: makeMessages(25), currentMsgCount: 26 }, config, repo, deps, runner);
    expect(result.stats.ltmQueued).toBe(true);
    expect(result.stats.ltmConverted).toBe(false);
    expect(deps.calls).toBe(0); // 요청 경로에서 에이전트 미호출 (동기 변환 이관 검증)

    const pending = jobRows().filter(j => j.kind === 'ltm' && j.status === 'pending');
    expect(pending.length).toBe(1);

    forceDue();
    await runner.tick();

    expect(deps.calls).toBe(1);
    expect(session.store._ltmConvertedUpTo).toBe(8);
    expect(session.store.longTermMemoryNodes.size).toBeGreaterThan(0);
    expect(jobRows().find(j => j.kind === 'ltm')!.status).toBe('done');

    // 잡의 flush가 영속화까지 했는지
    const { store: loaded } = new ChatStateRepo(db.sqlite).load('job-ltm');
    expect(loaded._ltmConvertedUpTo).toBe(8);
  });

  it('워터마크가 이동한 낡은 LTM 배치는 스킵한다 (롤백 경합 가드)', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('job-stale');
    session.store._ltmConvertedUpTo = 8; // 잡 등록 후 워터마크가 움직인 상황 재현

    runner.enqueue('job-stale', 'ltm', {
      batchStart: 0, batchEnd: 8, personaName: '',
      messages: [{ role: 'user', content: '옛 메시지' }],
    });
    forceDue();
    await runner.tick();

    expect(deps.calls).toBe(0);
    expect(session.store._ltmConvertedUpTo).toBe(8); // 불변
    expect(jobRows()[0].status).toBe('done');
  });

  it('dream 잡: 메시지 수가 게이트 미달이면 태스크 없이 종료한다', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('job-gate');
    session.store.currentTurn = 2; // < autodreamAutoMinMessages(4)

    runner.enqueue('job-gate', 'dream', {});
    forceDue();
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    const callsBefore = fetchSpy.mock.calls.length;
    await runner.tick();

    expect(jobRows()[0].status).toBe('done');
    expect(fetchSpy.mock.calls.length).toBe(callsBefore); // LLM 호출 0회
  });

  it('dream 잡: 고아 링킹이 모의 LLM으로 관계를 생성한다', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('job-orphan');
    const ns = session.store;
    ns.currentTurn = 20;
    // 관계 0개 고아 4개 — 키워드를 공유시켜 후보 탐색이 되게 한다
    for (let i = 0; i < 4; i++) {
      ns.addLongTermMemoryNode({ name: `고아${i}`, content: `### 고아 ${i}\n마법 관련 사건`, keywords: ['마법', `사건${i}`] });
    }

    runner.enqueue('job-orphan', 'dream', {});
    forceDue();
    await runner.tick();

    expect(jobRows()[0].status).toBe('done');
    const totalRels = ns.getAllNodes().reduce((s, n) => s + (n.relationships || []).length, 0);
    expect(totalRels).toBeGreaterThan(0);
  });

  it('로어북 임포트 잡: 엔트리→로어 노드, 키 없는 엔트리는 키워드 생성, 관계 연결', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('job-lore');

    runner.enqueue('job-lore', 'import-lorebook', {
      entries: [
        { content: '마법 체계는 계약 기반이다.', key: '마법,계약', comment: '마법 체계' },
        { content: '북쪽 산맥에 고대 용이 산다.', comment: '용의 산' }, // 키 없음 → 키워드 생성
        { content: '', key: '빈엔트리' }, // 빈 내용 → 스킵
      ],
    });
    forceDue();
    await runner.tick();

    const job = jobRows()[0];
    expect(job.status).toBe('done');
    const ns = session.store;
    expect(ns.loreNodes.size).toBe(2);
    const nodes = [...ns.loreNodes.values()];
    expect(nodes[0].keywords).toEqual(['마법', '계약']);
    expect(nodes[1].keywords).toEqual(['생성키워드', '로어']); // 모의 LLM 생성분
    // 관계 연결 (모의: #0↔#1 bi)
    expect(nodes[0].relationships.some(r => r.targetId === nodes[1].id)).toBe(true);
    expect(nodes[1].relationships.some(r => r.targetId === nodes[0].id)).toBe(true);
    // 결과가 payload에 기록되고 영속화됨
    expect(JSON.parse(job.payload_json).result.imported).toBe(2);
    const { store: loaded } = new ChatStateRepo(db.sqlite).load('job-lore');
    expect(loaded.loreNodes.size).toBe(2);
  });

  it('로어북 임포트 잡 실행은 enabled=true를 명시적으로 영속화한다', async () => {
    const runner = makeRunner(agentSpy());
    const session = sessions.get('job-lore-enables');
    expect(session.enabled).toBeUndefined();

    runner.enqueue('job-lore-enables', 'import-lorebook', {
      entries: [{ content: '자동 활성화 확인용 로어', key: '활성화', comment: '활성화 확인' }],
    });
    forceDue();
    await runner.tick();

    expect(session.enabled).toBe(true);
    const loaded = new ChatStateRepo(db.sqlite).load('job-lore-enables');
    expect(loaded.enabled).toBe(true);
    const stored = db.sqlite.prepare('SELECT meta_json FROM chats WHERE chat_key = ?')
      .get('job-lore-enables') as { meta_json: string };
    expect(JSON.parse(stored.meta_json).enabled).toBe(true);
  });

  it('콜드 스타트 잡: 숏텀 창 밖 메시지를 8청크로 처리하고 워터마크를 올린다', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('job-cold');
    const snapshots: Array<{ turn: number; watermark: number; hash: string }> = [];
    const takeDiff = session.diffManager.takeDiff.bind(session.diffManager);
    vi.spyOn(session.diffManager, 'takeDiff').mockImplementation(async (store, type) => {
      snapshots.push({
        turn: store.currentTurn,
        watermark: store._ltmConvertedUpTo,
        hash: store._ltmWatermarkHash,
      });
      await takeDiff(store, type);
    });

    const messages = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `${i}번째 턴 이야기`,
    }));
    runner.enqueue('job-cold', 'cold-start', { messages, personaName: '카라' });
    forceDue();
    await runner.tick();

    const job = jobRows()[0];
    expect(job.status).toBe('done');
    // 마지막이 user(24번째, 짝수)라 keepTurns=9 → cut=16개 → 2청크
    expect(deps.calls).toBe(2);
    const ns = session.store;
    expect(ns._ltmConvertedUpTo).toBe(16); // 워터마크 반영 (원본 버그 4호 후보 수정)
    expect(ns._ltmWatermarkHash).toBe(contentHash('15번째 턴 이야기'));
    expect(ns.currentTurn).toBe(16);
    expect(snapshots).toEqual([
      { turn: 8, watermark: 8, hash: contentHash('7번째 턴 이야기') },
      { turn: 16, watermark: 16, hash: contentHash('15번째 턴 이야기') },
    ]);
    expect(ns.longTermMemoryNodes.size).toBeGreaterThan(0);
    const payload = JSON.parse(job.payload_json);
    expect(payload.result.chunks).toBe(2);
    expect(payload.messages).toBeUndefined(); // 완료 후 전문 폐기
    // 영속화 확인
    const { store: loaded } = new ChatStateRepo(db.sqlite).load('job-cold');
    expect(loaded._ltmConvertedUpTo).toBe(16);
  });

  it('enqueue 디바운스: 같은 종류 pending 잡은 새 행 없이 run_after만 갱신된다', () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    runner.enqueue('job-dedupe', 'dream', {}, { delayMs: 1000 });
    const first = jobRows()[0];
    runner.enqueue('job-dedupe', 'dream', {}, { delayMs: 60000 });
    const rows = jobRows();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(first.id);
    expect(rows[0].run_after).toBeGreaterThan(first.run_after);
  });

  it('파이프라인 대기 중이면 dream 잡이 조기 양보한다', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('job-yield');
    const ns = session.store;
    ns.currentTurn = 20;
    for (let i = 0; i < 4; i++) {
      ns.addLongTermMemoryNode({ name: `고아${i}`, content: `### 고아 ${i}`, keywords: ['마법', `사건${i}`] });
    }
    session.pipelineWaiting = 1; // 파이프라인이 락 대기 중인 상황 재현

    runner.enqueue('job-yield', 'dream', {});
    forceDue();
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    const callsBefore = fetchSpy.mock.calls.length;
    await runner.tick();

    expect(jobRows()[0].status).toBe('done');
    expect(fetchSpy.mock.calls.length).toBe(callsBefore); // 태스크 전부 양보 — LLM 호출 0회
  });

  it('worldsim 이벤트의 globalKeywords를 생성 LTM 노드에 보존하고 8개로 제한한다', async () => {
    const { runWorldSimAgent } = await import('../src/jobs/agents.js');
    const ns = sessions.get('job-worldsim-global-keywords').store;
    ns.addExtraLoreNode({ name: '북쪽 상단', content: '북쪽 상단은 가격을 조정한다.', keywords: ['상단'] });
    const globalKeywords = Array.from({ length: 9 }, (_, i) => `테마${i + 1}`);
    const fetchSpy = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ events: [{
        name: '북쪽 상단이 가격을 올린다',
        content: '### 사건\n설명',
        keywords: ['상단'],
        globalKeywords,
        importance: 2,
        timestamp: '2607290100',
      }] }) } }],
    }), { status: 200 }));

    expect(await runWorldSimAgent(ns, testConfig())).toBe(1);
    const event = [...ns.longTermMemoryNodes.values()].find(node => node.worldSim);
    expect(event?.globalKeywords).toEqual(globalKeywords.slice(0, 8));
  });
});

// ── 진화 트랙 D2 (2026-08-01): 원문 로그·발췌·워터마크 해시 ──
import { repairTruncatedJson, contentHash, stripThoughtBlocks } from '../src/core/util.js';

describe('진화 트랙 D2', () => {
  it('syncMessages: 증분 upsert — 리롤은 꼬리만, 롤백은 초과분 삭제', () => {
    const mk = (n: number, tag = '') => Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}번째${i === n - 1 ? tag : ''}`,
    }));
    const r1 = repo.syncMessages('d2-log', mk(10));
    expect(r1).toEqual({ upserted: 10, deleted: 0 });
    // 동일 재전송 → 쓰기 0
    expect(repo.syncMessages('d2-log', mk(10))).toEqual({ upserted: 0, deleted: 0 });
    // 리롤: 마지막 메시지만 내용 변경 → 1행
    expect(repo.syncMessages('d2-log', mk(10, '-리롤')).upserted).toBe(1);
    // 롤백: 7개로 줄면 초과분 3행 삭제
    expect(repo.syncMessages('d2-log', mk(7)).deleted).toBe(3);
    const rows = repo.getMessageRange('d2-log', 0, 100);
    expect(rows.length).toBe(7);
    expect(rows[3]).toMatchObject({ idx: 3, role: 'assistant', content: '3번째' });
  });

  it('repairTruncatedJson: 출력 캡 절단에서 완성된 노드들을 구제한다', () => {
    const full = { nodes: [
      { tempId: '_n1', op: 'create', nodeType: 'longTermMemory', name: 'A', content: '### A' },
      { tempId: '_n2', op: 'create', nodeType: 'longTermMemory', name: 'B', content: '### B' },
      { tempId: '_n3', op: 'create', nodeType: 'extraLore', name: 'C', content: '### C' },
    ], relationships: [] };
    const text = '```json\n' + JSON.stringify(full, null, 1);
    // 마지막 노드 중간에서 절단 (닫는 괄호들 소실)
    const cutAt = text.indexOf('"### C"') + 3;
    const truncated = text.substring(0, cutAt);
    const repaired = repairTruncatedJson(truncated) as any;
    expect(repaired).toBeTruthy();
    expect(repaired.nodes.length).toBeGreaterThanOrEqual(2); // 완성분 구제
    expect(repaired.nodes[0].name).toBe('A');
    // 유효 JSON은 그대로 통과
    expect((repairTruncatedJson(JSON.stringify(full)) as any).nodes.length).toBe(3);
  });

  it('LTM 잡: 생성 LTM에 sourceTurn 앵커 스탬핑 + 워터마크 해시 기록', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('d2-anchor');
    const batch = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `배치메시지${i}` }));
    runner.enqueue('d2-anchor', 'ltm', { batchStart: 0, batchEnd: 8, personaName: '', messages: batch });
    forceDue();
    await runner.tick();

    const ns = session.store;
    const ltm = [...ns.longTermMemoryNodes.values()][0];
    expect(ltm.sourceTurnStart).toBe(0);
    expect(ltm.sourceTurnEnd).toBe(7);
    expect(ns._ltmConvertedUpTo).toBe(8);
    expect(ns._ltmWatermarkHash).toBe(contentHash('배치메시지7'));
    // 영속 왕복
    const { store: loaded } = new ChatStateRepo(db.sqlite).load('d2-anchor');
    const loadedLtm = [...loaded.longTermMemoryNodes.values()][0];
    expect(loadedLtm.sourceTurnStart).toBe(0);
    expect(loaded._ltmWatermarkHash).toBe(ns._ltmWatermarkHash);
  });

  it('주입 시 원문 발췌: sourceTurn 앵커가 있는 고중요도 LTM에 로그 슬라이스 동반', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('d2-excerpt');
    const ns = session.store;
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `원문로그${i} 마법 이야기` }));
    repo.syncMessages('d2-excerpt', msgs);
    ns.addLongTermMemoryNode({
      name: '마법 계약 사건', content: '### 마법 계약\n- Description: 마법 계약이 맺어졌다', keywords: ['마법'], importance: 4,
    });
    const ltm = [...ns.longTermMemoryNodes.values()][0];
    ltm.sourceTurnStart = 2;
    ltm.sourceTurnEnd = 4;
    repo.flush('d2-excerpt', ns, session.diffManager);

    const pipelineMsgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...Array.from({ length: 5 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant', content: `마법 이야기 ${i}`, removable: true,
      })),
    ];
    const result = await runPipeline(session, { messages: pipelineMsgs, currentMsgCount: 6 }, testConfig(), repo, deps, runner);
    expect(result.memCtx).toContain('Source excerpt (messages 3–5)');
    expect(result.memCtx).toContain('원문로그2');
    expect(result.memCtx).toContain('원문로그4');
    expect(result.memCtx).not.toContain('원문로그5'); // 범위 밖
  });

  it('워터마크 해시 재동기화: 편집으로 인덱스가 밀리면 ±5 창에서 보정 (전진 스킵 없음)', async () => {
    const deps = agentSpy();
    const runner = makeRunner(deps);
    const session = sessions.get('d2-wmsync');
    session.enabled = true; // 워터마크 보정 로직 자체를 검증하므로 명시적으로 사용
    const ns = session.store;
    // 30개 로그, 워터마크 8이었는데 앞에 메시지 1개가 삽입돼 인덱스가 +1 밀린 상황
    const chat = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `밀린로그${i}` }));
    ns._ltmConvertedUpTo = 8;
    ns._ltmWatermarkHash = contentHash('밀린로그7'); // 실제 그 내용은 이제 index 7이 아니라... 그대로 7 — 대신 밀림 재현:
    // 삽입 시뮬레이션: 서버가 기억한 해시는 "밀린로그6" (원래 index 7에 있었으나 이제 8에 있음)
    ns._ltmWatermarkHash = contentHash('밀린로그8');

    const pipelineMsgs: PipelineMessage[] = [
      { role: 'system', content: '→[omninode.lore]← →[omninode.memory]←' },
      ...chat.map(m => ({ ...m, removable: true })),
    ];
    await runPipeline(session, { messages: pipelineMsgs, currentMsgCount: 30, allChatMessages: chat }, testConfig(), repo, deps, runner);
    // 해시가 index 8(=워터마크 9의 직전)에 있으므로 9로 보정됐어야 함
    expect(session.store._ltmConvertedUpTo).toBe(9);
  });
});

describe('stripThoughtBlocks (AI 사고 블록 제거 — 2026-08-05)', () => {
  it('<Thoughts> 블록과 pm:think 마커를 제거하고 서사만 남긴다', () => {
    const msg = '<!-- pm:think:v1:s:abc-123 -->\n<Thoughts>\n**Analyzing outcomes**\nRele might be allowed...\n</Thoughts>\n\nRele took a deep breath and began.';
    const out = stripThoughtBlocks(msg);
    expect(out).toBe('Rele took a deep breath and began.');
  });

  it('사고 블록이 없으면 원문 유지, 전부 사고면 빈 문자열', () => {
    expect(stripThoughtBlocks('평범한 대사입니다.')).toBe('평범한 대사입니다.');
    expect(stripThoughtBlocks('<Thoughts>only thinking</Thoughts>')).toBe('');
  });

  it('발췌 조립이 사고 블록을 인용하지 않는다', async () => {
    // 기존 발췌 테스트와 동일 구조로 최소 재현: 메시지에 Thoughts 포함
    const db2 = openDbFile(':memory:');
    const repo2 = new ChatStateRepo(db2.sqlite);
    const key = 'thoughts-excerpt';
    repo2.syncMessages(key, [
      { role: 'user', content: '질문한다' },
      { role: 'assistant', content: '<Thoughts>meta reasoning here</Thoughts>\n\n실제 답변이다' },
    ]);
    const rows = repo2.getMessageRange(key, 0, 2);
    const lines = rows.map(r => stripThoughtBlocks(r.content)).filter(Boolean);
    expect(lines.join(' ')).not.toContain('meta reasoning');
    expect(lines.join(' ')).toContain('실제 답변이다');
    db2.sqlite.close();
  });

  it('발췌 조립이 사용자 정규식 필터(이미지 명령)도 통과시킨다', async () => {
    const { applyChatRegexFilters } = await import('../src/llm/embeddings.js');
    const cfg = { chatRegexFilters: [{ pattern: '<img=[^_>]+_[^_>]+>', flags: 'g', replacement: '' }] } as any;
    const msg = '대사가 이어진다.\n\n<img="Cedric_thinking">\n\n그리고 계속된다.';
    const out = applyChatRegexFilters(stripThoughtBlocks(msg), cfg);
    expect(out).not.toContain('<img=');
    expect(out).toContain('대사가 이어진다');
    expect(out).toContain('그리고 계속된다');
  });
});

describe('runCompactionAgent ([Updated] 노트 컴팩션 — 2026-08-05)', () => {
  async function setup(llm: string, notes = 3, type: 'extraLore' | 'longTermMemory' = 'extraLore') {
    const { runCompactionAgent } = await import('../src/jobs/agents.js');
    const { OmniNodeStore } = await import('../src/core/node-store.js');
    const ns = new OmniNodeStore();
    ns.currentTurn = 50;
    let content = '### 서쪽 경계 측량단\n\n- Type: organization\n- Description: 측량단이 파견됐다.';
    for (let i = 0; i < notes; i++) content += `\n[Updated] 정정 사실 ${i}.`;
    const args = { name: '서쪽 경계 측량단', content, keywords: ['측량단'] };
    const node = type === 'extraLore' ? ns.addExtraLoreNode(args) : ns.addLongTermMemoryNode(args);
    compactionResponse = llm;
    setupMockFetch();
    return { runCompactionAgent, ns, node };
  }

  async function setupLore(llm: string) {
    const { runCompactionAgent } = await import('../src/jobs/agents.js');
    const { OmniNodeStore } = await import('../src/core/node-store.js');
    const ns = new OmniNodeStore();
    ns.currentTurn = 50;
    const head = '### 고대 관문  \r\n\r\n- Type:\tlocation\r\n- Description: 제작자 원문은 공백과 개행까지 보존한다.  \r\n';
    const notesTail = '[Updated] 관문은 겨울에만 열린다.\r\n[Updated] 겨울이 아니라 보름달 밤에 열린다.\r\n[Updated] 보름달 밤에는 은 열쇠도 필요하다.';
    const node = ns.addLoreNode({ name: '고대 관문', content: head + notesTail, keywords: ['관문'] });
    compactionResponse = llm;
    setupMockFetch();
    return { runCompactionAgent, ns, node, head, notesTail };
  }

  it.each(['extraLore', 'longTermMemory'] as const)('%s 노트 3개 이상 노드는 기존 전체 재작성 경로를 유지한다', async (type) => {
    const rewritten = '### 서쪽 경계 측량단\n\n- Type: organization\n- Description: 측량단이 파견됐고, 정정 사실 0~2가 모두 반영된 현재 상태 서술이다. 충분한 길이를 확보한다.';
    const { runCompactionAgent, ns, node } = await setup(rewritten, 3, type);
    const n = await runCompactionAgent(ns, testConfig());
    expect(n).toBe(1);
    expect(node.content).toBe(rewritten);
    expect(node.content).not.toContain('[Updated]');
  });

  it('lore는 head 바이트를 보존하고 전문을 읽어 노트 3개만 정확히 1개로 병합한다', async () => {
    const merged = '관문은 보름달 밤에 열리며 은 열쇠가 필요하다.';
    const { runCompactionAgent, ns, node, head, notesTail } = await setupLore(merged);

    const n = await runCompactionAgent(ns, testConfig());

    expect(n).toBe(1);
    const savedHead = node.content.slice(0, head.length);
    expect(Buffer.compare(Buffer.from(savedHead), Buffer.from(head))).toBe(0);
    expect(node.content).toBe(`${head}\n[Updated] ${merged}`);
    expect((node.content.match(/\[Updated\]/g) || [])).toHaveLength(1);

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const request = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(request.messages[1].content).toContain(head);
    expect(request.messages[1].content).toContain(notesTail);
  });

  it('lore 가드: 원 노트 합계의 약 90%인 병합 출력은 거부한다', async () => {
    const { runCompactionAgent, ns, node, notesTail } = await setupLore('');
    const originalNotesTextLength = notesTail.split('[Updated]').slice(1)
      .reduce((sum, note) => sum + note.trim().length, 0);
    compactionResponse = 'x'.repeat(Math.ceil(originalNotesTextLength * 0.9));

    // 기본값(0.95)이 아니라 다이얼 자체를 검증 — 0.85로 고정
    expect(await runCompactionAgent(ns, { ...testConfig(), loreNoteCompactionMaxRatio: 0.85 })).toBe(0);
    expect(node._loreCompactionSkipAtNotes).toBe(3);
  });

  it('lore 가드: 비율을 1.0으로 설정하면 85% 초과 병합도 허용한다', async () => {
    const { runCompactionAgent, ns, node, notesTail } = await setupLore('');
    const originalNotesTextLength = notesTail.split('[Updated]').slice(1)
      .reduce((sum, note) => sum + note.trim().length, 0);
    const merged = 'x'.repeat(Math.ceil(originalNotesTextLength * 0.9));
    compactionResponse = merged;

    expect(await runCompactionAgent(ns, { ...testConfig(), loreNoteCompactionMaxRatio: 1.0 })).toBe(1);
    expect(node.content).toContain(merged);
  });

  it('lore 가드: 비율을 0으로 설정하면 원 노트 합계보다 긴 병합도 허용한다', async () => {
    const { runCompactionAgent, ns, node, notesTail } = await setupLore('');
    const originalNotesTextLength = notesTail.split('[Updated]').slice(1)
      .reduce((sum, note) => sum + note.trim().length, 0);
    const merged = 'x'.repeat(originalNotesTextLength + 1);
    compactionResponse = merged;

    expect(await runCompactionAgent(ns, { ...testConfig(), loreNoteCompactionMaxRatio: 0 })).toBe(1);
    expect(node.content).toContain(merged);
    expect(node._loreCompactionSkipAtNotes).toBeUndefined();
  });

  it('lore 가드: 원 노트 합계의 약 80%인 병합 출력은 허용한다', async () => {
    const { runCompactionAgent, ns, node, notesTail } = await setupLore('');
    const originalNotesTextLength = notesTail.split('[Updated]').slice(1)
      .reduce((sum, note) => sum + note.trim().length, 0);
    const merged = 'x'.repeat(Math.floor(originalNotesTextLength * 0.8));
    compactionResponse = merged;

    expect(await runCompactionAgent(ns, testConfig())).toBe(1);
    expect(node.content).toContain(merged);
  });

  it('lore 가드 거부 뒤에는 같은 노트 수의 노드를 LLM 호출 없이 건너뛴다', async () => {
    const { runCompactionAgent, ns, node, notesTail } = await setupLore('');
    const originalNotesTextLength = notesTail.split('[Updated]').slice(1)
      .reduce((sum, note) => sum + note.trim().length, 0);
    compactionResponse = 'x'.repeat(Math.ceil(originalNotesTextLength * 0.9));
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    expect(await runCompactionAgent(ns, { ...testConfig(), loreNoteCompactionMaxRatio: 0.85 })).toBe(0);
    expect(node._loreCompactionSkipAtNotes).toBe(3);
    fetchMock.mockClear();

    expect(await runCompactionAgent(ns, { ...testConfig(), loreNoteCompactionMaxRatio: 0.85 })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lore 가드 거부 뒤 새 노트가 추가되면 다시 LLM 병합을 시도한다', async () => {
    const { runCompactionAgent, ns, node, notesTail } = await setupLore('');
    const originalNotesTextLength = notesTail.split('[Updated]').slice(1)
      .reduce((sum, note) => sum + note.trim().length, 0);
    compactionResponse = 'x'.repeat(Math.ceil(originalNotesTextLength * 0.9));
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;

    expect(await runCompactionAgent(ns, { ...testConfig(), loreNoteCompactionMaxRatio: 0.85 })).toBe(0);
    node.content += '\n[Updated] 새 정정 사실.';
    compactionResponse = '새 정정 사실까지 반영한 병합 노트.';
    fetchMock.mockClear();

    expect(await runCompactionAgent(ns, { ...testConfig(), loreNoteCompactionMaxRatio: 0.85 })).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(node._loreCompactionSkipAtNotes).toBeUndefined();
  });

  it('lore 가드 cooldown 마커는 serialize와 serializeFull에 포함되지 않는다', async () => {
    const { ns, node } = await setupLore('사용되지 않는 응답');
    node._loreCompactionSkipAtNotes = 3;

    const serialized = ns.serialize() as { loreNodes: Array<Record<string, unknown>> };
    const serializedFull = ns.serializeFull() as { loreNodes: Array<Record<string, unknown>> };
    expect(serialized.loreNodes.find(entry => entry.id === node.id)).not.toHaveProperty('_loreCompactionSkipAtNotes');
    expect(serializedFull.loreNodes.find(entry => entry.id === node.id)).not.toHaveProperty('_loreCompactionSkipAtNotes');
  });

  it('lore 가드: 빈 값·[Updated] 잔존·원 노트 합계보다 긴 출력은 원문을 유지한다', async () => {
    const badOutputs = ['   \n', '병합 실패\n[Updated] 두 번째 노트', '과도하게 긴 병합 노트 '.repeat(20)];
    for (const bad of badOutputs) {
      const { runCompactionAgent, ns, node } = await setupLore(bad);
      const before = node.content;
      const n = await runCompactionAgent(ns, testConfig());
      expect(n).toBe(0);
      expect(node.content).toBe(before);
    }
  });

  it('lore LLM 예외는 전파하지 않고 원문을 유지한다', async () => {
    const { runCompactionAgent, ns, node } = await setupLore('사용되지 않는 응답');
    const before = node.content;
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error('mock lore compaction failure'));

    await expect(runCompactionAgent(ns, testConfig())).resolves.toBe(0);
    expect(node.content).toBe(before);
  });

  it('가드: ### 미시작·노트 잔존·과도 축소 출력은 거부하고 원문 유지', async () => {
    for (const bad of ['멋대로 서술', '### 서쪽 경계 측량단\n[Updated] 남음', '### 짧']) {
      const { runCompactionAgent, ns, node } = await setup(bad);
      const before = node.content;
      const n = await runCompactionAgent(ns, testConfig());
      expect(n).toBe(0);
      expect(node.content).toBe(before);
    }
  });

  it('노트가 게이트 미만이면 후보에서 제외된다', async () => {
    const { runCompactionAgent, ns } = await setup('### 무관', 2);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    const n = await runCompactionAgent(ns, testConfig());
    expect(n).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled(); // LLM 호출 자체가 없어야 함
  });
});

describe('cold start failed-chunk accounting (2026-08-31 GLM 제보)', () => {
  it('청크 실패(ok:false·throw)를 failedChunks로 집계한다', async () => {
    const ns = new OmniNodeStore();
    let call = 0;
    const deps = {
      async runNodeEditAgent() {
        call++;
        if (call === 1) throw new Error('LLM down');
        return { totalActions: 0, createdExtraLoreIds: [], affectedNodeIds: [], ok: false };
      },
    } as unknown as NodeEditAgentDeps;
    const msgs = Array.from({ length: 16 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant', content: `m${i}`,
    }));
    const r = await coldStartFromHistory(msgs, ns, { ...DEFAULT_CONFIG }, 'P', 'C', false, deps);
    expect(r.chunks).toBe(2);
    expect(r.failedChunks).toBe(2);
    expect(r.nodeCount).toBe(0);
  });
});
