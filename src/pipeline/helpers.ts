// 파이프라인 헬퍼 — 원본 이식:
//   메시지 헬퍼/injectPlaceholder/orderLoreByReranker (L6963–7074)
//   extractKeywords/extractNodeKeywords (MODULE 7, L4522–4656)
//   summarizeCutTurns (L5834–5889)
//   convertToLTMNodes (L6935–6961)
// 의도적 차이: 전역 nodeStore → ns 파라미터, processingTracker → no-op,
// 노드 편집 에이전트는 주입식 인터페이스(NodeEditAgentDeps) — Phase 4b에서 실물 이식.
import { OmniNodeStore } from '../core/node-store.js';
import {
  LOG_PREFIX, _dbg, contentHash, cosineSimilarity, robustParseJSON, _evictOldest,
} from '../core/util.js';
import { callLLM, stripThought } from '../llm/client.js';
import { callReranker, getCachedTextEmbeddings, applyChatRegexFilters } from '../llm/embeddings.js';
import type { OmniConfig } from '../config-store.js';

export interface PipelineMessage {
  role: string;
  content: string;
  removable?: boolean;
  [k: string]: unknown;
}

// ── Message helpers (L6963–6990) ──

export function getChatIndices(messages: PipelineMessage[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].removable === true && (messages[i].role === 'user' || messages[i].role === 'assistant')) {
      indices.push(i);
    }
  }
  return indices;
}

export function countTurns(msgs: unknown[]): number {
  return msgs.length;
}

export function getShortTermWindowValue(cfg: { shortTermWindow?: unknown } | null | undefined): number {
  const v = parseInt(cfg?.shortTermWindow as string, 10);
  return Number.isNaN(v) ? 9 : Math.max(0, v);
}

export function splitAtTurnBoundary<T>(msgs: T[], keepTurns: number): { cut: T[]; kept: T[] } {
  if (msgs.length <= keepTurns) {
    return { cut: [], kept: msgs };
  }
  const splitIdx = msgs.length - keepTurns;
  return { cut: msgs.slice(0, splitIdx), kept: msgs.slice(splitIdx) };
}

export function injectPlaceholder(messages: PipelineMessage[], placeholder: string, content: string): boolean {
  let found = false;
  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'g');
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].content && messages[i].content.includes(placeholder)) {
      messages[i] = { ...messages[i], content: messages[i].content.replace(re, content || '') };
      found = true;
    }
  }
  return found;
}

// ── Keyword extraction (MODULE 7) ──

const _keywordCache = new Map<string, { keywords: string[]; turn: number; timestamp: number }>();
const KEYWORD_CACHE_MAX = 10;
const KEYWORD_CACHE_TTL = 3600000; // 1 hour

export async function extractKeywords(
  recentMessages: Array<{ role: string; content: unknown }>,
  config: OmniConfig,
  atlasMd: string,
  currentTurn = 0,
): Promise<string[]> {
  if (!recentMessages || recentMessages.length === 0) return [];

  const text = applyChatRegexFilters(recentMessages.map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  ).join('\n'), config);

  // Cache check: same input text → reuse keywords (e.g. reroll/swipe)
  const hash = contentHash(text);
  const cached = _keywordCache.get(hash);
  if (cached && (Date.now() - cached.timestamp) < KEYWORD_CACHE_TTL) {
    console.log(`${LOG_PREFIX} Keyword cache hit (hash ${hash.substring(0, 8)})`);
    return cached.keywords;
  }

  // Always use ATLAS.md-based LLM keyword extraction
  const atlasCtx = atlasMd
    ? `\n\nKnowledge atlas (use this to understand the world and improve keyword selection):\n${atlasMd}`
    : '';

  try {
    const result = await callLLM([
      {
        role: 'system',
        content: `Extract the 8-12 most important keywords and concepts from this conversation that would be useful for retrieving relevant context. Include character names, locations, events, emotions, objects, and key topics. Return ONLY a JSON array of strings.${atlasCtx}`,
      },
      { role: 'user', content: text },
    ], { _config: config, maxTokens: 200, _useAux: true, _label: 'chat keywords' });

    const parsed = robustParseJSON(result);
    if (Array.isArray(parsed)) {
      const keywords = parsed.filter(k => typeof k === 'string' && k.trim()).slice(0, 15);
      _keywordCache.set(hash, { keywords, turn: currentTurn, timestamp: Date.now() });
      _evictOldest(_keywordCache as Map<unknown, unknown>, KEYWORD_CACHE_MAX);
      return keywords;
    }
    return [];
  } catch (e) {
    console.log(`${LOG_PREFIX} extractKeywords error: ${(e as Error).message}`);
    return [];
  }
}

function _glinerHeaders(apiKey: string | undefined): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey.trim()) h['Authorization'] = `Bearer ${apiKey.trim()}`;
  return h;
}

