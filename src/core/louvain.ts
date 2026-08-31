// 원본 MODULE 4B: LOUVAIN COMMUNITY DETECTION (L2897–3228)의 이식.
// 원본과의 의도적 차이:
//  - 원본 L2952의 로그가 TDZ(선언 전 참조: hasDelta/_dirtyNodes)로 ReferenceError를 던지는
//    버그가 있어(간선이 1개라도 있으면 항상 실패, 호출부 try/catch가 삼킴) 로그를
//    선언 이후로 이동해 수정했다. 차분 테스트가 원본의 throw를 증명한다.
//  - _yieldToEventLoop: MessageChannel 대신 setImmediate (서버 환경, 동작 동일)
import type { OmniNodeStore } from './node-store.js';
import { LOG_PREFIX, _dbg, contentHash } from './util.js';

export interface GraphNode { id: string }
export interface GraphEdge { source: string; target: string; weight: number }
export interface LouvainResult {
  communities: Map<string, number | string>;
  hierarchy: Array<Map<string, number | string>>;
}

function _yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// 모듈 상태 (warm-start / fingerprint 캐시) — 원본의 모듈 레벨 let과 동일
let _prevLouvainCommunities: Map<string, number | string> | null = null;
let _louvainGraphFingerprint: string | null = null;
let _louvainCachedResult: LouvainResult | null = null;

export function _resetLouvainState() {
  _prevLouvainCommunities = null;
  _louvainGraphFingerprint = null;
  _louvainCachedResult = null;
}

function _computeGraphFingerprint(nodes: GraphNode[], edges: GraphEdge[]): string {
  // Sort node IDs and edge keys for deterministic fingerprint
  const nodeIds = nodes.map(n => n.id).sort();
  const edgeKeys = edges.map(e => {
    const [a, b] = [e.source, e.target].sort();
    return `${a}|${b}|${(e.weight || 1).toFixed(2)}`;
  }).sort();
  return contentHash(nodeIds.join(',') + '\x00' + edgeKeys.join(','));
}

// ── 크기 캡 + 재귀 분할 (원작 이탈, 사용자 승인 2026-08-03) ────────────────
// 연속 단일 서사에서 Louvain이 스토리 전체를 한 블롭으로 뭉치는 문제(T100 실측
// 85노드) 대응. 원작 전 버전에 최대 크기 개념 없음(MIN_COMMUNITY_SIZE만 존재).
// 초과 군집은 서브그래프에서 Louvain을 재실행해 나누고(전역에서 안 보이던 내부
// 경계가 소규모에서는 드러남 — 해상도 한계의 역이용), 그래도 안 나뉘는 밀집
// 덩어리는 시간순 이등분 폴백으로 캡을 보장한다. 분할이 있어야 beta27 계층
// (슈퍼 커뮤니티)도 묶을 재료가 생긴다. communityGroups를 제자리 수정.
export async function splitOversizedCommunities(
  communityGroups: Map<number | string, string[]>,
  edges: GraphEdge[],
  maxSize: number,
  getNodeOrder: (id: string) => number,
): Promise<number> {
  if (maxSize <= 0) return 0;
  const oversized = [...communityGroups.entries()].filter(([, m]) => m.length > maxSize);
  let splits = 0;
  for (const [commId, memberIds] of oversized) {
    communityGroups.delete(commId);
    const pieces: string[][] = [];
    const stack: string[][] = [memberIds];
    while (stack.length > 0) {
      const group = stack.pop()!;
      if (group.length <= maxSize) { pieces.push(group); continue; }
      const idSet = new Set(group);
      const subNodes: GraphNode[] = group.map(id => ({ id }));
      const subEdges = edges.filter(e => idSet.has(e.source) && idSet.has(e.target));
      const subRes = await louvainCommunityDetection(subNodes, subEdges);
      const subGroups = new Map<number | string, string[]>();
      for (const [nid, cid] of subRes.communities) {
        if (!subGroups.has(cid)) subGroups.set(cid, []);
        subGroups.get(cid)!.push(nid);
      }
      const parts = [...subGroups.values()];
      if (parts.length >= 2 && Math.max(...parts.map(p => p.length)) < group.length) {
        stack.push(...parts);
      } else {
        // Louvain이 경계를 못 찾는 덩어리 — 시간순 이등분 (항상 크기 감소 → 종료 보장)
        const sorted = [...group].sort((a, b) => getNodeOrder(a) - getNodeOrder(b));
        const mid = Math.ceil(sorted.length / 2);
        stack.push(sorted.slice(0, mid), sorted.slice(mid));
      }
    }
    pieces.forEach((piece, i) => communityGroups.set(`${commId}_s${i}`, piece));
    splits++;
    console.log(`${LOG_PREFIX} Community split: ${commId}(${memberIds.length}) → ${pieces.length} sub-communities (cap ${maxSize})`);
  }
  return splits;
}

