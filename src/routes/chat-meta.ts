import type { Context, Hono } from 'hono';
import type { ChatStateRepo } from '../persistence/chat-state-repo.js';
import type { SessionManager } from '../pipeline/session.js';

function sessionMeta(sessions: SessionManager, chatKey: string) {
  const session = sessions.get(chatKey);
  return {
    turn: session.store.currentTurn,
    nodeCount: session.store.getNodeCount(),
    simulBot: session.simulBot,
    enabled: session.isEnabled(),
    enabledExplicit: typeof session.enabled === 'boolean',
  };
}

// 시작 화면용 경량 메타 API. 노드 전문은 직렬화하지 않고 스토어 카운터만 읽는다.
export function registerChatMetaRoutes(
  app: Hono,
  sessions: SessionManager,
  repo: ChatStateRepo,
): void {
  app.get('/api/chats/:chatKey/meta', (c) => {
    return c.json(sessionMeta(sessions, c.req.param('chatKey')));
  });

  // PUT과 POST 동일 처리. 플러그인은 POST만 쓴다 — RisuAI 노드서버(도커)의 /proxy2 프록시가
  // GET·POST만 라우팅해 PUT이 404로 떨어짐 (server/node/server.cjs, 2026-08-29 온보딩 스모크에서 발견).
  // 브라우저가 서버를 직접 호출하는 웹 페이지 경로는 프록시를 안 타므로 다른 PUT/PATCH/DELETE는 무관.
  const updateMeta = async (c: Context) => {
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
    const unknownKeys = Object.keys(patch).filter(key => key !== 'simulBot' && key !== 'enabled');
    if (unknownKeys.length > 0) {
      return c.json({ error: `unknown chat meta key(s): ${unknownKeys.join(', ')}` }, 400);
    }
    if (patch.simulBot !== undefined && typeof patch.simulBot !== 'boolean') {
      return c.json({ error: 'simulBot must be a boolean' }, 400);
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    const chatKey = c.req.param('chatKey') as string;
    const session = sessions.get(chatKey);
    return session.runExclusive(async () => {
      if (typeof patch.simulBot === 'boolean') session.simulBot = patch.simulBot;
      if (typeof patch.enabled === 'boolean') session.enabled = patch.enabled;
      repo.flush(chatKey, session.store, session.diffManager, session.simulBot, session.enabled);
      return c.json(sessionMeta(sessions, chatKey));
    });
  };
  app.put('/api/chats/:chatKey/meta', updateMeta);
  app.post('/api/chats/:chatKey/meta', updateMeta);
}
