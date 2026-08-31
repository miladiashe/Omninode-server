import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import qrcode from 'qrcode-terminal';
import { SETTINGS_HTML } from './web/settings-page.js';
import { INJECTION_HTML } from './web/injection-page.js';
import { DASHBOARD_HTML } from './web/dashboard-page.js';
import { GRAPH_HTML } from './web/graph-page.js';
import { API_VERSION, loadConfig } from './config.js';
import { openDb } from './db.js';
import { bearerAuth } from './auth.js';
import { ChatStateRepo } from './persistence/chat-state-repo.js';
import { ConfigStore } from './config-store.js';
import { SessionManager } from './pipeline/session.js';
import { runPipeline, type PipelineRequest } from './pipeline/pipeline.js';
import { realNodeEditAgent } from './pipeline/node-edit-agent.js';
import { JobRunner } from './jobs/runner.js';
import { setLlmLogger } from './llm/client.js';
import { setMaxNodeContentChars } from './core/node-store.js';
import { registerChatMetaRoutes } from './routes/chat-meta.js';
import { registerConfigTestRoutes } from './routes/config-test.js';

// LLM 호출 관측 — 어떤 모델에 몇 토큰 요청이 나가 몇 초 걸렸는지 콘솔에 기록
// (게이트웨이 행/저속을 잡 고착과 구분하기 위함 — 2026-08-01 오진 사례)
setLlmLogger(e => {
  if (e.type === 'req') console.log(`[llm] → ${e.model}${e.aux ? ' (aux)' : ''} ${e.tokens}tok ${e.label}`);
  else if (e.type === 'res') console.log(`[llm] ← ${(e.dur / 1000).toFixed(1)}s${e.outTokens != null ? ` ${e.outTokens}tok` : ''}`);
  else console.log(`[llm] ✗ ${e.error}`);
});

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const config = loadConfig();
const db = openDb(config.dataDir);
const repo = new ChatStateRepo(db.sqlite);
const configStore = new ConfigStore(db.sqlite);
const sessions = new SessionManager(repo);
setMaxNodeContentChars(configStore.load().maxNodeContentChars); // 노드 내용 캡 반영 (D2)
const jobRunner = new JobRunner(db.sqlite, repo, sessions, configStore, realNodeEditAgent);
jobRunner.start();

const app = new Hono();
app.use('*', cors());

// 접근 로그 — 요청이 서버에 닿는지부터 보이게 (플러그인 무호출 디버깅용)
app.use('*', async (c, next) => {
  const t0 = Date.now();
  await next();
  console.log(`[http] ${c.req.method} ${c.req.path} → ${c.res.status} (${Date.now() - t0}ms)`);
  return;
});

// 설정 페이지 — 규칙: "플러그인에 넣은 그 주소를 브라우저에 열면 설정 화면"
app.get('/', (c) => c.redirect('/settings'));
app.get('/settings', (c) => c.html(SETTINGS_HTML));
app.get('/injection', (c) => c.html(INJECTION_HTML)); // 주입 내역 뷰어 (회상 검증)
app.get('/dashboard', (c) => c.html(DASHBOARD_HTML)); // 채팅 목록·잡·기억 리셋 (Phase 8b)
app.get('/graph', (c) => c.html(GRAPH_HTML)); // 노드 그래프 뷰어·편집 (Phase 8c/8d)

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    version: pkg.version,
    apiVersion: API_VERSION,
  }),
);

app.use('/api/*', bearerAuth(config.token));

// 인증 동작 확인용
app.get('/api/ping', (c) => c.json({ pong: true }));

// ── 설정 (원본 설정 패널의 서버판 — UI는 Phase 8) ──
app.get('/api/config', (c) => c.json(configStore.load()));
app.get('/api/config/raw', (c) => c.json(configStore.loadRaw()));
app.put('/api/config', async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'config must be a JSON object' }, 400);
  }
  // 얕은 병합 — 부분 PUT이 나머지 설정을 날리지 않게 (2026-08-05 사고: 정규식 한 키
  // PUT이 LLM 설정 전체를 지움). 최상위 키 단위 교체이므로 customLlm 등 중첩 객체를
  // 보낼 땐 그 객체의 전체 내용을 보내야 한다 (설정 페이지는 원래 전체 폼 전송이라 무관).
  // 키 삭제는 값에 null을 보내면 됨.
  const merged: Record<string, unknown> = { ...configStore.loadRaw(), ...body };
  for (const [k, v] of Object.entries(merged)) {
    if (v === null) delete merged[k];
  }
  configStore.save(merged);
  setMaxNodeContentChars(configStore.load().maxNodeContentChars); // 즉시 반영
  return c.json({ ok: true });
});