export async function louvainCommunityDetection(nodes: GraphNode[], edges: GraphEdge[]): Promise<LouvainResult> {
  // nodes: [{ id }], edges: [{ source, target, weight }]
  if (nodes.length === 0) return { communities: new Map(), hierarchy: [] };

  // Graph fingerprint cache: skip if graph unchanged
  const graphFp = _computeGraphFingerprint(nodes, edges);
  if (graphFp === _louvainGraphFingerprint && _louvainCachedResult) {
    console.log(`${LOG_PREFIX} Louvain: graph fingerprint cache hit, skipping recompute`);
    return _louvainCachedResult;
  }

  const nodeIds = nodes.map(n => n.id);
  const nodeIdxMap = new Map<string, number>();
  nodeIds.forEach((id, i) => nodeIdxMap.set(id, i));
  let N = nodeIds.length;

  // Build adjacency: adjWeights[i] = Map<j, weight>
  let adjWeights: Array<Map<number, number>> = Array.from({ length: N }, () => new Map());
  let totalWeight = 0;
  for (const e of edges) {
    const si = nodeIdxMap.get(e.source);
    const ti = nodeIdxMap.get(e.target);
    if (si === undefined || ti === undefined) continue;
    if (si === ti) continue;
    const w = e.weight || 1;
    adjWeights[si].set(ti, (adjWeights[si].get(ti) || 0) + w);
    adjWeights[ti].set(si, (adjWeights[ti].get(si) || 0) + w);
    totalWeight += w;
  }
  if (totalWeight === 0) {
    const comm = new Map<string, number | string>();
    nodeIds.forEach(id => comm.set(id, id));
    return { communities: comm, hierarchy: [comm] };
  }

  let m2 = totalWeight * 2;
  // k[i] = sum of weights of edges incident to i
  let k: number[] = new Array(N).fill(0);
  for (let i = 0; i < N; i++) {
    for (const w of adjWeights[i].values()) k[i] += w;
  }

  // community[i] = community index of node i (in current-level graph)
  let community: number[] = Array.from({ length: N }, (_, i) => i);

  // Warm-start: seed from previous run's community assignments if enough overlap
  if (_prevLouvainCommunities && _prevLouvainCommunities.size > 0) {
    let hitCount = 0;
    const prevCommToNew = new Map<number | string, number>(); // map old community labels → new contiguous indices
    let nextCommIdx = 0;
    for (let i = 0; i < N; i++) {
      const prevComm = _prevLouvainCommunities.get(nodeIds[i]);
      if (prevComm !== undefined) {
        if (!prevCommToNew.has(prevComm)) prevCommToNew.set(prevComm, nextCommIdx++);
        community[i] = prevCommToNew.get(prevComm)!;
        hitCount++;
      } else {
        community[i] = nextCommIdx++;
      }
    }
    if (hitCount > N * 0.5) {
      _dbg(`${LOG_PREFIX} Louvain warm-start: ${hitCount}/${N} nodes seeded from previous communities`);
    } else {
      // Not enough overlap, fall back to cold start
      for (let i = 0; i < N; i++) community[i] = i;
    }
  }

  // Detect delta nodes: nodes that are new or whose neighborhood changed since last run
  const _dirtyNodes = new Set<number>(); // indices of nodes that need re-evaluation
  if (_prevLouvainCommunities && _prevLouvainCommunities.size > 0) {
    const prevNodeSet = new Set(_prevLouvainCommunities.keys());
    for (let i = 0; i < N; i++) {
      if (!prevNodeSet.has(nodeIds[i])) {
        // New node — mark it and its neighbors as dirty
        _dirtyNodes.add(i);
        for (const j of adjWeights[i].keys()) _dirtyNodes.add(j);
      }
    }
  }
  const hasDelta = _dirtyNodes.size > 0 && _dirtyNodes.size < N;
  // (원본 버그 수정: 이 로그는 원래 L2952에서 hasDelta/_dirtyNodes 선언 전에 실행되어 TDZ throw)
  console.log(`${LOG_PREFIX} Louvain: N=${N}, totalWeight=${totalWeight}${hasDelta ? `, delta=${_dirtyNodes.size} dirty nodes` : ''}`);

  // nodeToOriginal[i] = set of original node indices that super-node i represents
  let nodeToOriginal: number[][] = Array.from({ length: N }, (_, i) => [i]);
  const hierarchyLevels: Array<Map<string, number | string>> = [];

  async function _louvainPass(level: number): Promise<boolean> {
    const sigmaTot = new Float64Array(N);
    for (let i = 0; i < N; i++) sigmaTot[community[i]] += k[i];

    const sigmaIn = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      for (const [j, w] of adjWeights[i]) {
        if (community[i] === community[j]) sigmaIn[community[i]] += w;
      }
    }
    for (let c = 0; c < N; c++) sigmaIn[c] /= 2;

    // Build iteration order: dirty (delta) nodes first on level 0 for incremental processing
    const order = Array.from({ length: N }, (_, i) => i);
    if (level === 0 && hasDelta) {
      // Put dirty nodes at the front so they settle first
      const dirty: number[] = [], stable: number[] = [];
      for (let i = 0; i < N; i++) {
        if (_dirtyNodes.has(i)) dirty.push(i); else stable.push(i);
      }
      // Shuffle within each group
      for (let i = dirty.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = dirty[i]; dirty[i] = dirty[j]; dirty[j] = tmp;
      }
      for (let i = stable.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = stable[i]; stable[i] = stable[j]; stable[j] = tmp;
      }
      const merged = dirty.concat(stable);
      for (let i = 0; i < N; i++) order[i] = merged[i];
    } else {
      // Fisher-Yates shuffle to avoid order bias
      for (let i = N - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      }
    }

    let improved = true;
    let anyMoved = false;
    const isLargeGraph = N > 2000;
    // Fewer iterations when we have a warm-start with delta — stable nodes converge fast
    const MAX_INNER_ITER = isLargeGraph ? 25 : (level === 0 && hasDelta ? 15 : 50);
    const YIELD_BUDGET_MS = 4; // yield frequently to minimize UI jank
    let iterCount = 0;
    const neighborComms = new Map<number, number>(); // reuse across nodes to reduce GC pressure
    while (improved && iterCount < MAX_INNER_ITER) {
      improved = false;
      iterCount++;
      let movedThisIter = 0;
      let frameStart = performance.now();
      for (const i of order) {
        const ci = community[i];
        neighborComms.clear();
        for (const [j, w] of adjWeights[i]) {
          const cj = community[j];
          neighborComms.set(cj, (neighborComms.get(cj) || 0) + w);
        }

        const ki = k[i];
        const ki_in = neighborComms.get(ci) || 0;

        let bestDelta = 0;
        let bestComm = ci;

        const removeDelta = -(ki_in / totalWeight) + (sigmaTot[ci] * ki) / (m2 * m2 / 2);

        for (const [cj, wj] of neighborComms) {
          if (cj === ci) continue;
          const addDelta = (wj / totalWeight) - (sigmaTot[cj] * ki) / (m2 * m2 / 2);
          const delta = removeDelta + addDelta;
          if (delta > bestDelta) {
            bestDelta = delta;
            bestComm = cj;
          }
        }

        if (bestComm !== ci && bestDelta > 1e-10) {
          sigmaTot[ci] -= ki;
          sigmaIn[ci] -= ki_in;
          community[i] = bestComm;
          sigmaTot[bestComm] += ki;
          sigmaIn[bestComm] += (neighborComms.get(bestComm) || 0);
          improved = true;
          anyMoved = true;
          movedThisIter++;
        }
        // Time-based yield: keep each frame under YIELD_BUDGET_MS
        if (performance.now() - frameStart >= YIELD_BUDGET_MS) {
          await _yieldToEventLoop();
          frameStart = performance.now();
        }
      }
      // Early exit: if <1% of nodes moved this iteration, further passes are unlikely to help
      if (iterCount > 1 && movedThisIter < Math.max(1, Math.floor(N * 0.01))) break;
      if (improved) await _yieldToEventLoop();
    }
    return anyMoved;
  }

  // originalCommunity[origIdx] tracks which community each original node belongs to
  const originalCommunity = Array.from({ length: nodeIds.length }, (_, i) => i);

  const isLargeGraph = N > 2000;
  const MAX_LEVELS = isLargeGraph ? 3 : 5;
  const LOUVAIN_TIME_BUDGET_MS = 5000; // abort if total Louvain exceeds this
  const louvainStartTime = performance.now();
  for (let level = 0; level < MAX_LEVELS; level++) {
    const moved = await _louvainPass(level);

    // Yield between Louvain levels to keep UI responsive
    await _yieldToEventLoop();

    // Time budget guard: abort early if Louvain is taking too long
    if (performance.now() - louvainStartTime > LOUVAIN_TIME_BUDGET_MS) {
      console.log(`${LOG_PREFIX} Louvain: time budget exceeded (${Math.round(performance.now() - louvainStartTime)}ms), stopping at level ${level}`);
      break;
    }

    // Renumber communities to contiguous 0..numComms-1
    const uniqueComms = [...new Set(community)];
    const remap = new Map<number, number>();
    uniqueComms.forEach((c, i) => remap.set(c, i));
    community = community.map(c => remap.get(c)!);
    const numComms = uniqueComms.length;

    // Update original node → community mapping
    for (let si = 0; si < N; si++) {
      for (const origIdx of nodeToOriginal[si]) {
        originalCommunity[origIdx] = community[si];
      }
    }

    // Save hierarchy snapshot (original nodeId → community)
    const snapshot = new Map<string, number | string>();
    for (let i = 0; i < nodeIds.length; i++) snapshot.set(nodeIds[i], originalCommunity[i]);
    hierarchyLevels.push(snapshot);

    if (!moved || numComms >= N) break;

    // Build super-graph: each community becomes a super-node
    const superAdj: Array<Map<number, number>> = Array.from({ length: numComms }, () => new Map());
    const superK: number[] = new Array(numComms).fill(0);
    const superNodeToOriginal: number[][] = Array.from({ length: numComms }, () => []);
    for (let i = 0; i < N; i++) {
      const ci = community[i];
      superK[ci] += k[i];
      for (const origIdx of nodeToOriginal[i]) superNodeToOriginal[ci].push(origIdx);
      for (const [j, w] of adjWeights[i]) {
        const cj = community[j];
        if (ci === cj) continue;
        superAdj[ci].set(cj, (superAdj[ci].get(cj) || 0) + w);
      }
    }

    // Replace working graph with super-graph
    adjWeights = superAdj;
    k = superK;
    N = numComms;
    nodeToOriginal = superNodeToOriginal;
    // Recompute totalWeight from super-graph
    totalWeight = 0;
    for (let i = 0; i < N; i++) {
      for (const w of adjWeights[i].values()) totalWeight += w;
    }
    totalWeight /= 2;
    m2 = totalWeight * 2;
    community = Array.from({ length: N }, (_, i) => i);
  }

  // Build final community assignment: nodeId → communityId
  const finalCommunities = new Map<string, number | string>();
  for (let i = 0; i < nodeIds.length; i++) {
    finalCommunities.set(nodeIds[i], originalCommunity[i]);
  }

  // Save for warm-start on next run
  _prevLouvainCommunities = finalCommunities;

  // Cache result with graph fingerprint
  const result: LouvainResult = { communities: finalCommunities, hierarchy: hierarchyLevels };
  _louvainGraphFingerprint = graphFp;
  _louvainCachedResult = result;

  return result;
}

