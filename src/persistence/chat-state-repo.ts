// 채팅별 기억 상태의 행 단위 영속화 (PLAN §5 "행 단위 저장 전략"의 구현).
//
// 저장 전략:
//  - 콜드(구조) 필드: 직렬화 엔트리 fingerprint를 채팅별로 기억 → 달라진 노드만 전체 행 UPSERT
//  - 핫(점수 4필드): 매 턴 EMA로 전 노드가 바뀌므로 추적 없이 전량 UPDATE
//  - 임베딩 캐시: 키(해시) 대조 증분, 벡터는 base64가 아닌 BLOB로 저장
//  - diff 스냅샷: (type,turn,timestamp) fingerprint 변경 시 해당 채팅분 재작성 (≤50행)
//  - flush 전체가 한 트랜잭션 → 크래시 시 이전 상태 보존
//
// 원본 대비 버그 수정: 원본 serialize()는 communitySummary 노드의
// communityId/level/memberNodeIds/parentCommunityId를 내보내지 않아 저장/복원 시
// 커뮤니티 계층이 유실된다(역직렬화 코드는 이 필드들을 읽는데 직렬화가 쓰지 않음).
// 여기서는 라이브 노드에서 보충해 무손실로 저장한다.
import type Database from 'better-sqlite3';
import { OmniNodeStore, NODE_EXTRA_FIELDS } from '../core/node-store.js';
import { DiffManager, type Snapshot } from '../core/diff-manager.js';
import { contentHash } from '../core/util.js';

const NODE_ARRAY_KEYS = ['loreNodes', 'extraLoreNodes', 'communityNodes', 'longTermMemoryNodes'] as const;

// serialize() 엔트리에 없는, 라이브 노드에서 보충해야 하는 선택 필드 (정의는 node-store와 공유)
const EXTRA_FIELDS = NODE_EXTRA_FIELDS;

export interface FlushStats {
  nodesUpserted: number;
  nodesDeleted: number;
  scoresUpdated: number;
  nodeEmbUpserted: number;
  nodeEmbDeleted: number;
  textEmbUpserted: number;
  hydeUpserted: number;
  diffsRewritten: boolean;
}

export interface LoadResult {
  store: OmniNodeStore;
  diffManager: DiffManager;
  exists: boolean;
  simulBot: boolean;
  // undefined means there is no explicit per-chat setting. Callers must derive
  // the effective value from nodeCount without persisting that derivation.
  enabled: boolean | undefined;
}

