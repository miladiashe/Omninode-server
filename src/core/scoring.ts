// 원본 MODULE 5: SCORING ENGINE (L3229–3473)의 이식. 로직 동일 유지.
import type { OmniNode } from './node-store.js';
import { OmniNodeStore } from './node-store.js';
import { LOG_PREFIX, _dbg, contentHash, cosineSimilarity, _evictOldest, _extractCompactTs, _compactTsToMinutes } from './util.js';

export interface ScoringConfig {
  relationshipWeights?: Record<string, number>;
  edgeHalfLife?: number;
  [k: string]: unknown;
}

export interface ScoreBreakdown {
  final: number;
  baseRelevance: number;
  contextMultiplier: number;
  recencyDecay: number;
}

export interface RankedNode {
  node: OmniNode;
  score: number;
  breakdown: ScoreBreakdown | null;
}

// ── Personalized PageRank (HippoRAG 2) ──
export function personalizedPageRank(
  seedNodeIds: Set<string>,
  nodeStore: OmniNodeStore,
  config: ScoringConfig | undefined,
  alpha = 0.15,
  iterations = 10,
): Map<string, number> {
  const allNodes = nodeStore.getActiveNodes();
  const N = allNodes.length;
  if (N === 0 || !seedNodeIds || seedNodeIds.size === 0) return new Map();

  const relWeights = config?.relationshipWeights || {};
  const defaultWeight = relWeights.default || 0.5;
  const currentTurn = nodeStore.currentTurn || 0;
  const edgeHalfLife = config?.edgeHalfLife || 100;
  const CONVERGENCE_EPS = 1e-6; // stop early when max rank change falls below this

  // Build adjacency list with temporal decay on edge weights
  const adj = new Map<string, Array<{ targetId: string; weight: number }>>();
  for (const n of allNodes) adj.set(n.id, []);

  for (const node of allNodes) {
    for (const rel of (node.relationships || [])) {
      if (!adj.has(rel.targetId)) continue;
      const baseW = (relWeights[(rel.type || 'related').toLowerCase()] ?? defaultWeight) * ((rel.strength || 3) / 5);
      const edgeAge = Math.max(0, currentTurn - (rel.createdAtTurn ?? node.creationTurn ?? 0));
      const temporalDecay = Math.pow(0.5, edgeAge / edgeHalfLife);
      adj.get(node.id)!.push({ targetId: rel.targetId, weight: baseW * temporalDecay });
    }
  }

  // Initialize: seed nodes get equal probability
  const seedWeight = 1.0 / seedNodeIds.size;
  let ranks = new Map<string, number>();
  for (const n of allNodes) ranks.set(n.id, seedNodeIds.has(n.id) ? seedWeight : 0);

  let convergedAt = iterations;
  for (let iter = 0; iter < iterations; iter++) {
    const newRanks = new Map<string, number>();
    for (const n of allNodes) {
      newRanks.set(n.id, alpha * (seedNodeIds.has(n.id) ? seedWeight : 0));
    }

    for (const node of allNodes) {
      const neighbors = adj.get(node.id);
      if (!neighbors || neighbors.length === 0) continue;
      const totalWeight = neighbors.reduce((s, e) => s + e.weight, 0);
      if (totalWeight === 0) continue;
      const share = (1 - alpha) * ranks.get(node.id)!;
      for (const edge of neighbors) {
        newRanks.set(edge.targetId, newRanks.get(edge.targetId)! + share * (edge.weight / totalWeight));
      }
    }

    // Convergence check: early exit when ranks stabilize
    let maxDelta = 0;
    for (const [id, newR] of newRanks) {
      const delta = Math.abs(newR - (ranks.get(id) || 0));
      if (delta > maxDelta) maxDelta = delta;
    }
    ranks = newRanks;
    if (maxDelta < CONVERGENCE_EPS) {
      convergedAt = iter + 1;
      break;
    }
  }
  if (convergedAt < iterations) {
    _dbg(`${LOG_PREFIX} PPR converged at iteration ${convergedAt}/${iterations}`);
  }

  // Normalize to 0–1
  let maxRank = 0;
  for (const r of ranks.values()) if (r > maxRank) maxRank = r;
  if (maxRank > 0) {
    for (const [id, r] of ranks) ranks.set(id, r / maxRank);
  }
  return ranks;
}