export async function extractNodeKeywords(text: string, config: OmniConfig): Promise<string[]> {
  if (!text || !text.trim()) return [];
  const mode = config.useGliner ? 'gliner' : 'llm';

  if (mode === 'gliner') {
    const glinerUrl = (config.glinerEndpoint || '').trim();
    if (glinerUrl) {
      try {
        const labels = Array.isArray(config.glinerLabels) && config.glinerLabels.length > 0
          ? config.glinerLabels
          : ['person', 'place', 'time', 'organization', 'object', 'event', 'emotion', 'concept'];
        const resp = await fetch(glinerUrl, {
          method: 'POST',
          headers: _glinerHeaders(config.glinerApiKey),
          body: JSON.stringify({ text: text.substring(0, 1500), labels }),
        });
        if (resp.ok) {
          const data = await resp.json() as any;
          const entities = data?.result?.entities || data?.entities || {};
          const keywords: string[] = [];
          for (const label of Object.keys(entities)) {
            const vals = entities[label];
            if (Array.isArray(vals)) {
              for (const v of vals) {
                if (typeof v === 'string' && v.trim() && !keywords.includes(v.trim())) {
                  keywords.push(v.trim());
                }
              }
            }
          }
          return keywords.slice(0, 7);
        }
      } catch (e) {
        console.log(`${LOG_PREFIX} GLiNER node keyword error: ${(e as Error).message}`);
      }
    }
    return [];
  }

  // LLM mode
  try {
    const result = await callLLM([
      {
        role: 'system',
        content: 'You are a keyword extraction assistant. Given a lorebook entry, extract 3-7 activation keywords that would trigger this entry in context. Return ONLY a JSON array of strings, e.g. ["keyword1","keyword2","keyword3"]. Keywords should be specific nouns, names, or distinctive terms from the content.',
      },
      { role: 'user', content: text.substring(0, 1500) },
    ], { _config: config, _useAux: true, _label: 'lore keywords' });
    const parsed = robustParseJSON(result);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(k => String(k).trim()).filter(Boolean);
    }
    return [];
  } catch (e) {
    console.log(`${LOG_PREFIX} LLM node keyword error: ${(e as Error).message}`);
    return [];
  }
}

// ── Summarize cut turns (L5834–5889) ──

const _summaryCache = new Map<string, { summary: string; timestamp: number }>();
const SUMMARY_CACHE_MAX = 10;
const SUMMARY_CACHE_TTL = 3600000; // 1 hour