// Build edge list from OmniNodeStore for Louvain
export async function buildGraphFromNodeStore(ns: OmniNodeStore): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  const allNodes = ns.getActiveNodes();
  const currentTurn = ns.currentTurn || 0;
  const AGE_THRESHOLD = 50;
  const ACTIVATION_THRESHOLD = 25;
  const eligibleNodes = allNodes.filter(n =>
    n.type === 'longTermMemory' &&
    ((currentTurn - (n.creationTurn || 0)) > AGE_THRESHOLD || (n.activationScore ?? 50) < ACTIVATION_THRESHOLD)
  );
  const eligibleIds = new Set(eligibleNodes.map(n => n.id));
  const nodes: GraphNode[] = eligibleNodes.map(n => ({ id: n.id }));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const relWeightMap: Record<string, number> = { causes: 0.7, enables: 0.6, prevents: 0.5, contradicts: 0.5, develops: 0.6, related: 0.3, parent: 0.8 };
  let frameStart = performance.now();
  const YIELD_BUDGET_MS = 4;
  for (const node of eligibleNodes) {
    for (const rel of (node.relationships || [])) {
      if (!eligibleIds.has(rel.targetId)) continue;
      const target = ns.getNode(rel.targetId);
      if (!target || target.archived) continue;
      const edgeKey = [node.id, rel.targetId].sort().join('|');
      if (seen.has(edgeKey)) continue;
      seen.add(edgeKey);
      const w = (rel.strength || 3) * (relWeightMap[rel.type] || 0.5);
      edges.push({ source: node.id, target: rel.targetId, weight: w });
    }
    if (performance.now() - frameStart >= YIELD_BUDGET_MS) {
      await _yieldToEventLoop();
      frameStart = performance.now();
    }
  }
  return { nodes, edges };
}