// ── 파이프라인 (플러그인 beforeRequest → 여기) ──
app.post('/api/chats/:chatKey/pipeline', async (c) => {
  const chatKey = c.req.param('chatKey');
  const body = await c.req.json() as PipelineRequest;
  if (!Array.isArray(body?.messages)) {
    return c.json({ error: 'messages array required' }, 400);
  }
  const omniConfig = configStore.load();
  const session = sessions.get(chatKey);
  session.pipelineWaiting++; // dream 잡이 이 신호를 보고 태스크 사이에 조기 양보
  try {
    const result = await session.runExclusive(() =>
      runPipeline(session, body, omniConfig, repo, realNodeEditAgent, jobRunner),
    );
    return c.json(result);
  } catch (e) {
    // 파이프라인 실패 시에도 원본과 동일하게 무수정 통과 응답 (플러그인 폴백 일관성)
    console.error('[pipeline] error:', e);
    return c.json({ messages: body.messages, loreCtx: '', memCtx: '', stats: null, error: (e as Error).message }, 500);
  } finally {
    session.pipelineWaiting--;
  }
});

// ── afterRequest 통지 → 오토드림 dream 잡 등록 (활동 기반 트리거, PLAN §5) ──
app.post('/api/chats/:chatKey/after-request', (c) => {
  const chatKey = c.req.param('chatKey');
  const omniConfig = configStore.load();
  const session = sessions.get(chatKey);
  if (session.isEnabled() && omniConfig.autodreamEnabled !== false) {
    // 인터벌만큼 뒤로 미룬 디바운스 등록 — 채팅이 활발한 동안엔 실행이 계속 밀리고,
    // 잠잠해지면 한 번 돈다 (원본 인터벌 루프의 서버판)
    const delayMs = Math.max(15, Math.min(300, Math.trunc(Number(omniConfig.autodreamAutoInterval)) || 60)) * 1000;
    jobRunner.enqueue(chatKey, 'dream', {}, { delayMs });
  }
  return c.json({ ok: true });
});

// ── 잡 조회 (E2E/디버깅용) ──
app.get('/api/jobs', (c) => c.json(jobRunner.listJobs(c.req.query('chatKey') || undefined)));

// ── STEP 0: 로어북 임포트 (플러그인이 CBS 해석 완료 엔트리를 보냄 — HANDOFF §1.B) ──
app.post('/api/chats/:chatKey/import-lorebook', async (c) => {
  const chatKey = c.req.param('chatKey');
  const body = await c.req.json() as { entries?: unknown[] };
  if (!Array.isArray(body?.entries) || body.entries.length === 0) {
    return c.json({ error: 'entries array required' }, 400);
  }
  const session = sessions.get(chatKey);
  await session.runExclusive(async () => {
    session.enabled = true;
    repo.flush(chatKey, session.store, session.diffManager, session.simulBot, session.enabled);
  });
  jobRunner.enqueue(chatKey, 'import-lorebook', { entries: body.entries });
  void jobRunner.tick(); // 즉시 시작 시도 (다른 잡 실행 중이면 다음 틱에)
  return c.json({ queued: true, entries: body.entries.length, hint: 'GET /api/jobs?chatKey=... 로 진행 확인' });
});

// ── STEP 0.5: 콜드 스타트 — 기존 채팅 히스토리에서 기억 형성 ──
app.post('/api/chats/:chatKey/cold-start', async (c) => {
  const chatKey = c.req.param('chatKey');
  const body = await c.req.json() as { messages?: unknown[]; personaName?: string; charName?: string };
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages array required' }, 400);
  }
  const session = sessions.get(chatKey);
  await session.runExclusive(async () => {
    session.enabled = true;
    repo.flush(chatKey, session.store, session.diffManager, session.simulBot, session.enabled);
  });
  jobRunner.enqueue(chatKey, 'cold-start', {
    messages: body.messages,
    personaName: body.personaName || '',
    charName: body.charName || '',
    simulBot: session.simulBot,
  });
  void jobRunner.tick();
  return c.json({ queued: true, messages: body.messages.length, hint: 'GET /api/jobs?chatKey=... 로 진행 확인' });
});

// ── 마지막 턴 주입 내역 — "진짜 주입인지 눈치인지" 회상 검증용 ──
app.get('/api/chats/:chatKey/last-injection', (c) => {
  const chatKey = c.req.param('chatKey');
  if (!sessions.has(chatKey)) return c.json({ error: 'no active session for this chat' }, 404);
  const inj = sessions.get(chatKey).lastInjection;
  if (!inj) return c.json({ error: 'no injection recorded yet' }, 404);
  return c.json(inj);
});

