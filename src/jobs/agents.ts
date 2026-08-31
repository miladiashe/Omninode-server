// 오토드림 에이전트 3종 + ATLAS.md 생성 — 원본 이식 (Phase 6).
//   shouldRunCommunityDetection / runCommunityDetectionAgent (L5896–6257)
//   runOrphanLinkingAgent (L6263–6400, _findOrphanNodes는 node-edit-agent.ts에 기이식)
//   runWorldSimAgent (L6772–6933, DEFAULT_WORLD_SIM_PROMPT → prompts.ts의 worldSim)
//   generateAtlasMdUpdate (L4334–4386) + buildNodeContextForAux (L4189–4207)
//   _auxOutputBudget (L4210–4215)
//
// 의도적 차이:
//  - nodeStore 전역 대신 ns 인자 주입 (서버는 채팅별 세션 — PLAN §4 공유 상태 캡슐화)
//  - _yieldToEventLoop/_dreamProfiler/performance.now 프레임 양보 제거 — 서버는 UI
//    스레드가 없고 잡이 세션 락(runExclusive) 안에서 돌므로 불필요
//  - autodreamScheduler.isCancelled/_pipelineLock 중단 검사 제거 — 세션 락이 파이프라인
//    진입을 원천 차단하므로 배치 사이 중단 검사가 성립하지 않음
//  - getPersonaName() 라이브 조회 대신 인자 전달 (서버는 Risu 접근 불가)
//  - 원본 worldsim이 addLongTermMemoryNode에 globalKeywords를 넘기지만 원본 시그니처가
//    이를 무시함(L1340) — 서버판은 이제 보존함: 원본과의 의도적 차이, 사용자 승인(2026-08-06)
import type { OmniNodeStore, OmniNode } from '../core/node-store.js';
import {
  LOG_PREFIX, robustParseJSON, _compactNow, estimateTokens, estimateMessagesTokens,
  normalizeRelType, clampStrength, defaultDirectionForType, _extractCompactTs,
} from '../core/util.js';
import { callLLM, stripThought, _resolveAuxLlm, DEFAULT_CONTEXT_WINDOW, type LlmConfig, type ChatMessage } from '../llm/client.js';
import { DEFAULT_PROMPTS } from '../llm/prompts.js';
import { louvainCommunityDetection, buildGraphFromNodeStore, splitOversizedCommunities } from '../core/louvain.js';
import { _findOrphanNodes, _findPotentialLinks, _executeSingleTool } from '../pipeline/node-edit-agent.js';
import type { OmniConfig } from '../config-store.js';

const COMMUNITY_NEW_NODE_THRESHOLD = 25;  // run when N+ new nodes since last run
const ORPHAN_LINK_MIN_NODES = 3;          // minimum orphans to justify an LLM call
const ORPHAN_LINK_BATCH_SIZE = 10;        // max orphans per LLM batch

export function shouldRunCommunityDetection(ns: OmniNodeStore): boolean {
  if (ns._nodesSinceLastCommunity >= COMMUNITY_NEW_NODE_THRESHOLD) return true;
  return false;
}

// Budget-aware maxTokens calculator for aux LLM calls (원본 L4210)
function _auxOutputBudget(messages: ChatMessage[], desiredMax: number, config: OmniConfig): number {
  const auxLlm = _resolveAuxLlm(config as unknown as LlmConfig);
  const auxCtxWindow = auxLlm.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const inputEst = estimateMessagesTokens(messages);
  return Math.min(desiredMax, Math.max(200, auxCtxWindow - inputEst - 100));
}

// 원본 L4189 — top 노드로 보조 LLM용 경량 컨텍스트 구성
export function buildNodeContextForAux(rankedNodes: Array<{ node: OmniNode; score: number }>, config: OmniConfig): string {
  const auxLlm = _resolveAuxLlm(config as unknown as LlmConfig);
  const auxCtxWindow = auxLlm.contextWindow || DEFAULT_CONTEXT_WINDOW;
  // Reserve ~15% of aux context for node context, capped at 4000 tokens
  const nodeCtxBudget = Math.max(300, Math.min(4000, Math.floor(auxCtxWindow * 0.15)));

  let used = 0;
  const parts: string[] = [];
  for (const { node, score } of rankedNodes) {
    if (score < 0.05) break;
    const snippet = node.content.length > 250 ? node.content.substring(0, 250) + '…' : node.content;
    const line = `[${node.type}] ${node.name}: ${snippet}`;
    const tokens = estimateTokens(line);
    if (used + tokens > nodeCtxBudget) break;
    parts.push(line);
    used += tokens;
  }
  return parts.length > 0 ? parts.join('\n') : '';
}