export function calculateBaseRelevance(node: OmniNode, recentChatEmbeddings: Float32Array[], pprScores: Map<string, number>): number {
  let cosinePart = 0;
  if (recentChatEmbeddings.length > 0 && node.embedding) {
    let maxSim = 0;
    for (let i = 0; i < recentChatEmbeddings.length; i++) {
      const recencyWeight = 1.0 - ((recentChatEmbeddings.length - 1 - i) * 0.05);
      const sim = cosineSimilarity(node.embedding, recentChatEmbeddings[i]) * recencyWeight;
      if (sim > maxSim) maxSim = sim;
    }
    cosinePart = Math.max(0, Math.min(1, maxSim));
  }

  // PPR-based graph relevance (replaces BFS 2-hop scoring)
  const hopPart = pprScores.get(node.id) || 0;

  return (cosinePart * 0.7) + (hopPart * 0.3);
}

// ── Context Multiplier ──
export function calculateContextMultiplier(node: OmniNode): number {
  const importanceBonus = (node.importance / 5) * 0.5;
  const activationBonus = (node.activationScore / 100) * 0.4;
  // MemRL utility factor: 0.7 (low utility) to 1.2 (high utility), neutral at 50
  const utilityRaw = (node.utilityScore ?? 50.0) / 50.0;
  const utilityFactor = Math.max(0.7, Math.min(1.2, 0.5 + utilityRaw * 0.5));
  return (1.0 + importanceBonus + activationBonus) * utilityFactor;
}

// ── Recency Decay (Bi-temporal: narrative time + insertion time) ──
export function calculateRecencyDecay(node: OmniNode, currentTurn: number, latestNarrativeTs: string): number {
  if (node.type === 'lore' || node.type === 'communitySummary') return 1.0;

  const age = currentTurn - node.creationTurn;

  let baseHalfLife = 50;
  if (node.type === 'extraLore') baseHalfLife = 200;

  const effectiveHalfLife = baseHalfLife + (node.importance * 20);
  const insertionDecay = Math.pow(0.5, age / effectiveHalfLife);

  // Narrative time decay (in-story temporal distance)
  let narrativeDecay = 1.0;
  const nodeTs = _extractCompactTs(node.timestamp);
  if (nodeTs && latestNarrativeTs && latestNarrativeTs > nodeTs) {
    const nodeMin = _compactTsToMinutes(nodeTs);
    const latestMin = _compactTsToMinutes(latestNarrativeTs);
    if (!isNaN(nodeMin) && !isNaN(latestMin) && latestMin > nodeMin) {
      const narrativeAgeMinutes = latestMin - nodeMin;
      const narrativeHalfLifeMinutes = 20 * 24 * 60; // 20 in-story days
      narrativeDecay = Math.pow(0.5, narrativeAgeMinutes / narrativeHalfLifeMinutes);
    }
  }

  const minFloor = (node.importance / 5) * 0.2;
  const blended = narrativeDecay * 0.4 + insertionDecay * 0.6;
  return Math.max(minFloor, blended);
}

// ── Final Score ──
export function calculateFinalScore(
  node: OmniNode,
  recentChatEmbeddings: Float32Array[],
  pprScores: Map<string, number>,
  latestNarrativeTs: string,
  currentTurn: number,
): ScoreBreakdown {
  const baseRelevance = calculateBaseRelevance(node, recentChatEmbeddings, pprScores);
  const contextMultiplier = calculateContextMultiplier(node);
  const recencyDecay = calculateRecencyDecay(node, currentTurn, latestNarrativeTs);
  const final = baseRelevance * contextMultiplier * recencyDecay;
  return { final, baseRelevance, contextMultiplier, recencyDecay };
}

// ── Type-Diversity Decay for context injection ──
export const DEFAULT_DIVERSITY_DECAY: Record<string, number> = {
  lore: 0.75, extraLore: 0.78,
  longTermMemory: 0.92, communitySummary: 0.90,
};
export const typeDiversityDecay: Record<string, number> = { ...DEFAULT_DIVERSITY_DECAY };

