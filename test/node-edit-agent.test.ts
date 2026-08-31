// Phase 4b 노드 편집 에이전트 테스트 — 모의 LLM으로 기억 형성 전 과정 검증
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OmniNodeStore } from '../src/core/node-store.js';
import {
  runNodeEditAgent, _executeSingleTool, postProcessExtraLoreMerge, _resetNodeEditCache,
  nameSimilarity, _findOrphanNodes,
} from '../src/pipeline/node-edit-agent.js';
import { DEFAULT_CONFIG, type OmniConfig } from '../src/config-store.js';
import { mulberry32 } from './fixture.js';

function textToVec(text: string, dim = 8): number[] {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = ((h << 5) - h + text.charCodeAt(i)) | 0; }
  const rand = mulberry32(h >>> 0);
  return Array.from({ length: dim }, () => rand() * 2 - 1);
}

let llmCalls = 0;
let llmResponse = '{}';
let llmRequestBodies: Array<Record<string, any>> = [];

function setupMockFetch() {
  llmCalls = 0;
  llmRequestBodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init.body));
    if (u.includes('/embeddings')) {
      const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({
        data: inputs.map((t, index) => ({ index, embedding: textToVec(t) })),
      }), { status: 200 });
    }
    llmCalls++;
    llmRequestBodies.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: llmResponse } }] }), { status: 200 });
  }));
}

function cfg(over: Partial<OmniConfig> = {}): OmniConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    customLlm: { ...DEFAULT_CONFIG.customLlm, apiUrl: 'https://mock.llm/v1/chat/completions', apiKey: 'k', model: 'mock' },
    embeddingEnabled: true,
    embeddingEndpoint: 'https://mock.emb/v1/embeddings',
    embeddingApiKey: 'k',
    maxRetries: 0,
    useGliner: false, // LLM 키워드 모드 (GLiNER 서버 없음)
    ...over,
  };
}

beforeEach(() => { setupMockFetch(); _resetNodeEditCache(); });
afterEach(() => vi.unstubAllGlobals());

