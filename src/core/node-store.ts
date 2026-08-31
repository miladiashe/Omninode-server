// 원본 omninode-beta21-fix5-selffix.js MODULE 2 (L1173–2078)의 이식.
// 로직은 원본과 동일하게 유지한다 (test/node-store.diff.test.ts의 차분 테스트로 검증).
// 원본과의 의도적 차이:
//  - updateUtilityScoresLLM: 전역 callLLM/DEFAULT_PROMPTS 대신 deps 주입 (Phase 3에서 연결)

import {
  LOG_PREFIX, _dbg, generateId, contentHash, cosineSimilarity, robustParseJSON,
  normalizeRelType, defaultDirectionForType, clampStrength, NODE_IMPORTANCE_RANGE,
  _normalizeCompactTs,
} from './util.js';

export type NodeType = 'lore' | 'extraLore' | 'communitySummary' | 'longTermMemory';

export interface NodeRelationship {
  targetId: string;
  direction: string;
  type: string;
  strength: number;
  createdAtTurn: number;
}

export interface OmniNode {
  id: string;
  type: NodeType;
  name: string;
  content: string;
  keywords: string[];
  globalKeywords: string[];
  importance: number;
  activationScore: number;
  utilityScore: number;
  creationTurn: number;
  relationships: NodeRelationship[];
  embedding: Float32Array | null;
  zeroScoreTurns: number;
  highScoreTurns: number;
  alwaysActive: boolean;
  archived: boolean;
  excluded: boolean;
  timestamp: string | null;
  // 선택 필드 (타입별/기능별)
  sourceNodeIds?: string[];
  parentLoreId?: string;
  worldSim?: boolean;
  _isChapterSummary?: boolean;
  _chapterRange?: unknown;
  communityId?: string;
  level?: number;
  memberNodeIds?: string[];
  parentCommunityId?: string | null;
  // 진화 트랙 D2: 이 기억이 다루는 원문 로그 구간 [start..end] (allChatMessages 인덱스 공간).
  // 주입 시 messages 테이블에서 발췌 조립에 사용. LLM에게 묻지 않고 배치 범위로 스탬핑
  // (beta27 S2 지뢰 회피 — creationTurn은 계속 "현재 턴"으로 노화/최신성 담당)
  sourceTurnStart?: number;
  sourceTurnEnd?: number;
  // RAM-only lore compaction retry cooldown; a restart clears it and permits one retry.
  _loreCompactionSkipAtNotes?: number;
}

export interface MemrlEntry { useful: boolean; confidence: number; turn: number }

export interface LlmDeps {
  callLLM: (messages: Array<{ role: string; content: string }>, opts: Record<string, unknown>) => Promise<string | null>;
  defaultPrompts: { memrlSystem: string; memrlUserTemplate: string };
}

// D2 캡 설정화 (사용자 결정 2026-08-01: "3000자는 부족" — 영어 기준 1000단어 미만.
// 주입량은 토큰 예산이 통제하므로 캡은 후하게. 재평가 [Updated] 누적 시 꼬리 창에
// 밀려 원 서술이 증발하는 문제의 완화이기도 함). 0 = 무제한.
// config.maxNodeContentChars → setMaxNodeContentChars()로 주입 (기본 12000).
// serialize()가 (원본 바이트 호환 때문에) 생략하는 선택 필드 — serializeFull()과
// 저장 계층(chat-state-repo EXTRA_FIELDS)이 라이브 노드에서 보충하는 대상의 단일 정의
export const NODE_EXTRA_FIELDS = [
  'sourceNodeIds', 'parentLoreId', 'worldSim', '_isChapterSummary', '_chapterRange',
  'communityId', 'level', 'memberNodeIds', 'parentCommunityId',
  'sourceTurnStart', 'sourceTurnEnd',
] as const;

export let MAX_NODE_CONTENT_CHARS = 12000;
export function setMaxNodeContentChars(v: unknown) {
  const n = Number(v);
  MAX_NODE_CONTENT_CHARS = Number.isFinite(n) && n >= 0 ? (n === 0 ? Infinity : n) : 12000;
}

export function createNode({
  type,
  content,
  keywords = [],
  globalKeywords = [],
  importance = 5,
  activationScore = 50.0,
  utilityScore = 50.0,
  creationTurn = 0,
  relationships = [],
  alwaysActive = false,
  archived = false,
  excluded = false,
  name = '',
  timestamp = null,
}: {
  type: NodeType;
  content?: string | null;
  keywords?: string[];
  globalKeywords?: string[] | null;
  importance?: number;
  activationScore?: number;
  utilityScore?: number;
  creationTurn?: number;
  relationships?: Array<Partial<NodeRelationship> & { targetId: string }>;
  alwaysActive?: boolean;
  archived?: boolean;
  excluded?: boolean;
  name?: string;
  timestamp?: unknown;
}): OmniNode {
  const prefixMap: Record<NodeType, string> = { lore: 'ln', extraLore: 'eln', communitySummary: 'csn', longTermMemory: 'ltm' };
  // 의도적 차이 (D2, 사용자 결정 2026-08-01): 원본은 모든 타입에 꼬리 3000자 유지(L1206) —
  // 로어는 원전이라 잘리면 정보 유실이고(실측: 제목·기본정보가 단어 중간에서 증발),
  // 주입량은 어차피 토큰 예산이 통제하므로 로어는 캡 미적용(전문 저장).
  // 나머지 타입(LTM/커뮤니티)은 원본대로 꼬리 유지.
  const trimmedContent = type === 'lore'
    ? (content || '')
    : (content && content.length > MAX_NODE_CONTENT_CHARS
      ? content.slice(content.length - MAX_NODE_CONTENT_CHARS)
      : (content || ''));
  return {
    id: generateId(prefixMap[type] || 'ltm'),
    type,
    name: name || '',
    content: trimmedContent,
    keywords: [...keywords],
    globalKeywords: [...(globalKeywords || [])],
    importance: Math.max(1, Math.min(5, importance)),
    activationScore: Math.max(0.0, Math.min(100.0, activationScore)),
    utilityScore: Math.max(0.0, Math.min(100.0, utilityScore)),
    creationTurn,
    relationships: relationships.map(r => {
      const t = normalizeRelType(r.type);
      return { targetId: r.targetId, direction: r.direction || defaultDirectionForType(t), type: t, strength: clampStrength(r.strength ?? 3), createdAtTurn: r.createdAtTurn ?? creationTurn };
    }),
    embedding: null,
    zeroScoreTurns: 0,
    highScoreTurns: 0,
    alwaysActive: !!alwaysActive,
    archived: !!archived,
    excluded: !!excluded,
    timestamp: _normalizeCompactTs(timestamp),
  };
}