// ── PPR cache (avoids recomputation when graph unchanged, e.g. reroll/swipe) ──
const _pprCache = new Map<string, { scores: Map<string, number>; timestamp: number }>();
const PPR_CACHE_MAX = 5;

export function _resetPprCache() { _pprCache.clear(); }

function _pprCacheKey(seedNodeIds: Set<string>, nodeStore: OmniNodeStore, config: ScoringConfig | undefined): string {
  const seeds = [...seedNodeIds].sort().join(',');
  const activeNodes = nodeStore.getActiveNodes();
  const nCount = activeNodes.length;
  let rCount = 0;
  for (const n of activeNodes) rCount += (n.relationships || []).length;
  const turn = nodeStore.currentTurn || 0;
  return contentHash(`${seeds}|${nCount}|${rCount}|${turn}|${config?.edgeHalfLife || 100}`);
}

export function rankNodes(
  nodes: OmniNode[],
  recentChatEmbeddings: Float32Array[],
  seedNodeIds: Set<string> | null,
  nodeStore: OmniNodeStore,
  currentTurn: number,
  config: ScoringConfig | undefined,
  keywordMatchedIds?: Set<string>,
  globalMatchedIds?: Set<string>,
): RankedNode[] {
  // Pre-compute PPR scores once for all nodes (replaces per-node BFS)
  let pprScores = new Map<string, number>();
  if (seedNodeIds && seedNodeIds.size > 0) {
    const cacheKey = _pprCacheKey(seedNodeIds, nodeStore, config);
    const cached = _pprCache.get(cacheKey);
    if (cached) {
      pprScores = cached.scores;
      console.log(`${LOG_PREFIX} PPR cache hit (${seedNodeIds.size} seeds, hash ${cacheKey.substring(0, 8)})`);
    } else {
      pprScores = personalizedPageRank(seedNodeIds, nodeStore, config);
      _pprCache.set(cacheKey, { scores: pprScores, timestamp: Date.now() });
      _evictOldest(_pprCache as Map<unknown, unknown>, PPR_CACHE_MAX);
    }
  }

  // Find latest narrative timestamp for bi-temporal decay
  let latestNarrativeTs = '';
  for (const n of nodes) {
    const ts = _extractCompactTs(n.timestamp);
    if (ts && ts > latestNarrativeTs) latestNarrativeTs = ts;
  }

  const globalOnly = globalMatchedIds || new Set<string>();
  const scored: RankedNode[] = nodes.map(node => {
    const result = calculateFinalScore(node, recentChatEmbeddings, pprScores, latestNarrativeTs, currentTurn);
    let s = result.final;
    if (globalOnly.has(node.id)) s *= 0.7;
    return { node, score: (isNaN(s) || !isFinite(s)) ? 0 : s, breakdown: result };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function reciprocalRankFusion(keywordRanked: RankedNode[], vectorRanked: RankedNode[], k = 60): RankedNode[] {
  interface FusionEntry { node: OmniNode; rrfScore: number; kwScore: number; vecScore: number; breakdown: ScoreBreakdown | null }
  const rrfScores = new Map<string, FusionEntry>(); // nodeId → entry

  for (let i = 0; i < keywordRanked.length; i++) {
    const { node, score, breakdown } = keywordRanked[i];
    const entry = rrfScores.get(node.id) || { node, rrfScore: 0, kwScore: score, vecScore: 0, breakdown: breakdown || null };
    entry.rrfScore += 1.0 / (k + i + 1);
    entry.kwScore = score;
    if (breakdown) entry.breakdown = breakdown;
    rrfScores.set(node.id, entry);
  }

  for (let i = 0; i < vectorRanked.length; i++) {
    const { node, score, breakdown } = vectorRanked[i];
    const entry = rrfScores.get(node.id) || { node, rrfScore: 0, kwScore: 0, vecScore: score, breakdown: breakdown || null };
    entry.rrfScore += 1.0 / (k + i + 1);
    entry.vecScore = score;
    if (breakdown) entry.breakdown = breakdown;
    rrfScores.set(node.id, entry);
  }

  const fused = [...rrfScores.values()];
  fused.sort((a, b) => b.rrfScore - a.rrfScore);
  return fused.map(e => ({ node: e.node, score: e.rrfScore, breakdown: e.breakdown }));
}