describe('runNodeEditAgent', () => {
  it('LLM 응답의 노드/관계 연산을 적용한다 (tempId 해석 포함)', async () => {
    const ns = new OmniNodeStore();
    ns.currentTurn = 10;
    llmResponse = JSON.stringify({
      nodes: [
        { tempId: '_n1', op: 'create', nodeType: 'longTermMemory', name: '엘레나가 아서에게 경고한다', content: '### 경고\n- Description: 저주에 대한 경고', keywords: ['엘레나', '저주'], globalKeywords: ['위험'], importance: 4, timestamp: '2607290100' },
        { tempId: '_n3', op: 'create', nodeType: 'extraLore', name: '저주받은 검', content: '### 저주받은 검\n- Type: item', keywords: ['검'], importance: 4 },
      ],
      relationships: [
        { op: 'add', sourceId: '_n1', targetId: '_n3', type: 'related', strength: 3 },
      ],
    });

    const result = await runNodeEditAgent('대화 텍스트', [{ role: 'assistant', content: '대화 텍스트' }], cfg(), '유저', '', true, ns);

    expect(result.totalActions).toBe(3);
    expect(ns.longTermMemoryNodes.size).toBe(1);
    expect(ns.extraLoreNodes.size).toBe(1);
    expect(result.createdExtraLoreIds).toHaveLength(1);

    const ltm = [...ns.longTermMemoryNodes.values()][0];
    // related는 양방향
    const extra = [...ns.extraLoreNodes.values()][0];
    expect(ltm.relationships.some(r => r.targetId === extra.id)).toBe(true);
    expect(extra.relationships.some(r => r.targetId === ltm.id)).toBe(true);
  });

  it('캐시 히트(리롤): LLM 재호출 없이 같은 연산을 재적용한다 — 원본 버그 3호 수정 검증', async () => {
    const ns = new OmniNodeStore();
    ns.currentTurn = 5;
    llmResponse = JSON.stringify({
      nodes: [{ tempId: '_n1', op: 'create', nodeType: 'longTermMemory', name: '사건', content: '내용', keywords: ['kw'], importance: 3 }],
      relationships: [],
    });
    const config = cfg();

    const first = await runNodeEditAgent('같은 대화', [{ role: 'assistant', content: '같은 대화' }], config, '', '', true, ns);
    expect(first.totalActions).toBe(1);
    const callsAfterFirst = llmCalls;

    // 리롤 시나리오: 롤백된 스토어에 같은 턴·같은 텍스트로 재실행
    const ns2 = new OmniNodeStore();
    ns2.currentTurn = 5;
    const second = await runNodeEditAgent('같은 대화', [{ role: 'assistant', content: '같은 대화' }], config, '', '', true, ns2);
    // 원본이었다면 여기서 NODE_EDIT_CACHE_TTL ReferenceError로 실패했을 경로
    expect(second.totalActions).toBe(1);
    expect(ns2.longTermMemoryNodes.size).toBe(1);
    expect(llmCalls).toBe(callsAfterFirst); // LLM 재호출 없음
  });

  it('깨진 LLM 응답이면 아무것도 만들지 않는다', async () => {
    const ns = new OmniNodeStore();
    llmResponse = '이건 JSON이 아닙니다';
    const result = await runNodeEditAgent('텍스트', [], cfg(), '', '', true, ns);
    expect(result.totalActions).toBe(0);
    expect(ns.getNodeCount()).toBe(0);
  });

  it('thinking 블록 뒤의 유효 JSON만 파싱해 노드 연산을 적용한다', async () => {
    const ns = new OmniNodeStore();
    llmResponse = '<think>분석 중 {중괄호가 있어도 JSON으로 보지 않는다}</think>' + JSON.stringify({
      nodes: [{ tempId: '_n1', op: 'create', nodeType: 'longTermMemory', name: '사건', content: '내용', keywords: ['사건'], importance: 3 }],
      relationships: [],
    });

    const result = await runNodeEditAgent('thinking 포함 응답', [], cfg({ agentTwoPassRelationships: false }), '', '', true, ns);

    expect(result.ok).toBe(true);
    expect(result.totalActions).toBe(1);
    expect(ns.longTermMemoryNodes.size).toBe(1);
  });

  it('thinking-only 응답은 구분 로그와 함께 즉시 실패한다', async () => {
    const ns = new OmniNodeStore();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    llmResponse = '<thinking>응답 토큰을 모두 사용했다 {"nodes":[]}</thinking>';

    try {
      const result = await runNodeEditAgent('thinking-only 응답', [], cfg({ agentTwoPassRelationships: false }), '', '', true, ns);
      expect(result.ok).toBe(false);
      expect(result.totalActions).toBe(0);
      expect(ns.getNodeCount()).toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(
        'NODE EDIT AGENT: response was thinking-only — 최대 응답 토큰을 올리세요',
      ));
    } finally {
      log.mockRestore();
    }
  });

  it('reevaluations: 중요도 갱신·내용 추가·키워드 추가를 적용한다', async () => {
    const ns = new OmniNodeStore();
    ns.currentTurn = 3;
    const existing = ns.addLongTermMemoryNode({ name: '기존 사건', content: '원래 내용', keywords: ['원래'], importance: 2 });
    llmResponse = JSON.stringify({
      nodes: [{ tempId: '_x', op: 'create', nodeType: 'longTermMemory', name: '새 사건', content: 'x', keywords: ['x'], importance: 3 }],
      relationships: [],
      reevaluations: [
        { nodeId: existing.id, newImportance: 5, updatedContent: '새로 밝혀진 사실', addKeywords: ['반전'], reason: '강화됨' },
      ],
    });
    await runNodeEditAgent('대화', [], cfg(), '', '', true, ns);
    expect(existing.importance).toBe(5);
    expect(existing.content).toContain('[Updated] 새로 밝혀진 사실');
    expect(existing.keywords).toContain('반전');
  });

  it('reevaluations: 신규 필드명 newDetail도 적용된다 (updatedContent 계약 분리)', async () => {
    const ns = new OmniNodeStore();
    ns.currentTurn = 3;
    const existing = ns.addLongTermMemoryNode({ name: '기존', content: '원래 내용', keywords: ['원래'] });
    llmResponse = JSON.stringify({
      nodes: [{ tempId: '_y', op: 'create', nodeType: 'longTermMemory', name: '동반 사건', content: 'y', keywords: ['y'], importance: 3 }],
      relationships: [],
      reevaluations: [{ nodeId: existing.id, newDetail: '한 문장짜리 새 사실.', reason: 'r' }],
    });
    await runNodeEditAgent('대화', [], cfg(), '', '', true, ns);
    expect(existing.content).toContain('[Updated] 한 문장짜리 새 사실.');
    expect(existing.content).toContain('원래 내용'); // 원문 보존
  });

  it('1인 캐릭터 봇일 때만 캐릭터 extraLore 금지 규칙을 프롬프트에 넣는다', async () => {
    const config = cfg({ agentTwoPassRelationships: false });
    const rule = '- NEVER create extraLore about "엘레나". The character card is always included in the prompt separately — creating extraLore would cause duplication.';

    llmResponse = JSON.stringify({
      nodes: [{ tempId: '_n1', op: 'create', nodeType: 'longTermMemory', name: '사건', content: '내용', keywords: ['사건'], globalKeywords: ['기억'], importance: 3 }],
      relationships: [],
    });
    await runNodeEditAgent('1인 캐릭터 대화', [], config, '유저', '엘레나', false, new OmniNodeStore());
    const singleCharacterPrompt = (llmRequestBodies.at(-1)?.messages || [])
      .map((message: { content?: string }) => message.content || '').join('\n');
    expect(singleCharacterPrompt).toContain(rule);

    await runNodeEditAgent('세계관 봇 대화', [], config, '유저', '엘레나', true, new OmniNodeStore());
    const simulBotPrompt = (llmRequestBodies.at(-1)?.messages || [])
      .map((message: { content?: string }) => message.content || '').join('\n');
    expect(simulBotPrompt).not.toContain(rule);
  });

  it('entityNameLanguage가 설정된 경우에만 엔티티 이름 언어 규칙을 프롬프트에 넣는다', async () => {
    const rule = '- Write every extraLore name in Korean, regardless of the conversation\'s language.';
    llmResponse = JSON.stringify({
      nodes: [{ tempId: '_n1', op: 'create', nodeType: 'longTermMemory', name: '사건', content: '내용', keywords: ['사건'], globalKeywords: ['기억'], importance: 3 }],
      relationships: [],
    });
    const promptText = () => (llmRequestBodies.at(-1)?.messages || [])
      .map((message: { content?: string }) => message.content || '').join('\n');

    await runNodeEditAgent('언어 지정 대화', [], cfg({ agentTwoPassRelationships: false, entityNameLanguage: ' Korean ' }), '유저', '엘레나', true, new OmniNodeStore());
    expect(promptText()).toContain(rule);

    await runNodeEditAgent('언어 미지정 대화', [], cfg({ agentTwoPassRelationships: false, entityNameLanguage: '' }), '유저', '엘레나', true, new OmniNodeStore());
    expect(promptText()).not.toContain('Write every extraLore name in');
  });
});