export class OmniNodeStore {
  loreNodes = new Map<string, OmniNode>();
  extraLoreNodes = new Map<string, OmniNode>();
  communityNodes = new Map<string, OmniNode>(); // communitySummary nodes (replaces loreStateNodes)
  longTermMemoryNodes = new Map<string, OmniNode>();
  atlasMd = ''; // "front page" — top-level knowledge summary for keyword generation
  currentTurn = 0;
  embeddingCache = new Map<string, { hash: string; embedding: Float32Array | null }>();
  textEmbeddingCache = new Map<string, Float32Array>();
  hydeCache = new Map<string, { text: string; embedding: Float32Array | null }>();
  memrlCache = new Map<string, MemrlEntry>();
  _lastCommunityTurn = 0;
  _nodesSinceLastCommunity = 0;
  _lastConvertedMsgCount = 0; // legacy (kept for deserialization compat)
  _ltmConvertedUpTo = 0; // index-based watermark: chat messages [0.._ltmConvertedUpTo) have been converted to LTM
  // D2 (beta27 L18545 방향): 워터마크 직전 메시지의 내용 해시 — 편집/삭제로 인덱스가
  // 어긋났는지 감지용. 검증은 pipeline에서 (±5 재탐색, 미발견 시 유지+경고 — beta27의
  // "전진 스킵"(S6 결함)은 채택하지 않음)
  _ltmWatermarkHash = '';
  _lastChapterTurn = 0;
  // Caches (invalidated on mutation)
  _allNodesCache: OmniNode[] | null = null;
  _activeNodesCache: OmniNode[] | null = null;
  _relCount = -1;
  _reverseRelIndex = new Map<string, Set<string>>(); // targetId → Set<sourceNodeId>

  _invalidateNodeCaches() {
    this._allNodesCache = null;
    this._activeNodesCache = null;
    this._relCount = -1;
  }

  _rebuildReverseRelIndex() {
    this._reverseRelIndex.clear();
    for (const node of this.getAllNodes()) {
      for (const rel of (node.relationships || [])) {
        let set = this._reverseRelIndex.get(rel.targetId);
        if (!set) { set = new Set(); this._reverseRelIndex.set(rel.targetId, set); }
        set.add(node.id);
      }
    }
  }

  _addToReverseIndex(sourceId: string, rels: NodeRelationship[] | undefined) {
    for (const rel of (rels || [])) {
      let set = this._reverseRelIndex.get(rel.targetId);
      if (!set) { set = new Set(); this._reverseRelIndex.set(rel.targetId, set); }
      set.add(sourceId);
    }
  }

  _removeFromReverseIndex(sourceId: string, rels: NodeRelationship[] | undefined) {
    for (const rel of (rels || [])) {
      const set = this._reverseRelIndex.get(rel.targetId);
      if (set) { set.delete(sourceId); if (set.size === 0) this._reverseRelIndex.delete(rel.targetId); }
    }
  }

  // ── CRUD: Lore Nodes ──

  addLoreNode({ name, content, keywords, creationTurn, relationships = [], alwaysActive = false }: {
    name?: string; content?: string; keywords: string[]; creationTurn?: number;
    relationships?: Array<Partial<NodeRelationship> & { targetId: string }>; alwaysActive?: boolean;
  }): OmniNode {
    const node = createNode({
      type: 'lore',
      name,
      content,
      keywords,
      importance: 5,
      creationTurn: creationTurn ?? this.currentTurn,
      relationships,
      alwaysActive,
    });
    this.loreNodes.set(node.id, node);
    this._invalidateNodeCaches();
    this._addToReverseIndex(node.id, node.relationships);
    console.log(`${LOG_PREFIX} Added lore node: ${node.id} (${keywords.join(', ')})`);
    return node;
  }

  updateLoreNode(id: string, updates: Record<string, unknown>) { return this.updateNode(id, updates); }
  removeLoreNode(id: string) { return this.removeNode(id); }

  // ── CRUD: Extra Lore Nodes ──