// ── 그래프 분기(clone) — 챗 복사 시 기억 복제 (HANDOFF §1.5 챗 복사 사고 해결책 ②) ──
app.post('/api/chats/:chatKey/clone-to/:dstKey', async (c) => {
  const src = c.req.param('chatKey');
  const dst = c.req.param('dstKey');
  if (src === dst) return c.json({ error: 'src and dst must differ' }, 400);
  if (!repo.chatExists(src) && !sessions.has(src)) {
    return c.json({ error: 'source chat not found' }, 404);
  }
  const overwrite = c.req.query('overwrite') === 'true';
  if (repo.chatExists(dst) && !overwrite) {
    return c.json({ error: 'destination exists (retry with ?overwrite=true)' }, 409);
  }
  // 램의 최신 상태를 먼저 플러시 — 파이프라인 실행과의 경합은 runExclusive로 직렬화
  if (sessions.has(src)) {
    const srcSession = sessions.get(src);
    await srcSession.runExclusive(async () => {
      repo.flush(src, srcSession.store, srcSession.diffManager, srcSession.simulBot, srcSession.enabled);
    });
  }
  if (overwrite) repo.deleteChat(dst);
  const copied = repo.cloneChat(src, dst);
  sessions.drop(dst); // 낡은 램 세션 제거 — 다음 접근 시 복제본 로드
  return c.json({ ok: true, copied });
});

// ── 기억 삭제 (기억 리셋·프라이버시 소거 — HANDOFF §G) ──
app.delete('/api/chats/:chatKey', (c) => {
  const chatKey = c.req.param('chatKey');
  if (!repo.chatExists(chatKey) && !sessions.has(chatKey)) {
    return c.json({ error: 'chat not found' }, 404);
  }
  sessions.drop(chatKey); // 램 먼저 — 이후 flush가 부활시키지 못하게
  repo.deleteChat(chatKey);
  // jobs 테이블은 deleteChat 범위 밖 — 콜드스타트 페이로드에 대화 원문이 있어 반드시 삭제
  db.sqlite.prepare('DELETE FROM jobs WHERE chat_key = ?').run(chatKey);
  if (c.req.query('purge') === 'true') {
    // 프라이버시 소거: WAL 잔상 + 삭제 페이지 재사용 공간까지 제거
    db.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    db.sqlite.exec('VACUUM');
  }
  console.log(`[omninode-server] chat memory deleted: ${chatKey}${c.req.query('purge') === 'true' ? ' (purged)' : ''}`);
  return c.json({ ok: true });
});

// ── 노드 조회 (웹 UI/디버깅용 최소) ──
app.get('/api/chats', (c) => c.json(repo.listChats()));
registerChatMetaRoutes(app, sessions, repo);
registerConfigTestRoutes(app, configStore);
app.get('/api/chats/:chatKey/nodes', (c) => {
  const session = sessions.get(c.req.param('chatKey'));
  return c.json({
    turn: session.store.currentTurn,
    nodeCount: session.store.getNodeCount(),
    nodes: session.store.serializeFull(), // 보충 필드(커뮤니티 멤버 등) 포함 — 디버깅 뷰 정확성
  });
});

const NODE_PATCH_KEYS = new Set([
  'name', 'content', 'keywords', 'globalKeywords', 'importance', 'activationScore',
  'timestamp', 'alwaysActive', 'archived', 'excluded',
]);
const SERIALIZED_NODE_KEYS = [
  'loreNodes', 'extraLoreNodes', 'communityNodes', 'longTermMemoryNodes',
] as const;