describe('_executeSingleTool 방어 규칙', () => {
  it('lore는 수정·삭제·병합 불가', () => {
    const ns = new OmniNodeStore();
    const lore = ns.addLoreNode({ name: '정전', content: '캐논', keywords: ['캐논'] });
    expect(_executeSingleTool(ns, 'update_node', { nodeId: lore.id, content: 'x' }, 'a')).toContain('read-only');
    expect(_executeSingleTool(ns, 'delete_node', { nodeId: lore.id }, 'a')).toContain('cannot be deleted');
    const other = ns.addExtraLoreNode({ name: 'x', content: 'y', keywords: ['z'] });
    expect(_executeSingleTool(ns, 'merge_nodes', { keepId: lore.id, removeId: other.id }, 'a')).toContain('cannot be merged');
  });

  it('graph_traverse가 깊이 제한 내 연결 노드를 순회한다', () => {
    const ns = new OmniNodeStore();
    const a = ns.addLongTermMemoryNode({ name: 'A', content: 'a', keywords: ['a'] });
    const b = ns.addLongTermMemoryNode({ name: 'B', content: 'b', keywords: ['b'] });
    const c = ns.addLongTermMemoryNode({ name: 'C', content: 'c', keywords: ['c'] });
    _executeSingleTool(ns, 'add_relationship', { sourceId: a.id, targetId: b.id, type: 'causes' }, 'x');
    _executeSingleTool(ns, 'add_relationship', { sourceId: b.id, targetId: c.id, type: 'develops' }, 'x');
    const out = _executeSingleTool(ns, 'graph_traverse', { nodeId: a.id, depth: 2 }, 'x');
    expect(out).toContain(`id="${b.id}"`);
    expect(out).toContain(`id="${c.id}"`);
  });
});

