// 원본 MODULE 4: EMBEDDING ENGINE의 API 호출부 (L2535–2896)의 이식. 로직 동일 유지.
// 원본과의 의도적 차이:
//  - Risuai.nativeFetch → 전역 fetch
//  - 전역 nodeStore 의존 제거 → ns(OmniNodeStore) 파라미터 주입
//  - API가 반환하는 number[] 벡터를 Float32Array로 변환 (영속화 BLOB·메모리 효율과 일관)
import { OmniNodeStore, type OmniNode } from '../core/node-store.js';
import { LOG_PREFIX, _dbg, contentHash, robustParseJSON, _evictOldest, stripThoughtBlocks } from '../core/util.js';
import { llmFetchSignal, callLLM, getNextApiKey, _setLastError, type LlmConfig, type ChatMessage } from './client.js';
import { DEFAULT_PROMPTS } from './prompts.js';

export interface EmbeddingConfig extends LlmConfig {
  embeddingEnabled?: boolean;
  embeddingEndpoint?: string;
  embeddingModel?: string;
  embeddingApiKey?: string;
  excludeUserEmbedding?: boolean;
  hydeEnabled?: boolean;
  hydeCacheMax?: number;
  hydePrompt?: string | null;
  chatRegexFilters?: Array<{ pattern: string; flags?: string; replacement?: string }>;
  rerankerEndpoint?: string;
  rerankerModel?: string;
  rerankerApiKey?: string;
}