  addExtraLoreNode({ name, content, keywords, importance = 4, activationScore = 50.0, creationTurn, relationships = [] }: {
    name?: string; content?: string; keywords: string[]; importance?: number; activationScore?: number;
    creationTurn?: number; relationships?: Array<Partial<NodeRelationship> & { targetId: string }>;
  }): OmniNode {
    const node = createNode({
      type: 'extraLore',
      name,
      content,
      keywords,
      importance: Math.max(3, Math.min(5, importance)),
      activationScore,
      creationTurn: creationTurn ?? this.currentTurn,
      relationships,
    });
    this.extraLoreNodes.set(node.id, node);
    this._invalidateNodeCaches();
    this._addToReverseIndex(node.id, node.relationships);
    _dbg(`${LOG_PREFIX} Added extra lore node: ${node.id} (importance=${node.importance})`);
    return node;
  }

  updateExtraLoreNode(id: string, updates: Record<string, unknown>) { return this.updateNode(id, updates); }
  removeExtraLoreNode(id: string) { return this.removeNode(id); }

  // ── CRUD: Long-term Memory Nodes ──

  addLongTermMemoryNode({ name, content, keywords, globalKeywords = [], importance = 3, activationScore = 30.0, creationTurn, relationships = [], timestamp = null }: {
    name?: string; content?: string; keywords: string[]; globalKeywords?: string[]; importance?: number; activationScore?: number;
    creationTurn?: number; relationships?: Array<Partial<NodeRelationship> & { targetId: string }>; timestamp?: unknown;
  }): OmniNode {
    const node = createNode({
      type: 'longTermMemory',
      name,
      content,
      keywords,
      globalKeywords,
      importance: Math.max(1, Math.min(5, importance)),
      activationScore,
      creationTurn: creationTurn ?? this.currentTurn,
      relationships,
      timestamp,
    });
    this.longTermMemoryNodes.set(node.id, node);
    this._invalidateNodeCaches();
    this._addToReverseIndex(node.id, node.relationships);
    _dbg(`${LOG_PREFIX} Added LTM node: ${node.id} (importance=${node.importance})`);
    return node;
  }

  updateLongTermMemoryNode(id: string, updates: Record<string, unknown>) { return this.updateNode(id, updates); }
  removeLongTermMemoryNode(id: string) { return this.removeNode(id); }

  // ── CRUD: Community Summary Nodes (GraphRAG hierarchical summaries) ──

  addCommunityNode({ name, content, keywords, importance = 5, activationScore = 50.0, creationTurn, relationships = [], timestamp = null, communityId = '', level = 0, memberNodeIds = [], parentCommunityId = null }: {
    name?: string; content?: string; keywords: string[]; importance?: number; activationScore?: number;
    creationTurn?: number; relationships?: Array<Partial<NodeRelationship> & { targetId: string }>; timestamp?: unknown;
    communityId?: string; level?: number; memberNodeIds?: string[]; parentCommunityId?: string | null;
  }): OmniNode {
    const node = createNode({
      type: 'communitySummary',
      name,
      content,
      keywords,
      importance: Math.max(3, Math.min(5, importance)),
      activationScore,
      creationTurn: creationTurn ?? this.currentTurn,
      relationships,
      timestamp,
    });
    node.communityId = communityId || node.id;
    node.level = level;
    node.memberNodeIds = memberNodeIds;
    node.parentCommunityId = parentCommunityId;
    this.communityNodes.set(node.id, node);
    this._invalidateNodeCaches();
    this._addToReverseIndex(node.id, node.relationships);
    _dbg(`${LOG_PREFIX} Added communitySummary: ${node.id} (level=${level}, members=${memberNodeIds.length})`);
    return node;
  }

  updateCommunityNode(id: string, updates: Record<string, unknown>) { return this.updateNode(id, updates); }
  removeCommunityNode(id: string) { return this.removeNode(id); }

  // ── Generic Accessors ──

  _getNodeMaps(): Array<Map<string, OmniNode>> {
    return [this.loreNodes, this.extraLoreNodes, this.communityNodes, this.longTermMemoryNodes];
  }

  updateNode(id: string, updates: Record<string, unknown>): OmniNode | null {
    const node = this.getNode(id);
    if (!node) return null;
    if (updates.name !== undefined) node.name = updates.name as string;
    if (updates.content !== undefined) node.content = updates.content as string;
    if (updates.keywords !== undefined) node.keywords = [...(updates.keywords as string[])];
    if (updates.relationships !== undefined) {
      this._removeFromReverseIndex(id, node.relationships);
      node.relationships = updates.relationships as NodeRelationship[];
      this._addToReverseIndex(id, node.relationships);
    }
    const imp = NODE_IMPORTANCE_RANGE[node.type];
    if (imp && updates.importance !== undefined) {
      node.importance = Math.max(imp[0], Math.min(imp[1], updates.importance as number));
    }
    if (updates.activationScore !== undefined && node.type !== 'lore') {
      node.activationScore = Math.max(0.0, Math.min(100.0, updates.activationScore as number));
    }
    if (updates.timestamp !== undefined && (node.type === 'longTermMemory' || node.type === 'communitySummary')) {
      node.timestamp = _normalizeCompactTs(updates.timestamp);
    }
    if (node.type === 'communitySummary') {
      if (updates.memberNodeIds !== undefined) node.memberNodeIds = [...(updates.memberNodeIds as string[])];
      if (updates.level !== undefined) node.level = updates.level as number;
    }
    if (updates.archived !== undefined) this._invalidateNodeCaches();
    return node;
  }

