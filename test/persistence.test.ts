// Phase 2 영속화 테스트: 행 단위 저장의 무결성과 증분 저장 효율
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDbFile, type Db } from '../src/db.js';
import { ChatStateRepo } from '../src/persistence/chat-state-repo.js';
import { OmniNodeStore } from '../src/core/node-store.js';
import { DiffManager } from '../src/core/diff-manager.js';
import { contentHash } from '../src/core/util.js';
import { makeFixture, mulberry32, randVec } from './fixture.js';

let db: Db;
let repo: ChatStateRepo;

beforeEach(() => {
  db = openDbFile(':memory:');
  repo = new ChatStateRepo(db.sqlite);
});

function makeStore(seed: number): OmniNodeStore {
  return OmniNodeStore.deserialize(structuredClone(makeFixture(seed)));
}

describe('ChatStateRepo', () => {
  it('저장 → 새 저장소 인스턴스로 로드 → 상태가 완전히 일치한다', () => {
    const store = makeStore(101);
    repo.flush('chat-a', store, new DiffManager());

    const fresh = new ChatStateRepo(db.sqlite); // shadow 없는 콜드 로드
    const { store: loaded, exists } = fresh.load('chat-a');
    expect(exists).toBe(true);
    expect(JSON.stringify(loaded.serialize())).toBe(JSON.stringify(store.serialize()));
    // 임베딩 캐시 (BLOB 왕복)
    expect(JSON.stringify(loaded.serializeEmbeddingCaches()))
      .toBe(JSON.stringify(store.serializeEmbeddingCaches()));
  });

  it('원본 serialize()가 유실하는 커뮤니티 필드를 보존한다 (원본 버그 수정 검증)', () => {
    const store = makeStore(102);
    const orig = store.communityNodes.get('csn_fix_1')!;
    expect(orig.memberNodeIds!.length).toBeGreaterThan(0); // 픽스처 전제

    repo.flush('chat-b', store, new DiffManager());
    const { store: loaded } = new ChatStateRepo(db.sqlite).load('chat-b');
    const node = loaded.communityNodes.get('csn_fix_1')!;
    expect(node.memberNodeIds).toEqual(orig.memberNodeIds);
    expect(node.communityId).toBe(orig.communityId);
    expect(node.level).toBe(orig.level);
    expect(node.parentCommunityId ?? null).toBe(orig.parentCommunityId ?? null);
    // 대조: 원본 serialize() 출력에는 이 필드들이 없다 (원본 유실 버그의 증명)
    const serialized = store.serialize() as any;
    const rawEntry = serialized.communityNodes.find((n: any) => n.id === 'csn_fix_1');
    expect(rawEntry.memberNodeIds).toBeUndefined();
  });

  it('점수만 바뀐 플러시는 UPSERT 0건, 점수 UPDATE만 발생한다', () => {
    const store = makeStore(103);
    const first = repo.flush('chat-c', store);
    expect(first.nodesUpserted).toBe(store.getNodeCount());

    // 핫 필드만 변경 (EMA 감쇠 — tick은 승격/아카이브로 구조를 바꿀 수 있어 별도 케이스)
    store.updateActivationScores(['ln_fix_1', 'eln_fix_2']);
    const second = repo.flush('chat-c', store);
    expect(second.nodesUpserted).toBe(0);
    expect(second.scoresUpdated).toBe(store.getNodeCount());
    expect(second.nodesDeleted).toBe(0);

    // 로드해서 점수 반영 확인
    const { store: loaded } = new ChatStateRepo(db.sqlite).load('chat-c');
    expect(JSON.stringify(loaded.serialize())).toBe(JSON.stringify(store.serialize()));
  });

  it('구조 변경은 해당 노드만 UPSERT, 삭제는 행 DELETE로 반영된다', () => {
    const store = makeStore(104);
    repo.flush('chat-d', store);

    store.updateNode('eln_fix_3', { content: '구조가 바뀐 내용', keywords: ['새키워드'] });
    store.removeNode('ltm_fix_1');
    const added = store.addExtraLoreNode({ name: '추가', content: '신규 노드', keywords: ['추가'], importance: 4 });
    const stats = repo.flush('chat-d', store);
    // eln_fix_3(수정) + 신규 1건 + ltm_fix_1 관계정리로 구조가 바뀐 노드들
    expect(stats.nodesUpserted).toBeGreaterThanOrEqual(2);
    expect(stats.nodesUpserted).toBeLessThan(10); // 전량 재작성이 아님
    expect(stats.nodesDeleted).toBe(1);

    const { store: loaded } = new ChatStateRepo(db.sqlite).load('chat-d');
    expect(loaded.getNode('ltm_fix_1')).toBeNull();
    expect(loaded.getNode(added.id)?.content).toBe('신규 노드');
    expect(JSON.stringify(loaded.serialize())).toBe(JSON.stringify(store.serialize()));
  });

  it('removeNode 후 flush한 노드와 종속 캐시는 새 리포에서 부활하지 않는다', async () => {
    const store = makeStore(111);
    const nodeId = 'ln_fix_0';
    const node = store.getNode(nodeId)!;
    const hash = contentHash(node.content);
    store.textEmbeddingCache.set(hash, new Float32Array([0.1, 0.2]));
    store.hydeCache.set(hash, { text: '삭제 검증', embedding: new Float32Array([0.3, 0.4]) });
    const dm = new DiffManager();
    repo.flush('chat-delete', store, dm);

    expect(store.embeddingCache.has(nodeId)).toBe(true);
    expect((db.sqlite.prepare('SELECT COUNT(*) AS count FROM nodes WHERE chat_key = ? AND id = ?')
      .get('chat-delete', nodeId) as { count: number }).count).toBe(1);
    expect((db.sqlite.prepare('SELECT COUNT(*) AS count FROM node_embeddings WHERE chat_key = ? AND node_id = ?')
      .get('chat-delete', nodeId) as { count: number }).count).toBe(1);

    await dm.takeDiff(store, 'BASE');
    expect(store.removeNode(nodeId)).toBe(true);
    const stats = repo.flush('chat-delete', store, dm);
    expect(stats.nodesDeleted).toBe(1);
    expect(stats.nodeEmbDeleted).toBe(1);

    for (const table of ['nodes', 'node_embeddings']) {
      const column = table === 'nodes' ? 'id' : 'node_id';
      const row = db.sqlite.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE chat_key = ? AND ' + column + ' = ?')
        .get('chat-delete', nodeId) as { count: number };
      expect(row.count).toBe(0);
    }
    for (const table of ['text_embeddings', 'hyde_cache']) {
      const row = db.sqlite.prepare('SELECT COUNT(*) AS count FROM ' + table + ' WHERE chat_key = ? AND hash = ?')
        .get('chat-delete', hash) as { count: number };
      expect(row.count).toBe(0);
    }

    const loaded = new ChatStateRepo(db.sqlite).load('chat-delete');
    expect(loaded.store.getNode(nodeId)).toBeNull();
    expect(loaded.store.embeddingCache.has(nodeId)).toBe(false);
    expect(loaded.store.textEmbeddingCache.has(hash)).toBe(false);
    expect(loaded.store.hydeCache.has(hash)).toBe(false);
    expect(loaded.store.getAllNodes().every(candidate =>
      candidate.relationships.every(rel => rel.targetId !== nodeId))).toBe(true);
  });

  it('diff 스냅샷이 영속화되고 복원 후 롤백이 동작한다', async () => {
    const store = makeStore(105);
    const dm = new DiffManager();
    await dm.takeDiff(store); // BASE
    const turnBefore = store.currentTurn;
    const contentBefore = store.getNode('ltm_fix_2')!.content;

    store.currentTurn++;
    store.updateNode('ltm_fix_2', { content: '변경 1' });
    await dm.takeDiff(store);
    store.currentTurn++;
    store.updateNode('ltm_fix_2', { content: '변경 2' });
    await dm.takeDiff(store);

    const stats = repo.flush('chat-e', store, dm);
    expect(stats.diffsRewritten).toBe(true);

    // 변경 없는 재플러시 → diff 재작성 안 함
    const stats2 = repo.flush('chat-e', store, dm);
    expect(stats2.diffsRewritten).toBe(false);

    // 콜드 로드 후 롤백
    const { store: loaded, diffManager: loadedDm } = new ChatStateRepo(db.sqlite).load('chat-e');
    expect(loadedDm.getSnapshotCount()).toBe(dm.getSnapshotCount());
    expect(loadedDm.rollbackTo(turnBefore, loaded)).toBe(true);
    expect(loaded.getNode('ltm_fix_2')!.content).toBe(contentBefore);
    expect(loaded.currentTurn).toBe(turnBefore);
  });

  it('벡터 BLOB 왕복이 손실 없다 (base64 미경유)', () => {
    const store = makeStore(106);
    const rand = mulberry32(1060);
    const vec = randVec(rand, 1536); // 실제 임베딩 차원
    store.embeddingCache.set('ln_fix_0', { hash: 'bighash', embedding: vec });
    repo.flush('chat-f', store);

    const { store: loaded } = new ChatStateRepo(db.sqlite).load('chat-f');
    const restored = loaded.embeddingCache.get('ln_fix_0')!;
    expect(restored.hash).toBe('bighash');
    expect([...restored.embedding!]).toEqual([...vec]);
  });

  it('임베딩 캐시는 증분 저장된다', () => {
    const store = makeStore(107);
    const first = repo.flush('chat-g', store);
    expect(first.nodeEmbUpserted).toBeGreaterThan(0);

    const second = repo.flush('chat-g', store); // 변경 없음
    expect(second.nodeEmbUpserted).toBe(0);
    expect(second.textEmbUpserted).toBe(0);
    expect(second.hydeUpserted).toBe(0);

    const rand = mulberry32(1070);
    store.embeddingCache.set('ln_fix_1', { hash: 'newhash', embedding: randVec(rand, 8) });
    store.embeddingCache.delete('eln_fix_0'); // 픽스처에 있던 키
    const third = repo.flush('chat-g', store);
    expect(third.nodeEmbUpserted).toBe(1);
  });

  it('멀티 채팅이 격리된다', () => {
    const a = makeStore(108);
    const b = makeStore(109);
    repo.flush('chat-h', a);
    repo.flush('chat-i', b);
    const freshRepo = new ChatStateRepo(db.sqlite);
    expect(JSON.stringify(freshRepo.load('chat-h').store.serialize())).toBe(JSON.stringify(a.serialize()));
    expect(JSON.stringify(freshRepo.load('chat-i').store.serialize())).toBe(JSON.stringify(b.serialize()));
    expect(freshRepo.listChats().map(c => c.chatKey).sort()).toEqual(['chat-h', 'chat-i']);

    repo.deleteChat('chat-h');
    expect(new ChatStateRepo(db.sqlite).load('chat-h').exists).toBe(false);
    expect(new ChatStateRepo(db.sqlite).load('chat-i').exists).toBe(true);
  });

  it('존재하지 않는 채팅 로드는 빈 상태를 반환한다', () => {
    const { store, diffManager, exists } = repo.load('no-such-chat');
    expect(exists).toBe(false);
    expect(store.isEmpty()).toBe(true);
    expect(diffManager.getSnapshotCount()).toBe(0);
  });

  it('레거시 conversation 타입 DB 행은 경고 후 무시한다', () => {
    db.sqlite.prepare('INSERT INTO chats (chat_key) VALUES (?)').run('chat-legacy');
    db.sqlite.prepare('INSERT INTO nodes (chat_key, id, type) VALUES (?, ?, ?)')
      .run('chat-legacy', 'conv_legacy', 'conversation');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const loaded = repo.load('chat-legacy');
    expect(loaded.exists).toBe(true);
    expect(loaded.store.isEmpty()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored 1 legacy conversation node rows'));

    repo.flush('chat-legacy', loaded.store);
    expect((db.sqlite.prepare('SELECT COUNT(*) AS count FROM nodes WHERE chat_key = ?')
      .get('chat-legacy') as { count: number }).count).toBe(0);
    warn.mockRestore();
  });

  it('레거시 WRITER/CHAT DB 컬럼 값은 오류 없이 무시하고 ATLAS만 로드한다', () => {
    db.sqlite.prepare(`
      INSERT INTO chats (chat_key, writer_md, chat_md, atlas_md)
      VALUES (?, ?, ?, ?)
    `).run('chat-legacy-md', 'legacy writer', 'legacy chat', '# Legacy Atlas');

    const loaded = repo.load('chat-legacy-md');
    expect(loaded.exists).toBe(true);
    expect(loaded.store.atlasMd).toBe('# Legacy Atlas');
    expect(loaded.store).not.toHaveProperty('writerMd');
    expect(loaded.store).not.toHaveProperty('chatMd');
    expect(loaded.store.serialize()).not.toHaveProperty('writerMd');
    expect(loaded.store.serialize()).not.toHaveProperty('chatMd');

    repo.flush('chat-legacy-md', loaded.store);
    const legacyColumns = db.sqlite.prepare(
      'SELECT writer_md, chat_md FROM chats WHERE chat_key = ?',
    ).get('chat-legacy-md') as { writer_md: string; chat_md: string };
    expect(legacyColumns).toEqual({ writer_md: 'legacy writer', chat_md: 'legacy chat' });
  });

  it('cloneChat: 전 테이블 복제 후 로드 상태가 원본과 일치하고 원본은 무손상이다', async () => {
    const store = makeStore(110);
    const dm = new DiffManager();
    await dm.takeDiff(store); // BASE
    store.currentTurn++;
    store.updateNode('ltm_fix_2', { content: '복제 테스트용 변경' });
    await dm.takeDiff(store);
    repo.flush('chat-src', store, dm);

    const copied = repo.cloneChat('chat-src', 'chat-dst');
    expect(copied.nodes).toBe(store.getNodeCount());
    expect(copied.diffs).toBe(2);

    const freshRepo = new ChatStateRepo(db.sqlite);
    const src = freshRepo.load('chat-src');
    const dst = freshRepo.load('chat-dst');
    expect(dst.exists).toBe(true);
    expect(JSON.stringify(dst.store.serialize())).toBe(JSON.stringify(src.store.serialize()));
    expect(JSON.stringify(dst.store.serializeEmbeddingCaches()))
      .toBe(JSON.stringify(src.store.serializeEmbeddingCaches()));
    expect(dst.diffManager.getSnapshotCount()).toBe(2);

    // 복제 후 원본만 수정해도 복제본은 영향 없다 (격리)
    src.store.removeNode('ln_fix_1');
    freshRepo.flush('chat-src', src.store);
    const again = new ChatStateRepo(db.sqlite);
    expect(again.load('chat-src').store.getNode('ln_fix_1')).toBeFalsy();
    expect(again.load('chat-dst').store.getNode('ln_fix_1')).toBeTruthy();
  });
});