function f32ToBlob(f32: Float32Array): Buffer {
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToF32(blob: Buffer | null): Float32Array | null {
  if (!blob || blob.byteLength === 0) return null;
  // Buffer 풀 오프셋이 4바이트 정렬이 아닐 수 있으므로 복사해서 정렬 보장
  const ab = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
  return new Float32Array(ab);
}

// 점수(핫) 필드를 제외한 구조 fingerprint
function structFingerprint(entry: Record<string, unknown>): string {
  const { activationScore, utilityScore, zeroScoreTurns, highScoreTurns, ...rest } = entry;
  return contentHash(JSON.stringify(rest));
}

function diffFingerprint(snapshots: Snapshot[]): string {
  return contentHash(JSON.stringify(snapshots.map(s => [s.type, s.turn, s.timestamp])));
}

interface SessionShadow {
  nodeFps: Map<string, string>; // nodeId → 구조 fingerprint
  diffFp: string;
}

export class ChatStateRepo {
  private db: Database.Database;
  private shadows = new Map<string, SessionShadow>();

  private selChat; private upsertChat;
  private selNodes; private upsertNode; private updScores; private delNode;
  private selNodeEmbKeys; private upsertNodeEmb; private delNodeEmb;
  private selTextEmbKeys; private upsertTextEmb; private delTextEmb;
  private selHydeKeys; private upsertHyde; private delHyde;
  private selMemrl; private delMemrlAll; private insMemrl;
  private selDiffs; private delDiffsAll; private insDiff;

  constructor(db: Database.Database) {
    this.db = db;
    this.selChat = db.prepare('SELECT * FROM chats WHERE chat_key = ?');
    this.upsertChat = db.prepare(`
      INSERT INTO chats (chat_key, current_turn, atlas_md, meta_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_key) DO UPDATE SET current_turn=excluded.current_turn,
        atlas_md=excluded.atlas_md, meta_json=excluded.meta_json, updated_at=excluded.updated_at`);
    // ord: Map 삽입 순서 보존 — PK 인덱스 스캔이 id 사전순으로 반환하므로 명시적 정렬 필요
    this.selNodes = db.prepare('SELECT * FROM nodes WHERE chat_key = ? ORDER BY ord');
    this.upsertNode = db.prepare(`
      INSERT OR REPLACE INTO nodes (chat_key, id, type, name, content, keywords_json, global_keywords_json,
        importance, activation_score, utility_score, creation_turn, relationships_json,
        zero_score_turns, high_score_turns, always_active, archived, excluded, ts, extras_json, ord)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.updScores = db.prepare(`
      UPDATE nodes SET activation_score = ?, utility_score = ?, zero_score_turns = ?, high_score_turns = ?, ord = ?
      WHERE chat_key = ? AND id = ?`);
    this.delNode = db.prepare('DELETE FROM nodes WHERE chat_key = ? AND id = ?');
    this.selNodeEmbKeys = db.prepare('SELECT node_id, hash FROM node_embeddings WHERE chat_key = ?');
    this.upsertNodeEmb = db.prepare('INSERT OR REPLACE INTO node_embeddings (chat_key, node_id, hash, vector) VALUES (?, ?, ?, ?)');
    this.delNodeEmb = db.prepare('DELETE FROM node_embeddings WHERE chat_key = ? AND node_id = ?');
    this.selTextEmbKeys = db.prepare('SELECT hash FROM text_embeddings WHERE chat_key = ?');
    this.upsertTextEmb = db.prepare('INSERT OR REPLACE INTO text_embeddings (chat_key, hash, vector) VALUES (?, ?, ?)');
    this.delTextEmb = db.prepare('DELETE FROM text_embeddings WHERE chat_key = ? AND hash = ?');
    this.selHydeKeys = db.prepare('SELECT hash FROM hyde_cache WHERE chat_key = ?');
    this.upsertHyde = db.prepare('INSERT OR REPLACE INTO hyde_cache (chat_key, hash, text, vector) VALUES (?, ?, ?, ?)');
    this.delHyde = db.prepare('DELETE FROM hyde_cache WHERE chat_key = ? AND hash = ?');
    // ORDER BY rowid = 삽입 순서 (PK 인덱스 스캔은 키 사전순이라 Map 순서가 깨짐)
    this.selMemrl = db.prepare('SELECT key, useful, confidence, turn FROM memrl_cache WHERE chat_key = ? ORDER BY rowid');
    this.delMemrlAll = db.prepare('DELETE FROM memrl_cache WHERE chat_key = ?');
    this.insMemrl = db.prepare('INSERT INTO memrl_cache (chat_key, key, useful, confidence, turn) VALUES (?, ?, ?, ?, ?)');
    this.selDiffs = db.prepare('SELECT seq, snapshot_json FROM diffs WHERE chat_key = ? ORDER BY seq');
    this.delDiffsAll = db.prepare('DELETE FROM diffs WHERE chat_key = ?');
    this.insDiff = db.prepare('INSERT INTO diffs (chat_key, seq, snapshot_json) VALUES (?, ?, ?)');
  }

  // 직렬화 엔트리 + 라이브 노드의 보충 필드 → 저장용 완전 엔트리
  private buildFullEntry(store: OmniNodeStore, entry: Record<string, any>): Record<string, any> {
    const live = store.getNode(entry.id) as Record<string, any> | null;
    const full = { ...entry };
    if (live) {
      for (const k of EXTRA_FIELDS) {
        if (live[k] !== undefined) full[k] = live[k];
      }
    }
    return full;
  }

  private nodeRowParams(chatKey: string, full: Record<string, any>, ord: number): unknown[] {
    const extras: Record<string, unknown> = {};
    for (const k of EXTRA_FIELDS) {
      if (full[k] !== undefined) extras[k] = full[k];
    }
    return [
      chatKey, full.id, full.type, full.name || '', full.content || '',
      JSON.stringify(full.keywords || []), JSON.stringify(full.globalKeywords || []),
      full.importance, full.activationScore, full.utilityScore ?? 50.0, full.creationTurn || 0,
      JSON.stringify(full.relationships || []),
      full.zeroScoreTurns || 0, full.highScoreTurns || 0,
      full.alwaysActive ? 1 : 0, full.archived ? 1 : 0, full.excluded ? 1 : 0,
      full.timestamp ?? null,
      Object.keys(extras).length > 0 ? JSON.stringify(extras) : null,
      ord,
    ];
  }

  load(chatKey: string): LoadResult {
    const chatRow = this.selChat.get(chatKey) as Record<string, any> | undefined;
    const nodeRows = this.selNodes.all(chatKey) as Array<Record<string, any>>;

    const arrays: Record<string, Array<Record<string, unknown>>> = {
      loreNodes: [], extraLoreNodes: [], communityNodes: [], longTermMemoryNodes: [],
    };
    const typeToKey: Record<string, string> = {
      lore: 'loreNodes', extraLore: 'extraLoreNodes', communitySummary: 'communityNodes',
      longTermMemory: 'longTermMemoryNodes',
    };
    const nodeFps = new Map<string, string>();
    let ignoredLegacyConversationNodes = 0;
    for (const row of nodeRows) {
      const entry: Record<string, unknown> = {
        id: row.id,
        type: row.type,
        name: row.name || '',
        content: row.content || '',
        keywords: JSON.parse(row.keywords_json),
        globalKeywords: JSON.parse(row.global_keywords_json),
        importance: row.importance,
        activationScore: row.activation_score,
        utilityScore: row.utility_score,
        creationTurn: row.creation_turn,
        relationships: JSON.parse(row.relationships_json),
        zeroScoreTurns: row.zero_score_turns,
        highScoreTurns: row.high_score_turns,
        alwaysActive: !!row.always_active,
        archived: !!row.archived,
        excluded: !!row.excluded,
        timestamp: row.ts ?? null,
        ...(row.extras_json ? JSON.parse(row.extras_json) : {}),
      };
      nodeFps.set(row.id as string, structFingerprint(entry));
      if (row.type === 'conversation') {
        ignoredLegacyConversationNodes++;
        continue;
      }
      (arrays[typeToKey[row.type as string]] ?? arrays.longTermMemoryNodes).push(entry);
    }
    if (ignoredLegacyConversationNodes > 0) {
      console.warn(`[OMNINODE] ChatStateRepo: ignored ${ignoredLegacyConversationNodes} legacy conversation node rows for ${chatKey}`);
    }

    const meta = chatRow?.meta_json ? JSON.parse(chatRow.meta_json) : {};
    const memrlRows = this.selMemrl.all(chatKey) as Array<Record<string, any>>;
    const data = {
      version: 1,
      currentTurn: chatRow?.current_turn || 0,
      atlasMd: chatRow?.atlas_md || '',
      ...arrays,
      memrlCache: memrlRows.map(r => ({ key: r.key, useful: !!r.useful, confidence: r.confidence, turn: r.turn })),
      lastCommunityTurn: meta.lastCommunityTurn || 0,
      nodesSinceLastCommunity: meta.nodesSinceLastCommunity || 0,
      lastConvertedMsgCount: meta.lastConvertedMsgCount || 0,
      ltmConvertedUpTo: meta.ltmConvertedUpTo || 0,
      ltmWatermarkHash: meta.ltmWatermarkHash || '',
      lastChapterTurn: meta.lastChapterTurn || 0,
    };
    const store = OmniNodeStore.deserialize(data);

    // 임베딩 캐시: BLOB → Float32Array 직접 복원 (base64 경유 없음).
    // ORDER BY rowid로 삽입 순서 보존 — 캐시 eviction이 Map 순서 기반이므로.
    // (같은 키 재삽입 시 rowid가 갱신되어 순서가 뒤로 밀릴 수 있으나 eviction에 무해)
    for (const row of this.db.prepare('SELECT node_id, hash, vector FROM node_embeddings WHERE chat_key = ? ORDER BY rowid').all(chatKey) as Array<Record<string, any>>) {
      const emb = blobToF32(row.vector);
      if (emb) store.embeddingCache.set(row.node_id, { hash: row.hash, embedding: emb });
    }
    for (const row of this.db.prepare('SELECT hash, vector FROM text_embeddings WHERE chat_key = ? ORDER BY rowid').all(chatKey) as Array<Record<string, any>>) {
      const emb = blobToF32(row.vector);
      if (emb) store.textEmbeddingCache.set(row.hash, emb);
    }
    for (const row of this.db.prepare('SELECT hash, text, vector FROM hyde_cache WHERE chat_key = ? ORDER BY rowid').all(chatKey) as Array<Record<string, any>>) {
      store.hydeCache.set(row.hash, { text: row.text, embedding: blobToF32(row.vector) });
    }

    const diffManager = new DiffManager();
    const diffRows = this.selDiffs.all(chatKey) as Array<Record<string, any>>;
    diffManager.deserialize(diffRows.map(r => JSON.parse(r.snapshot_json)));

    this.shadows.set(chatKey, { nodeFps, diffFp: diffFingerprint(diffManager.snapshots) });
    return {
      store,
      diffManager,
      exists: !!chatRow,
      simulBot: typeof meta.simulBot === 'boolean' ? meta.simulBot : true,
      enabled: typeof meta.enabled === 'boolean' ? meta.enabled : undefined,
    };
  }

  flush(
    chatKey: string,
    store: OmniNodeStore,
    diffManager?: DiffManager,
    simulBot = true,
    enabled?: boolean,
  ): FlushStats {
    const stats: FlushStats = {
      nodesUpserted: 0, nodesDeleted: 0, scoresUpdated: 0,
      nodeEmbUpserted: 0, nodeEmbDeleted: 0, textEmbUpserted: 0, hydeUpserted: 0,
      diffsRewritten: false,
    };
    const shadow = this.shadows.get(chatKey) ?? { nodeFps: new Map<string, string>(), diffFp: diffFingerprint([]) };
    const data = store.serialize() as Record<string, any>;

    this.db.transaction(() => {
      // 채팅 메타
      this.upsertChat.run(
        chatKey, data.currentTurn, data.atlasMd,
        JSON.stringify({
          lastCommunityTurn: data.lastCommunityTurn,
          nodesSinceLastCommunity: data.nodesSinceLastCommunity,
          lastConvertedMsgCount: data.lastConvertedMsgCount,
          ltmConvertedUpTo: data.ltmConvertedUpTo,
          ltmWatermarkHash: data.ltmWatermarkHash,
          lastChapterTurn: data.lastChapterTurn,
          simulBot,
          ...(typeof enabled === 'boolean' ? { enabled } : {}),
        }),
        Date.now(),
      );

      // 노드: 콜드=fingerprint 대조 UPSERT / 핫=점수(+ord) 전량 UPDATE
      const seen = new Set<string>();
      let ord = 0;
      for (const key of NODE_ARRAY_KEYS) {
        for (const entry of data[key] as Array<Record<string, any>>) {
          seen.add(entry.id);
          const full = this.buildFullEntry(store, entry);
          const fp = structFingerprint(full);
          if (shadow.nodeFps.get(entry.id) !== fp) {
            this.upsertNode.run(...this.nodeRowParams(chatKey, full, ord));
            shadow.nodeFps.set(entry.id, fp);
            stats.nodesUpserted++;
          } else {
            this.updScores.run(entry.activationScore, entry.utilityScore ?? 50.0,
              entry.zeroScoreTurns || 0, entry.highScoreTurns || 0, ord, chatKey, entry.id);
            stats.scoresUpdated++;
          }
          ord++;
        }
      }
      for (const id of [...shadow.nodeFps.keys()]) {
        if (!seen.has(id)) {
          this.delNode.run(chatKey, id);
          shadow.nodeFps.delete(id);
          stats.nodesDeleted++;
        }
      }

      // 노드 임베딩: (node_id, hash) 대조 증분
      const dbNodeEmb = new Map<string, string>();
      for (const row of this.selNodeEmbKeys.all(chatKey) as Array<Record<string, any>>) dbNodeEmb.set(row.node_id, row.hash);
      for (const [nodeId, entry] of store.embeddingCache) {
        if (!entry.embedding) continue;
        if (dbNodeEmb.get(nodeId) !== entry.hash) {
          this.upsertNodeEmb.run(chatKey, nodeId, entry.hash, f32ToBlob(entry.embedding));
          stats.nodeEmbUpserted++;
        }
      }
      for (const nodeId of dbNodeEmb.keys()) {
        if (!store.embeddingCache.has(nodeId)) {
          this.delNodeEmb.run(chatKey, nodeId);
          stats.nodeEmbDeleted++;
        }
      }

      // 텍스트 임베딩 / HyDE: 해시 키 대조 증분
      const dbTextEmb = new Set((this.selTextEmbKeys.all(chatKey) as Array<Record<string, any>>).map(r => r.hash));
      for (const [hash, emb] of store.textEmbeddingCache) {
        if (!dbTextEmb.has(hash)) { this.upsertTextEmb.run(chatKey, hash, f32ToBlob(emb)); stats.textEmbUpserted++; }
      }
      for (const hash of dbTextEmb) {
        if (!store.textEmbeddingCache.has(hash)) this.delTextEmb.run(chatKey, hash);
      }
      const dbHyde = new Set((this.selHydeKeys.all(chatKey) as Array<Record<string, any>>).map(r => r.hash));
      for (const [hash, entry] of store.hydeCache) {
        if (!dbHyde.has(hash)) {
          this.upsertHyde.run(chatKey, hash, entry.text || '', entry.embedding ? f32ToBlob(entry.embedding) : null);
          stats.hydeUpserted++;
        }
      }
      for (const hash of dbHyde) {
        if (!store.hydeCache.has(hash)) this.delHyde.run(chatKey, hash);
      }

      // MemRL 캐시: 소규모(≤500) — 전량 재작성
      this.delMemrlAll.run(chatKey);
      for (const entry of data.memrlCache as Array<Record<string, any>>) {
        this.insMemrl.run(chatKey, entry.key, entry.useful ? 1 : 0, entry.confidence, entry.turn);
      }

      // Diff 스냅샷: fingerprint 변경 시에만 재작성 (≤50행)
      if (diffManager) {
        const fp = diffFingerprint(diffManager.snapshots);
        if (fp !== shadow.diffFp) {
          this.delDiffsAll.run(chatKey);
          diffManager.snapshots.forEach((snap, seq) => {
            this.insDiff.run(chatKey, seq, JSON.stringify(snap));
          });
          shadow.diffFp = fp;
          stats.diffsRewritten = true;
        }
      }
    })();

    this.shadows.set(chatKey, shadow);
    return stats;
  }

  chatExists(chatKey: string): boolean {
    return !!this.selChat.get(chatKey);
  }

  // ── 원문 대화 로그 (진화 트랙 D2) ──
  // 해시 대조 증분 동기화: 바뀐/새 행만 upsert, 들어온 길이 초과분은 삭제(롤백 반영).
  // 리롤은 꼬리 몇 행만 재작성되므로 턴당 쓰기가 수 행에 그친다.
  syncMessages(chatKey: string, msgs: Array<{ role: string; content: string }>): { upserted: number; deleted: number } {
    const stored = this.db.prepare('SELECT idx, hash FROM messages WHERE chat_key = ? ORDER BY idx')
      .all(chatKey) as Array<{ idx: number; hash: string }>;
    const storedHash = new Map(stored.map(r => [r.idx, r.hash]));
    const upsert = this.db.prepare(
      'INSERT OR REPLACE INTO messages (chat_key, idx, role, content, hash) VALUES (?, ?, ?, ?, ?)');
    const del = this.db.prepare('DELETE FROM messages WHERE chat_key = ? AND idx >= ?');
    let upserted = 0, deleted = 0;
    this.db.transaction(() => {
      for (let i = 0; i < msgs.length; i++) {
        const h = contentHash(`${msgs[i].role}\x00${msgs[i].content}`);
        if (storedHash.get(i) !== h) {
          upsert.run(chatKey, i, msgs[i].role, msgs[i].content, h);
          upserted++;
        }
      }
      if (stored.length > msgs.length) {
        del.run(chatKey, msgs.length);
        deleted = stored.length - msgs.length;
      }
    })();
    return { upserted, deleted };
  }

  // 챗 복사 자동 감지 (HANDOFF §G [필수]): incoming 히스토리와 가장 긴 공통 프리픽스를
  // 가진 "그래프 보유" 채팅 탐색. 첫 메시지는 캐릭터 인사말이라 모든 채팅이 동일 —
  // 짧은 일치는 증거가 못 되므로 minPrefix 미달은 무시. 동률이면 최근 갱신 채팅 우선.
  findCopySource(
    dstKey: string,
    msgs: Array<{ role: string; content: string }>,
    minPrefix: number,
  ): { chatKey: string; lcp: number } | null {
    const hashes = msgs.map(m => contentHash(`${m.role}\x00${m.content}`));
    const chats = this.db.prepare(`
      SELECT c.chat_key AS chatKey, c.updated_at AS updatedAt,
        c.meta_json AS metaJson,
        (SELECT COUNT(*) FROM nodes n WHERE n.chat_key = c.chat_key) AS nodeCount
      FROM chats c WHERE c.chat_key != ?`).all(dstKey) as
      Array<{ chatKey: string; updatedAt: number; metaJson: string; nodeCount: number }>;
    let best: { chatKey: string; lcp: number; updatedAt: number } | null = null;
    for (const c of chats) {
      if (!c.nodeCount) continue;
      const meta = c.metaJson ? JSON.parse(c.metaJson) as Record<string, unknown> : {};
      if (meta.enabled === false) continue;
      const rows = this.db.prepare(
        'SELECT hash FROM messages WHERE chat_key = ? AND idx < ? ORDER BY idx',
      ).all(c.chatKey, hashes.length) as Array<{ hash: string }>;
      let lcp = 0;
      while (lcp < rows.length && lcp < hashes.length && rows[lcp].hash === hashes[lcp]) lcp++;
      if (lcp < minPrefix) continue;
      if (!best || lcp > best.lcp || (lcp === best.lcp && c.updatedAt > best.updatedAt)) {
        best = { chatKey: c.chatKey, lcp, updatedAt: c.updatedAt };
      }
    }
    return best ? { chatKey: best.chatKey, lcp: best.lcp } : null;
  }

  // 발췌 조립용 원문 슬라이스 [startIdx, endIdx)
  getMessageRange(chatKey: string, startIdx: number, endIdx: number): Array<{ idx: number; role: string; content: string }> {
    return this.db.prepare(
      'SELECT idx, role, content FROM messages WHERE chat_key = ? AND idx >= ? AND idx < ? ORDER BY idx')
      .all(chatKey, startIdx, endIdx) as Array<{ idx: number; role: string; content: string }>;
  }

  // 그래프 분기(clone) — 챗 복사 시 기억 복제용 (HANDOFF §1.5).
  // 전 테이블의 src 행을 dst 키로 복사. ORDER BY rowid로 삽입 순서 보존
  // (memrl/임베딩 캐시 로드가 rowid 순서에 의존 — 상단 관례 주석 참조).
  cloneChat(srcKey: string, dstKey: string): Record<string, number> {
    const copied: Record<string, number> = {};
    this.db.transaction(() => {
      for (const table of ['chats', 'nodes', 'node_embeddings', 'text_embeddings', 'hyde_cache', 'memrl_cache', 'diffs', 'messages']) {
        const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(r => r.name);
        const selectCols = cols.map(c => (c === 'chat_key' ? '?' : c)).join(', ');
        const info = this.db.prepare(
          `INSERT INTO ${table} (${cols.join(', ')}) SELECT ${selectCols} FROM ${table} WHERE chat_key = ? ORDER BY rowid`,
        ).run(dstKey, srcKey);
        copied[table] = info.changes;
      }
    })();
    // dst의 낡은 fingerprint shadow 제거 — 다음 load가 재구축
    this.shadows.delete(dstKey);
    return copied;
  }

  // 채팅 상태 전체 삭제 (임포트 재시도·정리용)
  deleteChat(chatKey: string) {
    this.db.transaction(() => {
      for (const table of ['chats', 'nodes', 'node_embeddings', 'text_embeddings', 'hyde_cache', 'memrl_cache', 'diffs', 'messages']) {
        this.db.prepare(`DELETE FROM ${table} WHERE chat_key = ?`).run(chatKey);
      }
    })();
    this.shadows.delete(chatKey);
  }

  listChats(): Array<{ chatKey: string; currentTurn: number; updatedAt: number; nodeCount: number; msgCount: number }> {
    const rows = this.db.prepare(`
      SELECT c.chat_key, c.current_turn, c.updated_at,
        (SELECT COUNT(*) FROM nodes n WHERE n.chat_key = c.chat_key) AS node_count,
        (SELECT COUNT(*) FROM messages m WHERE m.chat_key = c.chat_key) AS msg_count
      FROM chats c ORDER BY c.updated_at DESC`).all() as Array<Record<string, any>>;
    return rows.map(r => ({ chatKey: r.chat_key, currentTurn: r.current_turn, updatedAt: r.updated_at, nodeCount: r.node_count, msgCount: r.msg_count }));
  }
}