  removeNode(id: string): boolean {
    for (const map of this._getNodeMaps()) {
      const node = map.get(id);
      if (node) {
        map.delete(id);
        this._invalidateNodeCaches();
        this.embeddingCache.delete(id);
        if (node.content) {
          const hash = contentHash(node.content);
          this.textEmbeddingCache.delete(hash);
          this.hydeCache.delete(hash);
        }
        this._removeFromReverseIndex(id, node.relationships);
        this._cleanRelationshipsTargeting(id);
        return true;
      }
    }
    return false;
  }

  getNode(id: string): OmniNode | null {
    return this.loreNodes.get(id)
      || this.extraLoreNodes.get(id)
      || this.communityNodes.get(id)
      || this.longTermMemoryNodes.get(id)
      || null;
  }

  getAllNodes(): OmniNode[] {
    if (this._allNodesCache) return this._allNodesCache;
    const all: OmniNode[] = [];
    for (const node of this.loreNodes.values()) all.push(node);
    for (const node of this.extraLoreNodes.values()) all.push(node);
    for (const node of this.communityNodes.values()) all.push(node);
    for (const node of this.longTermMemoryNodes.values()) all.push(node);
    this._allNodesCache = all;
    return all;
  }

  getActiveNodes(): OmniNode[] {
    if (this._activeNodesCache) return this._activeNodesCache;
    this._activeNodesCache = this.getAllNodes().filter(n => !n.archived);
    return this._activeNodesCache;
  }

  getRelationshipCount(): number {
    if (this._relCount >= 0) return this._relCount;
    let c = 0;
    for (const n of this.getAllNodes()) c += (n.relationships || []).length;
    this._relCount = c;
    return c;
  }

  getNodeCount(): number {
    return this.loreNodes.size + this.extraLoreNodes.size + this.communityNodes.size + this.longTermMemoryNodes.size;
  }

  isEmpty(): boolean {
    return this.getNodeCount() === 0;
  }

  // ── Keyword Search (Dual-level: local + global) ──

  findByKeyword(keyword: string, includeGlobal = true): Array<{ node: OmniNode; level: 'local' | 'global' }> {
    const kw = keyword.toLowerCase().trim();
    const results: Array<{ node: OmniNode; level: 'local' | 'global' }> = [];
    for (const node of this.getActiveNodes()) {
      let matched = false;
      for (const nodeKw of node.keywords) {
        if (nodeKw.toLowerCase().includes(kw) || kw.includes(nodeKw.toLowerCase())) {
          results.push({ node, level: 'local' });
          matched = true;
          break;
        }
      }
      if (!matched && includeGlobal && node.globalKeywords) {
        for (const gk of node.globalKeywords) {
          if (gk.toLowerCase().includes(kw) || kw.includes(gk.toLowerCase())) {
            results.push({ node, level: 'global' });
            break;
          }
        }
      }
    }
    return results;
  }

  // ── Node Lifecycle: Tick ──

  tick(recentKeywords: string[] = []): { deleted: string[]; promoted: string[]; unarchived: string[] } {
    const promoted: string[] = [];
    const unarchived: string[] = [];

    // Un-archive extraLore nodes whose keywords match recent context
    if (recentKeywords.length > 0) {
      const kwSet = new Set(recentKeywords.map(k => k.toLowerCase()));
      for (const [id, node] of this.extraLoreNodes) {
        if (!node.archived) continue;
        const hit = node.keywords.some(k => kwSet.has(k.toLowerCase())) ||
          (node.globalKeywords && node.globalKeywords.some(k => kwSet.has(k.toLowerCase())));
        if (hit) {
          node.archived = false;
          node.zeroScoreTurns = 0;
          node.activationScore = 30.0;
          unarchived.push(id);
        }
      }
      if (unarchived.length > 0) console.log(`${LOG_PREFIX} Un-archived ${unarchived.length} extra lore nodes via keyword match`);
    }

    for (const [id, node] of this.extraLoreNodes) {
      if (node.archived) continue;
      // Track zero-score turns (EMA approaches 0 asymptotically, so use < 1.0)
      if (node.activationScore < 1.0) {
        node.zeroScoreTurns = (node.zeroScoreTurns || 0) + 1;
      } else {
        node.zeroScoreTurns = 0;
      }

      // Track high-score turns
      if (node.activationScore >= 90.0) {
        node.highScoreTurns = (node.highScoreTurns || 0) + 1;
      } else {
        node.highScoreTurns = 0;
      }

      // Auto-archive: score=0 for 30 consecutive turns → archive instead of delete
      if (node.zeroScoreTurns >= 30 && !node.archived) {
        node.archived = true;
        node.zeroScoreTurns = 0;
        console.log(`${LOG_PREFIX} Auto-archived extra lore node ${id} (score=0 for 30 turns)`);
        continue;
      }

      // Promote: score>=90 for 24 consecutive turns → becomes lore node
      if (node.highScoreTurns >= 24) {
        this.extraLoreNodes.delete(id);
        // 원본 버그 수정 (beta21~28.1 공통, 2026-08-04 실측): 원본은 name/globalKeywords/
        // timestamp를 안 넘겨 승격된 로어가 "(이름없음)"이 됨 — 원작자 제보 목록 대상
        const loreNode = createNode({
          type: 'lore',
          name: node.name,
          content: node.content,
          keywords: node.keywords,
          globalKeywords: node.globalKeywords,
          importance: 5,
          activationScore: 50.0,
          creationTurn: this.currentTurn,
          relationships: node.relationships,
          timestamp: node.timestamp ?? null,
        });
        // Preserve original ID so relationships still work
        loreNode.id = id;
        loreNode.embedding = node.embedding;
        this.loreNodes.set(id, loreNode);
        promoted.push(id);
        console.log(`${LOG_PREFIX} Promoted extra lore node ${id} to lore node (score>=90 for 24 turns)`);
      }
    }

    if (promoted.length > 0 || unarchived.length > 0) {
      console.log(`${LOG_PREFIX} Tick: ${promoted.length} promoted, ${unarchived.length} un-archived`);
    }
    return { deleted: [], promoted, unarchived };
  }

