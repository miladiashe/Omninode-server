// 원본 MODULE 5B: NODE EDIT AGENT (L3474–4091) + 툴 디스패처/키워드 역인덱스
// (L6266–6770) + 기본 프롬프트 블록(L256–434)의 이식. 로직 동일 유지.
//
// 원본과의 의도적 차이:
//  - 전역 nodeStore → ns 파라미터 (키워드 역인덱스는 스토어별 WeakMap)
//  - 원본 버그 3호 수정: NODE_EDIT_CACHE_TTL이 정의된 곳 없이 사용되어(L3844)
//    캐시 히트(=리롤) 시 ReferenceError → catch가 삼켜 해당 배치 기억이 증발.
//    주석(L3791) "No TTL" 의도대로 TTL 검사를 제거.
//  - showMergeConfirmDialog(iframe UI) → 서버는 자동 승인 (후보는 이미 임계값 통과;
//    Phase 8 웹 UI에서 검토 큐로 승격 예정)
//  - processingTracker/onActivity → 제거(no-op), _emitStateChange → 제거
//  - 관계 툴(add/remove/update_relationship)이 노드 캐시·역인덱스를 갱신하도록 보강.
//    원본은 관계를 직접 변조해 역인덱스가 낡은 채 남았고(잠재 버그 — 이후 removeNode의
//    관계 정리 누락 가능), 이식본은 툴 실행 후 재구축한다.
import { join } from 'node:path';
import { OmniNodeStore, type OmniNode, MAX_NODE_CONTENT_CHARS } from '../core/node-store.js';
import {
  LOG_PREFIX, contentHash, cosineSimilarity, robustParseJSON, repairTruncatedJson, estimateTokens,
  _evictOldest, _normalizeCompactTs, _compactNow, normalizeRelType,
  defaultDirectionForType, clampStrength,
} from '../core/util.js';
import { rankNodes, reciprocalRankFusion, typeDiversityDecay } from '../core/scoring.js';
import { callLLM, stripThought, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '../llm/client.js';
import {
  getCachedTextEmbeddings, generateHyDEWithEmbeddings, applyChatRegexFiltersToTexts,
  getNodeEmbeddings,
} from '../llm/embeddings.js';
import type { OmniConfig } from '../config-store.js';
import type { NodeEditAgentDeps } from './helpers.js';

// ── Bigram Dice coefficient for name similarity ──
export function nameSimilarity(a: string | undefined, b: string | undefined): number {
  if (!a || !b) return 0;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9　-鿿가-힯]/g, '');
  const bigrams = (s: string) => {
    const bg = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) bg.add(s.substring(i, i + 2));
    return bg;
  };
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return na === nb ? 1 : 0;
  const ba = bigrams(na), bb = bigrams(nb);
  let intersection = 0;
  for (const g of ba) { if (bb.has(g)) intersection++; }
  return (2 * intersection) / (ba.size + bb.size);
}