// ── Community Detection Agent (원본 L5903) ──────────────────────────
export async function runCommunityDetectionAgent(ns: OmniNodeStore, config: OmniConfig): Promise<number> {
  try {
    if (!shouldRunCommunityDetection(ns)) {
      console.log(`${LOG_PREFIX} Community detection: skipped (turn delta=${ns.currentTurn - ns._lastCommunityTurn}, newNodes=${ns._nodesSinceLastCommunity})`);
      return 0;
    }

    const activeCount = ns.getActiveNodes().length;
    console.log(`${LOG_PREFIX} Community detection: starting (turn ${ns.currentTurn}, ${activeCount} active nodes)`);

    // Phase 1: Build graph and run Louvain
    const { nodes: graphNodes, edges } = await buildGraphFromNodeStore(ns);
    console.log(`${LOG_PREFIX} Community detection: graph built (${graphNodes.length} nodes, ${edges.length} edges)`);
    if (graphNodes.length < 3) {
      console.log(`${LOG_PREFIX} Community detection: too few nodes (${graphNodes.length}), skipping`);
      ns._lastCommunityTurn = ns.currentTurn;
      ns._nodesSinceLastCommunity = 0;
      return 0;
    }

    const louvainResult = await louvainCommunityDetection(graphNodes, edges);
    const { communities, hierarchy } = louvainResult;
    if (communities.size === 0) {
      ns._lastCommunityTurn = ns.currentTurn;
      ns._nodesSinceLastCommunity = 0;
      return 0;
    }

    // Group nodes by community
    const communityGroups = new Map<number | string, string[]>(); // commId → [nodeId, ...]
    for (const [nodeId, commId] of communities) {
      if (!communityGroups.has(commId)) communityGroups.set(commId, []);
      communityGroups.get(commId)!.push(nodeId);
    }

    console.log(`${LOG_PREFIX} Community detection: ${communityGroups.size} communities found from ${graphNodes.length} nodes`);

    // 크기 캡 + 재귀 분할 (원작 이탈 — louvain.ts splitOversizedCommunities 헤더 참조. 0=원작 무제한)
    const maxCommSize = Math.max(0, Math.trunc(Number(config.maxCommunitySize)) || 0);
    if (maxCommSize > 0) {
      await splitOversizedCommunities(communityGroups, edges, maxCommSize, (id) => {
        const n = ns.getNode(id);
        return (n?.creationTurn || 0) * 1e13 + (Number(_extractCompactTs(n?.timestamp)) || 0);
      });
    }

    // Phase 2: Incremental update — match new communities to existing ones
    const JACCARD_KEEP_THRESHOLD = 0.7;   // ≥70% overlap → keep existing summary
    const JACCARD_UPDATE_THRESHOLD = 0.3; // 30-70% overlap → re-summarize with new members
    // <30% overlap → treat as entirely new community

    const existingLevel0 = [...ns.communityNodes.values()].filter(cn => cn.level === 0);
    const existingLevel1 = [...ns.communityNodes.values()].filter(cn => cn.level === 1);
    const matchedExistingIds = new Set<string>();

    function jaccardSimilarity(setA: Set<string> | string[], setB: Set<string> | string[]): number {
      const a = setA instanceof Set ? setA : new Set(setA);
      const b = setB instanceof Set ? setB : new Set(setB);
      let intersection = 0;
      for (const v of a) { if (b.has(v)) intersection++; }
      const union = a.size + b.size - intersection;
      return union === 0 ? 0 : intersection / union;
    }

    function findBestMatch(memberIds: string[], existingNodes: OmniNode[]): { node: OmniNode | null; score: number } {
      const memberSet = new Set(memberIds);
      let bestNode: OmniNode | null = null, bestScore = 0;
      for (const cn of existingNodes) {
        if (matchedExistingIds.has(cn.id)) continue;
        const score = jaccardSimilarity(memberSet, cn.memberNodeIds || []);
        if (score > bestScore) { bestScore = score; bestNode = cn; }
      }
      return { node: bestNode, score: bestScore };
    }

    async function generateCommunitySummary(members: OmniNode[], commId: number | string) {
      // 원본은 앞 15멤버 × 200자만 읽었음 (76멤버 커뮤니티에서 61멤버가 0자 반영 —
      // 2026-08-03 실측). 전문 읽기로 교체 (사용자 결정): 시간순 정렬 후 보조 LLM
      // 컨텍스트 예산까지 전문, 넘치면 나머지는 이름만 (존재는 알린다).
      const sysPrompt = config.communitySummaryPrompt || DEFAULT_PROMPTS.communitySummary;
      const perChars = Math.max(0, Math.trunc(Number(config.communitySummaryMemberChars)) || 0); // 0=전문
      const sorted = [...members].sort((a, b) =>
        (a.creationTurn || 0) - (b.creationTurn || 0) || (_extractCompactTs(a.timestamp) || '').localeCompare(_extractCompactTs(b.timestamp) || ''));
      const outputMax = Math.min(1500, 400 + members.length * 15);
      const auxLlm = _resolveAuxLlm(config as unknown as LlmConfig);
      const auxCtxWindow = auxLlm.contextWindow || DEFAULT_CONTEXT_WINDOW;
      const inputBudget = Math.max(2000, auxCtxWindow - estimateTokens(sysPrompt) - outputMax - 300);
      let used = 0;
      const entryLines: string[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const n = sorted[i];
        const body = perChars > 0 ? (n.content || '').slice(0, perChars) : (n.content || '');
        let line = `${i + 1}. [${n.type}] ${n.name || 'unnamed'}${n.timestamp ? ` (ts:${n.timestamp})` : ''}: ${body}`;
        let tok = estimateTokens(line);
        if (used + tok > inputBudget) {
          line = `${i + 1}. [${n.type}] ${n.name || 'unnamed'} (content omitted for budget)`;
          tok = estimateTokens(line);
          if (used + tok > inputBudget) break;
        }
        entryLines.push(line);
        used += tok;
      }
      const summaryResult = await callLLM([
        { role: 'system', content: sysPrompt },
        { role: 'user', content: `Community of ${members.length} related nodes:\n\n${entryLines.join('\n')}` },
      ], { _config: config as unknown as LlmConfig, _useAux: true, maxTokens: outputMax, _label: 'community summary' });
      if (!summaryResult) return null;

      const parsed = robustParseJSON(summaryResult) as Record<string, any> | null;
      const title = (parsed && parsed.title) ? String(parsed.title).trim() : `Community ${commId}`;
      const summary = (parsed && parsed.summary) ? String(parsed.summary).trim() : summaryResult.trim();
      let keywords: string[] = (parsed && Array.isArray(parsed.keywords)) ? parsed.keywords : [];
      if (!keywords.length) {
        keywords = members.flatMap(n => n.keywords || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 7);
      }
      const timestamp = (parsed && typeof parsed.timestamp === 'string' && /^\d{10}$/.test(parsed.timestamp))
        ? parsed.timestamp : _compactNow();
      return { title, summary, keywords, timestamp };
    }

    // Phase 3: Parallelized level-0 community summaries
    let summariesCreated = 0;
    let summariesReused = 0;
    let summariesUpdated = 0;
    const MIN_COMMUNITY_SIZE = 3;
    const MAX_CONCURRENT_LLM = 3;
    const level0Communities: Array<{ commId: number | string; node: OmniNode }> = [];

    interface LlmTask { type: 'update' | 'new'; commId: number | string; memberIds: string[]; members: OmniNode[]; existingMatch: OmniNode | null }
    const llmTasks: LlmTask[] = [];

    for (const [commId, memberIds] of communityGroups) {
      if (memberIds.length < MIN_COMMUNITY_SIZE) continue;
      const members = memberIds.map(id => ns.getNode(id)).filter((n): n is OmniNode => !!n && !n.archived);
      if (members.length < MIN_COMMUNITY_SIZE) continue;

      const { node: existingMatch, score: jaccard } = findBestMatch(memberIds, existingLevel0);

      if (existingMatch && jaccard >= JACCARD_KEEP_THRESHOLD) {
        matchedExistingIds.add(existingMatch.id);
        existingMatch.memberNodeIds = memberIds;
        existingMatch.communityId = `comm_${commId}`;
        existingMatch.timestamp = _compactNow();
        existingMatch.relationships = members.slice(0, 20).map(m => ({
          targetId: m.id, direction: 'uni', type: 'parent', strength: 4, createdAtTurn: ns.currentTurn,
        }));
        level0Communities.push({ commId, node: existingMatch });
        summariesReused++;
      } else if (existingMatch && jaccard >= JACCARD_UPDATE_THRESHOLD) {
        matchedExistingIds.add(existingMatch.id);
        llmTasks.push({ type: 'update', commId, memberIds, members, existingMatch });
      } else {
        llmTasks.push({ type: 'new', commId, memberIds, members, existingMatch: null });
      }
    }

    // Run community LLM calls with concurrency limit
    if (llmTasks.length > 0) {
      const llmResults: PromiseSettledResult<Awaited<ReturnType<typeof generateCommunitySummary>>>[] = [];
      for (let batch = 0; batch < llmTasks.length; batch += MAX_CONCURRENT_LLM) {
        const slice = llmTasks.slice(batch, batch + MAX_CONCURRENT_LLM);
        const batchResults = await Promise.allSettled(
          slice.map(task => generateCommunitySummary(task.members, task.commId))
        );
        llmResults.push(...batchResults);
      }
      for (let i = 0; i < llmTasks.length; i++) {
        const task = llmTasks[i];
        const settled = llmResults[i];
        const result = (settled && settled.status === 'fulfilled') ? settled.value : null;
        if (!result) continue;

        const rels = task.members.slice(0, 20).map(m => ({
          targetId: m.id, direction: 'uni', type: 'parent', strength: 4, createdAtTurn: ns.currentTurn,
        }));

        if (task.type === 'update' && task.existingMatch) {
          task.existingMatch.name = result.title;
          task.existingMatch.content = result.summary;
          task.existingMatch.keywords = result.keywords.map(k => String(k).trim()).filter(Boolean);
          task.existingMatch.memberNodeIds = task.memberIds;
          task.existingMatch.communityId = `comm_${task.commId}`;
          task.existingMatch.timestamp = result.timestamp;
          task.existingMatch.relationships = rels;
          level0Communities.push({ commId: task.commId, node: task.existingMatch });
          summariesUpdated++;
        } else {
          const commNode = ns.addCommunityNode({
            name: result.title,
            content: result.summary,
            keywords: result.keywords.map(k => String(k).trim()).filter(Boolean),
            importance: 5,
            creationTurn: ns.currentTurn,
            relationships: rels,
            timestamp: result.timestamp,
            communityId: `comm_${task.commId}`,
            memberNodeIds: task.memberIds,
          });
          level0Communities.push({ commId: task.commId, node: commNode });
          summariesCreated++;
        }
      }
    }

    // Remove unmatched old level-0 communities (their community dissolved)
    for (const old of existingLevel0) {
      if (!matchedExistingIds.has(old.id)) {
        ns.removeNode(old.id);
      }
    }

    console.log(`${LOG_PREFIX} Community L0: ${summariesCreated} new, ${summariesUpdated} updated, ${summariesReused} reused`);

    // Phase 4: Parallelized level-1 super-community summaries
    if (hierarchy.length > 1 && level0Communities.length > 3) {
      const lastLevel = hierarchy[hierarchy.length - 1];
      const superGroups = new Map<number | string, OmniNode[]>();
      for (const { commId, node } of level0Communities) {
        const firstMember = (communityGroups.get(commId) || [])[0];
        const superCommId = firstMember ? (lastLevel.get(firstMember) ?? commId) : commId;
        if (!superGroups.has(superCommId)) superGroups.set(superCommId, []);
        superGroups.get(superCommId)!.push(node);
      }

      const matchedSuperIds = new Set<string>();
      interface SuperTask { superCommId: number | string; childNodes: OmniNode[]; childNodeIds: string[]; existingSuper: OmniNode | null }
      const superLlmTasks: SuperTask[] = [];

      for (const [superCommId, childNodes] of superGroups) {
        if (childNodes.length < 2) continue;
        const childNodeIds = childNodes.map(cn => cn.id);
        const { node: existingSuper, score: sJaccard } = findBestMatch(childNodeIds, existingLevel1);

        if (existingSuper && sJaccard >= JACCARD_KEEP_THRESHOLD) {
          matchedSuperIds.add(existingSuper.id);
          existingSuper.memberNodeIds = childNodeIds;
          existingSuper.communityId = `comm_super_${superCommId}`;
          existingSuper.timestamp = _compactNow();
          existingSuper.relationships = childNodes.map(cn => ({
            targetId: cn.id, direction: 'uni', type: 'parent', strength: 5, createdAtTurn: ns.currentTurn,
          }));
          for (const cn of childNodes) { cn.parentCommunityId = existingSuper.communityId; }
        } else {
          if (existingSuper) matchedSuperIds.add(existingSuper.id);
          superLlmTasks.push({ superCommId, childNodes, childNodeIds, existingSuper });
        }
      }

      if (superLlmTasks.length > 0) {
        const superPrompt = config.superCommunityPrompt || DEFAULT_PROMPTS.superCommunity;
        const superResults: PromiseSettledResult<string | null>[] = [];
        for (let batch = 0; batch < superLlmTasks.length; batch += MAX_CONCURRENT_LLM) {
          const slice = superLlmTasks.slice(batch, batch + MAX_CONCURRENT_LLM);
          const batchResults = await Promise.allSettled(
            slice.map(task => {
              const childSummaries = task.childNodes.map((n, i) =>
                `${i + 1}. ${n.name}${n.timestamp ? ` (ts:${n.timestamp})` : ''}: ${(n.content || '').slice(0, 250)}`
              ).join('\n');
              return callLLM([
                { role: 'system', content: superPrompt },
                { role: 'user', content: `Sub-community summaries:\n\n${childSummaries}` },
              ], { _config: config as unknown as LlmConfig, _useAux: true, maxTokens: 400, _label: 'super community' });
            })
          );
          superResults.push(...batchResults);
        }

        for (let i = 0; i < superLlmTasks.length; i++) {
          const task = superLlmTasks[i];
          const settled = superResults[i];
          const raw = (settled && settled.status === 'fulfilled') ? settled.value : null;
          if (!raw) continue;

          const parsed = robustParseJSON(raw) as Record<string, any> | null;
          const superTitle = (parsed && parsed.title) ? String(parsed.title).trim() : `Overview ${task.superCommId}`;
          const superSummary = (parsed && parsed.summary) ? String(parsed.summary).trim() : raw.trim();
          const keywords: string[] = (parsed && Array.isArray(parsed.keywords)) ? parsed.keywords : [];
          const superTimestamp = (parsed && typeof parsed.timestamp === 'string' && /^\d{10}$/.test(parsed.timestamp))
            ? parsed.timestamp : _compactNow();
          const relationships = task.childNodes.map(cn => ({
            targetId: cn.id, direction: 'uni', type: 'parent', strength: 5, createdAtTurn: ns.currentTurn,
          }));

          if (task.existingSuper) {
            task.existingSuper.name = superTitle;
            task.existingSuper.content = superSummary;
            task.existingSuper.keywords = keywords.map(k => String(k).trim()).filter(Boolean);
            task.existingSuper.memberNodeIds = task.childNodeIds;
            task.existingSuper.communityId = `comm_super_${task.superCommId}`;
            task.existingSuper.timestamp = superTimestamp;
            task.existingSuper.relationships = relationships;
          } else {
            const superNode = ns.addCommunityNode({
              name: superTitle,
              content: superSummary,
              keywords: keywords.map(k => String(k).trim()).filter(Boolean),
              importance: 5,
              creationTurn: ns.currentTurn,
              relationships,
              timestamp: superTimestamp,
              communityId: `comm_super_${task.superCommId}`,
              level: 1,
              memberNodeIds: task.childNodeIds,
            });
            for (const cn of task.childNodes) { cn.parentCommunityId = superNode.communityId; }
          }
          summariesCreated++;
        }
      }

      // Remove unmatched old level-1 communities
      for (const old of existingLevel1) {
        if (!matchedSuperIds.has(old.id) && !matchedExistingIds.has(old.id)) {
          ns.removeNode(old.id);
        }
      }
    } else {
      // No hierarchy needed — remove stale level-1 nodes
      for (const old of existingLevel1) {
        ns.removeNode(old.id);
      }
    }

    // Phase 5: Node cleanup (detect orphans, duplicates)
    let cleanedCount = 0;
    const allActive = ns.getActiveNodes();
    const allNodeIds = new Set(allActive.map(n => n.id));
    for (const node of allActive) {
      if (node.type !== 'longTermMemory') continue;
      // Orphan detection: LTM with zero relationships and very old
      const hasRels = (node.relationships || []).some(r => allNodeIds.has(r.targetId));
      const isOld = (ns.currentTurn - node.creationTurn) > 150;
      const isLowUtility = node.utilityScore < 10 && node.activationScore < 5;
      if (!hasRels && isOld && isLowUtility) {
        node.archived = true;
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      console.log(`${LOG_PREFIX} Community agent: archived ${cleanedCount} orphan nodes`);
    }

    ns._lastCommunityTurn = ns.currentTurn;
    ns._nodesSinceLastCommunity = 0;

    console.log(`${LOG_PREFIX} Community detection complete: ${summariesCreated} new, ${summariesUpdated} updated, ${summariesReused} reused, ${cleanedCount} orphans archived`);
    return summariesCreated;
  } catch (e) {
    console.log(`${LOG_PREFIX} Community detection error: ${(e as Error).message}`);
    return 0;
  }
}

// ── Orphan Node Linking Agent (원본 L6286) ──────────────────────────
export async function runOrphanLinkingAgent(ns: OmniNodeStore, config: OmniConfig, precomputedOrphans: OmniNode[] | null = null): Promise<number> {
  const orphans = precomputedOrphans || _findOrphanNodes(ns);
  if (orphans.length < ORPHAN_LINK_MIN_NODES) {
    console.log(`${LOG_PREFIX} Orphan linking: skipped (only ${orphans.length} orphans)`);
    return 0;
  }

  console.log(`${LOG_PREFIX} Orphan linking: starting (${orphans.length} orphans found)`);

  // Prioritize newer orphans, process ALL in batches of BATCH_SIZE
  const sorted = orphans.sort((a, b) => b.creationTurn - a.creationTurn);

  const systemPrompt = `You are a knowledge graph relationship analyzer. Given an orphan node (a node with few/no connections) and its potential link candidates, determine which relationships should be created.

Relationship types: "causes", "enables", "prevents", "contradicts", "develops", "related", "parent"
Strength: 1 (weak) to 5 (very strong)
Direction: "bi" (bidirectional, default) or "uni" (one-way, source→target)

Rules:
- Only create relationships where genuine semantic connection exists
- Prefer "related" type when the connection is topical but not causal
- Use "parent" for hierarchical containment (e.g., character→faction)
- Be conservative: a wrong link is worse than no link
- You may create multiple links if multiple candidates are genuinely related
- If none of the candidates have a meaningful connection, return an empty links array: {"links": []}

Output valid JSON only:
{
  "links": [
    { "targetId": "...", "type": "related", "strength": 3, "direction": "bi" }
  ]
}`;

  const linkedIds = new Set<string>();
  let totalLinksCreated = 0;

  for (let i = 0; i < sorted.length; i += ORPHAN_LINK_BATCH_SIZE) {
    const batch = sorted.slice(i, i + ORPHAN_LINK_BATCH_SIZE);
    console.log(`${LOG_PREFIX} Orphan linking: processing batch ${Math.floor(i / ORPHAN_LINK_BATCH_SIZE) + 1}/${Math.ceil(sorted.length / ORPHAN_LINK_BATCH_SIZE)} (${batch.length} orphans)`);

    const tasks = batch.map(orphan => async () => {
      const candidates = _findPotentialLinks(ns, orphan, 6);
      if (candidates.length === 0) return 0;

      const orphanData = {
        id: orphan.id,
        type: orphan.type,
        name: orphan.name || orphan.keywords?.[0] || orphan.id,
        content: orphan.content.substring(0, 300),
        keywords: (orphan.keywords || []).slice(0, 8),
        candidates: candidates.map(c => ({
          id: c.node.id,
          type: c.node.type,
          name: c.node.name || c.node.keywords?.[0] || c.node.id,
          keywords: (c.node.keywords || []).slice(0, 5),
          content: c.node.content.substring(0, 150),
          reason: c.reason,
        })),
      };

      const userPrompt = `Analyze this orphan node and determine connections to the candidates:\n\n${JSON.stringify(orphanData, null, 1)}`;

      try {
        const result = await callLLM([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ], { _config: config as unknown as LlmConfig, _useAux: true, jsonMode: true, maxTokens: 512, _label: 'orphan linking' });

        if (!result) return 0;

        const raw = stripThought(result).content;
        const parsed = robustParseJSON(raw) as Record<string, any> | null;
        if (!parsed) return 0;

        let count = 0;
        if (Array.isArray(parsed.links)) {
          for (const link of parsed.links) {
            const targetId = link.targetId;
            if (!targetId) continue;
            const src = ns.getNode(orphan.id);
            const tgt = ns.getNode(targetId);
            if (!src || !tgt) continue;
            if (src.relationships.some(r => r.targetId === targetId)) continue;
            _executeSingleTool(ns, 'add_relationship', {
              sourceId: orphan.id,
              targetId,
              type: link.type || 'related',
              strength: link.strength ?? 3,
              direction: link.direction || 'bi',
            }, 'orphanLink');
            count++;
            linkedIds.add(orphan.id);
          }
        }
        return count;
      } catch (e) {
        console.log(`${LOG_PREFIX} Orphan linking: error for ${orphan.id}: ${(e as Error).message}`);
        return 0;
      }
    });

    const results = await Promise.allSettled(tasks.map(fn => fn()));
    for (const r of results) {
      if (r.status === 'fulfilled') totalLinksCreated += r.value;
    }
  }

  console.log(`${LOG_PREFIX} Orphan linking: ${totalLinksCreated} links created from ${sorted.length} orphans (${Math.ceil(sorted.length / ORPHAN_LINK_BATCH_SIZE)} batches)`);
  return totalLinksCreated;
}

// ── World Sim Agent (원본 L6809) ────────────────────────────────────
export async function runWorldSimAgent(ns: OmniNodeStore, config: OmniConfig, personaName = ''): Promise<number> {
  const maxNodes = Math.max(1, Math.min(10, Math.trunc(Number(config.worldSimMaxNodes)) || 5));

  // Build world context
  const allNodes = ns.getAllNodes().filter(n => !n.archived);

  // Gather entities (characters, locations, items)
  const entities = allNodes
    .filter(n => n.type === 'extraLore')
    .sort((a, b) => (b.activationScore || 0) - (a.activationScore || 0))
    .slice(0, 10)
    .map(n => `[Entity:${n.id}] ${n.name}: ${(n.content || '').substring(0, 200)}`);

  // Gather lore (canon facts)
  const lore = allNodes
    .filter(n => n.type === 'lore')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 8)
    .map(n => `[Lore:${n.id}] ${n.name}: ${(n.content || '').substring(0, 200)}`);

  // Gather recent memories (what happened recently)
  const recentMemories = allNodes
    .filter(n => n.type === 'longTermMemory')
    .sort((a, b) => (b.creationTurn || 0) - (a.creationTurn || 0))
    .slice(0, 8)
    .map(n => `[Memory:${n.id}] ${n.name}: ${(n.content || '').substring(0, 150)}`);

  // Gather community summaries
  const communities = allNodes
    .filter(n => n.type === 'communitySummary')
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 5)
    .map(n => `[Community:${n.id}] ${n.name}: ${(n.content || '').substring(0, 200)}`);

  const contextParts: string[] = [];
  if (ns.atlasMd) contextParts.push(`## World Atlas\n${ns.atlasMd}`);
  if (entities.length > 0) contextParts.push(`## Known Entities\n${entities.join('\n')}`);
  if (lore.length > 0) contextParts.push(`## Canon Lore\n${lore.join('\n')}`);
  if (recentMemories.length > 0) contextParts.push(`## Recent Events\n${recentMemories.join('\n')}`);
  if (communities.length > 0) contextParts.push(`## Thematic Clusters\n${communities.join('\n')}`);

  if (contextParts.length === 0) {
    console.log(`${LOG_PREFIX} World Sim: no world context available, skipping`);
    return 0;
  }

  const sysPrompt = config.worldSimPrompt || DEFAULT_PROMPTS.worldSim;
  const userPrompt = `Current world state:\n\n${contextParts.join('\n\n')}\n\n---\n\nPlayer character: ${personaName || '(unknown)'}\nGenerate up to ${maxNodes} off-screen events happening elsewhere in the world. Focus on events that could naturally become relevant later.`;

  const messages: ChatMessage[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: userPrompt },
  ];

  const maxOut = _auxOutputBudget(messages, 2000, config);

  try {
    const response = await callLLM(messages, { maxTokens: maxOut, _config: config as unknown as LlmConfig, jsonMode: true, _label: 'world sim' });
    if (!response) {
      console.log(`${LOG_PREFIX} World Sim: no LLM response`);
      return 0;
    }

    const cleaned = stripThought(response).content.trim();

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
      else throw new Error('No valid JSON in response');
    }

    const events = Array.isArray(parsed.events) ? parsed.events.slice(0, maxNodes) : [];
    if (events.length === 0) {
      console.log(`${LOG_PREFIX} World Sim: LLM returned no events`);
      return 0;
    }

    // 보조 모델이 JSON 문자열 안 개행을 이중 이스케이프(\\n)로 내보내는 경우가 있어
    // 파스 결과에 리터럴 \n이 남는다 (T116 월드심 배치 실측) — 실제 개행으로 정규화
    const _unescape = (t: unknown) => String(t ?? '').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
    let created = 0;
    for (const ev of events) {
      if (!ev.name || !ev.content) continue;
      const importance = Math.max(1, Math.min(3, Math.trunc(Number(ev.importance)) || 2));
      const added = ns.addLongTermMemoryNode({
        name: _unescape(ev.name),
        content: _unescape(ev.content),
        keywords: Array.isArray(ev.keywords) ? ev.keywords.slice(0, 8) : [],
        globalKeywords: Array.isArray(ev.globalKeywords) ? ev.globalKeywords.slice(0, 8) : [],
        importance,
        activationScore: 30.0,
        creationTurn: ns.currentTurn,
        timestamp: ev.timestamp || null,
        relationships: [],
      });
      added.worldSim = true;

      // Add relationships to existing nodes
      if (Array.isArray(ev.relationships)) {
        for (const rel of ev.relationships) {
          if (!rel.targetId || !ns.getNode(rel.targetId)) continue;
          const relType = normalizeRelType(rel.type || 'related');
          const strength = clampStrength(rel.strength ?? 2);
          ns.updateNode(added.id, {
            relationships: [
              ...(added.relationships || []),
              { targetId: rel.targetId, type: relType, strength, direction: defaultDirectionForType(relType), createdAtTurn: ns.currentTurn },
            ],
          });
        }
      }
      created++;
    }

    console.log(`${LOG_PREFIX} 🌍 World Sim: created ${created} off-screen event nodes`);
    return created;
  } catch (e) {
    console.log(`${LOG_PREFIX} World Sim error: ${(e as Error).message}`);
    return 0;
  }
}