app.patch('/api/chats/:chatKey/nodes/:nodeId', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'body must be a JSON object' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'body must be a JSON object' }, 400);
  }

  const patch = body as Record<string, unknown>;
  const unknownKeys = Object.keys(patch).filter(key => !NODE_PATCH_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return c.json({ error: `unknown node patch key(s): ${unknownKeys.join(', ')}` }, 400);
  }
  for (const key of ['name', 'content'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'string') {
      return c.json({ error: `${key} must be a string` }, 400);
    }
  }
  for (const key of ['keywords', 'globalKeywords'] as const) {
    if (patch[key] !== undefined && (!Array.isArray(patch[key]) || !patch[key].every(value => typeof value === 'string'))) {
      return c.json({ error: `${key} must be an array of strings` }, 400);
    }
  }
  for (const key of ['importance', 'activationScore'] as const) {
    if (patch[key] !== undefined && (typeof patch[key] !== 'number' || !Number.isFinite(patch[key]))) {
      return c.json({ error: `${key} must be a finite number` }, 400);
    }
  }
  if (patch.timestamp !== undefined && patch.timestamp !== null && typeof patch.timestamp !== 'string') {
    return c.json({ error: 'timestamp must be a string or null' }, 400);
  }
  for (const key of ['alwaysActive', 'archived', 'excluded'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      return c.json({ error: `${key} must be a boolean` }, 400);
    }
  }

  const chatKey = c.req.param('chatKey');
  const nodeId = c.req.param('nodeId');
  const session = sessions.get(chatKey);
  const serialized = await session.runExclusive(async () => {
    if (!session.store.getNode(nodeId)) return null;

    // 수동 편집은 원문을 파괴할 수 있으므로 변이 직전 상태를 명시적인 BASE로 남긴다.
    await session.diffManager.takeDiff(session.store, 'BASE');
    const node = session.store.updateNode(nodeId, patch)!;

    // 원작 updateNode도 아래 필드를 대입하지 않는다. 원작 편집 모달이 alwaysActive를
    // 직접 대입한 것과 같은 방식으로 REST 전용 필드를 보충한다. archived 캐시 무효화는
    // updateNode가 patch 키를 보고 이미 수행한다.
    if (patch.globalKeywords !== undefined) node.globalKeywords = [...patch.globalKeywords as string[]];
    if (patch.alwaysActive !== undefined) node.alwaysActive = patch.alwaysActive as boolean;
    if (patch.archived !== undefined) node.archived = patch.archived as boolean;
    if (patch.excluded !== undefined) node.excluded = patch.excluded as boolean;

    repo.flush(chatKey, session.store, session.diffManager, session.simulBot, session.enabled);
    const full = session.store.serializeFull() as Record<string, unknown>;
    for (const key of SERIALIZED_NODE_KEYS) {
      const entries = full[key];
      if (!Array.isArray(entries)) continue;
      const result = entries.find(entry => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === nodeId);
      if (result) return result as Record<string, unknown>;
    }
    return null;
  });

  if (!serialized) return c.json({ error: 'node not found' }, 404);
  return c.json(serialized);
});

app.delete('/api/chats/:chatKey/nodes/:nodeId', async (c) => {
  const chatKey = c.req.param('chatKey');
  const nodeId = c.req.param('nodeId');
  const session = sessions.get(chatKey);
  const removedId = await session.runExclusive(async () => {
    if (!session.store.getNode(nodeId)) return null;

    // 삭제 직전 상태를 BASE로 남겨 파괴적 작업의 복구 경로를 보존한다.
    await session.diffManager.takeDiff(session.store, 'BASE');
    session.store.removeNode(nodeId);
    repo.flush(chatKey, session.store, session.diffManager, session.simulBot, session.enabled);
    return nodeId;
  });

  if (!removedId) return c.json({ error: 'node not found' }, 404);
  return c.json({ ok: true, removedId });
});

function printStartupBanner(port: number) {
  const ips: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
    }
  }
  const primary = ips[0] ? `http://${ips[0]}:${port}` : `http://localhost:${port}`;
  const settingsUrl = `${primary}/settings#token=${config.token}`;

  const omniConfig = configStore.load();
  const llmReady = !!(omniConfig.customLlm?.apiUrl && omniConfig.customLlm?.model);

  const lines = [
    `OmniNode Server v${pkg.version} (api v${API_VERSION})`,
    '',
    llmReady ? '상태: LLM 설정 완료 ✓' : '⚠️  LLM 미설정 — 아래 주소에서 설정하세요!',
    '',
    '설정 페이지 (토큰 자동 입력됨):',
    `  ${settingsUrl}`,
    ...(ips.length > 1 ? ips.slice(1).map(ip => `  http://${ip}:${port}/settings#token=${config.token}`) : []),
    `  http://localhost:${port}/settings#token=${config.token}`,
  ];
  const width = Math.max(...lines.map(l => l.length));
  const bar = '─'.repeat(width + 2);
  console.log(`┌${bar}┐`);
  for (const l of lines) console.log(`│ ${l.padEnd(width)} │`);
  console.log(`└${bar}┘`);

  // 다른 기기(폰 등)에서 열 때: QR 스캔 한 번이면 끝
  if (ips.length > 0) {
    console.log('폰에서 설정하려면 QR 스캔:');
    qrcode.generate(settingsUrl, { small: true });
  }
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[omninode-server] data dir: ${config.dataDir}`);
  printStartupBanner(info.port);
});