  // ── Activation Score Updates ──

  updateActivationScores(injectedIds: Iterable<string>) {
    const injectedSet = new Set(injectedIds);
    const ALPHA = 0.2;

    for (const node of this.getActiveNodes()) {
      const target = injectedSet.has(node.id) ? 100 : 0;
      node.activationScore = ALPHA * target + (1 - ALPHA) * node.activationScore;
    }
  }

  // ── MemRL Utility Score Updates ──
  // Original embedding-based: compares AI response embedding with each
  // previously-injected node's embedding.
  // LLM-based: asks auxiliary LLM to judge usefulness in batches.

  updateUtilityScores(prevInjectedIds: Set<string> | null, responseEmbedding: Float32Array | null) {
    if (!responseEmbedding || !prevInjectedIds || prevInjectedIds.size === 0) return;

    const SIMILARITY_HIGH = 0.35;
    const SIMILARITY_LOW = 0.15;
    const DELTA_UP = 1.5;
    const DELTA_DOWN = 1.0;

    for (const nodeId of prevInjectedIds) {
      const node = this.getNode(nodeId);
      if (!node || node.archived) continue;
      if (!node.embedding) continue;

      const sim = cosineSimilarity(node.embedding, responseEmbedding);
      if (sim >= SIMILARITY_HIGH) {
        node.utilityScore = Math.min(100.0, node.utilityScore + DELTA_UP);
      } else if (sim < SIMILARITY_LOW) {
        node.utilityScore = Math.max(0.0, node.utilityScore - DELTA_DOWN);
      }
    }
  }

