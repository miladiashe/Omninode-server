import type { Hono } from 'hono';
import { type ConfigStore, type OmniConfig } from '../config-store.js';
import {
  _getLastError,
  _resolveAuxLlm,
  callLLM,
  resolveApiFormat,
  type LastErrorKind,
} from '../llm/client.js';
import { callEmbeddingApi, callReranker } from '../llm/embeddings.js';

const TEST_MAX_TOKENS = 1024;
const CONFIG_TEST_TARGETS = ['main', 'aux', 'embedding', 'reranker'] as const;
type ConfigTestTarget = typeof CONFIG_TEST_TARGETS[number];

function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

export function registerConfigTestRoutes(app: Hono, configStore: ConfigStore): void {
  app.post('/api/config/test', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }

    const request = body as { target?: unknown; config?: unknown };
    if (!CONFIG_TEST_TARGETS.includes(request.target as ConfigTestTarget)) {
      return c.json({ error: 'target must be main, aux, embedding, or reranker' }, 400);
    }
    if (request.config !== undefined && (
      !request.config || typeof request.config !== 'object' || Array.isArray(request.config)
    )) {
      return c.json({ error: 'config must be a JSON object' }, 400);
    }

    const target = request.target as ConfigTestTarget;
    const configPatch = (request.config ?? {}) as Record<string, unknown>;
    const temp = { ...configStore.load(), ...configPatch } as OmniConfig;
    const startedAt = performance.now();
    const failed = (kind: LastErrorKind) => c.json({
      ok: false as const,
      target,
      ms: elapsedMs(startedAt),
      error: _getLastError(kind) ?? '응답 없음 — 서버 로그를 확인하세요',
    });

    if (target === 'main' || target === 'aux') {
      const useAux = target === 'aux';
      const usedFallback = useAux && _resolveAuxLlm(temp) === temp.customLlm;
      // 연결 테스트는 실제 요청 한 번만 보내고 1024 토큰으로 제한한다 (생각(thinking) 모델은 한도를 생각에도 쓰므로 32는 부족 — 2026-08-30 Vertex gemini-3.1 실측). 엔드포인트 객체는 반드시 복제해서
      // 캡을 씌운다 — temp는 얕은 병합이라 customLlm/auxiliaryLlm이 configStore 결과(나아가 DEFAULT_CONFIG)와
      // 참조를 공유할 수 있고, 직접 변이하면 실제 파이프라인 호출까지 이 캡으로 잘린다.
      temp.maxRetries = 0;
      const capped = { ...temp, customLlm: { ...temp.customLlm, maxTokens: TEST_MAX_TOKENS } } as OmniConfig;
      if (temp.auxiliaryLlm) capped.auxiliaryLlm = { ...temp.auxiliaryLlm, maxTokens: TEST_MAX_TOKENS };
      const llmConfig = useAux ? _resolveAuxLlm(capped) : capped.customLlm;

      try {
        const reply = await callLLM([
          { role: 'user', content: 'Reply with only the word "Hi".' },
        ], { _config: capped, maxTokens: TEST_MAX_TOKENS, _useAux: useAux || undefined, _label: 'test' });
        if (reply === null) return failed('llm');
        return c.json({
          ok: true as const,
          target,
          ms: elapsedMs(startedAt),
          format: resolveApiFormat(llmConfig),
          model: llmConfig.model,
          reply,
          ...(usedFallback ? { usedFallback: true } : {}),
        });
      } catch {
        return failed('llm');
      }
    }

    if (target === 'embedding') {
      const vectors = await callEmbeddingApi(['Hi'], temp);
      if (!vectors?.[0]) return failed('embedding');
      return c.json({
        ok: true as const,
        target,
        ms: elapsedMs(startedAt),
        dims: vectors[0].length,
      });
    }

    const ranked = await callReranker('greeting', ['Hi there', 'Invoice total'], temp);
    if (ranked === null) return failed('reranker');
    return c.json({
      ok: true as const,
      target,
      ms: elapsedMs(startedAt),
      scores: ranked.map(result => result.score),
    });
  });
}