// ── XML escape (L6404) ──
function _xe(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Orphan nodes (L6266) ──
export function _findOrphanNodes(ns: OmniNodeStore): OmniNode[] {
  const allActive = ns.getActiveNodes();
  const activeIds = new Set(allActive.map(n => n.id));
  const connCount = new Map<string, number>();
  for (const n of allActive) connCount.set(n.id, 0);
  for (const n of allActive) {
    for (const rel of (n.relationships || [])) {
      if (activeIds.has(rel.targetId)) {
        connCount.set(n.id, (connCount.get(n.id) || 0) + 1);
        connCount.set(rel.targetId, (connCount.get(rel.targetId) || 0) + 1);
      }
    }
  }
  return allActive.filter(n => !n.archived && (connCount.get(n.id) || 0) === 0);
}

// ── Inverted keyword index (L6408–6436) — 스토어별 상태 ──
interface KwIndexState {
  turn: number;
  count: number;
  index: Map<string, Set<string>>;
  nodes: Map<string, OmniNode>;
}
const _kwIndexStates = new WeakMap<OmniNodeStore, KwIndexState>();

function _ensureKeywordIndex(ns: OmniNodeStore): KwIndexState {
  const count = ns.getNodeCount();
  const existing = _kwIndexStates.get(ns);
  if (existing && existing.turn === ns.currentTurn && existing.count === count) return existing;
  const state: KwIndexState = { turn: ns.currentTurn, count, index: new Map(), nodes: new Map() };
  for (const n of ns.getAllNodes()) {
    state.nodes.set(n.id, n);
    for (const kw of (n.keywords || [])) {
      const key = kw.toLowerCase();
      if (!state.index.has(key)) state.index.set(key, new Set());
      state.index.get(key)!.add(n.id);
    }
    // Index name words too
    for (const w of (n.name || '').toLowerCase().split(/\s+/)) {
      if (w.length > 2) {
        if (!state.index.has(w)) state.index.set(w, new Set());
        state.index.get(w)!.add(n.id);
      }
    }
  }
  _kwIndexStates.set(ns, state);
  return state;
}

// ── Potential link candidates (L6439–6503) ──
export function _findPotentialLinks(ns: OmniNodeStore, newNode: OmniNode, maxSuggestions = 8) {
  const { index: _kwIndex, nodes: _kwIndexNodes } = _ensureKeywordIndex(ns);
  const newKw = new Set((newNode.keywords || []).map(k => k.toLowerCase()));
  const newNameWords = new Set((newNode.name || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));

  const candidateScores = new Map<string, { score: number; reason: string }>();
  const addCandidate = (id: string, score: number, reason: string) => {
    if (id === newNode.id) return;
    const existing = candidateScores.get(id);
    if (existing) {
      existing.score += score;
    } else {
      candidateScores.set(id, { score, reason });
    }
  };

  for (const kw of newKw) {
    const exact = _kwIndex.get(kw);
    if (exact) {
      for (const id of exact) addCandidate(id, 10, `Shared keyword "${kw}"`);
    }
    for (const [indexKey, ids] of _kwIndex) {
      if (indexKey === kw) continue;
      if (indexKey.includes(kw) || kw.includes(indexKey)) {
        for (const id of ids) addCandidate(id, 3, `Keyword overlap "${indexKey}"`);
      }
    }
  }

  for (const w of newNameWords) {
    const ids = _kwIndex.get(w);
    if (ids) {
      for (const id of ids) addCandidate(id, 5, `Name contains "${w}"`);
    }
  }

  for (const [id, entry] of candidateScores) {
    const n = _kwIndexNodes.get(id);
    if (n && n.type === 'lore') entry.score += 2;
  }

  const scored: Array<{ node: OmniNode; score: number; reason: string }> = [];
  for (const [id, entry] of candidateScores) {
    const n = _kwIndexNodes.get(id);
    if (n) scored.push({ node: n, score: entry.score, reason: entry.reason });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxSuggestions);
}

function _buildPotentialLinksXml(ns: OmniNodeStore, newNode: OmniNode): string {
  const links = _findPotentialLinks(ns, newNode);
  if (links.length === 0) return '';
  const lines = links.map(l =>
    `    <node id="${_xe(l.node.id)}" type="${l.node.type}" name="${_xe((l.node.name || l.node.keywords[0] || l.node.id).substring(0, 40))}" reason="${_xe(l.reason)}"/>`,
  );
  return `\n  <potentialLinks>\n${lines.join('\n')}\n  </potentialLinks>`;
}

// ── Ephemeral agent plans ──
const _agentPlanMap = new Map<string, string>();
let _agentIdCounter = 0;

// ── Tool dispatcher (L6509–6770) ──
export function _executeSingleTool(ns: OmniNodeStore, name: string, args: Record<string, any>, agentId: string): string {
  try {
    const a = args || {};
    switch (name) {
      case 'create_node': {
        const nType = a.nodeType || 'longTermMemory';
        if (nType !== 'longTermMemory' && nType !== 'extraLore') {
          return `Error: unsupported node type ${nType}`;
        }
        if (nType === 'extraLore') {
          const node = ns.addExtraLoreNode({
            name: a.name || '',
            content: a.content || '',
            keywords: Array.isArray(a.keywords) ? a.keywords : [],
            importance: Math.min(5, Math.max(3, parseInt(a.importance) || 4)),
            activationScore: 50.0,
            creationTurn: ns.currentTurn,
            relationships: [],
          });
          if (Array.isArray(a.globalKeywords)) node.globalKeywords = [...a.globalKeywords];
          return `<result>\n  <status>Created extraLore node</status>\n  <nodeId>${_xe(node.id)}</nodeId>\n  <name>${_xe(node.name)}</name>${_buildPotentialLinksXml(ns, node)}\n</result>`;
        } else {
          const compactTsLtm = _normalizeCompactTs(a.timestamp) || _compactNow();
          const node = ns.addLongTermMemoryNode({
            name: a.name || 'Untitled event',
            content: a.content || '',
            keywords: Array.isArray(a.keywords) ? a.keywords : [],
            importance: Math.min(5, Math.max(1, parseInt(a.importance) || 3)),
            activationScore: 50.0,
            creationTurn: ns.currentTurn,
            relationships: [],
            timestamp: compactTsLtm,
          });
          if (Array.isArray(a.globalKeywords)) node.globalKeywords = [...a.globalKeywords];
          return `<result>\n  <status>Created LTM node</status>\n  <nodeId>${_xe(node.id)}</nodeId>\n  <name>${_xe(node.name)}</name>${_buildPotentialLinksXml(ns, node)}\n</result>`;
        }
      }
      case 'update_node': {
        const node = ns.getNode(a.nodeId);
        if (!node) return `Error: node ${a.nodeId} not found`;
        if (node.type === 'lore') return `Error: lore nodes are content-read-only. Use add_relationship/remove_relationship/update_relationship to edit their connections.`;
        const updates: Record<string, unknown> = {};
        if (a.name !== undefined) updates.name = a.name;
        if (a.content !== undefined) updates.content = a.content;
        if (a.keywords !== undefined) updates.keywords = a.keywords;
        if (a.importance !== undefined) updates.importance = a.importance;
        if (a.timestamp !== undefined) updates.timestamp = a.timestamp;
        ns.updateNode(node.id, updates);
        if (a.globalKeywords !== undefined && Array.isArray(a.globalKeywords)) node.globalKeywords = [...a.globalKeywords];
        return `Updated node ${a.nodeId}`;
      }
      case 'delete_node': {
        const node = ns.getNode(a.nodeId);
        if (!node) return `Error: node ${a.nodeId} not found`;
        if (node.type === 'lore') return `Error: lore nodes cannot be deleted. They are imported from the character card.`;
        ns.removeNode(node.id);
        return `Deleted node ${a.nodeId}`;
      }
      case 'merge_nodes': {
        const keep = ns.getNode(a.keepId);
        const remove = ns.getNode(a.removeId);
        if (!keep || !remove) return `Error: node not found (${a.keepId} or ${a.removeId})`;
        if (keep.type === 'lore' || remove.type === 'lore') return `Error: lore nodes cannot be merged. They are imported from the character card.`;
        keep.content = a.mergedContent || keep.content + '\n' + remove.content;
        keep.importance = Math.max(keep.importance, remove.importance);
        keep.activationScore = Math.min(100, Math.max(keep.activationScore, remove.activationScore) + 5);
        for (const rel of remove.relationships) {
          if (rel.targetId !== keep.id && !keep.relationships.some(r => r.targetId === rel.targetId)) {
            keep.relationships.push({ ...rel });
          }
        }
        ns.removeNode(remove.id);
        return `Merged ${a.removeId} into ${a.keepId}`;
      }
      case 'add_relationship': {
        const src = ns.getNode(a.sourceId);
        const tgt = ns.getNode(a.targetId);
        if (!src || !tgt) return `Error: node not found (${a.sourceId} or ${a.targetId})`;
        const relType = normalizeRelType(a.type);
        const dir = a.direction || defaultDirectionForType(relType);
        const str = clampStrength(a.strength ?? 3);
        if (!src.relationships.some(r => r.targetId === a.targetId)) {
          src.relationships.push({ targetId: a.targetId, direction: dir, type: relType, strength: str, createdAtTurn: ns.currentTurn });
        }
        if (dir !== 'uni' && !tgt.relationships.some(r => r.targetId === a.sourceId)) {
          tgt.relationships.push({ targetId: a.sourceId, direction: 'bi', type: relType, strength: str, createdAtTurn: ns.currentTurn });
        }
        ns._invalidateNodeCaches();
        ns._rebuildReverseRelIndex();
        const arrow = dir === 'uni' ? '→' : '↔';
        return `Linked ${a.sourceId} ${arrow} ${a.targetId} (${relType}, ${dir}, strength=${str})`;
      }
      case 'remove_relationship': {
        const src = ns.getNode(a.sourceId);
        const tgt = ns.getNode(a.targetId);
        if (!src || !tgt) return `Error: node not found (${a.sourceId} or ${a.targetId})`;
        src.relationships = src.relationships.filter(r => r.targetId !== a.targetId);
        tgt.relationships = tgt.relationships.filter(r => r.targetId !== a.sourceId);
        ns._invalidateNodeCaches();
        ns._rebuildReverseRelIndex();
        return `Removed relationship ${a.sourceId} ↔ ${a.targetId}`;
      }
      case 'update_relationship': {
        const src = ns.getNode(a.sourceId);
        const tgt = ns.getNode(a.targetId);
        if (!src || !tgt) return `Error: node not found (${a.sourceId} or ${a.targetId})`;
        const srcRel = src.relationships.find(r => r.targetId === a.targetId);
        const tgtRel = tgt.relationships.find(r => r.targetId === a.sourceId);
        if (!srcRel && !tgtRel) return `Error: no relationship between ${a.sourceId} and ${a.targetId}`;
        const newType = normalizeRelType(a.newType);
        const newDir = a.direction || defaultDirectionForType(newType);
        const newStr = a.strength !== undefined ? clampStrength(a.strength) : null;
        if (srcRel) { srcRel.type = newType; srcRel.direction = newDir; if (newStr !== null) srcRel.strength = newStr; }
        if (newDir === 'uni') {
          if (tgtRel) tgt.relationships = tgt.relationships.filter(r => r.targetId !== a.sourceId);
        } else {
          if (tgtRel) { tgtRel.type = newType; tgtRel.direction = 'bi'; if (newStr !== null) tgtRel.strength = newStr; }
          else tgt.relationships.push({ targetId: a.sourceId, direction: 'bi', type: newType, strength: newStr ?? 3, createdAtTurn: ns.currentTurn });
        }
        ns._invalidateNodeCaches();
        ns._rebuildReverseRelIndex();
        return `Updated relationship ${a.sourceId} ↔ ${a.targetId} → ${a.newType}`;
      }
      case 'list_nodes': {
        let nodes = ns.getAllNodes();
        const ft = a.filterType || 'all';
        if (ft !== 'all') nodes = nodes.filter(n => n.type === ft);
        const sortKey = a.sortBy || 'creationTurn';
        const desc = (a.order || 'desc') === 'desc';
        nodes = [...nodes].sort((x, y) => {
          let va: number, vb: number;
          if (sortKey === 'name') {
            const sa = (x.name || x.keywords[0] || '').toLowerCase();
            const sb = (y.name || y.keywords[0] || '').toLowerCase();
            return desc ? sb.localeCompare(sa) : sa.localeCompare(sb);
          }
          if (sortKey === 'importance') { va = x.importance; vb = y.importance; }
          else if (sortKey === 'activation') { va = x.activationScore || 0; vb = y.activationScore || 0; }
          else { va = x.creationTurn; vb = y.creationTurn; }
          return desc ? vb - va : va - vb;
        });
        const limit = Math.min(a.limit || 20, 50);
        const listed = nodes.slice(0, limit);
        if (listed.length === 0) return '<result><nodes count="0"/></result>';
        return `<result><nodes count="${listed.length}" total="${nodes.length}">\n` + listed.map(n =>
          `<node id="${_xe(n.id)}" type="${n.type}" importance="${n.importance}" activation="${Math.round(n.activationScore || 0)}" turn="${n.creationTurn}" rels="${(n.relationships || []).length}" name="${_xe(n.name || n.keywords[0] || n.id)}">${_xe(n.content.substring(0, 80))}</node>`,
        ).join('\n') + '\n</nodes></result>';
      }
      case 'search_nodes': {
        const q = (a.query || '').toLowerCase();
        if (!q) return 'Error: empty query';
        let all = ns.getAllNodes();
        const ft = a.filterType || 'all';
        if (ft !== 'all') all = all.filter(n => n.type === ft);
        const matches = all.filter(n =>
          (n.content || '').toLowerCase().includes(q) ||
          (n.name || '').toLowerCase().includes(q),
        );
        const limit = Math.min(a.limit || 10, 30);
        if (matches.length === 0) return `<result><nodes count="0" query="${_xe(a.query)}"/></result>`;
        return `<result><nodes count="${matches.length}" query="${_xe(a.query)}">\n` + matches.slice(0, limit).map(n =>
          `<node id="${_xe(n.id)}" type="${n.type}" importance="${n.importance}" name="${_xe(n.name || n.keywords[0] || n.id)}">${_xe(n.content.substring(0, 80))}</node>`,
        ).join('\n') + '\n</nodes></result>';
      }
      case 'search_keywords': {
        const kw = (a.keyword || '').toLowerCase();
        if (!kw) return 'Error: empty keyword';
        let all = ns.getAllNodes();
        const ft = a.filterType || 'all';
        if (ft !== 'all') all = all.filter(n => n.type === ft);
        const matches = all.filter(n =>
          (n.keywords || []).some(k => k.toLowerCase().includes(kw)),
        );
        const limit = Math.min(a.limit || 10, 30);
        if (matches.length === 0) return `<result><nodes count="0" keyword="${_xe(a.keyword)}"/></result>`;
        return `<result><nodes count="${matches.length}" keyword="${_xe(a.keyword)}">\n` + matches.slice(0, limit).map(n =>
          `<node id="${_xe(n.id)}" type="${n.type}" importance="${n.importance}" name="${_xe(n.name || n.keywords[0] || n.id)}"><keywords>${_xe((n.keywords || []).join(', '))}</keywords></node>`,
        ).join('\n') + '\n</nodes></result>';
      }
      case 'search_orphans': {
        const ft = a.filterType || 'all';
        let orphans = _findOrphanNodes(ns);
        if (ft !== 'all') orphans = orphans.filter(n => n.type === ft);
        const limit = Math.min(a.limit || 20, 50);
        if (orphans.length === 0) return `<result><orphans count="0"/></result>`;
        return `<result><orphans count="${orphans.length}">\n` + orphans.slice(0, limit).map(n => {
          return `<node id="${_xe(n.id)}" type="${n.type}" importance="${n.importance}" turn="${n.creationTurn}" name="${_xe(n.name || n.keywords[0] || n.id)}" excluded="${!!n.excluded}">${_xe(n.content.substring(0, 80))}</node>`;
        }).join('\n') + '\n</orphans></result>';
      }
      case 'graph_traverse': {
        const startNode = ns.getNode(a.nodeId);
        if (!startNode) return `Error: node ${a.nodeId} not found`;
        const maxDepth = Math.min(Math.max(a.depth || 2, 1), 4);
        const filterRel = a.filterType || 'all';
        const visited = new Set<string>();
        const resultItems: Array<{ node: OmniNode; depth: number; path: string[]; relType: string }> = [];
        const queue: Array<{ id: string; depth: number; path: string[]; relType: string }> = [{ id: a.nodeId, depth: 0, path: [], relType: '' }];
        visited.add(a.nodeId);
        while (queue.length > 0) {
          const { id, depth, path, relType } = queue.shift()!;
          const node = ns.getNode(id);
          if (!node) continue;
          resultItems.push({ node, depth, path, relType });
          if (depth < maxDepth) {
            for (const rel of (node.relationships || [])) {
              if (filterRel !== 'all' && rel.type !== filterRel) continue;
              if (!visited.has(rel.targetId)) {
                visited.add(rel.targetId);
                queue.push({ id: rel.targetId, depth: depth + 1, path: [...path, node.id], relType: rel.type });
              }
            }
          }
        }
        if (resultItems.length <= 1) return `<result><graph root="${_xe(startNode.name || a.nodeId)}" depth="${maxDepth}" count="1"><node id="${_xe(a.nodeId)}" type="${startNode.type}" name="${_xe(startNode.name || a.nodeId)}" rels="0"/></graph></result>`;
        return `<result><graph root="${_xe(startNode.name || a.nodeId)}" depth="${maxDepth}" count="${resultItems.length}">\n` + resultItems.map(item => {
          const n = item.node;
          const pathAttr = item.path.length > 0 ? ` path="${_xe(item.path.join(' → '))}"` : '';
          const relAttr = item.relType ? ` via="${item.relType}"` : '';
          return `<node id="${_xe(n.id)}" type="${n.type}" importance="${n.importance}" depth="${item.depth}"${relAttr}${pathAttr} name="${_xe(n.name || n.id)}">${_xe(n.content.substring(0, 80))}</node>`;
        }).join('\n') + '\n</graph></result>';
      }
      case 'write_plan': {
        _agentPlanMap.set(agentId, a.plan || '');
        console.log(`${LOG_PREFIX} Agent [${agentId}] wrote PLAN.md:\n${a.plan || ''}`);
        return `<result><status>Plan saved. Now proceed with STEP 1 — DISCOVERY.</status></result>`;
      }
      case 'update_plan': {
        _agentPlanMap.set(agentId, a.plan || '');
        console.log(`${LOG_PREFIX} Agent [${agentId}] updated PLAN.md:\n${a.plan || ''}`);
        return `<result><status>Plan updated.</status></result>`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}

// ── Default prompt blocks (L256–418) ──
export function getDefaultNodeEditBlocks(cfg: OmniConfig): Array<{ role: string; content: string }> {
  const useGliner = Boolean(cfg?.useGliner && (cfg.glinerEndpoint || '').trim());
  // D2 캡 (사용자 승인 2026-08-01): 원본의 폭주 지시(디테일마다 노드)를 예산 지시로 교체.
  // 0 = 무제한(원본 문구 유지). 실측 근거: deepseek 75노드/8msg, gpt5.4 60노드 — 모델 무관 폭발
  const maxNodes = Math.max(0, Math.trunc(Number(cfg?.ltmMaxNodesPerBatch)) || 0);
  const capped = maxNodes > 0;
  // D2 2패스: 관계는 별도 2차 호출 — 출력 절단 시 관계가 통째로 유실되는 구조 제거
  const twoPass = cfg?.agentTwoPassRelationships !== false;

  const coverageRule = capped
    ? `4. Budgeted coverage — Create AT MOST ${maxNodes} nodes total (LTM + extraLore combined).
   - One LTM per significant event, decision, or revelation.
   - Merge minor actions, reactions, and environmental details INTO their parent event's Description — do NOT give them separate nodes.
   - If there are more candidate events than the budget, keep the most consequential ${maxNodes} and fold the rest into related nodes' descriptions.
   - Never pad to reach the limit: fewer meaningful events → fewer nodes.`
    : `4. Thorough coverage — Create MANY nodes. Split each assistant turn into MULTIPLE LTMs:
   - One LTM for each distinct action, movement, or scene change.
   - One LTM for each emotional shift or reaction.
   - One LTM for each environmental detail or discovery.
   - If an assistant turn contains 8 events, create 8 separate LTM nodes.`;

  const relationshipRule = twoPass
    ? `5. Do NOT output a "relationships" array — relationship linking runs as a separate second pass after your nodes are saved. Focus on nodes only.`
    : `5. Rich relationships — Each node should have at least 2 relationships. You can freely connect new nodes with existing nodes too. Types: "causes", "enables", "prevents", "contradicts", "develops", "related", "parent". Each relationship has a "strength" (1-5): 1=weak/tangential, 3=moderate, 5=very strong/critical.
   - Every LTM → related lore/extraLore entries ("related")
   - LTM → LTM if one event causes or develops from another ("causes"/"develops")`;

  const hardLimitLine = capped ? `\nHard limit: the "nodes" array must contain at most ${maxNodes} entries.` : '';
  const keywordRule = useGliner
    ? `8. Keywords are extracted automatically — do NOT include "keywords" or "globalKeywords" fields in your JSON output.`
    : `8. Dual-level keywords:
   - "keywords" = specific, local terms (character names, places, exact items). e.g. ["Elena", "forest battle", "cursed sword"]
   - "globalKeywords" = abstract themes and concepts. e.g. ["betrayal", "romance", "power struggle", "redemption"]
   - Every node MUST have both. At least 2 keywords and 1 globalKeyword per node.`;
  const jsonExample = useGliner
    ? `{
  "nodes": [
    { "tempId": "_n1", "op": "create", "nodeType": "longTermMemory", "name": "...", "content": "...", "importance": 3, "timestamp": "..." },
    { "tempId": "_n3", "op": "create", "nodeType": "extraLore", "name": "...", "content": "...", "importance": 4 },
    { "op": "update", "nodeId": "existing_id", "content": "new content" }
  ],
${twoPass ? '' : `  "relationships": [
    { "op": "add", "sourceId": "_n1", "targetId": "ln_8888", "type": "related", "strength": 2 }
  ],
`}  "reevaluations": [
    { "nodeId": "existing_id", "newImportance": 4, "reason": "reinforced by new event" },
    { "nodeId": "existing_id", "newDetail": "One or two sentences stating ONLY the newly learned fact.", "reason": "corrected by new info" }
  ]
}`
    : `{
  "nodes": [
    { "tempId": "_n1", "op": "create", "nodeType": "longTermMemory", "name": "...", "content": "...", "keywords": ["k1","k2"], "globalKeywords": ["theme1"], "importance": 3, "timestamp": "..." },
    { "tempId": "_n3", "op": "create", "nodeType": "extraLore", "name": "...", "content": "...", "keywords": ["k1"], "globalKeywords": ["theme1"], "importance": 4 },
    { "op": "update", "nodeId": "existing_id", "content": "new content" }
  ],
${twoPass ? '' : `  "relationships": [
    { "op": "add", "sourceId": "_n1", "targetId": "ln_8888", "type": "related", "strength": 2 }
  ],
`}  "reevaluations": [
    { "nodeId": "existing_id", "newImportance": 4, "reason": "reinforced by new event" },
    { "nodeId": "existing_id", "newDetail": "One or two sentences stating ONLY the newly learned fact.", "reason": "corrected by new info" },
    { "nodeId": "existing_id", "addKeywords": ["newkw"], "reason": "topic expanded" }
  ]
}`;
  return [
    {
      role: 'system',
      content:
        `{{#if customPrompt}}{{customPrompt}}

{{/if}}You are an expert narrative analyst. Memorize following node types and process conversations.

# NODE TYPES

## 1. longTermMemory (LTM) — Events & Actions (NO verbatim dialogue transcription — the original chat log is preserved separately and excerpts are attached at injection time)
- importance: 1 (trivial) – 5 (critical)
- timestamp: \`YYMMDDHHmm\` only (exactly 10 digits)
- Content template — copy this structure exactly, including markdown formats:
\`\`\`
### Event title here

- Time: when it happens (separate from timestamp)
- Location: where it happens
- Description: Detailed description of the event. Write enough detail so someone who never read the conversation can fully understand what happened. Include character actions, environmental details, emotional states, and consequences.
\`\`\`

## 2. extraLore — Named Entity Encyclopedia
- ONLY for named characters, items, locations, organizations. NEVER for abstract concepts/emotions.
- NEVER create extraLore about "{{personaName}}". He/She is player character.
{{#if noSimulBot}}- NEVER create extraLore about "{{characterName}}". The character card is always included in the prompt separately — creating extraLore would cause duplication.
{{/if}}{{#if entityNameLanguage}}- Write every extraLore name in {{entityNameLanguage}}, regardless of the conversation's language.
{{/if}}- importance: 3 (trivial) – 5 (critical)
- Content template — copy this structure exactly:
\`\`\`
### Entity Name

- Type: character/item/location/organization
- Appearance: physical description if applicable
- Description: key facts, abilities, significance
\`\`\`

## 3. lore — The Canon
- Their contents are read-only, but their relarionships are editable.
- Connect relationships to new nodes. This is recommended, and aim for at least one LTM nodes to be connected.

# RULES

1. Full names only — NEVER use pronouns in titles or content. Always write the character's full name.
2. Title format: "Subject Present-tense verb Object" — e.g. "Elena warns Arthur about the curse".
3. No duplicates — Check existing nodes. If a similar node already exists, use the "update" op instead of creating a new one. An update op's "content" REPLACES the node's entire content: provide the complete rewritten text following the content template. Use it only when the node's existing description as a whole is wrong or outdated.
${coverageRule}
${relationshipRule}
6. Do NOT delete or merge existing nodes. Focus only on creating new nodes and updating existing ones. Node cleanup is handled by a separate community detection process.
7. Re-evaluate existing nodes: When a new event changes what an existing node means WITHOUT invalidating its description, add a "reevaluations" entry — adjust "newImportance", add keywords, or record the new fact via "newDetail". "newDetail" must contain ONLY the newly learned fact in 1-2 sentences; NEVER restate or rewrite the node's existing description there (full rewrites belong to the "update" op). It is appended to the node as a dated correction note.
   - "newDetail" is for facts that change THIS node's own state (something was sealed, revealed, lost, resolved).
   - If the new fact is merely that this node CONNECTS to another event (parallels it, foreshadowed it, caused it, is contradicted by it), do NOT write a newDetail — express connections as graph relationships instead${twoPass ? ' (the separate relationship pass handles them)' : ' (use the "relationships" array)'}.
${keywordRule}

# JSON FORMAT

Return ONLY valid JSON — no markdown fences, no commentary, no explanation:

${jsonExample}

- "tempId" (e.g. "_n1") for new nodes.
- Real node IDs for existing nodes.
- "reevaluations" is optional. Include it when new events change the significance of existing memories.${hardLimitLine}`,
    },
    {
      role: 'user',
      content:
        `Here is the conversation you need to process:

{{conversation}}

---

Analyze the conversation above step by step:

Step 0: Check existing nodes to prevent duplicates and connect relationships from them.
${capped
  ? `Step 1: List candidate events, then select up to ${maxNodes} by narrative importance. Fold minor details into their parent event's Description.`
  : `Step 1: List every distinct event, action, movement, emotional reaction, and environmental detail in the conversation. Count them — each becomes a separate LTM node.`}
Step 2: List every named character, location, item, or organization. Each new one becomes an extraLore node.${twoPass ? '' : `
Step 3: For each node, determine at least 2 relationships.`}`,
    },
    {
      role: 'assistant',
      content:
        `Understood. I will follow the format of system instruction.

Can you provide existing node contents for me to prevent duplication and connect relationships with existing nodes?`,
    },
    {
      role: 'user',
      content:
        `{{nodeContext}}

---

Now output the complete JSON with ALL identified nodes and relationships. Follow the exact content templates. Aim for every nodes connected in a single group, including existing nodes too, without any isolation.`,
    },
  ];
}

// ── Prompt template renderer (L423–434) ──
export function renderPromptTemplate(text: string, vars: Record<string, unknown>): string {
  let result = text.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, varName, content) => {
    return vars[varName] ? content : '';
  });
  result = result.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
    return vars[varName] !== undefined ? String(vars[varName]) : '';
  });
  return result;
}

// ── Pre-search context (L3498–3598) ──
// D2 2패스 (continuation 방식, 사용자 제안 2026-08-01): 1차와 완전히 동일한 프리픽스에
// assistant(1차 출력)를 이어붙여 "관계만 출력"을 요청 — 프로바이더 프롬프트 캐시가
// 프리픽스에 정확히 적중(deepseek 디스크 캐시 ~90% 할인, OpenAI 자동 캐싱)하고,
// 모델이 1차에서 본 전체 그래프 컨텍스트를 그대로 보므로 후보 선정의 천장/매몰 문제가 없음.
// (초기 구현은 키워드 매칭 후보 ≤30개 경량 컨텍스트였으나 링크 리콜 천장 문제로 교체)
async function _runRelationshipPass(
  ns: OmniNodeStore,
  config: OmniConfig,
  parsed: NodeEditParsed,
  passOneMessages: Array<{ role: string; content: string }>,
  passOneRawResponse: string,
): Promise<Array<Record<string, any>>> {
  const newNodes = (parsed.nodes || []).filter(n => n.op !== 'update' && n.tempId);
  if (newNodes.length === 0) return [];

  const messages = [
    ...passOneMessages,
    { role: 'assistant', content: passOneRawResponse },
    {
      role: 'user',
      content: `Good. Now output ONLY the relationships for the nodes you just created.

Rules:
- Connect your new nodes to each other (use their tempIds like "_n1") and to existing nodes from the context above (use their real ids).
- Types MUST be one of: "causes", "enables", "prevents", "contradicts", "develops", "related", "parent". Strength 1-5.
- For each new node, add only its DEFINING connections — the specific nodes this event is directly about, directly caused by, causes, develops, or contradicts (typically 2-4). Shared topic or theme alone does NOT justify a link.
- If a new node touches many things (a report, a review, a summary), connect it only to the nodes it directly quotes or responds to.
- Cross-references to OLD events belong here too: when an existing node's event is DIRECTLY developed, contradicted, or caused by a specific new node, link that existing node's real id to the relevant new node — do not leave such connections as prose notes.
- Only meaningful connections — a wrong link is worse than no link.

Output ONLY valid JSON — no markdown fences, no commentary:
{ "relationships": [ { "op": "add", "sourceId": "_n1", "targetId": "_n2", "type": "related", "strength": 3 } ] }`,
    },
  ];

  try {
    const resp = await callLLM(messages, { _config: config, maxTokens: 6000, jsonMode: true, _label: 'node rels (pass 2)' });
    if (!resp) return [];
    const textContent = stripThought(resp).content;
    let rp = robustParseJSON(textContent) as { relationships?: Array<Record<string, any>> } | null;
    if (!rp || !Array.isArray(rp.relationships)) {
      rp = repairTruncatedJson(textContent) as { relationships?: Array<Record<string, any>> } | null;
    }
    if (!rp || !Array.isArray(rp.relationships)) return [];
    // 유효 엔드포인트만 (tempId는 신규 목록에, 실ID는 스토어에 존재해야)
    const tempIds = new Set(newNodes.map(n => String(n.tempId)));
    return rp.relationships.filter(r => {
      const okEnd = (id: unknown) => tempIds.has(String(id)) || !!ns.getNode(String(id));
      return r && okEnd(r.sourceId) && okEnd(r.targetId) && String(r.sourceId) !== String(r.targetId);
    }).map(r => ({ ...r, op: 'add' }));
  } catch (e) {
    console.log(`${LOG_PREFIX} Relationship pass 2 error: ${(e as Error).message} — nodes saved without rels (orphan linking will catch up)`);
    return [];
  }
}

export async function buildPreSearchContext(
  rawMessages: Array<{ role: string; content: unknown }>,
  config: OmniConfig,
  tokenBudget: number,
  ns: OmniNodeStore,
): Promise<{ text: string; injectedIds: string[] }> {
  const allNodes = ns.getAllNodes().filter(n => !n.archived);
  if (allNodes.length === 0 || tokenBudget <= 0) return { text: '', injectedIds: [] };

  // Compute embeddings for ALL raw messages
  let chatEmbeddings: Float32Array[] = [];
  if (config.embeddingEnabled && rawMessages && rawMessages.length > 0) {
    let embedMsgs = rawMessages;
    if (config.excludeUserEmbedding) {
      embedMsgs = rawMessages.filter(m => m.role !== 'user');
    }
    if (embedMsgs.length > 0) {
      let chatTexts = embedMsgs.map(m =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      );
      chatTexts = applyChatRegexFiltersToTexts(chatTexts, config);
      if (config.hydeEnabled) {
        chatEmbeddings = await generateHyDEWithEmbeddings(chatTexts, config, ns);
      } else {
        chatEmbeddings = await getCachedTextEmbeddings(chatTexts, config, ns);
      }
    }
  }

  // Detect seed nodes (nodes mentioned by name in the messages)
  const seedNodeIds = new Set<string>();
  const msgText = (rawMessages || []).map(m => m.content || '').join(' ').toLowerCase();

  for (const n of allNodes) {
    let matched = false;
    if (n.name && n.name.length > 1 && msgText.includes(n.name.toLowerCase())) {
      matched = true;
    }
    if (!matched && n.keywords) {
      for (const kw of n.keywords) {
        if (kw.length > 1 && msgText.includes(kw.toLowerCase())) {
          matched = true;
          break;
        }
      }
    }
    if (matched) seedNodeIds.add(n.id);
  }

  // Score ALL nodes uniformly
  const currentTurn = ns.currentTurn || 0;

  let scored;
  const useRRF = config.embeddingEnabled && chatEmbeddings.length > 0 && seedNodeIds.size > 0;
  if (useRRF) {
    const kwNodes = allNodes.filter(n => seedNodeIds.has(n.id));
    const keywordRanked = rankNodes(kwNodes, chatEmbeddings, seedNodeIds, ns, currentTurn, config, seedNodeIds);
    const vectorRanked = rankNodes(allNodes, chatEmbeddings, seedNodeIds, ns, currentTurn, config, seedNodeIds);
    scored = reciprocalRankFusion(keywordRanked, vectorRanked, config.rrfK || 60);
  } else {
    scored = rankNodes(allNodes, chatEmbeddings, seedNodeIds, ns, currentTurn, config, seedNodeIds);
  }

  const formatNode = (n: OmniNode) => {
    const rels = (n.relationships || []).map(r => {
      const t = ns.getNode(r.targetId);
      return t ? `${r.type || 'related'}(${r.strength || 3})→${t.name || t.id}` : null;
    }).filter(Boolean).join(', ');
    return `<node id="${n.id}" type="${n.type}" importance="${n.importance}" turn="${n.creationTurn}">\n<name>${n.name || n.keywords?.[0] || n.id}</name>\n<content>${n.content}</content>\n${rels ? ` <relationships>\n${rels}\n</relationships>\n` : ''}</node>`;
  };

  let usedTokens = 0;
  const lines: string[] = [];
  const injectedIds: string[] = [];

  // Fill budget with type-diversity-aware selection
  const _remaining = scored.slice();
  const _typeCount: Record<string, number> = {};
  while (_remaining.length > 0 && usedTokens < tokenBudget) {
    let bestIdx = -1, bestEff = -Infinity;
    for (let i = 0; i < _remaining.length; i++) {
      const { node, score } = _remaining[i];
      const d = typeDiversityDecay[node.type] || 0.85;
      const eff = score * Math.pow(d, _typeCount[node.type] || 0);
      if (eff > bestEff) { bestEff = eff; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const { node } = _remaining.splice(bestIdx, 1)[0];
    const line = formatNode(node);
    const tok = estimateTokens(line);
    if (usedTokens + tok > tokenBudget) break;
    lines.push(line);
    usedTokens += tok;
    injectedIds.push(node.id);
    _typeCount[node.type] = (_typeCount[node.type] || 0) + 1;
  }

  return {
    text: lines.length > 0
      ? `Existing nodes (${allNodes.length} total, showing ${lines.length}):\n<existing_nodes>\n${lines.join('\n')}\n</existing_nodes>`
      : '',
    injectedIds,
  };
}

// ── Apply node-edit operations (L3602–3784) ──
interface NodeEditParsed {
  nodes?: Array<Record<string, any>>;
  relationships?: Array<Record<string, any>>;
  reevaluations?: Array<Record<string, any>>;
}

export async function _applyNodeEditOps(
  ns: OmniNodeStore,
  parsed: NodeEditParsed,
  config: OmniConfig,
  agentId: string,
  skipGliner = false,
): Promise<{ results: string[]; createdExtraLoreIds: string[]; tempIdMap: Map<string, string> }> {
  const tempIdMap = new Map<string, string>();
  const results: string[] = [];
  const createdExtraLoreIds: string[] = [];
  const glinerNodeIds: string[] = [];

  // Phase 1: node operations
  if (Array.isArray(parsed.nodes)) {
    for (const op of parsed.nodes) {
      try {
        if (op.op === 'create') {
          const result = _executeSingleTool(ns, 'create_node', {
            nodeType: op.nodeType || 'longTermMemory',
            name: op.name || '',
            content: op.content || '',
            keywords: op.keywords || [],
            globalKeywords: op.globalKeywords || [],
            importance: op.importance,
            timestamp: op.timestamp || '',
          }, agentId);
          results.push(result);
          ns._nodesSinceLastCommunity++;
          const idMatch = result.match(/<nodeId>([^<]+)<\/nodeId>/);
          if (idMatch && op.tempId) {
            tempIdMap.set(op.tempId, idMatch[1]);
          }
          if (idMatch) glinerNodeIds.push(idMatch[1]);
          if ((op.nodeType || 'longTermMemory') === 'extraLore' && idMatch) {
            createdExtraLoreIds.push(idMatch[1]);
          }
        } else if (op.op === 'update') {
          const realId = op.nodeId && tempIdMap.has(op.nodeId) ? tempIdMap.get(op.nodeId)! : op.nodeId;
          const args: Record<string, unknown> = { nodeId: realId };
          if (op.name !== undefined) args.name = op.name;
          if (op.content !== undefined) args.content = op.content;
          if (op.keywords !== undefined) args.keywords = op.keywords;
          if (op.globalKeywords !== undefined) args.globalKeywords = op.globalKeywords;
          if (op.importance !== undefined) args.importance = op.importance;
          if (op.timestamp !== undefined) args.timestamp = op.timestamp;
          results.push(_executeSingleTool(ns, 'update_node', args, agentId));
          if (op.content !== undefined) glinerNodeIds.push(realId);
        } else if (op.op === 'delete') {
          console.log(`${LOG_PREFIX} NodeEdit: delete op for ${op.nodeId} ignored (restricted to community agent)`);
          results.push(`<ignored>Delete operations are handled by the community detection agent</ignored>`);
        } else if (op.op === 'merge') {
          console.log(`${LOG_PREFIX} NodeEdit: merge op for ${op.keepId}+${op.removeId} ignored (restricted to community agent)`);
          results.push(`<ignored>Merge operations are handled by the community detection agent</ignored>`);
        }
      } catch (e) {
        results.push(`Error (node op): ${(e as Error).message}`);
      }
    }
  }

  // Phase 2: relationship operations (tempIds resolved)
  if (Array.isArray(parsed.relationships)) {
    for (const op of parsed.relationships) {
      try {
        const srcId = op.sourceId && tempIdMap.has(op.sourceId) ? tempIdMap.get(op.sourceId)! : op.sourceId;
        const tgtId = op.targetId && tempIdMap.has(op.targetId) ? tempIdMap.get(op.targetId)! : op.targetId;
        if (op.op === 'add') {
          results.push(_executeSingleTool(ns, 'add_relationship', {
            sourceId: srcId, targetId: tgtId, type: op.type || 'related', direction: op.direction, strength: op.strength,
          }, agentId));
        } else if (op.op === 'remove') {
          results.push(_executeSingleTool(ns, 'remove_relationship', {
            sourceId: srcId, targetId: tgtId,
          }, agentId));
        } else if (op.op === 'update') {
          results.push(_executeSingleTool(ns, 'update_relationship', {
            sourceId: srcId, targetId: tgtId, newType: op.type || op.newType || 'related', direction: op.direction, strength: op.strength,
          }, agentId));
        }
      } catch (e) {
        results.push(`Error (rel op): ${(e as Error).message}`);
      }
    }
  }

  // Phase 3: A-MEM reevaluations
  if (Array.isArray(parsed.reevaluations)) {
    for (const reeval of parsed.reevaluations) {
      try {
        const node = ns.getNode(reeval.nodeId);
        if (!node || node.archived) {
          results.push(`Reevaluation skipped: node ${reeval.nodeId} not found or archived`);
          continue;
        }
        let changed = false;
        if (reeval.newImportance !== undefined) {
          const newImp = Math.max(1, Math.min(5, Math.round(reeval.newImportance)));
          if (newImp !== node.importance) {
            console.log(`${LOG_PREFIX} A-MEM: ${node.id} importance ${node.importance}→${newImp} (${reeval.reason || 'no reason'})`);
            node.importance = newImp;
            changed = true;
          }
        }
        // newDetail이 정식 명칭 (2026-08-02 계약 분리) — updatedContent는 구 캐시/구 모델 출력 호환
        const _detailRaw = reeval.newDetail !== undefined ? reeval.newDetail : reeval.updatedContent;
        if (_detailRaw !== undefined && String(_detailRaw).trim()) {
          const normalizedUpdate = String(_detailRaw).trim();
          const updateLine = `\n[Updated] ${normalizedUpdate}`;
          if (!node.content.includes(updateLine.trim())) {
            const merged = node.content + updateLine;
            node.content = merged.length > MAX_NODE_CONTENT_CHARS
              ? merged.slice(merged.length - MAX_NODE_CONTENT_CHARS)
              : merged;
            changed = true;
          }
        }
        if (Array.isArray(reeval.addKeywords) && reeval.addKeywords.length > 0) {
          const existing = new Set(node.keywords.map(k => k.toLowerCase()));
          for (const kw of reeval.addKeywords) {
            if (!existing.has(kw.toLowerCase())) {
              node.keywords.push(kw);
            }
          }
          changed = true;
        }
        if (Array.isArray(reeval.addGlobalKeywords) && reeval.addGlobalKeywords.length > 0) {
          if (!node.globalKeywords) node.globalKeywords = [];
          const existing = new Set(node.globalKeywords.map(k => k.toLowerCase()));
          for (const gk of reeval.addGlobalKeywords) {
            if (!existing.has(gk.toLowerCase())) {
              node.globalKeywords.push(gk);
            }
          }
          changed = true;
        }
        if (changed) {
          results.push(`Reevaluated node ${node.id}: ${reeval.reason || 'updated'}`);
        }
      } catch (e) {
        results.push(`Error (reevaluation): ${(e as Error).message}`);
      }
    }
  }

  // Phase 4: GLiNER keyword post-processing
  if (!skipGliner && config.useGliner && (config.glinerEndpoint || '').trim() && glinerNodeIds.length > 0) {
    const glinerUrl = config.glinerEndpoint.trim();
    const labels = Array.isArray(config.glinerLabels) && config.glinerLabels.length > 0
      ? config.glinerLabels
      : ['person', 'place', 'time', 'organization', 'object', 'event', 'emotion', 'concept'];
    const batchSize = 5;
    for (let i = 0; i < glinerNodeIds.length; i += batchSize) {
      const batch = glinerNodeIds.slice(i, i + batchSize);
      const promises = batch.map(async (nid) => {
        const node = ns.getNode(nid);
        if (!node || !node.content) return;
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (config.glinerApiKey && config.glinerApiKey.trim()) headers['Authorization'] = `Bearer ${config.glinerApiKey.trim()}`;
          const resp = await fetch(glinerUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ text: node.content.substring(0, 1500), labels }),
          });
          if (resp.ok) {
            const data = await resp.json() as any;
            const entities = data?.result?.entities || data?.entities || {};
            const kws: string[] = [];
            for (const vals of Object.values(entities)) {
              if (Array.isArray(vals)) {
                for (const v of vals) {
                  if (typeof v === 'string' && v.trim() && !kws.includes(v.trim())) kws.push(v.trim());
                }
              }
            }
            if (kws.length > 0) node.keywords = kws.slice(0, 7);
          }
        } catch (e) {
          console.log(`${LOG_PREFIX} GLiNER post-process error for ${nid}: ${(e as Error).message}`);
        }
      });
      await Promise.all(promises);
    }
    console.log(`${LOG_PREFIX} GLiNER post-processed keywords for ${glinerNodeIds.length} nodes`);
  }

  return { results, createdExtraLoreIds, tempIdMap };
}

// ── Node-edit result cache (L3789) ──
// 원본 버그 3호: NODE_EDIT_CACHE_TTL이 미정의 상태로 참조되어 캐시 히트 시 항상 throw.
// 주석의 의도("No TTL — keyed by turn + content")대로 TTL 없이 동작하게 수정.
const _nodeEditResultCache = new Map<string, { parsed: NodeEditParsed; timestamp: number }>();
const NODE_EDIT_CACHE_MAX = 30;

export function _resetNodeEditCache() { _nodeEditResultCache.clear(); }

// ── Node-edit LLM agent (L3817–3945) ──
export async function runNodeEditAgent(
  conversationText: string,
  rawMessages: Array<{ role: string; content: unknown }>,
  config: OmniConfig,
  personaName: string,
  characterName: string,
  simulBot: boolean,
  ns: OmniNodeStore,
): Promise<{ totalActions: number; createdExtraLoreIds: string[]; affectedNodeIds: string[]; contextInjectedIds: string[]; ok: boolean }> {
  const agentId = `agent-${++_agentIdCounter}`;
  _agentPlanMap.set(agentId, '');

  const customPromptText = config.customPrompt || '';
  const contextWindow = config.customLlm?.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const maxTokens = config.customLlm?.maxTokens || DEFAULT_MAX_TOKENS;

  const totalInputBudget = contextWindow - maxTokens;

  const blocks = (Array.isArray(config.nodeEditPromptBlocks) && config.nodeEditPromptBlocks.length > 0)
    ? config.nodeEditPromptBlocks as Array<{ role: string; content: string }>
    : getDefaultNodeEditBlocks(config);

  // Stable cache key: conversation text + turn + prompt config
  const _graphFp = `${ns.currentTurn}`;
  // beta27 방향(L10692): 프롬프트 블록 해시를 키에 포함 — 프롬프트 설정 변경 시 캐시 자연 무효화
  const _blocksHash = contentHash(JSON.stringify(blocks));
  const entityNameLanguage = String(config.entityNameLanguage || '').trim();
  const _stableCacheKey = contentHash(`${conversationText}\x00${customPromptText}\x00${_blocksHash}\x00${personaName}\x00${characterName}\x00${simulBot}\x00${entityNameLanguage}\x00${_graphFp}`);
  const cachedResult = _nodeEditResultCache.get(_stableCacheKey);
  if (cachedResult) {
    console.log(`${LOG_PREFIX} NODE EDIT AGENT: cache hit (key ${_stableCacheKey.substring(0, 8)}), skipping LLM + context build`);
    const parsed = cachedResult.parsed;
    const { results, createdExtraLoreIds, tempIdMap } = await _applyNodeEditOps(ns, parsed, config, agentId, true);
    const totalActions = results.length;
    console.log(`${LOG_PREFIX} NODE EDIT AGENT (cached): ${totalActions} total actions`);
    _agentPlanMap.delete(agentId);
    const affectedNodeIds = [...tempIdMap.values()];
    return { totalActions, createdExtraLoreIds, affectedNodeIds, contextInjectedIds: [], ok: true };
  }

  // Template variables — nodeContext resolved after budget calculation
  const templateVars: Record<string, unknown> = {
    customPrompt: customPromptText,
    personaName: personaName,
    characterName,
    noSimulBot: !simulBot,
    entityNameLanguage,
    conversation: conversationText,
    nodeContext: '',
  };

  // Step 1: Render blocks WITHOUT nodeContext to estimate static token usage
  let staticTokens = 0;
  for (const block of blocks) {
    const rendered = renderPromptTemplate(block.content, templateVars);
    staticTokens += estimateTokens(rendered);
  }

  // Step 2: Remaining budget goes to node context
  const nodeBudget = Math.max(0, totalInputBudget - staticTokens);
  const ctxResult = nodeBudget > 0
    ? await buildPreSearchContext(rawMessages, config, nodeBudget, ns)
    : { text: '', injectedIds: [] };

  // Step 3: Re-render blocks with actual nodeContext
  templateVars.nodeContext = ctxResult.text;
  const messages = blocks.map(block => ({
    role: block.role,
    content: renderPromptTemplate(block.content, templateVars),
  }));

  const response = await callLLM(messages, { _config: config, maxTokens: config.customLlm?.maxTokens || DEFAULT_MAX_TOKENS, jsonMode: true, _label: 'node edit agent' });

  if (!response) {
    console.log(`${LOG_PREFIX} NODE EDIT AGENT: no response from LLM`);
    _agentPlanMap.delete(agentId);
    return { totalActions: 0, createdExtraLoreIds: [], affectedNodeIds: [], contextInjectedIds: [], ok: false };
  }

  const stripped = stripThought(response);
  const textContent = stripped.content;

  if (!textContent && stripped.thought) {
    console.log(`${LOG_PREFIX} NODE EDIT AGENT: response was thinking-only — 최대 응답 토큰을 올리세요`);
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const dir = join(process.env.OMNINODE_DATA_DIR ?? join(process.cwd(), 'data'), 'debug');
      mkdirSync(dir, { recursive: true });
      const f = join(dir, `agent-parse-fail-${Date.now()}.txt`);
      writeFileSync(f, response);
      console.log(`${LOG_PREFIX} Full response dumped: ${f}`);
    } catch { /* 진단 편의 기능 — 실패해도 무시 */ }
    _agentPlanMap.delete(agentId);
    return { totalActions: 0, createdExtraLoreIds: [], affectedNodeIds: [], contextInjectedIds: [], ok: false };
  }

  let parsed = robustParseJSON(textContent) as NodeEditParsed | null;
  if (!parsed || ((!parsed.nodes || parsed.nodes.length === 0) && (!parsed.relationships || parsed.relationships.length === 0))) {
    // D2: 출력 캡 절단 복구 시도 — 완성된 요소까지 구제 (util.repairTruncatedJson)
    const repaired = repairTruncatedJson(textContent) as NodeEditParsed | null;
    if (repaired && ((repaired.nodes && repaired.nodes.length > 0) || (repaired.relationships && repaired.relationships.length > 0))) {
      console.log(`${LOG_PREFIX} NODE EDIT AGENT: parse failed but truncation repair salvaged ${(repaired.nodes || []).length} nodes / ${(repaired.relationships || []).length} rels`);
      parsed = repaired;
    }
  }
  if (!parsed || ((!parsed.nodes || parsed.nodes.length === 0) && (!parsed.relationships || parsed.relationships.length === 0))) {
    console.log(`${LOG_PREFIX} NODE EDIT AGENT: could not parse valid JSON from response`);
    console.log(`${LOG_PREFIX} Response preview: ${textContent.substring(0, 300)}`);
    // 진단 덤프 (2026-08-01 LTM 출력 절단 조사): 실패 응답 전문을 파일로 —
    // 16k 출력이 실제로 뭘로 채워졌는지(update 전문 재작성? 과잉 생성?) 확정용
    try {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const dir = join(process.env.OMNINODE_DATA_DIR ?? join(process.cwd(), 'data'), 'debug');
      mkdirSync(dir, { recursive: true });
      const f = join(dir, `agent-parse-fail-${Date.now()}.txt`);
      writeFileSync(f, textContent);
      console.log(`${LOG_PREFIX} Full response dumped: ${f}`);
    } catch { /* 진단 편의 기능 — 실패해도 무시 */ }
    _agentPlanMap.delete(agentId);
    return { totalActions: 0, createdExtraLoreIds: [], affectedNodeIds: [], contextInjectedIds: [], ok: false };
  }

  // D2 2패스: 동일 프리픽스 continuation으로 관계 획득 (tempId 기준 — 캐시/리롤 재적용과 호환)
  if (config.agentTwoPassRelationships !== false) {
    const passRels = await _runRelationshipPass(ns, config, parsed, messages, textContent);
    parsed.relationships = passRels;
    if (passRels.length > 0) {
      console.log(`${LOG_PREFIX} Relationship pass 2: ${passRels.length} rels for ${(parsed.nodes || []).length} nodes`);
    }
  }

  // Cache store: save parsed result for future reroll hits
  _nodeEditResultCache.set(_stableCacheKey, { parsed, timestamp: Date.now() });
  if (_nodeEditResultCache.size > NODE_EDIT_CACHE_MAX) {
    _evictOldest(_nodeEditResultCache as Map<unknown, unknown>, NODE_EDIT_CACHE_MAX);
  }

  const { results, createdExtraLoreIds, tempIdMap } = await _applyNodeEditOps(ns, parsed, config, agentId);
  const totalActions = results.length;

  console.log(`${LOG_PREFIX} NODE EDIT AGENT: ${totalActions} total actions (${(parsed.nodes || []).length} nodes, ${(parsed.relationships || []).length} rels)`);

  _agentPlanMap.delete(agentId);
  const affectedNodeIds = [...tempIdMap.values()];
  return { totalActions, createdExtraLoreIds, affectedNodeIds, contextInjectedIds: ctxResult.injectedIds, ok: true };
}

// ── Post-process: extraLore merge detection (L3949–4091) ──
// 원본은 showMergeConfirmDialog로 사용자 승인 후 병합 — 서버는 자동 승인 (Phase 8에서 검토 큐)
export async function postProcessExtraLoreMerge(newExtraLoreIds: string[], config: OmniConfig, ns: OmniNodeStore): Promise<void> {
  if (!config.mergeEnabled) {
    console.log(`${LOG_PREFIX} Merge: disabled in config`);
    return;
  }
  if (!config.embeddingEnabled) {
    console.log(`${LOG_PREFIX} Merge: skipped (embedding disabled)`);
    return;
  }
  if (!newExtraLoreIds || newExtraLoreIds.length === 0) return;

  console.log(`${LOG_PREFIX} Merge: checking ${newExtraLoreIds.length} new extraLore IDs`);

  const nameThreshold = config.mergeNameThreshold ?? 0.7;
  const vectorThreshold = config.mergeVectorThreshold ?? 0.85;

  const newNodes = newExtraLoreIds
    .map(id => ns.getNode(id))
    .filter((n): n is OmniNode => !!n && n.type === 'extraLore');

  if (newNodes.length === 0) {
    console.log(`${LOG_PREFIX} Merge: no valid extraLore nodes found for given IDs`);
    return;
  }

  const existingNodes = ns.getAllNodes().filter(n =>
    (n.type === 'lore' || n.type === 'extraLore') && !newExtraLoreIds.includes(n.id),
  );
  if (existingNodes.length === 0 && newNodes.length < 2) {
    console.log(`${LOG_PREFIX} Merge: nothing to compare against`);
    return;
  }

  console.log(`${LOG_PREFIX} Merge: comparing ${newNodes.length} new vs ${existingNodes.length} existing (thresholds: name≥${(nameThreshold * 100).toFixed(0)}%, vec≥${(vectorThreshold * 100).toFixed(0)}%)`);

  const embeddingMap = await getNodeEmbeddings([...newNodes, ...existingNodes], ns, config);

  const candidates: Array<{ newNode: OmniNode; existing: OmniNode; nameSim: number; vectorSim: number }> = [];
  let nearMisses = 0;
  // 새 노드끼리도 비교 — 생성 순서상 앞선 새 노드를 뒤 노드의 '기존'으로 취급.
  // 벌크 실행(콜드스타트/로어북 임포트)은 병합 체크를 종료 후 한 번만 돌리므로,
  // 이게 없으면 청크 간 중복이 검사 자체를 받지 않는다 (Harmonic Lens 표본 사례).
  const orderedNew = [...newNodes].sort((a, b) => (a.creationTurn - b.creationTurn) || a.id.localeCompare(b.id));
  for (let i = 0; i < orderedNew.length; i++) {
    const newNode = orderedNew[i];
    const newEmb = newNode.embedding || embeddingMap.get(newNode.id);
    for (const existing of [...existingNodes, ...orderedNew.slice(0, i)]) {
      const nSim = nameSimilarity(newNode.name, existing.name);
      const existEmb = existing.embedding || embeddingMap.get(existing.id);
      let vSim = 0;
      if (newEmb && existEmb) {
        vSim = cosineSimilarity(newEmb, existEmb);
      }

      if (nSim >= nameThreshold || vSim >= vectorThreshold) {
        candidates.push({ newNode, existing, nameSim: nSim, vectorSim: vSim });
      } else if (nSim >= nameThreshold * 0.7 || vSim >= vectorThreshold * 0.8) {
        nearMisses++;
      }
    }
  }

  if (candidates.length === 0) {
    if (nearMisses > 0) console.log(`${LOG_PREFIX} Merge: 0 candidates (${nearMisses} near-misses — consider lowering thresholds)`);
    return;
  }

  console.log(`${LOG_PREFIX} Merge: found ${candidates.length} candidate pair(s) — auto-approving (server mode)`);
  const approved = candidates;

  const processedRemovedIds = new Set<string>();

  // Execute merges: keep the earlier-created node, absorb the newer one
  for (const { newNode, existing } of approved) {
    if (processedRemovedIds.has(newNode.id) || processedRemovedIds.has(existing.id)) {
      console.log(`${LOG_PREFIX} Merge skipped: "${newNode.name}" or "${existing.name}" was already merged in this batch.`);
      continue;
    }

    const currentNew = ns.getNode(newNode.id);
    const currentExisting = ns.getNode(existing.id);
    if (!currentNew || !currentExisting) continue;

    try {
      // Determine keep/remove: lore nodes are ALWAYS kept (canonical)
      let keepNode: OmniNode, removeNode: OmniNode;
      if (currentExisting.type === 'lore') {
        keepNode = currentExisting;
        removeNode = currentNew;
      } else if (currentNew.type === 'lore') {
        keepNode = currentNew;
        removeNode = currentExisting;
      } else {
        keepNode = (currentExisting.creationTurn <= currentNew.creationTurn) ? currentExisting : currentNew;
        removeNode = keepNode === currentExisting ? currentNew : currentExisting;
      }

      if (keepNode.type === 'lore') {
        // Can't use merge_nodes on lore — manually transfer relationships then delete extraLore
        for (const rel of removeNode.relationships || []) {
          if (rel.targetId !== keepNode.id && !keepNode.relationships.some(r => r.targetId === rel.targetId)) {
            keepNode.relationships.push({ ...rel });
          }
        }
        for (const n of ns.getAllNodes()) {
          if (n.id === keepNode.id || n.id === removeNode.id) continue;
          for (const rel of n.relationships || []) {
            if (rel.targetId === removeNode.id) {
              rel.targetId = keepNode.id; // Redirect to lore node
            }
          }
        }
        ns.removeNode(removeNode.id);
        ns._rebuildReverseRelIndex();

        processedRemovedIds.add(removeNode.id);
        console.log(`${LOG_PREFIX} Merged (into lore): "${removeNode.name}" → "${keepNode.name}"`);
      } else {
        _executeSingleTool(ns, 'merge_nodes', {
          keepId: keepNode.id,
          removeId: removeNode.id,
          mergedContent: keepNode.content + '\n\n---\n' + removeNode.content,
        }, 'merge');

        processedRemovedIds.add(removeNode.id);
        console.log(`${LOG_PREFIX} Merged: "${removeNode.name}" → "${keepNode.name}"`);
      }
    } catch (e) {
      console.log(`${LOG_PREFIX} Merge error for "${currentNew.name}" ↔ "${currentExisting.name}": ${(e as Error).message}`);
    }
  }
}

// ── 파이프라인 주입용 실물 의존성 묶음 ──
export const realNodeEditAgent: NodeEditAgentDeps = {
  runNodeEditAgent: (text, msgs, config, personaName, characterName, simulBot, ns) =>
    runNodeEditAgent(text, msgs, config, personaName, characterName, simulBot, ns),
  postProcessExtraLoreMerge: (ids, config, ns) =>
    postProcessExtraLoreMerge(ids, config, ns),
};