describe('postProcessExtraLoreMerge (자동 승인)', () => {
  it('이름이 거의 같은 extraLore를 기존 노드로 병합한다', async () => {
    const ns = new OmniNodeStore();
    ns.currentTurn = 1;
    const existing = ns.addExtraLoreNode({ name: '붉은 용 카르마', content: '기존 설명', keywords: ['용'] });
    ns.currentTurn = 5;
    const dup = ns.addExtraLoreNode({ name: '붉은용 카르마', content: '중복 설명', keywords: ['용'] });
    expect(nameSimilarity('붉은 용 카르마', '붉은용 카르마')).toBeGreaterThan(0.7);

    await postProcessExtraLoreMerge([dup.id], cfg(), ns);

    expect(ns.getNode(dup.id)).toBeNull(); // 중복 제거됨
    const kept = ns.getNode(existing.id)!;
    expect(kept.content).toContain('기존 설명');
    expect(kept.content).toContain('중복 설명'); // 내용 흡수
  });

  it('유사하지 않으면 병합하지 않는다', async () => {
    const ns = new OmniNodeStore();
    const a = ns.addExtraLoreNode({ name: '북쪽 항구도시', content: '항구 이야기', keywords: ['항구'] });
    const b = ns.addExtraLoreNode({ name: '고대 마법서', content: '마법서 이야기', keywords: ['마법서'] });
    await postProcessExtraLoreMerge([b.id], cfg(), ns);
    expect(ns.getNode(a.id)).toBeTruthy();
    expect(ns.getNode(b.id)).toBeTruthy();
  });

  it('새 노드끼리도 비교한다 — 벌크 실행(콜드스타트)의 청크 간 중복', async () => {
    const ns = new OmniNodeStore();
    ns.currentTurn = 0;
    const chunk1 = ns.addExtraLoreNode({ name: '수정 등대', content: '배치 1 설명', keywords: ['등대'], creationTurn: 0 });
    ns.currentTurn = 8;
    const chunk2 = ns.addExtraLoreNode({ name: '수정등대', content: '배치 2 설명', keywords: ['등대'], creationTurn: 8 });
    // 콜드스타트처럼 둘 다 '새 노드' 목록으로 전달 — 기존 노드는 없음
    await postProcessExtraLoreMerge([chunk1.id, chunk2.id], cfg(), ns);
    expect(ns.getNode(chunk2.id)).toBeNull(); // 나중 것이 흡수됨
    const kept = ns.getNode(chunk1.id)!;
    expect(kept.content).toContain('배치 1 설명');
    expect(kept.content).toContain('배치 2 설명');
  });
});

