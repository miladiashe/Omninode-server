import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { openDbFile } from '../src/db.js';
import { ChatStateRepo } from '../src/persistence/chat-state-repo.js';
import { SessionManager } from '../src/pipeline/session.js';
import { registerChatMetaRoutes } from '../src/routes/chat-meta.js';

describe('chat meta API', () => {
  it('PUT으로 저장한 simulBot=false를 세션 재로드 뒤 GET으로 복원한다', async () => {
    const db = openDbFile(':memory:');
    const repo = new ChatStateRepo(db.sqlite);
    const sessions = new SessionManager(repo);
    const app = new Hono();
    registerChatMetaRoutes(app, sessions, repo);

    const session = sessions.get('meta-roundtrip');
    session.store.currentTurn = 7;
    session.store.addExtraLoreNode({ name: '기억', content: '저장 확인', keywords: ['확인'] });

    const put = await app.request('/api/chats/meta-roundtrip/meta', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ simulBot: false }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({
      turn: 7, nodeCount: 1, simulBot: false, enabled: true, enabledExplicit: false,
    });

    const stored = db.sqlite.prepare('SELECT meta_json FROM chats WHERE chat_key = ?')
      .get('meta-roundtrip') as { meta_json: string };
    expect(JSON.parse(stored.meta_json).simulBot).toBe(false);
    expect(JSON.parse(stored.meta_json)).not.toHaveProperty('enabled');

    const reloadedRepo = new ChatStateRepo(db.sqlite);
    const reloadedSessions = new SessionManager(reloadedRepo);
    const reloadedApp = new Hono();
    registerChatMetaRoutes(reloadedApp, reloadedSessions, reloadedRepo);

    const get = await reloadedApp.request('/api/chats/meta-roundtrip/meta');
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({
      turn: 7, nodeCount: 1, simulBot: false, enabled: true, enabledExplicit: false,
    });
    expect(reloadedSessions.get('meta-roundtrip').simulBot).toBe(false);
  });

  it('POST도 PUT과 동일하게 메타를 저장한다 (RisuAI 도커 /proxy2가 PUT을 404로 거부하므로 플러그인은 POST 사용)', async () => {
    const db = openDbFile(':memory:');
    const repo = new ChatStateRepo(db.sqlite);
    const sessions = new SessionManager(repo);
    const app = new Hono();
    registerChatMetaRoutes(app, sessions, repo);

    const post = await app.request('/api/chats/meta-post/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ simulBot: false, enabled: true }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toMatchObject({ simulBot: false, enabled: true, enabledExplicit: true });
    const stored = db.sqlite.prepare('SELECT meta_json FROM chats WHERE chat_key = ?')
      .get('meta-post') as { meta_json: string };
    expect(JSON.parse(stored.meta_json)).toMatchObject({ simulBot: false, enabled: true });

    const bad = await app.request('/api/chats/meta-post/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ simulBot: 'yes' }),
    });
    expect(bad.status).toBe(400);
  });

  it('enabled 파생값은 저장하지 않고 명시 PUT만 저장하며 boolean만 허용한다', async () => {
    const db = openDbFile(':memory:');
    const repo = new ChatStateRepo(db.sqlite);
    const sessions = new SessionManager(repo);
    const app = new Hono();
    registerChatMetaRoutes(app, sessions, repo);

    const initial = await app.request('/api/chats/meta-enabled/meta');
    expect(await initial.json()).toMatchObject({ enabled: false, enabledExplicit: false, nodeCount: 0 });
    expect(repo.chatExists('meta-enabled')).toBe(false); // GET 파생값은 비영속

    const invalid = await app.request('/api/chats/meta-enabled/meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(invalid.status).toBe(400);

    const put = await app.request('/api/chats/meta-enabled/meta', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
    });
    expect(await put.json()).toMatchObject({ enabled: true, enabledExplicit: true, nodeCount: 0 });
    const stored = db.sqlite.prepare('SELECT meta_json FROM chats WHERE chat_key = ?')
      .get('meta-enabled') as { meta_json: string };
    expect(JSON.parse(stored.meta_json).enabled).toBe(true);
  });
});
