// Phase 3 LLM 레이어 유닛 테스트 — 실 API 불필요 (fetch 모의).
// 실 API 스모크 테스트는 사용자 키 설정 후 별도 진행.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  callLLM, stripThought, buildGeminiUrl, getNextApiKey, _resetLlmClientState,
  _getLastError, _getVertexAccessToken, resolveApiFormat, rpmLimiter, type LlmConfig,
} from '../src/llm/client.js';
import { _canonicalUri } from '../src/llm/sigv4.js';
import {
  callEmbeddingApi, getCachedTextEmbeddings, getNodeEmbeddings, callReranker,
  generateHyDEWithEmbeddings, type EmbeddingConfig,
} from '../src/llm/embeddings.js';
import { OmniNodeStore } from '../src/core/node-store.js';

type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; json?: unknown; text?: string }) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    const body = r.text ?? JSON.stringify(r.json ?? {});
    return new Response(body, { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

function cfg(over: Partial<LlmConfig['customLlm']> = {}, top: Partial<LlmConfig> = {}): LlmConfig {
  return {
    customLlm: { apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'sk-test', model: 'test-model', ...over },
    maxRetries: 0,
    ...top,
  };
}

beforeEach(() => _resetLlmClientState());
afterEach(() => vi.unstubAllGlobals());

describe('callLLM', () => {
  it('OpenAI 호환: 요청 본문/헤더 구성과 응답 파싱', async () => {
    mockFetch(() => ({ json: { choices: [{ message: { content: '응답 텍스트' } }], usage: { completion_tokens: 5 } } }));
    const result = await callLLM([{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], { _config: cfg() });
    expect(result).toBe('응답 텍스트');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('test-model');
    expect(body.messages).toHaveLength(2);
    expect(body.stream).toBe(false);
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test');
  });

  it('Anthropic 스타일 / result / response 응답을 파싱한다', async () => {
    mockFetch(() => ({ json: { content: [{ text: '안녕' }, { text: '하세요' }] } }));
    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: cfg() })).toBe('안녕하세요');

    mockFetch(() => ({ json: { result: 'r-텍스트' } }));
    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: cfg() })).toBe('r-텍스트');

    mockFetch(() => ({ json: { response: 'resp-텍스트' } }));
    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: cfg() })).toBe('resp-텍스트');
  });

  it('Gemini: URL 조립·역할 매핑·systemInstruction·thought 파트 제외', async () => {
    mockFetch(() => ({
      json: { candidates: [{ content: { parts: [{ text: '숨은 생각', thought: true }, { text: '실제 답' }] } }] },
    }));
    const config = cfg({ apiUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-test', apiKey: 'g-key' });
    const result = await callLLM([
      { role: 'system', content: '시스템' },
      { role: 'assistant', content: '이전 답' },
      { role: 'user', content: '질문' },
    ], { _config: config, jsonMode: true });

    expect(result).toBe('실제 답'); // thought 파트 제외
    expect(calls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=g-key');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe('시스템');
    expect(body.contents[0].role).toBe('user'); // model로 시작 금지 → user로 강제
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    // Gemini는 Authorization 헤더 대신 key 쿼리 파라미터
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });

  it('OpenAI: 명시 형식의 빈 apiUrl은 기본 chat/completions 주소를 사용한다', async () => {
    mockFetch(() => ({ json: { choices: [{ message: { content: '기본 주소 응답' } }] } }));
    const config = cfg({ apiFormat: 'openai', apiUrl: '' });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('기본 주소 응답');
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('Gemini: 명시 형식의 빈 apiUrl은 Google AI Studio 기본 주소를 사용한다', async () => {
    mockFetch(() => ({ json: { candidates: [{ content: { parts: [{ text: '기본 Gemini 응답' }] } }] } }));
    const config = cfg({ apiFormat: 'gemini', apiUrl: '', model: 'gemini-test', apiKey: 'g-key' });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('기본 Gemini 응답');
    expect(calls[0].url)
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent?key=g-key');
  });

  it('Anthropic: 전용 헤더·system 분리·assistant 시작 보정·text 응답 결합', async () => {
    mockFetch(() => ({
      json: {
        content: [
          { type: 'text', text: '첫째' },
          { type: 'tool_use', text: '제외' },
          { type: 'text', text: '둘째' },
        ],
        usage: { output_tokens: 9 },
      },
    }));
    const config = cfg({ apiFormat: 'anthropic', apiUrl: '', maxTokens: 321 });
    const result = await callLLM([
      { role: 'system', content: '시스템 1' },
      { role: 'system', content: '시스템 2' },
      { role: 'assistant', content: '먼저 답함' },
      { role: 'user', content: '질문' },
    ], { _config: config });

    expect(result).toBe('첫째둘째');
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers.Authorization).toBeUndefined();
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.system).toBe('시스템 1\n\n시스템 2');
    expect(body.messages).toEqual([
      { role: 'user', content: '.' },
      { role: 'assistant', content: '먼저 답함' },
      { role: 'user', content: '질문' },
    ]);
    expect(body.messages.every((message: { role: string }) => message.role !== 'system')).toBe(true);
    expect(body.max_tokens).toBe(321);
  });

  it('OpenAI Responses: instructions·input·max_output_tokens 구성과 두 응답 형식 파싱', async () => {
    let responseNumber = 0;
    mockFetch(() => {
      responseNumber++;
      return responseNumber === 1
        ? { json: { output_text: '직접 응답' } }
        : {
            json: {
              output: [
                { type: 'reasoning', content: [{ type: 'output_text', text: '제외' }] },
                { type: 'message', content: [{ type: 'output_text', text: '폴백 ' }, { type: 'output_text', text: '응답' }] },
              ],
            },
          };
    });
    const config = cfg({}, {
      auxiliaryLlm: {
        apiFormat: 'openai-responses',
        apiUrl: '',
        apiKey: 'responses-key',
        model: 'responses-model',
      },
    });
    const messages = [
      { role: 'system', content: '시스템 1' },
      { role: 'system', content: '시스템 2' },
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '답' },
    ];

    expect(await callLLM(messages, { _config: config, _useAux: true, maxTokens: 456 })).toBe('직접 응답');
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.instructions).toBe('시스템 1\n\n시스템 2');
    expect(body.input).toEqual([
      { role: 'user', content: '질문' },
      { role: 'assistant', content: '답' },
    ]);
    expect(body.max_output_tokens).toBe(456);
    expect(body.stream).toBe(false);
    expect(await callLLM(messages, { _config: config, _useAux: true })).toBe('폴백 응답');
  });

  it('Vertex: 빈 apiUrl과 global 리전으로 서비스 계정 project_id 주소를 조립한다', async () => {
    mockFetch(() => ({ json: { candidates: [{ content: { parts: [{ text: 'global 응답' }] } }] } }));
    const config = cfg(
      { apiFormat: 'vertex', apiUrl: '', model: 'gemini-test', gcpRegion: 'global' },
      { vertexAiServiceAccountJson: JSON.stringify({ project_id: 'p1' }) },
    );

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('global 응답');
    expect(calls[0].url)
      .toBe('https://aiplatform.googleapis.com/v1/projects/p1/locations/global/publishers/google/models/gemini-test:generateContent');
  });

  it('Vertex: 빈 apiUrl과 regional 리전으로 지역별 project_id 주소를 조립한다', async () => {
    mockFetch(() => ({ json: { candidates: [{ content: { parts: [{ text: 'regional 응답' }] } }] } }));
    const config = cfg(
      { apiFormat: 'vertex', apiUrl: '', model: 'gemini-test', gcpRegion: 'us-central1' },
      { vertexAiServiceAccountJson: JSON.stringify({ project_id: 'p1' }) },
    );

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('regional 응답');
    expect(calls[0].url)
      .toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google/models/gemini-test:generateContent');
  });

  it('Vertex: apiUrl이 있으면 project_id 주소를 조립하지 않고 그대로 존중한다', async () => {
    const customUrl = 'https://custom.example.com/v1/projects/custom/locations/custom/publishers/google/models/custom:generateContent';
    mockFetch(() => ({ json: { candidates: [{ content: { parts: [{ text: 'custom 응답' }] } }] } }));
    const config = cfg({ apiFormat: 'vertex', apiUrl: customUrl, model: 'gemini-test' });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('custom 응답');
    expect(calls[0].url).toBe(customUrl);
  });

  it('Vertex: 빈 apiUrl인데 project_id가 없으면 null과 주소 조립 안내를 반환한다', async () => {
    mockFetch(() => ({ json: {} }));
    const config = cfg(
      { apiFormat: 'vertex', apiUrl: '', model: 'gemini-test', gcpRegion: 'global' },
      { vertexAiServiceAccountJson: JSON.stringify({}) },
    );

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBeNull();
    expect(_getLastError('llm'))
      .toBe('Vertex: 서비스 계정 JSON의 project_id가 없어 주소를 만들 수 없습니다');
    expect(calls).toHaveLength(0);
  });

  it('Bedrock messages: mantle URL·x-api-key·model 본문을 사용한다', async () => {
    mockFetch(() => ({ json: { content: [{ type: 'text', text: 'bedrock messages' }] } }));
    const config = cfg({
      apiFormat: 'bedrock',
      apiUrl: 'https://ignored.example.com',
      awsRegion: 'us-east-1',
      bedrockEndpoint: 'messages',
      model: 'anthropic.claude-opus-5',
    });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('bedrock messages');
    expect(calls[0].url).toBe('https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages');
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect(JSON.parse(calls[0].init.body as string).model).toBe('anthropic.claude-opus-5');
  });

  it('Bedrock invoke: modelId 콜론 보존·Bearer 인증·anthropic_version 본문을 사용한다', async () => {
    mockFetch(() => ({ json: { content: [{ type: 'text', text: 'bedrock invoke' }] } }));
    const model = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const config = cfg({
      apiFormat: 'bedrock',
      apiUrl: '',
      awsRegion: 'us-east-1',
      bedrockEndpoint: 'invoke',
      model,
    });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('bedrock invoke');
    expect(calls[0].url).toBe(`https://bedrock-runtime.us-east-1.amazonaws.com/model/${model}/invoke`);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['anthropic-version']).toBeUndefined();
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.anthropic_version).toBe('bedrock-2023-05-31');
    expect(body.model).toBeUndefined();
  });

  it('Bedrock invoke SigV4: bedrock 범위로 서명하고 canonical URI에서만 콜론을 인코딩한다', async () => {
    mockFetch(() => ({ json: { content: [{ type: 'text', text: 'signed invoke' }] } }));
    const model = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    const config = cfg({
      apiFormat: 'bedrock',
      apiUrl: '',
      apiKey: 'must-not-be-used',
      awsRegion: 'us-east-1',
      bedrockEndpoint: 'invoke',
      model,
      awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      awsSecretAccessKey: 'secret-example',
    });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('signed invoke');
    expect(calls[0].url).toBe(`https://bedrock-runtime.us-east-1.amazonaws.com/model/${model}/invoke`);
    expect(_canonicalUri(calls[0].url))
      .toBe('/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/invoke');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization)
      .toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request,/);
    expect(headers.Authorization)
      .toContain('SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date');
    expect(headers.Authorization).not.toContain('Bearer');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('Bedrock messages SigV4: bedrock-mantle 범위와 anthropic-version 헤더로 서명한다', async () => {
    mockFetch(() => ({ json: { content: [{ type: 'text', text: 'signed mantle' }] } }));
    const config = cfg({
      apiFormat: 'bedrock',
      apiUrl: '',
      apiKey: 'must-not-be-used',
      awsRegion: 'us-east-1',
      bedrockEndpoint: 'messages',
      model: 'anthropic.claude-opus-5',
      awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      awsSecretAccessKey: 'secret-example',
    });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('signed mantle');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization)
      .toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/bedrock-mantle\/aws4_request,/);
    expect(headers.Authorization)
      .toContain('SignedHeaders=anthropic-version;content-type;host;x-amz-content-sha256;x-amz-date');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('Bedrock SigV4: 세션 토큰을 헤더와 SignedHeaders에 포함한다', async () => {
    mockFetch(() => ({ json: { content: [{ type: 'text', text: 'temporary credentials' }] } }));
    const config = cfg({
      apiFormat: 'bedrock',
      apiUrl: '',
      awsRegion: 'us-east-1',
      bedrockEndpoint: 'messages',
      model: 'anthropic.claude-opus-5',
      awsAccessKeyId: 'ASIAIOSFODNN7EXAMPLE',
      awsSecretAccessKey: 'secret-example',
      awsSessionToken: 'session-token-example',
    });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBe('temporary credentials');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-amz-security-token']).toBe('session-token-example');
    expect(headers.Authorization).toContain('x-amz-date;x-amz-security-token');
  });

  it('Bedrock SigV4: 시크릿만 있고 액세스 키 ID가 없으면 null과 안내 오류를 반환한다', async () => {
    mockFetch(() => ({ json: {} }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = cfg({
      apiFormat: 'bedrock',
      apiUrl: '',
      awsRegion: 'us-east-1',
      model: 'anthropic.claude-opus-5',
      awsSecretAccessKey: 'secret-example',
      awsAccessKeyId: '',
    });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBeNull();
    expect(_getLastError('llm')).toBe('Bedrock: 액세스 키 ID가 비어 있습니다');
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('액세스 키 ID'));
  });

  it('Bedrock: AWS 리전이 없으면 null을 반환하고 fetch하지 않는다', async () => {
    mockFetch(() => ({ json: {} }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const config = cfg({ apiFormat: 'bedrock', apiUrl: '', awsRegion: '', model: 'anthropic.claude-opus-5' });

    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: config })).toBeNull();
    expect(calls).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('AWS Region'));
  });

  it('멀티 키(줄바꿈 구분)가 호출마다 로테이션된다', async () => {
    mockFetch(() => ({ json: { choices: [{ message: { content: 'ok' } }] } }));
    const config = cfg({ apiKey: 'key-A\nkey-B\nkey-C' });
    for (const expected of ['key-A', 'key-B', 'key-C', 'key-A']) {
      await callLLM([{ role: 'user', content: 'x' }], { _config: config });
      expect((calls.at(-1)!.init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${expected}`);
    }
  });

  it('실패 시 지수 백오프로 재시도한다', async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      mockFetch(() => (++attempt < 3 ? { status: 500, text: 'boom' } : { json: { choices: [{ message: { content: '성공' } }] } }));
      const p = callLLM([{ role: 'user', content: 'x' }], { _config: cfg({}, { maxRetries: 3 }) });
      await vi.advanceTimersByTimeAsync(1000); // 1차 백오프
      await vi.advanceTimersByTimeAsync(2000); // 2차 백오프
      expect(await p).toBe('성공');
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('예상 밖 응답 포맷은 에러가 된다', async () => {
    mockFetch(() => ({ json: { unexpected: true } }));
    await expect(callLLM([{ role: 'user', content: 'x' }], { _config: cfg() }))
      .rejects.toThrow(/unexpected response format/);
  });

  it('auto 형식의 apiUrl이 비어 있으면 기존 미설정 결과를 반환한다', async () => {
    mockFetch(() => ({ json: {} }));
    expect(await callLLM([{ role: 'user', content: 'x' }], { _config: cfg({ apiFormat: 'auto', apiUrl: '' }) })).toBeNull();
    expect(_getLastError('llm')).toBe('LLM not configured. Set API URL and Model in OMNINODE settings.');
    expect(calls).toHaveLength(0);
  });
});

describe('buildGeminiUrl / stripThought / rpmLimiter', () => {
  it('resolveApiFormat auto: 미지 URL은 OpenAI, aiplatform은 Vertex, generativelanguage는 Gemini', () => {
    expect(resolveApiFormat({ apiFormat: 'auto', apiUrl: 'https://unknown.example.com/v1/messages' })).toBe('openai');
    expect(resolveApiFormat({ apiFormat: 'auto', apiUrl: 'https://api.anthropic.com/v1/messages' })).toBe('openai');
    expect(resolveApiFormat({ apiFormat: 'auto', apiUrl: 'https://us-central1-aiplatform.googleapis.com/v1/projects/p' })).toBe('vertex');
    expect(resolveApiFormat({ apiFormat: 'auto', apiUrl: 'https://generativelanguage.googleapis.com/v1beta' })).toBe('gemini');
  });

  it('buildGeminiUrl 변형들', () => {
    expect(buildGeminiUrl('https://generativelanguage.googleapis.com/v1beta/', 'm-1', 'k'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent?key=k');
    // 이미 완전한 URL이면 그대로 + key만
    expect(buildGeminiUrl('https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent?key=exist', 'm-1', 'k2'))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/m-1:generateContent?key=exist');
    // Vertex: key 쿼리 없음, 모델 경로 자동 부착
    expect(buildGeminiUrl('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l', 'm-2', 'k'))
      .toBe('https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/l/publishers/google/models/m-2:generateContent');
  });

  it('stripThought', () => {
    expect(stripThought('<think>소문자 생각</think>결론')).toEqual({ thought: '소문자 생각', content: '결론' });
    expect(stripThought('<thinking>긴 태그 생각</thinking>결론')).toEqual({ thought: '긴 태그 생각', content: '결론' });
    expect(stripThought('<Thought>고민중</Thought>결론')).toEqual({ thought: '고민중', content: '결론' });
    expect(stripThought('<THINK>첫째</THINK>중간<thinking>둘째</thinking>끝'))
      .toEqual({ thought: '첫째\n둘째', content: '중간끝' });
    expect(stripThought('앞부분<think>잘린 생각')).toEqual({ thought: '잘린 생각', content: '앞부분' });
    expect(stripThought('  그냥 답  ')).toEqual({ thought: '', content: '그냥 답' });
    expect(stripThought(null)).toEqual({ thought: '', content: '' });
  });

  it('rpm 0이면 리미터는 무제한 통과', async () => {
    rpmLimiter.setLimit(0);
    await rpmLimiter.acquire();
    expect(rpmLimiter.currentWindowCount).toBe(0);
  });

  it('getNextApiKey: 단일 키는 로테이션 없이 그대로', () => {
    expect(getNextApiKey({ apiKey: 'only-one' })).toBe('only-one');
    expect(getNextApiKey({ apiKey: '' })).toBe('');
  });
});

describe('Gemini 생각(thinking) 소진 진단', () => {
  it('parts가 thought뿐이고 finishReason=MAX_TOKENS면 한도 안내를 오류로 남긴다', async () => {
    mockFetch(() => ({ json: { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ thought: true, text: '...' }] } }] } }));
    const config = cfg({ apiFormat: 'gemini', apiUrl: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-3.1-pro-preview' });
    // callLLM은 재시도 소진 후 throw하는 설계(호출자가 catch) — 마지막 오류에 사람 말 안내가 남는지 본다
    await expect(callLLM([{ role: 'user', content: 'Hi' }], { _config: config })).rejects.toThrow('최대 응답 토큰');
    const { _getLastError } = await import('../src/llm/client.js');
    expect(_getLastError('llm')).toContain('생각(thinking)');
  });
});

describe('OpenAI 호환 생각(thinking) 소진 진단', () => {
  it.each([
    {
      choice: { message: { content: '', reasoning_content: '숨은 추론' } },
      expected: '응답이 생각(thinking)에 토큰을 다 써서 답 텍스트가 비었습니다 — 최대 응답 토큰을 올리세요',
    },
    {
      choice: { finish_reason: 'length', message: { reasoning: '숨은 추론' } },
      expected: '응답이 생각(thinking)에 토큰을 다 써서 답 텍스트가 비었습니다 (finish_reason=length) — 최대 응답 토큰을 올리세요',
    },
  ])('content가 비고 reasoning만 있으면 null과 한도 안내를 남긴다', async ({ choice, expected }) => {
    mockFetch(() => ({ json: { choices: [choice] } }));
    expect(await callLLM([{ role: 'user', content: 'Hi' }], { _config: cfg() })).toBeNull();
    expect(_getLastError('llm')).toBe(expected);
  });
});

describe('Vertex 서비스계정 JWT', () => {
  it('올바르게 서명된 JWT로 토큰을 교환하고 캐시한다', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    let assertion = '';
    mockFetch((_url, init) => {
      assertion = decodeURIComponent(String(init.body).match(/assertion=([^&]+)/)![1]);
      return { json: { access_token: 'at-123', expires_in: 3600 } };
    });

    const sa = JSON.stringify({ client_email: 'svc@test.iam', private_key: privateKey });
    expect(await _getVertexAccessToken(sa)).toBe('at-123');

    // JWT 구조 + RS256 서명 실검증
    const [h, p, sig] = assertion.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe('svc@test.iam');
    expect(payload.scope).toContain('cloud-platform');
    const verifier = createVerify('RSA-SHA256').update(`${h}.${p}`);
    expect(verifier.verify(publicKey, Buffer.from(sig, 'base64url'))).toBe(true);

    // 두 번째 호출은 캐시 → fetch 없음
    const callCount = calls.length;
    expect(await _getVertexAccessToken(sa)).toBe('at-123');
    expect(calls.length).toBe(callCount);
  });

  it('키 정보가 없으면 null', async () => {
    mockFetch(() => ({ json: {} }));
    expect(await _getVertexAccessToken(JSON.stringify({ client_email: 'a' }))).toBeNull();
    expect(await _getVertexAccessToken('')).toBeNull();
  });
});

describe('임베딩 / 리랭커', () => {
  const embCfg = (over: Partial<EmbeddingConfig> = {}): EmbeddingConfig => ({
    ...cfg(), embeddingEnabled: true, embeddingEndpoint: 'https://emb.example.com/v1/embeddings',
    embeddingApiKey: 'emb-key', embeddingModel: 'test-embed', ...over,
  });

  it('배치 응답을 index로 정렬해 Float32Array로 반환한다', async () => {
    mockFetch(() => ({
      json: { data: [{ index: 1, embedding: [3, 4] }, { index: 0, embedding: [1, 2] }] }, // 순서 뒤섞임
    }));
    const out = await callEmbeddingApi(['a', 'b'], embCfg());
    expect(out).toHaveLength(2);
    expect(out![0]).toBeInstanceOf(Float32Array);
    expect([...out![0]]).toEqual([1, 2]); // index 정렬 확인
    expect([...out![1]]).toEqual([3, 4]);
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.model).toBe('test-embed');
  });

  it('엔드포인트 미설정 시 customLlm URL에서 /embeddings 유도', async () => {
    mockFetch(() => ({ json: { data: [{ index: 0, embedding: [1] }] } }));
    await callEmbeddingApi(['x'], embCfg({ embeddingEndpoint: '' }));
    expect(calls[0].url).toBe('https://api.example.com/v1/embeddings');
  });

  it('텍스트 임베딩 캐시: 히트 시 fetch가 발생하지 않는다', async () => {
    mockFetch(() => ({ json: { data: [{ index: 0, embedding: [1, 1] }, { index: 1, embedding: [2, 2] }] } }));
    const ns = new OmniNodeStore();
    const first = await getCachedTextEmbeddings(['텍스트A', '텍스트B'], embCfg(), ns);
    expect(first).toHaveLength(2);
    expect(calls).toHaveLength(1);

    const second = await getCachedTextEmbeddings(['텍스트A', '텍스트B'], embCfg(), ns);
    expect(second).toHaveLength(2);
    expect(calls).toHaveLength(1); // 캐시 히트 → 추가 fetch 없음
  });

  it('노드 임베딩 캐시: 내용이 바뀐 노드만 재계산한다', async () => {
    mockFetch(() => ({ json: { data: [{ index: 0, embedding: [5, 5] }] } }));
    const ns = new OmniNodeStore();
    const node = ns.addExtraLoreNode({ name: 'n', content: '내용', keywords: ['kw'] });
    await getNodeEmbeddings([node], ns, embCfg());
    expect(calls).toHaveLength(1);

    await getNodeEmbeddings([node], ns, embCfg()); // 변경 없음 → 캐시
    expect(calls).toHaveLength(1);

    node.content = '바뀐 내용'; // 해시 변경 → 재계산
    await getNodeEmbeddings([node], ns, embCfg());
    expect(calls).toHaveLength(2);
  });

  it('리랭커: Jina(results)와 Voyage(data) 포맷 모두 파싱하고 점수 내림차순 정렬', async () => {
    mockFetch(() => ({ json: { results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }] } }));
    const jina = await callReranker('q', ['d1', 'd2'], embCfg({ rerankerEndpoint: 'https://r.example.com', rerankerModel: 'rr' }));
    expect(jina).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);

    mockFetch(() => ({ json: { data: [{ index: 0, score: 0.5 }, { index: 1, score: 0.7 }] } }));
    const voyage = await callReranker('q', ['d1', 'd2'], embCfg({ rerankerEndpoint: 'https://r.example.com' }));
    expect(voyage).toEqual([{ index: 1, score: 0.7 }, { index: 0, score: 0.5 }]);
  });

  it('HyDE: LLM으로 가상 기억을 만들고 캐시하며, 실패 시 원문으로 폴백한다', async () => {
    const hydeCfg = embCfg({ hydeEnabled: true, auxiliaryLlm: { apiUrl: 'https://aux.example.com/v1/chat/completions', apiKey: 'aux-key', model: 'aux-model' } });
    mockFetch((url) => {
      if (url.includes('aux.example.com')) {
        return { json: { choices: [{ message: { content: '{"memory": "가상 기억 노드"}' } }] } };
      }
      return { json: { data: [{ index: 0, embedding: [7, 7] }] } };
    });
    const ns = new OmniNodeStore();
    const out = await generateHyDEWithEmbeddings(['원본 채팅'], hydeCfg, ns);
    expect(out).toHaveLength(1);
    expect([...out[0]]).toEqual([7, 7]);
    const llmCalls = calls.filter(c => c.url.includes('aux.example.com')).length;

    // 캐시 히트: LLM 재호출 없음
    await generateHyDEWithEmbeddings(['원본 채팅'], hydeCfg, ns);
    expect(calls.filter(c => c.url.includes('aux.example.com')).length).toBe(llmCalls);

    // LLM 실패 → 원문 폴백 (임베딩은 원문으로 진행)
    mockFetch((url) => {
      if (url.includes('aux.example.com')) return { status: 500, text: 'down' };
      return { json: { data: [{ index: 0, embedding: [9, 9] }] } };
    });
    const fallback = await generateHyDEWithEmbeddings(['다른 채팅'], hydeCfg, new OmniNodeStore());
    expect(fallback).toHaveLength(1);
    expect([...fallback[0]]).toEqual([9, 9]);
  });
});