describe('_findOrphanNodes', () => {
  it('관계가 하나도 없는 활성 노드만 찾는다', () => {
    const ns = new OmniNodeStore();
    const a = ns.addLongTermMemoryNode({ name: 'A', content: 'a', keywords: ['a'] });
    const b = ns.addLongTermMemoryNode({ name: 'B', content: 'b', keywords: ['b'] });
    const orphan = ns.addLongTermMemoryNode({ name: '외톨이', content: 'o', keywords: ['o'] });
    _executeSingleTool(ns, 'add_relationship', { sourceId: a.id, targetId: b.id, type: 'related' }, 'x');
    const orphans = _findOrphanNodes(ns);
    expect(orphans.map(n => n.id)).toEqual([orphan.id]);
  });
});

describe('D2 캡/2패스 프롬프트', () => {
  it('GLiNER 엔드포인트가 비어 있으면 LLM 키워드 폴백 프롬프트를 사용한다', async () => {
    const { getDefaultNodeEditBlocks } = await import('../src/pipeline/node-edit-agent.js');
    const fallback = getDefaultNodeEditBlocks({ ...cfg(), useGliner: true, glinerEndpoint: '  ' } as any);
    const fallbackPrompt = fallback.map(b => b.content).join('\n');
    expect(fallbackPrompt).toContain('Dual-level keywords');
    expect(fallbackPrompt).toContain('"keywords": ["k1","k2"]');
    expect(fallbackPrompt).not.toContain('Keywords are extracted automatically');

    const configured = getDefaultNodeEditBlocks({ ...cfg(), useGliner: true, glinerEndpoint: 'http://gliner.test/predict' } as any);
    const configuredPrompt = configured.map(b => b.content).join('\n');
    expect(configuredPrompt).toContain('Keywords are extracted automatically');
    expect(configuredPrompt).not.toContain('"keywords": ["k1","k2"]');
  });

  it('ltmMaxNodesPerBatch 설정 시 예산 지시로, 0이면 원본 폭주 지시 유지', async () => {
    const { getDefaultNodeEditBlocks } = await import('../src/pipeline/node-edit-agent.js');
    const capped = getDefaultNodeEditBlocks({ ...cfg(), ltmMaxNodesPerBatch: 32 } as any);
    const sysCapped = capped.map(b => b.content).join('\n');
    expect(sysCapped).toContain('AT MOST 32 nodes');
    expect(sysCapped).toContain('at most 32 entries'); // 하드 리마인더
    expect(sysCapped).not.toContain('create 8 separate LTM nodes');

    const unlimited = getDefaultNodeEditBlocks({ ...cfg(), ltmMaxNodesPerBatch: 0 } as any);
    const sysUnlimited = unlimited.map(b => b.content).join('\n');
    expect(sysUnlimited).toContain('create 8 separate LTM nodes'); // 원본 문구
    expect(sysUnlimited).not.toContain('AT MOST');
  });

  it('2패스 모드면 프롬프트에서 관계 출력 지시가 빠진다', async () => {
    const { getDefaultNodeEditBlocks } = await import('../src/pipeline/node-edit-agent.js');
    const twoPass = getDefaultNodeEditBlocks({ ...cfg(), agentTwoPassRelationships: true } as any);
    const sys = twoPass.map(b => b.content).join('\n');
    expect(sys).toContain('Do NOT output a "relationships" array');
    expect(sys).not.toContain('"relationships": [\n    { "op": "add"'); // 예시에서도 제거

    const single = getDefaultNodeEditBlocks({ ...cfg(), agentTwoPassRelationships: false } as any);
    const sysSingle = single.map(b => b.content).join('\n');
    expect(sysSingle).toContain('Rich relationships');
  });
});
