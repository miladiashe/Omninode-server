// 원본 MODULE 3: LLM COMMUNICATION (L2079–2534)의 이식. 로직 동일 유지.
// 원본과의 의도적 차이:
//  - Risuai.nativeFetch → 전역 fetch (Node 20)
//  - processingTracker.logLLM → 주입식 로거(setLlmLogger), 기본 no-op (SSE는 Phase 8)
//  - options._config 필수화 (원본은 전역 getConfig() 폴백 — 서버는 요청별 config 주입)
// Vertex JWT는 원본의 WebCrypto(crypto.subtle) 코드가 Node 20에서 그대로 동작한다.
import { LOG_PREFIX, _dbg, contentHash, estimateMessagesTokens } from '../core/util.js';
import { signAwsRequest } from './sigv4.js';

export const DEFAULT_CONTEXT_WINDOW = 128000;
export const DEFAULT_MAX_TOKENS = 16000;
export const DEFAULT_AUX_MAX_TOKENS = 8000;

export type ApiFormat = 'auto' | 'openai' | 'openai-responses' | 'anthropic' | 'bedrock' | 'gemini' | 'vertex';

export interface LlmEndpointConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
  apiFormat?: ApiFormat;
  formatProfiles?: Partial<Record<ApiFormat, LlmProfile>>;
  awsRegion?: string;
  bedrockEndpoint?: 'messages' | 'invoke';
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  gcpRegion?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  cotTokenLimit?: number;
  manualCoT?: boolean;
  systemPrompt?: string;
}

export type LlmProfile = Omit<LlmEndpointConfig, 'apiFormat' | 'formatProfiles'>;

// LLM 레이어가 참조하는 config 부분집합 (전체 config는 Phase 4에서)
export interface LlmConfig {
  customLlm: LlmEndpointConfig;
  auxiliaryLlm?: LlmEndpointConfig;
  rpm?: number;
  maxRetries?: number;
  vertexAiServiceAccountJson?: string;
  [k: string]: unknown;
}

export interface ChatMessage { role: string; content: string }

export interface CallLlmOptions {
  _config: LlmConfig;
  _useAux?: boolean;
  _label?: string;
  maxTokens?: number;
  jsonMode?: boolean;
  responseSchema?: Record<string, unknown>;
}

// ── 진행 로그 훅 (processingTracker.logLLM 대체) ──
// llmTimeoutMs 해석: 미설정 → 기본 180초, 0 이하 → 타임아웃 없음(원본과 동일 동작)
export function llmFetchSignal(cfg: LlmConfig): AbortSignal | undefined {
  const raw = cfg.llmTimeoutMs;
  const t = raw === undefined || raw === null ? 180_000 : Number(raw);
  return Number.isFinite(t) && t > 0 ? AbortSignal.timeout(t) : undefined;
}

export type LlmLogEvent =
  | { type: 'req'; model: string; tokens: number; aux: boolean; label: string }
  | { type: 'res'; dur: number; outTokens: number | null }
  | { type: 'err'; error: string };
let _llmLog: (e: LlmLogEvent) => void = () => {};
export function setLlmLogger(fn: (e: LlmLogEvent) => void) { _llmLog = fn; }

export type LastErrorKind = 'llm' | 'embedding' | 'reranker';
const _lastError: Partial<Record<LastErrorKind, string>> = {};

export function _getLastError(kind: LastErrorKind): string | null {
  return _lastError[kind] ?? null;
}

export function _setLastError(kind: LastErrorKind, error: string | null): void {
  if (error === null) delete _lastError[kind];
  else _lastError[kind] = error;
}

