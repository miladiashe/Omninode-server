import Database from 'better-sqlite3';
import { join } from 'node:path';

// sqlite-vec 제거(2026-08-29 배포 준비): 로드 후 버전만 찍고 실사용처 0곳이었음 —
// 벡터 유사도는 JS cosineSimilarity, 임베딩은 일반 테이블 BLOB. 네이티브 의존성을
// better-sqlite3 하나로 줄여 Termux 등 도커 없는 호스트의 설치 실패 요인을 없앤다.
export interface Db {
  sqlite: Database.Database;
}

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chats (
    chat_key     TEXT PRIMARY KEY,
    current_turn INTEGER NOT NULL DEFAULT 0,
    writer_md    TEXT NOT NULL DEFAULT '',
    chat_md      TEXT NOT NULL DEFAULT '',
    atlas_md     TEXT NOT NULL DEFAULT '',
    meta_json    TEXT NOT NULL DEFAULT '{}',
    updated_at   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS nodes (
    chat_key             TEXT NOT NULL,
    id                   TEXT NOT NULL,
    type                 TEXT NOT NULL,
    name                 TEXT NOT NULL DEFAULT '',
    content              TEXT NOT NULL DEFAULT '',
    keywords_json        TEXT NOT NULL DEFAULT '[]',
    global_keywords_json TEXT NOT NULL DEFAULT '[]',
    importance           REAL NOT NULL DEFAULT 3,
    activation_score     REAL NOT NULL DEFAULT 50,
    utility_score        REAL NOT NULL DEFAULT 50,
    creation_turn        INTEGER NOT NULL DEFAULT 0,
    relationships_json   TEXT NOT NULL DEFAULT '[]',
    zero_score_turns     INTEGER NOT NULL DEFAULT 0,
    high_score_turns     INTEGER NOT NULL DEFAULT 0,
    always_active        INTEGER NOT NULL DEFAULT 0,
    archived             INTEGER NOT NULL DEFAULT 0,
    excluded             INTEGER NOT NULL DEFAULT 0,
    ts                   TEXT,
    extras_json          TEXT,
    ord                  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_key, id)
  );

  CREATE TABLE IF NOT EXISTS node_embeddings (
    chat_key TEXT NOT NULL,
    node_id  TEXT NOT NULL,
    hash     TEXT NOT NULL,
    vector   BLOB,
    PRIMARY KEY (chat_key, node_id)
  );

  CREATE TABLE IF NOT EXISTS text_embeddings (
    chat_key TEXT NOT NULL,
    hash     TEXT NOT NULL,
    vector   BLOB,
    PRIMARY KEY (chat_key, hash)
  );

  CREATE TABLE IF NOT EXISTS hyde_cache (
    chat_key TEXT NOT NULL,
    hash     TEXT NOT NULL,
    text     TEXT NOT NULL DEFAULT '',
    vector   BLOB,
    PRIMARY KEY (chat_key, hash)
  );

  CREATE TABLE IF NOT EXISTS memrl_cache (
    chat_key   TEXT NOT NULL,
    key        TEXT NOT NULL,
    useful     INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    turn       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_key, key)
  );

  CREATE TABLE IF NOT EXISTS diffs (
    chat_key      TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    PRIMARY KEY (chat_key, seq)
  );

  CREATE TABLE IF NOT EXISTS config (
    scope TEXT PRIMARY KEY,
    json  TEXT NOT NULL DEFAULT '{}'
  );

  -- 원문 대화 로그 (진화 트랙 D2 — canonical source). 그래프는 이로부터 재생성 가능한
  -- 파생물이 된다. idx = 채팅 내 메시지 순번(0-base), hash = 내용 해시(증분 동기화용)
  CREATE TABLE IF NOT EXISTS messages (
    chat_key TEXT NOT NULL,
    idx      INTEGER NOT NULL,
    role     TEXT NOT NULL,
    content  TEXT NOT NULL DEFAULT '',
    hash     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (chat_key, idx)
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_key     TEXT NOT NULL,
    kind         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    payload_json TEXT NOT NULL DEFAULT '{}',
    run_after    INTEGER NOT NULL DEFAULT 0,
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, run_after);
  CREATE INDEX IF NOT EXISTS idx_jobs_chat ON jobs(chat_key, kind, status);
`;

export function openDbFile(file: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  sqlite.exec(SCHEMA_SQL);
  sqlite
    .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
    .run(String(SCHEMA_VERSION));

  return { sqlite };
}

export function openDb(dataDir: string): Db {
  return openDbFile(join(dataDir, 'omninode.db'));
}