// ── Call Embedding API (batch) ──
export async function callEmbeddingApi(texts: string[], config: EmbeddingConfig): Promise<Float32Array[] | null> {
  _setLastError('embedding', null);
  if (!config.embeddingEnabled) {
    _setLastError('embedding', 'Embedding is not enabled');
    return null;
  }

  let endpoint = config.embeddingEndpoint;
  if (!endpoint && config.customLlm.apiUrl) {
    endpoint = config.customLlm.apiUrl.replace(/\/chat\/completions\/?$/, '/embeddings');
  }
  if (!endpoint) {
    console.log(`${LOG_PREFIX} Embedding endpoint not configured`);
    _setLastError('embedding', 'Embedding endpoint not configured');
    return null;
  }

  const apiKey = config.embeddingApiKey
    ? getNextApiKey({ apiKey: config.embeddingApiKey }, `embedding:${contentHash(config.embeddingApiKey || '')}`)
    : getNextApiKey(config.customLlm);
  const model = config.embeddingModel || 'text-embedding-3-small';

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: texts, model }),
      signal: llmFetchSignal(config),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      _setLastError('embedding', `HTTP ${resp.status}: ${err.substring(0, 300)}`);
      console.log(`${LOG_PREFIX} Embedding API error ${resp.status}: ${err.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json() as any;
    if (data.data && Array.isArray(data.data)) {
      const vectors = data.data
        .sort((a: any, b: any) => a.index - b.index)
        .map((d: any) => new Float32Array(d.embedding));
      if (vectors.length === 0) _setLastError('embedding', 'unexpected response format');
      return vectors;
    }
    _setLastError('embedding', 'unexpected response format');
    return null;
  } catch (e) {
    _setLastError('embedding', e instanceof Error ? e.message : String(e));
    console.log(`${LOG_PREFIX} Embedding API fetch error: ${(e as Error).message}`);
    return null;
  }
}

// ── Text Embedding Cache (content-hash → vector) ──
const TEXT_EMBED_CACHE_MAX = 2000; // beta27 값 채택 — 임베딩 API 호출 절감

function _trimTextEmbeddingCache(ns: OmniNodeStore) {
  _evictOldest(ns.textEmbeddingCache as Map<unknown, unknown>, TEXT_EMBED_CACHE_MAX);
}

// ── Reranker API (Jina/Cohere-compatible) ──
export async function callReranker(query: string, documents: string[], config: EmbeddingConfig): Promise<Array<{ index: number; score: number }> | null> {
  _setLastError('reranker', null);
  const endpoint = config.rerankerEndpoint;
  if (!endpoint) {
    _setLastError('reranker', 'Reranker endpoint not configured');
    return null;
  }
  if (documents.length === 0) {
    _setLastError('reranker', 'No documents to rerank');
    return null;
  }

  const apiKey = config.rerankerApiKey
    ? getNextApiKey({ apiKey: config.rerankerApiKey }, `reranker:${contentHash(config.rerankerApiKey || '')}`)
    : null;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body: Record<string, unknown> = { query, documents };
    if (config.rerankerModel) body.model = config.rerankerModel;

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: llmFetchSignal(config),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      _setLastError('reranker', `HTTP ${resp.status}: ${err.substring(0, 300)}`);
      console.log(`${LOG_PREFIX} Reranker API error ${resp.status}: ${err.substring(0, 200)}`);
      return null;
    }

    const data = await resp.json() as any;
    // Support Jina/Cohere (results) and VoyageAI (data) response formats
    const results = data.results ?? data.data;
    if (Array.isArray(results)) {
      return results
        .map((r: any) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }))
        .sort((a, b) => b.score - a.score);
    }
    _setLastError('reranker', 'unexpected response format');
    return null;
  } catch (e) {
    _setLastError('reranker', e instanceof Error ? e.message : String(e));
    console.log(`${LOG_PREFIX} Reranker API fetch error: ${(e as Error).message}`);
    return null;
  }
}

export async function getCachedTextEmbeddings(texts: string[], config: EmbeddingConfig, ns: OmniNodeStore): Promise<Float32Array[]> {
  if (!config.embeddingEnabled || texts.length === 0) return [];

  const results: Array<Float32Array | undefined> = new Array(texts.length);
  const uncachedTexts: string[] = [];
  const uncachedIndices: number[] = [];

  for (let i = 0; i < texts.length; i++) {
    const hash = contentHash(texts[i]);
    const cached = ns.textEmbeddingCache.get(hash);
    if (cached) {
      results[i] = cached;
    } else {
      uncachedTexts.push(texts[i]);
      uncachedIndices.push(i);
    }
  }

  if (uncachedTexts.length > 0) {
    const batchSize = 100;
    for (let b = 0; b < uncachedTexts.length; b += batchSize) {
      const batch = uncachedTexts.slice(b, b + batchSize);
      const batchIdx = uncachedIndices.slice(b, b + batchSize);
      const vecs = await callEmbeddingApi(batch, config);
      if (vecs) {
        for (let j = 0; j < vecs.length; j++) {
          results[batchIdx[j]] = vecs[j];
          ns.textEmbeddingCache.set(contentHash(batch[j]), vecs[j]);
        }
      }
    }
    _trimTextEmbeddingCache(ns);
  }

  if (uncachedTexts.length > 0 && uncachedTexts.length < texts.length) {
    _dbg(`${LOG_PREFIX} Text embedding cache: ${texts.length - uncachedTexts.length} hit, ${uncachedTexts.length} miss`);
  }

  return results.filter(Boolean) as Float32Array[];
}

// ── Embedding Cache Management ──
export function getEmbeddingCacheKey(nodeId: string, keywords: string[] | undefined, content: string): string {
  const kw = Array.isArray(keywords) ? keywords.join(',') : '';
  return `${nodeId}:${contentHash(`${kw}:${content}`)}`;
}

export async function getNodeEmbeddings(nodes: OmniNode[], nodeStore: OmniNodeStore, config: EmbeddingConfig): Promise<Map<string, Float32Array>> {
  if (!config.embeddingEnabled || nodes.length === 0) return new Map();

  const embeddings = new Map<string, Float32Array>();
  const needCompute: string[] = [];
  const needComputeIndices: number[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const cacheKey = getEmbeddingCacheKey(node.id, node.keywords, node.content);
    const cached = nodeStore.embeddingCache.get(node.id);
    if (cached && cached.hash === cacheKey && cached.embedding) {
      node.embedding = cached.embedding;
      embeddings.set(node.id, cached.embedding);
    } else {
      needCompute.push(`${node.keywords.join(', ')}: ${node.content}`);
      needComputeIndices.push(i);
    }
  }

  if (needCompute.length > 0) {
    console.log(`${LOG_PREFIX} Computing embeddings for ${needCompute.length} nodes (${nodes.length - needCompute.length} cached)`);
    // Batch in chunks of 100
    const batchSize = 100;
    for (let b = 0; b < needCompute.length; b += batchSize) {
      const batchTexts = needCompute.slice(b, b + batchSize);
      const batchLocalIndices = needComputeIndices.slice(b, b + batchSize);
      const vectors = await callEmbeddingApi(batchTexts, config);
      if (vectors) {
        for (let j = 0; j < vectors.length; j++) {
          const nodeIdx = batchLocalIndices[j];
          const node = nodes[nodeIdx];
          const cacheKey = getEmbeddingCacheKey(node.id, node.keywords, node.content);
          node.embedding = vectors[j];
          nodeStore.embeddingCache.set(node.id, { hash: cacheKey, embedding: vectors[j] });
          embeddings.set(node.id, vectors[j]);
        }
      }
    }
  }

  return embeddings;
}

// ── Chat Regex Filters ──
// 내장 필터: AI 사고 블록(<Thoughts>/pm:think)은 사용자 설정과 무관하게 항상 제거
// (2026-08-05 — 발췌에 사고 요약문이 인용되는 실측 후 결정, util.stripThoughtBlocks 참조)
export function applyChatRegexFilters(text: string, config: EmbeddingConfig): string {
  const stripped = stripThoughtBlocks(text);
  const filters = config.chatRegexFilters;
  if (!Array.isArray(filters) || filters.length === 0) return stripped;
  let result = stripped;
  for (const block of filters) {
    if (!block || !block.pattern) continue;
    try {
      const regex = new RegExp(block.pattern, block.flags || 'g');
      result = result.replace(regex, block.replacement ?? '');
    } catch { /* invalid regex — skip */ }
  }
  return result;
}

export function applyChatRegexFiltersToTexts(texts: string[], config: EmbeddingConfig): string[] {
  const filters = config.chatRegexFilters;
  if (!Array.isArray(filters) || filters.length === 0) return texts;
  return texts.map(t => applyChatRegexFilters(t, config));
}

// ── Chat Embedding ──
export async function getChatEmbeddings(messages: Array<{ role: string; content: unknown }>, config: EmbeddingConfig, ns: OmniNodeStore): Promise<Float32Array[]> {
  if (!config.embeddingEnabled || messages.length === 0) return [];

  // Feature: Exclude user role messages from embedding
  let filteredMsgs = messages;
  if (config.excludeUserEmbedding) {
    filteredMsgs = messages.filter(m => m.role !== 'user');
    if (filteredMsgs.length === 0) return [];
  }

  let texts = filteredMsgs.map(m =>
    typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  );

  // Feature: Chat regex filters — remove noise before embedding/HyDE
  texts = applyChatRegexFiltersToTexts(texts, config);

  // Feature: HyDE — generate hypothetical memory nodes with cached embeddings
  if (config.hydeEnabled) {
    return generateHyDEWithEmbeddings(texts, config, ns);
  }

  return getCachedTextEmbeddings(texts, config, ns);
}

// ── HyDE: Hypothetical Document Embeddings with Embedding Cache ──
export async function generateHyDEWithEmbeddings(chatTexts: string[], config: EmbeddingConfig, ns: OmniNodeStore): Promise<Float32Array[]> {
  const hydePrompt = config.hydePrompt || DEFAULT_PROMPTS.hyde;

  const hydeTexts: string[] = new Array(chatTexts.length);
  const cachedEmbeddings: Array<Float32Array | null> = new Array(chatTexts.length).fill(null);
  let cacheHits = 0;
  let fullCacheHits = 0;
  const uncachedIndices: number[] = [];

  for (let i = 0; i < chatTexts.length; i++) {
    const hash = contentHash(chatTexts[i]);
    const cached = ns ? ns.hydeCache.get(hash) : null;
    if (cached) {
      const hydeText = typeof cached === 'string' ? cached : cached.text;
      const hydeEmb = typeof cached === 'object' && cached.embedding ? cached.embedding : null;
      hydeTexts[i] = hydeText;
      cachedEmbeddings[i] = hydeEmb;
      cacheHits++;
      if (hydeEmb) fullCacheHits++;
    } else {
      uncachedIndices.push(i);
    }
  }

  // Parallelize LLM calls for uncached texts
  if (uncachedIndices.length > 0) {
    const promises = uncachedIndices.map(async (idx) => {
      try {
        const hydeResult = await callLLM([
          { role: 'system', content: hydePrompt },
          { role: 'user', content: chatTexts[idx] },
        ] as ChatMessage[], { _config: config, maxTokens: 150, _useAux: true, _label: 'HyDE expansion' });
        let out = chatTexts[idx];
        if (hydeResult && hydeResult.trim()) {
          const parsed = robustParseJSON(hydeResult) as { memory?: string } | null;
          out = (parsed && parsed.memory) ? parsed.memory.trim() : hydeResult.trim();
        }
        hydeTexts[idx] = out;
        if (ns) ns.hydeCache.set(contentHash(chatTexts[idx]), { text: out, embedding: null });
      } catch {
        hydeTexts[idx] = chatTexts[idx];
      }
    });
    await Promise.allSettled(promises);
  }

  if (cacheHits > 0) _dbg(`${LOG_PREFIX} HyDE cache: ${cacheHits}/${chatTexts.length} text hits, ${fullCacheHits} full (text+embedding) hits`);

  // Compute embeddings for uncached entries
  const textsNeedingEmbed: string[] = [];
  const embedIndexMap: number[] = []; // maps textsNeedingEmbed index → chatTexts index
  for (let i = 0; i < hydeTexts.length; i++) {
    if (cachedEmbeddings[i] === null) {
      textsNeedingEmbed.push(hydeTexts[i]);
      embedIndexMap.push(i);
    }
  }

  let newEmbeddings: Float32Array[] = [];
  if (textsNeedingEmbed.length > 0) {
    newEmbeddings = await getCachedTextEmbeddings(textsNeedingEmbed, config, ns);
  }

  // Assemble final embedding array and update cache with embeddings
  const result: Array<Float32Array | null> = new Array(hydeTexts.length).fill(null);
  for (let i = 0; i < hydeTexts.length; i++) {
    if (cachedEmbeddings[i] !== null) {
      result[i] = cachedEmbeddings[i];
    }
  }
  for (let j = 0; j < embedIndexMap.length; j++) {
    const origIdx = embedIndexMap[j];
    const emb = newEmbeddings[j] || null;
    result[origIdx] = emb;
    // Update hydeCache with embedding
    if (ns && emb) {
      const hash = contentHash(chatTexts[origIdx]);
      const existing = ns.hydeCache.get(hash);
      if (existing && typeof existing === 'object') {
        existing.embedding = emb;
      } else {
        ns.hydeCache.set(hash, { text: hydeTexts[origIdx], embedding: emb });
      }
    }
  }

  // Enforce cache size limit
  if (ns) {
    _evictOldest(ns.hydeCache as Map<unknown, unknown>, config.hydeCacheMax || 200);
  }

  return result.filter((e): e is Float32Array => e != null);
}