// ── Rate Limiter (Sliding Window RPM) ──
export const rpmLimiter = {
  _timestamps: [] as number[],
  _limit: 0,
  _waitCount: 0,
  _totalWaitMs: 0,

  setLimit(rpm: unknown) {
    this._limit = Math.max(0, parseInt(rpm as string, 10) || 0);
  },

  _prune() {
    const cutoff = Date.now() - 60_000;
    while (this._timestamps.length > 0 && this._timestamps[0] <= cutoff) {
      this._timestamps.shift();
    }
  },

  async acquire() {
    if (this._limit <= 0) return;
    this._prune();

    if (this._timestamps.length < this._limit) {
      this._timestamps.push(Date.now());
      return;
    }

    const oldest = this._timestamps[0];
    const waitMs = Math.max(0, oldest + 60_000 - Date.now()) + 50;
    this._waitCount++;
    console.log(`${LOG_PREFIX} RPM limit (${this._limit}/min) reached — waiting ${(waitMs / 1000).toFixed(1)}s`);

    const waitStart = Date.now();
    await new Promise(resolve => setTimeout(resolve, waitMs));
    this._totalWaitMs += Date.now() - waitStart;

    this._prune();
    this._timestamps.push(Date.now());
  },

  get currentWindowCount() {
    this._prune();
    return this._timestamps.length;
  },
};

// ── API Key Rotation ──
const _keyRotationState = new Map<string, number>(); // scopeKey -> next index

export function getNextApiKey(llmCfg: { apiKey?: string; apiUrl?: string; model?: string }, scopeKey: string | null = null): string {
  const raw = llmCfg.apiKey || '';
  const keys = raw.split('\n').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return '';
  if (keys.length === 1) return keys[0];
  const scope = scopeKey || `${llmCfg.apiUrl || ''}|${llmCfg.model || ''}|${contentHash(raw)}`;
  const idx = _keyRotationState.get(scope) || 0;
  const key = keys[idx % keys.length];
  _keyRotationState.set(scope, idx + 1);
  return key;
}

// ── Gemini Endpoint Detection & Conversion ──
export function isGeminiEndpoint(url: string | undefined): boolean {
  if (!url) return false;
  return /generativelanguage\.googleapis\.com/i.test(url)
    || /aiplatform\.googleapis\.com/i.test(url);
}

export function isVertexAI(url: string | undefined): boolean {
  if (!url) return false;
  return /aiplatform\.googleapis\.com/i.test(url);
}

export function resolveApiFormat(cfg: Pick<LlmEndpointConfig, 'apiFormat' | 'apiUrl'>): Exclude<ApiFormat, 'auto'> {
  if (cfg.apiFormat && cfg.apiFormat !== 'auto') return cfg.apiFormat;
  if (isVertexAI(cfg.apiUrl)) return 'vertex';
  if (isGeminiEndpoint(cfg.apiUrl)) return 'gemini';
  return 'openai';
}

// ── VertexAI Service Account JWT Auth ──
let _vertexTokenCache: { token: string | null; expiry: number } = { token: null, expiry: 0 };