// ── Atlas MD (Front Page) — 원본 L4334 ──────────────────────────────
// ── Reevaluation Note Compaction (서버판 추가 — 사용자 아이디어 2026-08-01, 게이트 도달로 구현 2026-08-05) ──
// [Updated] 노트가 쌓인 LTM/extraLore는 "현재 시점의 정합된 사실 하나"로 재작성한다.
// 제작자 원문인 lore는 첫 [Updated] 앞의 본문을 그대로 두고 노트들만 하나로 병합한다.
// 재작성 = 원문 파괴 위험(beta27 S1 교훈)이므로: ①실행 전 상태는 diff 스냅샷이 보존
// ②출력 가드 실패 시 무변경 ③모든 타입이 회당 상한을 공유해 저빈도를 유지.
export async function runCompactionAgent(ns: OmniNodeStore, config: OmniConfig): Promise<number> {
  if (config.reevalCompactionEnabled === false) return 0;
  const minNotes = Math.max(2, Math.trunc(Number(config.reevalCompactionMinNotes)) || 3);
  const maxPerRun = Math.max(1, Math.trunc(Number(config.reevalCompactionMaxPerRun)) || 2);

  const candidates = ns.getActiveNodes()
    .filter(n => {
      const noteCount = (n.content.match(/\[Updated\]/g) || []).length;
      if ((n.type !== 'longTermMemory' && n.type !== 'extraLore' && n.type !== 'lore') || noteCount < minNotes) return false;
      if (n.type === 'lore' && n._loreCompactionSkipAtNotes !== undefined) {
        if (noteCount <= n._loreCompactionSkipAtNotes) return false;
        delete n._loreCompactionSkipAtNotes;
      }
      return true;
    })
    .sort((a, b) => (b.content.match(/\[Updated\]/g) || []).length - (a.content.match(/\[Updated\]/g) || []).length)
    .slice(0, maxPerRun);
  if (candidates.length === 0) return 0;

  const sysPrompt = config.compactionPrompt || DEFAULT_PROMPTS.compaction;
  let compacted = 0;
  for (const node of candidates) {
    const before = node.content;
    const noteCount = (before.match(/\[Updated\]/g) || []).length;

    if (node.type === 'lore') {
      const firstNoteAt = before.indexOf('[Updated]');
      const head = before.slice(0, firstNoteAt);
      const notesTail = before.slice(firstNoteAt);
      const originalNotesTextLength = notesTail.split('[Updated]').slice(1)
        .reduce((sum, note) => sum + note.trim().length, 0);
      const configuredLoreNoteCompactionMaxRatio = Number(config.loreNoteCompactionMaxRatio);
      const loreNoteCompactionLengthGuardEnabled = configuredLoreNoteCompactionMaxRatio !== 0;
      const loreNoteCompactionMaxRatio = Number.isNaN(configuredLoreNoteCompactionMaxRatio)
        ? 0.85
        : Math.min(Math.max(configuredLoreNoteCompactionMaxRatio, 0.1), 1.0);
      const maxMergedNoteLength = originalNotesTextLength * loreNoteCompactionMaxRatio;
      const lorePrompt = config.loreNoteCompactionPrompt || DEFAULT_PROMPTS.loreNoteCompaction;
      const messages: ChatMessage[] = [
        { role: 'system', content: lorePrompt },
        { role: 'user', content: `ORIGINAL LORE BODY (read-only context):\n${head}\n\nALL CORRECTION NOTES TO MERGE:\n${notesTail}` },
      ];

      try {
        const out = await callLLM(messages, {
          maxTokens: _auxOutputBudget(messages, 2000, config), _config: config as unknown as LlmConfig,
          _useAux: true, _label: 'lore note compaction',
        });
        const mergedNote = stripThought(out).content.trim();
        if (!mergedNote || mergedNote.includes('[Updated]')
          || (loreNoteCompactionLengthGuardEnabled && mergedNote.length > maxMergedNoteLength)) {
          node._loreCompactionSkipAtNotes = noteCount;
          console.log(`${LOG_PREFIX} Compaction(lore-notes): guard rejected output for "${node.name}" (len ${mergedNote.length} > ${loreNoteCompactionMaxRatio * 100}% of ${originalNotesTextLength} (${maxMergedNoteLength})) — keeping original`);
          continue;
        }
        node.content = `${head}\n[Updated] ${mergedNote}`;
        compacted++;
        console.log(`${LOG_PREFIX} Compaction(lore-notes): ${node.name} ${noteCount} notes → 1`);
      } catch (e) {
        console.log(`${LOG_PREFIX} Compaction(lore-notes): error for "${node.name}": ${(e as Error).message} — keeping original`);
      }
      continue;
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: before },
    ];
    const out = await callLLM(messages, {
      maxTokens: _auxOutputBudget(messages, 2000, config), _config: config as unknown as LlmConfig,
      _useAux: true, _label: 'note compaction',
    });
    if (!out) continue;
    const text = stripThought(out).content.trim();
    // 가드: 템플릿 유지 + 노트 소멸 + 과도 축소(원문 노트 제외 분량의 60% 미만) 거부
    const baseLen = before.indexOf('[Updated]') > 0 ? before.indexOf('[Updated]') : before.length;
    if (!text.startsWith('###') || text.includes('[Updated]') || text.length < baseLen * 0.6) {
      console.log(`${LOG_PREFIX} Compaction: guard rejected output for "${node.name}" (len ${text.length} vs base ${baseLen}) — keeping original`);
      continue;
    }
    node.content = text;
    compacted++;
    console.log(`${LOG_PREFIX} Compaction: "${node.name}" ${before.length} → ${text.length} chars (${noteCount} notes folded)`);
  }
  return compacted;
}