  // LLM-based MemRL: asks aux model to judge node usefulness
  async updateUtilityScoresLLM(prevInjectedIds: Set<string> | null, responseText: string, config: Record<string, unknown>, deps: LlmDeps) {
    if (!prevInjectedIds || prevInjectedIds.size === 0 || !responseText) return;

    const BATCH_SIZE = 10;
    const MEMRL_TTL = 10; // cache TTL in turns
    const responseHash = contentHash(responseText);
    const nodeIds = [...prevInjectedIds];
    const nodesToBatch: OmniNode[] = [];
    const cachedResults = new Map<string, MemrlEntry>();

    // Check memrlCache first
    for (const nodeId of nodeIds) {
      const cacheKey = `${nodeId}_${responseHash}`;
      const cached = this.memrlCache.get(cacheKey);
      if (cached && (this.currentTurn - cached.turn) < MEMRL_TTL) {
        cachedResults.set(nodeId, cached);
      } else {
        const node = this.getNode(nodeId);
        if (node && !node.archived) nodesToBatch.push(node);
      }
    }

    if (cachedResults.size > 0) {
      _dbg(`${LOG_PREFIX} MemRL cache: ${cachedResults.size}/${nodeIds.length} hits`);
    }

    // Apply cached results
    for (const [nodeId, cached] of cachedResults) {
      const node = this.getNode(nodeId);
      if (!node) continue;
      this._applyMemrlDelta(node, cached.useful, cached.confidence);
    }

    // Batch LLM queries for uncached nodes
    for (let i = 0; i < nodesToBatch.length; i += BATCH_SIZE) {
      const batch = nodesToBatch.slice(i, i + BATCH_SIZE);
      const nodeDescriptions = batch.map((n, idx) => `${idx + 1}. [${n.id}] "${n.name}": ${(n.content || '').slice(0, 200)}`).join('\n');
      const userTemplate = (config.memrlUserPromptTemplate as string) || deps.defaultPrompts.memrlUserTemplate;
      const prompt = userTemplate
        .replace('{{responseExcerpt}}', responseText.slice(0, 500))
        .replace('{{nodeDescriptions}}', nodeDescriptions);

    try {
        const sysPrompt = (config.memrlSystemPrompt as string) || deps.defaultPrompts.memrlSystem;
        const result = await deps.callLLM([
          { role: 'system', content: sysPrompt },
          { role: 'user', content: prompt },
        ], { _config: config, maxTokens: 300, _useAux: true, _label: 'node keywords' });

        const parsed = robustParseJSON(result);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const node = this.getNode(item.nodeId);
            if (!node) continue;
            const useful = !!item.useful;
            const confidence = Math.max(0, Math.min(1, item.confidence || 0.5));
            this._applyMemrlDelta(node, useful, confidence);
            // Cache result
            const cacheKey = `${item.nodeId}_${responseHash}`;
            this.memrlCache.set(cacheKey, { useful, confidence, turn: this.currentTurn });
          }
        }
      } catch (err) {
        console.log(`${LOG_PREFIX} MemRL LLM batch failed, skipping: ${(err as Error).message || err}`);
      }
    }

    // Evict stale memrlCache entries
    for (const [key, entry] of this.memrlCache) {
      if ((this.currentTurn - entry.turn) >= MEMRL_TTL) {
        this.memrlCache.delete(key);
      }
    }
  }

  _applyMemrlDelta(node: OmniNode, useful: boolean, confidence: number) {
    if (useful && confidence >= 0.7) {
      node.utilityScore = Math.min(100.0, node.utilityScore + 2.0);
    } else if (useful) {
      node.utilityScore = Math.min(100.0, node.utilityScore + 1.0);
    } else if (!useful && confidence >= 0.7) {
      node.utilityScore = Math.max(0.0, node.utilityScore - 1.5);
    } else {
      node.utilityScore = Math.max(0.0, node.utilityScore - 0.5);
    }
  }

  // ── Relationship Cleanup ──

  _cleanRelationshipsTargeting(removedId: string) {
    const sources = this._reverseRelIndex.get(removedId);
    if (sources && sources.size > 0) {
      for (const srcId of sources) {
        const node = this.getNode(srcId);
        if (node) node.relationships = node.relationships.filter(r => r.targetId !== removedId);
      }
      this._reverseRelIndex.delete(removedId);
    }
  }

  // ── Serialization ──

  serialize(): Record<string, unknown> {
    const mapToArr = (map: Map<string, OmniNode>) => {
      const arr: Array<Record<string, unknown>> = [];
      for (const [, node] of map) {
        const entry: Record<string, unknown> = {
          id: node.id,
          type: node.type,
          name: node.name || '',
          content: node.content,
          keywords: [...(node.keywords || [])],
          globalKeywords: [...(node.globalKeywords || [])],
          importance: node.importance,
          activationScore: node.activationScore,
          utilityScore: node.utilityScore ?? 50.0,
          creationTurn: node.creationTurn,
          relationships: (node.relationships || []).map(r => ({ ...r })),
          zeroScoreTurns: node.zeroScoreTurns || 0,
          highScoreTurns: node.highScoreTurns || 0,
          alwaysActive: node.alwaysActive || false,
          archived: node.archived || false,
          excluded: node.excluded || false,
          timestamp: node.timestamp ?? null,
        };
        if (node.sourceNodeIds) entry.sourceNodeIds = [...node.sourceNodeIds];
        if (node.parentLoreId) entry.parentLoreId = node.parentLoreId;
        if (node.worldSim) entry.worldSim = true;
        if (node._isChapterSummary) { entry._isChapterSummary = true; entry._chapterRange = node._chapterRange; }
        arr.push(entry);
      }
      return arr;
    };

    return {
      version: 1,
      currentTurn: this.currentTurn,
      atlasMd: this.atlasMd,
      loreNodes: mapToArr(this.loreNodes),
      extraLoreNodes: mapToArr(this.extraLoreNodes),
      communityNodes: mapToArr(this.communityNodes),
      longTermMemoryNodes: mapToArr(this.longTermMemoryNodes),
      // embeddingCache, textEmbeddingCache, hydeCache stored separately (per-chat)
      memrlCache: this._serializeMemrlCache(),
      lastCommunityTurn: this._lastCommunityTurn,
      nodesSinceLastCommunity: this._nodesSinceLastCommunity,
      lastConvertedMsgCount: this._lastConvertedMsgCount, // legacy compat
      ltmConvertedUpTo: this._ltmConvertedUpTo,
      // D2: 값이 있을 때만 포함 — 원본 차분 테스트(바이트 비교)와의 호환 유지
      ...(this._ltmWatermarkHash ? { ltmWatermarkHash: this._ltmWatermarkHash } : {}),
      lastChapterTurn: this._lastChapterTurn || 0,
    };
  }

  // serialize()는 원본 바이트 호환을 위해 일부 선택 필드를 생략한다 (원본의 커뮤니티 필드
  // 유실 버그 — HANDOFF §H, 28.1까지 미해결 — 을 그대로 반영한 출력). 저장·스냅샷처럼
  // "복원 가능해야 하는" 소비자는 이 메서드로 라이브 노드의 보충 필드까지 실어야 한다.
  serializeFull() {
    const data = this.serialize();
    for (const key of ['loreNodes', 'extraLoreNodes', 'communityNodes', 'longTermMemoryNodes'] as const) {
      for (const entry of (data as Record<string, unknown>)[key] as Array<Record<string, unknown>>) {
        const live = this.getNode(entry.id as string) as unknown as Record<string, unknown> | null;
        if (!live) continue;
        for (const k of NODE_EXTRA_FIELDS) {
          if (live[k] !== undefined) entry[k] = live[k];
        }
      }
    }
    return data;
  }

  serializeEmbeddingCaches() {
    return {
      embeddingCache: this._serializeEmbeddingCache(),
      textEmbeddingCache: this._serializeTextEmbeddingCache(),
      hydeCache: this._serializeHydeCache(),
    };
  }

  // Base64 ↔ Float32Array helpers (~2.25x smaller than JSON number arrays)
  static _b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  static _b64Lookup = (() => {
    const lut = new Uint8Array(128);
    const chars = OmniNodeStore._b64Chars;
    for (let i = 0; i < chars.length; i++) lut[chars.charCodeAt(i)] = i;
    return lut;
  })();

  static _f32ToBase64(f32: Float32Array): string {
    const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    const chars = OmniNodeStore._b64Chars;
    const len = bytes.length;
    const fullTriples = (len / 3) | 0;
    const remainder = len - fullTriples * 3;
    const parts = new Array(fullTriples + (remainder ? 1 : 0));
    let pi = 0;
    for (let i = 0, end = fullTriples * 3; i < end; i += 3) {
      const b1 = bytes[i], b2 = bytes[i + 1], b3 = bytes[i + 2];
      parts[pi++] = chars[(b1 >> 2) & 63] + chars[((b1 & 3) << 4) | ((b2 >> 4) & 15)] +
        chars[((b2 & 15) << 2) | ((b3 >> 6) & 3)] + chars[b3 & 63];
    }
    if (remainder === 1) {
      const b1 = bytes[len - 1];
      parts[pi] = chars[(b1 >> 2) & 63] + chars[(b1 & 3) << 4] + '==';
    } else if (remainder === 2) {
      const b1 = bytes[len - 2], b2 = bytes[len - 1];
      parts[pi] = chars[(b1 >> 2) & 63] + chars[((b1 & 3) << 4) | ((b2 >> 4) & 15)] +
        chars[(b2 & 15) << 2] + '=';
    }
    return parts.join('');
  }

  static _base64ToF32(b64: string): Float32Array {
    const lut = OmniNodeStore._b64Lookup;
    const len = b64.length;
    let padding = 0;
    if (b64[len - 1] === '=') { padding++; if (b64[len - 2] === '=') padding++; }
    const byteLen = (len * 3 / 4) - padding;
    const bytes = new Uint8Array(byteLen);
    let j = 0;
    for (let i = 0; i < len; i += 4) {
      const a = lut[b64.charCodeAt(i)], b = lut[b64.charCodeAt(i + 1)],
        c = lut[b64.charCodeAt(i + 2)], d = lut[b64.charCodeAt(i + 3)];
      bytes[j++] = (a << 2) | (b >> 4);
      if (j < byteLen) bytes[j++] = ((b & 15) << 4) | (c >> 2);
      if (j < byteLen) bytes[j++] = ((c & 3) << 6) | d;
    }
    return new Float32Array(bytes.buffer);
  }

  // Accept both base64 string and legacy number array
  static _decodeEmbedding(v: unknown): Float32Array | null {
    if (!v) return null;
    if (typeof v === 'string') return OmniNodeStore._base64ToF32(v);
    if (Array.isArray(v)) return new Float32Array(v);
    return null;
  }

  _serializeEmbeddingCache() {
    const out: Array<Record<string, unknown>> = [];
    for (const [nodeId, entry] of this.embeddingCache) {
      out.push({ nodeId, hash: entry.hash, embedding: entry.embedding ? OmniNodeStore._f32ToBase64(entry.embedding) : null });
    }
    return out;
  }

  _deserializeEmbeddingCache(arr: unknown) {
    this.embeddingCache.clear();
    if (!Array.isArray(arr)) return;
    let expectedDim = 0;
    let skipped = 0;
    for (const entry of arr) {
      const emb = OmniNodeStore._decodeEmbedding(entry.embedding);
      if (entry.nodeId && entry.hash && emb) {
        if (expectedDim === 0) { expectedDim = emb.length; }
        else if (emb.length !== expectedDim) { skipped++; continue; }
        this.embeddingCache.set(entry.nodeId, { hash: entry.hash, embedding: emb });
      }
    }
    if (skipped > 0) console.log(`${LOG_PREFIX} embeddingCache: skipped ${skipped} entries with mismatched dimensions (expected ${expectedDim})`);
  }

  _serializeTextEmbeddingCache() {
    const out: Array<Record<string, unknown>> = [];
    for (const [hash, embedding] of this.textEmbeddingCache) {
      out.push({ hash, embedding: embedding ? OmniNodeStore._f32ToBase64(embedding) : null });
    }
    return out;
  }

  _deserializeTextEmbeddingCache(arr: unknown) {
    this.textEmbeddingCache.clear();
    if (!Array.isArray(arr)) return;
    let expectedDim = 0;
    let skipped = 0;
    for (const entry of arr) {
      const emb = OmniNodeStore._decodeEmbedding(entry.embedding);
      if (entry.hash && emb) {
        if (expectedDim === 0) { expectedDim = emb.length; }
        else if (emb.length !== expectedDim) { skipped++; continue; }
        this.textEmbeddingCache.set(entry.hash, emb);
      }
    }
    if (skipped > 0) console.log(`${LOG_PREFIX} textEmbeddingCache: skipped ${skipped} entries with mismatched dimensions (expected ${expectedDim})`);
  }

  _serializeHydeCache() {
    const out: Array<Record<string, unknown>> = [];
    const MAX_HYDE_CACHE = 200;
    let count = 0;
    for (const [hash, entry] of this.hydeCache) {
      if (count >= MAX_HYDE_CACHE) break;
      if (typeof entry === 'string') {
        out.push({ hash, hydeStr: entry, embedding: null });
      } else {
        out.push({
          hash,
          hydeStr: entry.text || '',
          embedding: entry.embedding ? OmniNodeStore._f32ToBase64(entry.embedding) : null,
        });
      }
      count++;
    }
    return out;
  }

  _deserializeHydeCache(arr: unknown) {
    this.hydeCache.clear();
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      if (entry.hash && entry.hydeStr) {
        this.hydeCache.set(entry.hash, {
          text: entry.hydeStr,
          embedding: OmniNodeStore._decodeEmbedding(entry.embedding),
        });
      }
    }
  }

  _serializeMemrlCache() {
    const out: Array<Record<string, unknown>> = [];
    const MAX_MEMRL_CACHE = 500;
    let count = 0;
    for (const [key, entry] of this.memrlCache) {
      if (count >= MAX_MEMRL_CACHE) break;
      out.push({ key, useful: entry.useful, confidence: entry.confidence, turn: entry.turn });
      count++;
    }
    return out;
  }

  _deserializeMemrlCache(arr: unknown) {
    this.memrlCache.clear();
    if (!Array.isArray(arr)) return;
    for (const entry of arr) {
      if (entry.key !== undefined) {
        this.memrlCache.set(entry.key, { useful: entry.useful, confidence: entry.confidence, turn: entry.turn });
      }
    }
  }

  static deserialize(data: Record<string, any> | null | undefined): OmniNodeStore {
    if (!data || data.version !== 1) return new OmniNodeStore();
    const store = new OmniNodeStore();
    store.currentTurn = data.currentTurn || 0;
    store.atlasMd = data.atlasMd || '';

    const loadNodes = (arr: any[] | undefined, map: Map<string, OmniNode>, type: NodeType) => {
      for (const raw of (arr || [])) {
        const node = createNode({
          type,
          name: raw.name || '',
          content: raw.content,
          keywords: raw.keywords || [],
          globalKeywords: raw.globalKeywords || [],
          importance: raw.importance,
          activationScore: raw.activationScore,
          utilityScore: raw.utilityScore ?? 50.0,
          creationTurn: raw.creationTurn,
          relationships: raw.relationships || [],
          alwaysActive: raw.alwaysActive || false,
          archived: raw.archived || false,
          excluded: raw.excluded || false,
          timestamp: raw.timestamp ?? null,
        });
        node.id = raw.id;
        node.zeroScoreTurns = raw.zeroScoreTurns || 0;
        node.highScoreTurns = raw.highScoreTurns || 0;
        if (raw.sourceNodeIds) node.sourceNodeIds = [...raw.sourceNodeIds];
        if (raw.parentLoreId) node.parentLoreId = raw.parentLoreId;
        // Community summary fields
        if (raw.communityId) node.communityId = raw.communityId;
        if (raw.level !== undefined) node.level = raw.level;
        if (raw.memberNodeIds) node.memberNodeIds = [...raw.memberNodeIds];
        if (raw.parentCommunityId) node.parentCommunityId = raw.parentCommunityId;
        if (raw.worldSim) node.worldSim = true;
        if (raw._isChapterSummary) { node._isChapterSummary = true; node._chapterRange = raw._chapterRange; }
        // D2: 원문 발췌 앵커
        if (raw.sourceTurnStart !== undefined) node.sourceTurnStart = raw.sourceTurnStart;
        if (raw.sourceTurnEnd !== undefined) node.sourceTurnEnd = raw.sourceTurnEnd;
        map.set(node.id, node);
      }
    };

    loadNodes(data.loreNodes, store.loreNodes, 'lore');
    loadNodes(data.extraLoreNodes, store.extraLoreNodes, 'extraLore');
    // Migration: load old loreStateNodes as communitySummary if communityNodes not present
    if (data.communityNodes && data.communityNodes.length > 0) {
      loadNodes(data.communityNodes, store.communityNodes, 'communitySummary');
    } else if (data.loreStateNodes && data.loreStateNodes.length > 0) {
      // Migrate legacy loreState → communitySummary
      for (const raw of data.loreStateNodes) {
        raw.communityId = raw.id;
        raw.level = 0;
        raw.memberNodeIds = raw.sourceNodeIds || [];
        raw.parentCommunityId = null;
      }
      loadNodes(data.loreStateNodes, store.communityNodes, 'communitySummary');
      console.log(`${LOG_PREFIX} Migrated ${data.loreStateNodes.length} loreState nodes → communitySummary`);
    }
    loadNodes(data.longTermMemoryNodes, store.longTermMemoryNodes, 'longTermMemory');
    if (Array.isArray(data.conversationNodes) && data.conversationNodes.length > 0) {
      console.warn(`${LOG_PREFIX} Ignored ${data.conversationNodes.length} legacy conversationNodes entries; the conversation node type has been removed`);
    }

    // Restore embedding cache
    store._deserializeEmbeddingCache(data.embeddingCache);
    store._deserializeTextEmbeddingCache(data.textEmbeddingCache);
    store._deserializeHydeCache(data.hydeCache);
    store._deserializeMemrlCache(data.memrlCache);
    store._lastCommunityTurn = data.lastCommunityTurn || 0;
    store._nodesSinceLastCommunity = data.nodesSinceLastCommunity || 0;
    store._lastConvertedMsgCount = data.lastConvertedMsgCount || 0;
    store._ltmConvertedUpTo = data.ltmConvertedUpTo || 0;
    store._ltmWatermarkHash = data.ltmWatermarkHash || '';
    store._lastChapterTurn = data.lastChapterTurn || 0;

    // Build reverse relationship index after all nodes loaded
    store._rebuildReverseRelIndex();

    console.log(`${LOG_PREFIX} Deserialized store: ${store.getNodeCount()} nodes, turn ${store.currentTurn}, ${store.embeddingCache.size} node + ${store.textEmbeddingCache.size} text + ${store.hydeCache.size} HyDE cached`);
    return store;
  }
}