function _base64UrlEncode(arrayBuffer: ArrayBuffer | Uint8Array): string {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _strToArrayBuffer(str: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(str);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function _pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

export async function _getVertexAccessToken(serviceAccountJson: string | Record<string, string> | null | undefined): Promise<string | null> {
  if (!serviceAccountJson) return null;

  // Return cached token if still valid
  if (_vertexTokenCache.token && Date.now() < _vertexTokenCache.expiry) {
    return _vertexTokenCache.token;
  }

  try {
    const sa = typeof serviceAccountJson === 'string' ? JSON.parse(serviceAccountJson) : serviceAccountJson;
    const iss = sa.client_email;
    const key = sa.private_key;
    const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
    const scope = 'https://www.googleapis.com/auth/cloud-platform';

    if (!iss || !key) {
      console.log(`${LOG_PREFIX} VertexAI: service account JSON missing client_email or private_key`);
      _setLastError('llm', 'VertexAI: service account JSON missing client_email or private_key');
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = { iss, scope, aud: tokenUri, iat: now, exp: now + 3600 };

    const headerB64 = _base64UrlEncode(_strToArrayBuffer(JSON.stringify(header)));
    const payloadB64 = _base64UrlEncode(_strToArrayBuffer(JSON.stringify(payload)));
    const signingInput = `${headerB64}.${payloadB64}`;

    // Import RSA private key
    const keyData = _pemToArrayBuffer(key);
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8', keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign'],
    );

    // Sign
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, _strToArrayBuffer(signingInput));
    const jwt = `${signingInput}.${_base64UrlEncode(signature)}`;

    // Exchange JWT for access token
    const resp = await fetch(tokenUri, {
      signal: AbortSignal.timeout(30_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${encodeURIComponent(jwt)}`,
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      console.log(`${LOG_PREFIX} VertexAI token exchange error ${resp.status}: ${err.substring(0, 300)}`);
      _setLastError('llm', `HTTP ${resp.status}: ${err.substring(0, 300)}`);
      return null;
    }

    const data = await resp.json() as { access_token: string; expires_in?: number };
    _vertexTokenCache = {
      token: data.access_token,
      expiry: Date.now() + ((data.expires_in || 3600) - 60) * 1000, // 60s margin
    };
    _dbg(`${LOG_PREFIX} VertexAI: obtained access token (expires in ${data.expires_in || 3600}s)`);
    return data.access_token;
  } catch (e) {
    console.log(`${LOG_PREFIX} VertexAI auth error: ${(e as Error).message}`);
    _setLastError('llm', e instanceof Error ? e.message : String(e));
    return null;
  }
}

export function buildGeminiUrl(baseUrl: string, model: string, apiKey: string, vertex = isVertexAI(baseUrl)): string {
  let url = baseUrl.replace(/\/+$/, '');
  // VertexAI: URL already contains the full path; just ensure :generateContent suffix
  if (vertex) {
    if (!/:generateContent/.test(url)) {
      // If user provided base URL without model, append it
      if (!/\/models\//.test(url) && !/\/publishers\//.test(url)) {
        url += `/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
      } else {
        url += ':generateContent';
      }
    }
    // VertexAI uses Bearer token auth, not key query param
    return url;
  }
  // Standard Gemini AI Studio
  if (!/:generateContent/.test(url)) {
    url = url.replace(/\/models\/?$/, '');
    url += `/models/${encodeURIComponent(model)}:generateContent`;
  }
  if (apiKey && !/[?&]key=/i.test(url)) {
    const sep = url.includes('?') ? '&' : '?';
    url += `${sep}key=${encodeURIComponent(apiKey)}`;
  }
  return url;
}

// Deep-merge source into target so nested objects are merged, not overwritten
function _deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      _deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

export function buildGeminiBody(messages: ChatMessage[], llmCfg: LlmEndpointConfig, options: Partial<CallLlmOptions> = {}): Record<string, any> {
  let systemText = '';
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += (systemText ? '\n\n' : '') + msg.content;
      continue;
    }
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }

  if (llmCfg.systemPrompt) {
    systemText = llmCfg.systemPrompt;
  }

  // Gemini requires contents to start with a "user" turn
  if (contents.length > 0 && contents[0].role === 'model') {
    contents[0].role = 'user';
  }

  const body: Record<string, any> = {
    contents,
    generationConfig: {
      maxOutputTokens: llmCfg.maxTokens || options.maxTokens || DEFAULT_MAX_TOKENS,
      temperature: llmCfg.temperature ?? 0.3,
    },
  };

  // Enable Gemini structured JSON output when requested
  if (options.jsonMode) {
    body.generationConfig.responseMimeType = 'application/json';
    if (options.responseSchema) {
      body.generationConfig.responseSchema = options.responseSchema;
    }
  }

  // Deep-merge extraBody so nested objects (e.g. generationConfig.thinkingConfig) merge properly
  if (llmCfg.extraBody && typeof llmCfg.extraBody === 'object') {
    _deepMerge(body, llmCfg.extraBody);
  }

  if (systemText) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  return body;
}

export function parseGeminiResponse(data: any): string | null {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!parts || !Array.isArray(parts)) return null;
  const texts = parts
    .filter((p: any) => p.text && !p.thought)
    .map((p: any) => p.text);
  return texts.length > 0 ? texts.join('\n') : null;
}

function _requestMaxTokens(llmCfg: LlmEndpointConfig, options: Partial<CallLlmOptions>): number {
  return llmCfg.maxTokens || options.maxTokens || DEFAULT_MAX_TOKENS;
}