export async function generateAtlasMdUpdate(currentAtlasMd: string, config: OmniConfig, ns: OmniNodeStore): Promise<string> {
  try {
    // Gather top community summaries
    const communities = [...ns.communityNodes.values()]
      .filter(n => !n.archived)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, 5);

    // Gather key lore nodes
    const keyLore = [...ns.loreNodes.values()]
      .filter(n => !n.archived)
      .sort((a, b) => (b.importance || 0) - (a.importance || 0))
      .slice(0, 5);

    // Gather top extraLore
    const keyExtra = [...ns.extraLoreNodes.values()]
      .filter(n => !n.archived)
      .sort((a, b) => (b.activationScore || 0) - (a.activationScore || 0))
      .slice(0, 3);

    const parts = [
      ...communities.map(n => `[Community] ${n.name || ''}: ${(n.content || '').substring(0, 300)}`),
      ...keyLore.map(n => `[Lore] ${n.name || ''}: ${(n.content || '').substring(0, 200)}`),
      ...keyExtra.map(n => `[ExtraLore] ${n.name || ''}: ${(n.content || '').substring(0, 150)}`),
    ];

    if (parts.length === 0) return currentAtlasMd;
    const context = parts.join('\n');

    const sysPrompt = `You are updating a knowledge atlas — a concise, high-level overview of all known characters, locations, factions, key objects, and ongoing story arcs. This atlas helps the system generate better search keywords.

Rules:
- Output a markdown document (200 words max)
- Structure: ## Characters, ## Locations, ## Key Objects, ## Active Plot Threads (use only sections that apply)
- Each entry = one line with the most important fact
- Preserve important info from the current atlas, update with new knowledge
- Write in English`;

    const msgs: ChatMessage[] = [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: `Current atlas:\n${currentAtlasMd || '(empty)'}\n\nKnowledge nodes:\n${context}` },
    ];
    const maxOut = _auxOutputBudget(msgs, 500, config);
    const result = await callLLM(msgs, { maxTokens: maxOut, _useAux: true, _config: config as unknown as LlmConfig, _label: 'atlas md' });

    if (!result) return currentAtlasMd;
    const cleaned = stripThought(result).content.trim();
    return cleaned || currentAtlasMd;
  } catch (e) {
    console.log(`${LOG_PREFIX} generateAtlasMdUpdate error: ${(e as Error).message}`);
    return currentAtlasMd;
  }
}
