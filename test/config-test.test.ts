import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ConfigStore } from '../src/config-store.js';
import { openDbFile } from '../src/db.js';
import { _resetLlmClientState } from '../src/llm/client.js';
import { registerConfigTestRoutes } from '../src/routes/config-test.js';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
const databases: Array<ReturnType<typeof openDbFile>['sqlite']> = [];

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; json?: unknown; text?: string }) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const response = handler(String(url), init);
    const body = response.text ?? JSON.stringify(response.json ?? {});
    return new Response(body, {
      status: response.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
}

function setup(initialRaw?: Record<string, unknown>) {
  const db = openDbFile(':memory:');
  databases.push(db.sqlite);
  const configStore = new ConfigStore(db.sqlite);
  if (initialRaw) configStore.save(initialRaw);
  const app = new Hono();
  registerConfigTestRoutes(app, configStore);
  return { app, configStore };
}

function mainConfig() {
  return {
    maxRetries: 0,
    customLlm: {
      apiFormat: 'openai',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-test',
      model: 'test-model',
    },
  };
}

async function postTest(app: Hono, target: string, config?: Record<string, unknown>) {
  return app.request('/api/config/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, ...(config === undefined ? {} : { config }) }),
  });
}

beforeEach(() => _resetLlmClientState());
afterEach(() => {
  vi.unstubAllGlobals();
  while (databases.length > 0) databases.pop()!.close();
});

describe('config connection test API', () => {
  it('main 성공: 테스트 프롬프트와 1024 이하 토큰으로 OpenAI 응답을 보고한다', async () => {
    mockFetch(() => ({ json: { choices: [{ message: { content: 'Hi' } }] } }));
    const { app } = setup();

    const response = await postTest(app, 'main', mainConfig());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      target: 'main',
      reply: 'Hi',
      format: 'openai',
      model: 'test-model',
    });
    expect(calls).toHaveLength(1);
    const requestBody = JSON.parse(calls[0].init.body as string);
    expect(requestBody.messages).toContainEqual({
      role: 'user',
      content: 'Reply with only the word "Hi".',
    });
    expect(requestBody.max_tokens).toBeLessThanOrEqual(1024);
  });

  it('main 실패: HTTP 상태와 응답 본문 일부를 오류로 보고한다', async () => {
    mockFetch(() => ({ status: 401, text: 'invalid API key for this account' }));
    const { app } = setup();

    const response = await postTest(app, 'main', mainConfig());
    expect(response.status).toBe(200);
    const result = await response.json() as { ok: boolean; target: string; error: string };
    expect(result).toMatchObject({
      ok: false,
      target: 'main',
      error: expect.stringContaining('HTTP 401'),
    });
    expect(result.error).toContain('invalid API key');
    expect(calls).toHaveLength(1);
  });

  it('config 임시 설정은 테스트 뒤에도 저장하지 않는다', async () => {
    mockFetch(() => ({ json: { choices: [{ message: { content: 'Hi' } }] } }));
    const initialRaw = { rpm: 7, customLlm: { apiUrl: 'https://saved.example.com', apiKey: 'saved', model: 'saved-model' } };
    const { app, configStore } = setup(initialRaw);
    const before = configStore.loadRaw();

    const response = await postTest(app, 'main', mainConfig());
    expect(response.status).toBe(200);
    expect(configStore.loadRaw()).toEqual(before);
  });

  it('customLlm.formatProfiles를 저장하면 원형 그대로 로드한다', () => {
    const { configStore } = setup();
    const formatProfiles = {
      auto: { apiUrl: 'https://auto.example.com/v1/chat/completions', apiKey: 'auto-key', model: 'auto-model' },
      anthropic: {
        apiUrl: 'https://api.anthropic.com/v1/messages',
        apiKey: 'anthropic-key',
        model: 'claude-test',
        maxTokens: 4096,
        extraHeaders: { 'X-Profile': 'anthropic' },
      },
      bedrock: {
        apiUrl: '',
        apiKey: 'bedrock-key',
        model: 'anthropic.claude-test',
        awsRegion: 'us-east-1',
        bedrockEndpoint: 'messages',
      },
    };
    const customLlm = {
      apiFormat: 'anthropic',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      apiKey: 'anthropic-key',
      model: 'claude-test',
      formatProfiles,
    };

    configStore.save({ customLlm });

    expect(configStore.loadRaw()).toEqual({ customLlm });
    expect(configStore.load().customLlm.formatProfiles).toEqual(formatProfiles);
  });

  it('레거시 MD 전체 비활성 설정은 ATLAS 비활성으로 매핑하고 제거된 키는 무시한다', () => {
    const { configStore } = setup({
      mdFeaturesEnabled: false,
      mdWriterEnabled: true,
      mdChatEnabled: true,
      mdAtlasEnabled: true,
    });

    const loaded = configStore.load() as unknown as Record<string, unknown>;
    expect(loaded.mdAtlasEnabled).toBe(false);
    expect(loaded).not.toHaveProperty('mdFeaturesEnabled');
    expect(loaded).not.toHaveProperty('mdWriterEnabled');
    expect(loaded).not.toHaveProperty('mdChatEnabled');
  });

  it('aux 미설정 시 메인 LLM으로 폴백했다고 보고한다', async () => {
    mockFetch(() => ({ json: { choices: [{ message: { content: 'Hi' } }] } }));
    const { app } = setup();

    const response = await postTest(app, 'aux', mainConfig());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      target: 'aux',
      reply: 'Hi',
      format: 'openai',
      model: 'test-model',
      usedFallback: true,
    });
  });

  it('embedding 성공: 첫 벡터의 차원 수를 보고한다', async () => {
    mockFetch(() => ({ json: { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] } }));
    const { app } = setup();

    const response = await postTest(app, 'embedding', {
      embeddingEnabled: true,
      embeddingEndpoint: 'https://emb.example.com/v1/embeddings',
      embeddingApiKey: 'emb-key',
      embeddingModel: 'embed-model',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, target: 'embedding', dims: 3 });
    expect(calls).toHaveLength(1);
  });

  it('연결 테스트의 토큰 캡이 저장 설정·기본값 객체로 새지 않는다 (참조 공유 변이 방지)', async () => {
    const { DEFAULT_CONFIG } = await import('../src/config-store.js');
    const before = DEFAULT_CONFIG.customLlm.maxTokens;
    mockFetch(() => ({ json: { choices: [{ message: { content: 'Hi' } }] } }));
    const { app, configStore } = setup({ customLlm: { apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'k', model: 'm' } });
    const res = await app.request('/api/config/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'main' }), // config 패치 없음 → temp.customLlm이 store 결과 객체를 그대로 참조
    });
    expect((await res.json()).ok).toBe(true);
    expect(DEFAULT_CONFIG.customLlm.maxTokens).toBe(before);
    expect(configStore.load().customLlm.maxTokens).not.toBe(1024);
  });

  it('target 불량은 400으로 거부한다', async () => {
    const { app } = setup();
    const response = await postTest(app, 'unknown');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('target') });
  });
});