function _mergeExtraBody(body: Record<string, any>, llmCfg: LlmEndpointConfig): Record<string, any> {
  if (llmCfg.extraBody && typeof llmCfg.extraBody === 'object') {
    _deepMerge(body, llmCfg.extraBody);
  }
  return body;
}

function _buildOpenAiBody(
  messages: ChatMessage[],
  llmCfg: LlmEndpointConfig,
  options: Partial<CallLlmOptions>,
): Record<string, any> {
  const body = _mergeExtraBody({
    model: llmCfg.model,
    messages,
    temperature: llmCfg.temperature ?? 0.3,
    max_tokens: _requestMaxTokens(llmCfg, options),
    stream: false,
  }, llmCfg);
  // OpenAI JSON mode intentionally remains disabled.
  if (options.jsonMode) {
    /*body.response_format = { type: 'json_object' };*/
  }
  return body;
}

function _buildOpenAiResponsesBody(
  messages: ChatMessage[],
  llmCfg: LlmEndpointConfig,
  options: Partial<CallLlmOptions>,
): Record<string, any> {
  const instructions = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n');
  const body: Record<string, any> = {
    model: llmCfg.model,
    input: messages
      .filter(message => message.role !== 'system')
      .map(message => ({ role: message.role, content: message.content })),
    max_output_tokens: _requestMaxTokens(llmCfg, options),
    temperature: llmCfg.temperature ?? 0.3,
    stream: false,
  };
  if (instructions) body.instructions = instructions;
  return _mergeExtraBody(body, llmCfg);
}

function _buildAnthropicBody(
  messages: ChatMessage[],
  llmCfg: LlmEndpointConfig,
  options: Partial<CallLlmOptions>,
  endpoint: 'messages' | 'invoke' = 'messages',
): Record<string, any> {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n');
  const anthropicMessages = messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }));

  if (anthropicMessages[0]?.role === 'assistant') {
    anthropicMessages.unshift({ role: 'user', content: '.' });
  }

  const body: Record<string, any> = {
    ...(endpoint === 'messages' ? { model: llmCfg.model } : { anthropic_version: 'bedrock-2023-05-31' }),
    max_tokens: _requestMaxTokens(llmCfg, options),
    temperature: llmCfg.temperature ?? 0.3,
    messages: anthropicMessages,
  };
  if (system) body.system = system;
  return _mergeExtraBody(body, llmCfg);
}

type ResolvedApiFormat = Exclude<ApiFormat, 'auto'>;
type LlmRequest = { url: string; headers: Record<string, string>; body: Record<string, any> };

const DEFAULT_API_URLS: Partial<Record<ResolvedApiFormat, string>> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  'openai-responses': 'https://api.openai.com/v1/responses',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
};

function _hasGeneratedEndpointUrl(llmCfg: LlmEndpointConfig, format: ResolvedApiFormat): boolean {
  if (!llmCfg.apiFormat || llmCfg.apiFormat === 'auto') return false;
  return format === 'bedrock' || format === 'vertex' || DEFAULT_API_URLS[format] !== undefined;
}

function _apiUrlOrDefault(llmCfg: LlmEndpointConfig, format: ResolvedApiFormat): string {
  const configuredUrl = llmCfg.apiUrl || '';
  if (configuredUrl.trim()) return configuredUrl;
  return _hasGeneratedEndpointUrl(llmCfg, format) ? DEFAULT_API_URLS[format] || '' : '';
}

function _vertexProjectId(serviceAccountJson: LlmConfig['vertexAiServiceAccountJson']): string | null {
  try {
    const serviceAccount = typeof serviceAccountJson === 'string'
      ? JSON.parse(serviceAccountJson)
      : serviceAccountJson;
    const projectId = (serviceAccount as Record<string, unknown> | null | undefined)?.project_id;
    return typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null;
  } catch {
    return null;
  }
}