export async function summarizeCutTurns(cutMessages: Array<{ role: string; content: unknown }>, config: OmniConfig): Promise<string> {
  if (!cutMessages || cutMessages.length === 0) return '';
  const text = applyChatRegexFilters(cutMessages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n'), config);

  // Cache check: same cutMsgs content → reuse summary (e.g. reroll/swipe)
  const hash = contentHash(text);
  const cached = _summaryCache.get(hash);
  if (cached && (Date.now() - cached.timestamp) < SUMMARY_CACHE_TTL) {
    console.log(`${LOG_PREFIX} Summary cache hit (hash ${hash.substring(0, 8)})`);
    return cached.summary;
  }

  try {
    const result = await callLLM([
      {
        role: 'system',
        content: 'Summarize the following conversation turns into a concise paragraph. Preserve key events, character actions, emotional states, and important details. Write in narrative style, third-person perspective.',
      },
      { role: 'user', content: text },
    ], { _config: config, maxTokens: 400, _useAux: true, _label: 'summarize' });
    const summary = result ? stripThought(result).content.trim() : '';
    if (summary) {
      _summaryCache.set(hash, { summary, timestamp: Date.now() });
      _evictOldest(_summaryCache as Map<unknown, unknown>, SUMMARY_CACHE_MAX);
    }
    return summary;
  } catch (e) {
    console.log(`${LOG_PREFIX} summarizeCutTurns error: ${(e as Error).message}`);
    return '';
  }
}

// ── LTM conversion (L6935–6961) — 노드 편집 에이전트는 주입식 ──

export interface NodeEditAgentDeps {
  runNodeEditAgent: (
    text: string,
    msgs: Array<{ role: string; content: unknown }>,
    config: OmniConfig,
    personaName: string,
    characterName: string,
    simulBot: boolean,
    ns: OmniNodeStore,
  ) => Promise<{ totalActions: number; createdExtraLoreIds: string[]; ok?: boolean; affectedNodeIds?: string[] }>;
  postProcessExtraLoreMerge?: (createdIds: string[], config: OmniConfig, ns: OmniNodeStore) => Promise<void>;
}

// Phase 4b에서 실물 이식 전까지의 기본 스텁 — 아무 노드도 만들지 않고 경고만 남긴다
export const stubNodeEditAgent: NodeEditAgentDeps = {
  async runNodeEditAgent() {
    console.log(`${LOG_PREFIX} runNodeEditAgent: not yet ported (Phase 4b) — skipping LTM conversion`);
    return { totalActions: 0, createdExtraLoreIds: [] };
  },
};

export async function convertToLTMNodes(
  oldMessages: Array<{ role: string; content: unknown }>,
  config: OmniConfig,
  personaName: string,
  characterName: string,
  simulBot: boolean,
  ns: OmniNodeStore,
  deps: NodeEditAgentDeps,
): Promise<{ ok: boolean; affectedNodeIds: string[] }> {
  if (!oldMessages || oldMessages.length === 0) return { ok: true, affectedNodeIds: [] }; // 변환할 것 없음 = 성공

  let msgs = oldMessages;
  if (config.useOnlyAssistantRole) {
    msgs = msgs.filter(m => m.role === 'assistant');
  }
  if (msgs.length === 0) return { ok: true, affectedNodeIds: [] };

  const text = applyChatRegexFilters(msgs
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n'), config);

  try {
    const { totalActions, createdExtraLoreIds, ok, affectedNodeIds } = await deps.runNodeEditAgent(
      text, msgs, config, personaName, characterName, simulBot, ns,
    );
    console.log(`${LOG_PREFIX} LTM node-edit: ${totalActions} total actions`);

    // Post-process merge for extraLore
    if (createdExtraLoreIds.length > 0 && deps.postProcessExtraLoreMerge) {
      await deps.postProcessExtraLoreMerge(createdExtraLoreIds, config, ns);
    }
    // ok 미표기(스텁/구식 deps)는 성공으로 간주. false = LLM 무응답/파싱 실패
    return { ok: ok !== false, affectedNodeIds: affectedNodeIds || [] };
  } catch (e) {
    console.log(`${LOG_PREFIX} convertToLTMNodes error: ${(e as Error).message}`);
    return { ok: false, affectedNodeIds: [] };
  }
}

// ── Lore ordering by reranker (L7008–7074) ──

const _loreOrderCache = new Map<string, string[]>(); // key -> ordered nodeId array

export interface LorePart { nodeId: string; name: string; content: string }

export async function orderLoreByReranker(loreParts: LorePart[], keywords: string[], config: OmniConfig, ns: OmniNodeStore): Promise<LorePart[]> {
  if (!Array.isArray(loreParts) || loreParts.length < 2) return loreParts;

  const cacheKey = `${(keywords || []).slice(0, 16).join('|')}::${loreParts.map(p => `${p.nodeId}:${contentHash(p.content || '')}`).join('|')}`;
  const cachedOrder = _loreOrderCache.get(cacheKey);
  if (Array.isArray(cachedOrder) && cachedOrder.length === loreParts.length) {
    const byId = new Map(loreParts.map(p => [p.nodeId, p]));
    const ordered: LorePart[] = [];
    for (const id of cachedOrder) {
      const part = byId.get(id);
      if (part) ordered.push(part);
    }
    if (ordered.length === loreParts.length) return ordered;
  }

  const query = (keywords || []).slice(0, 12).join(', ') || '';
  const documents = loreParts.map(p => {
    const label = String(p.name || p.nodeId || '').slice(0, 60);
    const compact = String(p.content || '').replace(/\s+/g, ' ').slice(0, 300);
    return `${label}: ${compact}`;
  });

  // Strategy 1: Dedicated reranker API (Jina/Cohere-compatible)
  if (config.rerankerEndpoint) {
    try {
      const results = await callReranker(query, documents, config);
      if (results && results.length === loreParts.length) {
        const ordered = results.map(r => loreParts[r.index]);
        _loreOrderCache.set(cacheKey, ordered.map(p => p.nodeId));
        _evictOldest(_loreOrderCache as Map<unknown, unknown>, 200);
        _dbg(`${LOG_PREFIX} Lore reranked via API (${ordered.length} items)`);
        return ordered;
      }
    } catch (e) {
      console.log(`${LOG_PREFIX} Reranker API failed, falling back to embedding: ${(e as Error).message}`);
    }
  }

  // Strategy 2: Embedding-based cosine similarity reranking (세션 스토어의 텍스트 임베딩 캐시 사용)
  if (config.embeddingEnabled && query) {
    try {
      const [queryEmbs, docEmbs] = await Promise.all([
        getCachedTextEmbeddings([query], config, ns),
        getCachedTextEmbeddings(documents, config, ns),
      ]);
      if (queryEmbs && queryEmbs[0] && docEmbs && docEmbs.length === loreParts.length) {
        const scored = loreParts.map((p, i) => ({
          part: p,
          score: docEmbs[i] ? cosineSimilarity(queryEmbs[0], docEmbs[i]) : 0,
        }));
        scored.sort((a, b) => b.score - a.score);
        const ordered = scored.map(s => s.part);
        _loreOrderCache.set(cacheKey, ordered.map(p => p.nodeId));
        _evictOldest(_loreOrderCache as Map<unknown, unknown>, 200);
        _dbg(`${LOG_PREFIX} Lore reranked via embedding similarity (${ordered.length} items)`);
        return ordered;
      }
    } catch (e) {
      console.log(`${LOG_PREFIX} Embedding reranking failed: ${(e as Error).message}`);
    }
  }

  // Fallback: return original order
  return loreParts;
}