async function _buildLlmRequest(
  format: ResolvedApiFormat,
  messages: ChatMessage[],
  llmCfg: LlmEndpointConfig,
  options: CallLlmOptions,
  rotatedKey: string,
  config: LlmConfig,
): Promise<LlmRequest | null> {
  let url: string;
  let body: Record<string, any>;
  let headers: Record<string, string>;

  switch (format) {
    case 'openai':
      url = _apiUrlOrDefault(llmCfg, format);
      headers = { 'Content-Type': 'application/json' };
      if (rotatedKey) headers.Authorization = `Bearer ${rotatedKey}`;
      body = _buildOpenAiBody(messages, llmCfg, options);
      break;
    case 'openai-responses':
      url = _apiUrlOrDefault(llmCfg, format);
      headers = { 'Content-Type': 'application/json' };
      if (rotatedKey) headers.Authorization = `Bearer ${rotatedKey}`;
      body = _buildOpenAiResponsesBody(messages, llmCfg, options);
      break;
    case 'anthropic':
      url = _apiUrlOrDefault(llmCfg, format);
      headers = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (rotatedKey) headers['x-api-key'] = rotatedKey;
      body = _buildAnthropicBody(messages, llmCfg, options);
      break;
    case 'bedrock': {
      const region = llmCfg.awsRegion!.trim();
      const endpoint = llmCfg.bedrockEndpoint || 'messages';
      const useSigV4 = !!llmCfg.awsSecretAccessKey?.trim();
      if (endpoint === 'invoke') {
        const modelId = encodeURIComponent(llmCfg.model).replace(/%3A/gi, ':');
        url = `https://bedrock-runtime.${region}.amazonaws.com/model/${modelId}/invoke`;
        headers = {
          'content-type': 'application/json',
          accept: 'application/json',
        };
        if (!useSigV4 && rotatedKey) headers.Authorization = `Bearer ${rotatedKey}`;
        body = _buildAnthropicBody(messages, llmCfg, options, 'invoke');
      } else {
        url = `https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`;
        headers = {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        };
        if (!useSigV4 && rotatedKey) headers['x-api-key'] = rotatedKey;
        body = _buildAnthropicBody(messages, llmCfg, options);
      }
      break;
    }
    case 'gemini':
      url = buildGeminiUrl(_apiUrlOrDefault(llmCfg, format), llmCfg.model, rotatedKey, false);
      headers = { 'Content-Type': 'application/json' };
      body = buildGeminiBody(messages, llmCfg, options);
      break;
    case 'vertex': {
      let baseUrl = llmCfg.apiUrl || '';
      if (!baseUrl.trim()) {
        const projectId = _vertexProjectId(config.vertexAiServiceAccountJson);
        if (!projectId) {
          const error = 'Vertex: 서비스 계정 JSON의 project_id가 없어 주소를 만들 수 없습니다';
          console.log(`${LOG_PREFIX} ${error}`);
          _setLastError('llm', error);
          return null;
        }
        const region = llmCfg.gcpRegion?.trim() || 'global';
        baseUrl = region === 'global'
          ? `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global`
          : `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}`;
      }
      url = buildGeminiUrl(baseUrl, llmCfg.model, rotatedKey, true);
      headers = { 'Content-Type': 'application/json' };
      const saJson = config.vertexAiServiceAccountJson;
      if (saJson) {
        const accessToken = await _getVertexAccessToken(saJson);
        if (accessToken) {
          headers.Authorization = `Bearer ${accessToken}`;
        } else {
          console.log(`${LOG_PREFIX} VertexAI: failed to obtain access token, falling back to apiKey`);
          if (rotatedKey) headers.Authorization = `Bearer ${rotatedKey}`;
        }
      } else if (rotatedKey) {
        headers.Authorization = `Bearer ${rotatedKey}`;
      }
      body = buildGeminiBody(messages, llmCfg, options);
      break;
    }
  }

  if (llmCfg.extraHeaders && typeof llmCfg.extraHeaders === 'object') {
    for (const [key, value] of Object.entries(llmCfg.extraHeaders)) {
      if (key && value) headers[key] = String(value);
    }
  }
  return { url, headers, body };
}

// ── CoT (Chain of Thought) Instruction ──
function getCoTInstruction(llmCfg: LlmEndpointConfig): string {
  if (!llmCfg.manualCoT) return '';
  return '\n\nBefore answering, think step-by-step inside <Thought>...</Thought> tags. Only your final answer (outside the tags) will be used.';
}

// ── LLM Retry Wrapper ──
export async function withRetry<T>(fn: () => Promise<T>, maxRetries: number, label = 'LLM'): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        // Exponential backoff: 1s, 2s, 4s, ...
        const delay = Math.min(1000 * Math.pow(2, attempt), 16000);
        console.log(`${LOG_PREFIX} ${label} attempt ${attempt + 1}/${maxRetries + 1} failed: ${(e as Error).message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Auxiliary LLM Resolver ──
// Returns auxiliaryLlm config when configured, otherwise falls back to customLlm.
function _isEndpointConfigured(endpoint: LlmEndpointConfig | undefined): endpoint is LlmEndpointConfig {
  if (!endpoint?.model) return false;
  const format = resolveApiFormat(endpoint);
  return !!endpoint.apiUrl?.trim() || _hasGeneratedEndpointUrl(endpoint, format);
}

export function _resolveAuxLlm(config: LlmConfig): LlmEndpointConfig {
  const aux = config.auxiliaryLlm;
  if (_isEndpointConfigured(aux)) return aux;
  return config.customLlm;
}

// ── Main LLM Call ──
export async function callLLM(messages: ChatMessage[], options: CallLlmOptions): Promise<string | null> {
  _setLastError('llm', null);
  const config = options._config;
  if (!config) {
    const error = 'callLLM: options._config is required (no global config on server)';
    _setLastError('llm', error);
    throw new Error(error);
  }
  const llmCfg = options._useAux ? _resolveAuxLlm(config) : config.customLlm;
  const format = resolveApiFormat(llmCfg);

  if (!_isEndpointConfigured(llmCfg)) {
    console.log(`${LOG_PREFIX} LLM not configured. Set API URL and Model in OMNINODE settings.`);
    _setLastError('llm', 'LLM not configured. Set API URL and Model in OMNINODE settings.');
    return null;
  }
  if (format === 'bedrock' && !llmCfg.awsRegion?.trim()) {
    console.log(`${LOG_PREFIX} Bedrock not configured. Set AWS Region in OMNINODE settings.`);
    _setLastError('llm', 'Bedrock not configured. Set AWS Region in OMNINODE settings.');
    return null;
  }
  if (format === 'bedrock' && llmCfg.awsSecretAccessKey?.trim() && !llmCfg.awsAccessKeyId?.trim()) {
    const error = 'Bedrock: 액세스 키 ID가 비어 있습니다';
    console.log(`${LOG_PREFIX} ${error}`);
    _setLastError('llm', error);
    return null;
  }

  rpmLimiter.setLimit(config.rpm);

  // Inject Manual CoT instruction into system messages if enabled
  const cotInstr = getCoTInstruction(llmCfg);
  if (cotInstr) {
    messages = messages.map(m => m.role === 'system' ? { ...m, content: m.content + cotInstr } : m);
  }

  // Context window pre-flight check
  const ctxWindow = llmCfg.contextWindow || DEFAULT_CONTEXT_WINDOW;
  const inputTokens = estimateMessagesTokens(messages);
  const outputReserve = options.maxTokens || llmCfg.maxTokens || DEFAULT_MAX_TOKENS;
  if (inputTokens + outputReserve > ctxWindow) {
    console.log(`${LOG_PREFIX} ⚠️ Context window warning: ~${inputTokens} input + ${outputReserve} output = ${inputTokens + outputReserve} (limit: ${ctxWindow})`);
  }

  const maxRetries = config.maxRetries ?? 3;

  try {
    return await withRetry(async () => {
      await rpmLimiter.acquire();
      const _reqStart = performance.now();
      const _reqLabel = options._label || '';
      _llmLog({ type: 'req', model: llmCfg.model, tokens: inputTokens, aux: !!options._useAux, label: _reqLabel });
      const rotatedKey = getNextApiKey(llmCfg);
      const request = await _buildLlmRequest(format, messages, llmCfg, options, rotatedKey, config);
      if (!request) return null;
      const { url, headers, body } = request;

      // Apply CoT token budget if configured
      if ((llmCfg.cotTokenLimit || 0) > 0 && format === 'openai') {
        body.max_completion_tokens = (llmCfg.maxTokens || options.maxTokens || DEFAULT_MAX_TOKENS) + (llmCfg.cotTokenLimit || 0);
      }

      const requestBody = JSON.stringify(body);
      const requestHeaders = format === 'bedrock' && llmCfg.awsSecretAccessKey?.trim()
        ? signAwsRequest({
            method: 'POST',
            url,
            region: llmCfg.awsRegion!.trim(),
            service: (llmCfg.bedrockEndpoint || 'messages') === 'invoke' ? 'bedrock' : 'bedrock-mantle',
            accessKeyId: llmCfg.awsAccessKeyId!.trim(),
            secretAccessKey: llmCfg.awsSecretAccessKey.trim(),
            sessionToken: llmCfg.awsSessionToken?.trim() || undefined,
            headers,
            body: requestBody,
          })
        : headers;

      // 의도적 차이(원본엔 타임아웃 없음): 게이트웨이가 응답 없이 요청을 물고 있으면
      // 잡 러너·세션 락이 통째로 멈춘다 (크레딧 소진 실측 2026-08-01) → 타임아웃 필수
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: requestHeaders,
          body: requestBody,
          signal: llmFetchSignal(config),
        });
      } catch (e) {
        _setLastError('llm', e instanceof Error ? e.message : String(e));
        throw e;
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        const errMsg = `LLM API error ${resp.status}: ${errText.substring(0, 300)}`;
        _setLastError('llm', `HTTP ${resp.status}: ${errText.substring(0, 300)}`);
        console.log(`${LOG_PREFIX} ${errMsg}`);
        _llmLog({ type: 'err', error: `${resp.status}: ${errText.substring(0, 60)}` });
        throw new Error(errMsg);
      }

      const data = await resp.json() as any;
      const _elapsed = Math.round(performance.now() - _reqStart);

      const _legacyOutTok = data.usage?.completion_tokens || data.usageMetadata?.candidatesTokenCount || null;
      const _outTok = format === 'anthropic' || format === 'bedrock'
        ? data.usage?.output_tokens ?? _legacyOutTok
        : format === 'openai-responses'
          ? data.usage?.output_tokens ?? _legacyOutTok
          : _legacyOutTok;

      if (format === 'openai-responses') {
        if (typeof data.output_text === 'string') {
          _llmLog({ type: 'res', dur: _elapsed, outTokens: _outTok });
          return data.output_text;
        }
        const texts = Array.isArray(data.output)
          ? data.output
            .filter((item: any) => item?.type === 'message' && Array.isArray(item.content))
            .flatMap((item: any) => item.content)
            .filter((item: any) => item?.type === 'output_text' && typeof item.text === 'string')
            .map((item: any) => item.text)
          : [];
        if (texts.length > 0) {
          _llmLog({ type: 'res', dur: _elapsed, outTokens: _outTok });
          return texts.join('');
        }
      } else if (format === 'anthropic' || format === 'bedrock') {
        const texts = Array.isArray(data.content)
          ? data.content
            .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
            .map((item: any) => item.text)
          : [];
        if (texts.length > 0) {
          _llmLog({ type: 'res', dur: _elapsed, outTokens: _outTok });
          return texts.join('');
        }
      } else {
        // Existing Gemini/OpenAI-compatible fallback parsing remains unchanged.
        if (data.candidates) {
          const text = parseGeminiResponse(data);
          if (text) { _llmLog({ type: 'res', dur: _elapsed, outTokens: _outTok }); return text; }
          // 생각(thinking) 모델이 출력 한도를 생각에 다 쓰면 parts가 thought뿐이거나 비어 있고
          // finishReason=MAX_TOKENS로 온다 — "형식 불명"이 아니라 한도 문제이므로 그렇게 알려준다 (2026-08-30 Vertex gemini-3.1 실측)
          const cand = data?.candidates?.[0];
          if (cand) {
            const reason = cand.finishReason || 'unknown';
            const onlyThoughts = Array.isArray(cand.content?.parts) && cand.content.parts.length > 0
              && cand.content.parts.every((p: any) => p.thought || !p.text);
            const detail = reason === 'MAX_TOKENS' || onlyThoughts
              ? `응답이 생각(thinking)에 토큰을 다 써서 답 텍스트가 비었습니다 (finishReason=${reason}) — 최대 응답 토큰을 올리세요`
              : `Gemini 응답에 텍스트가 없습니다 (finishReason=${reason}): ${JSON.stringify(data).substring(0, 300)}`;
            _llmLog({ type: 'err', error: detail });
            _setLastError('llm', detail);
            throw new Error(detail);
          }
        }
        if (data.choices && data.choices[0]) {
          _llmLog({ type: 'res', dur: _elapsed, outTokens: _outTok });
          const choice = data.choices[0];
          const message = choice.message;
          const hasReasoning = [message?.reasoning_content, message?.reasoning].some((value: unknown) => {
            if (typeof value === 'string') return value.trim().length > 0;
            if (Array.isArray(value)) return value.length > 0;
            return value !== null && value !== undefined;
          });
          const contentIsEmpty = message?.content === null || message?.content === undefined
            || (typeof message.content === 'string' && message.content.trim().length === 0);
          if (contentIsEmpty && hasReasoning) {
            const finishDetail = choice.finish_reason === 'length' ? ' (finish_reason=length)' : '';
            const detail = `응답이 생각(thinking)에 토큰을 다 써서 답 텍스트가 비었습니다${finishDetail} — 최대 응답 토큰을 올리세요`;
            _llmLog({ type: 'err', error: detail });
            _setLastError('llm', detail);
            return null;
          }
          const text = message?.content || choice.text || null;
          if (text === null) _setLastError('llm', 'unexpected response format');
          return text;
        }
        if (data.content && Array.isArray(data.content)) {
          _llmLog({ type: 'res', dur: _elapsed, outTokens: _outTok });
          return data.content.map((c: any) => c.text || '').join('');
        }
        if (typeof data.result === 'string') { _llmLog({ type: 'res', dur: _elapsed, outTokens: _outTok }); return data.result; }
        if (typeof data.response === 'string') { _llmLog({ type: 'res', dur: _elapsed, outTokens: _outTok }); return data.response; }
      }

      const excerpt = JSON.stringify(data).substring(0, 300);
      console.log(`${LOG_PREFIX} LLM: unexpected response format: ${excerpt}`);
      _llmLog({ type: 'err', error: 'unexpected response format' });
      _setLastError('llm', `unexpected response format: ${excerpt}`);
      throw new Error('LLM returned unexpected response format');
    }, maxRetries, 'callLLM');
  } catch (e) {
    if (!_getLastError('llm')) {
      _setLastError('llm', e instanceof Error ? e.message : String(e));
    }
    throw e;
  }
}

// ── Strip thinking tags ──
export function stripThought(raw: string | null | undefined): { thought: string; content: string } {
  if (!raw) return { thought: '', content: raw || '' };
  const thoughts: string[] = [];
  const content = raw.replace(/<(think|thinking|thought)>([\s\S]*?)(?:<\/\1>|$)/gi, (_block, _tag, body: string) => {
    thoughts.push(body.trim());
    return '';
  }).trim();
  return { thought: thoughts.join('\n'), content };
}

// 테스트용: 모듈 상태 초기화
export function _resetLlmClientState() {
  _keyRotationState.clear();
  _vertexTokenCache = { token: null, expiry: 0 };
  for (const kind of ['llm', 'embedding', 'reranker'] as const) delete _lastError[kind];
  rpmLimiter._timestamps = [];
  rpmLimiter._limit = 0;
}
