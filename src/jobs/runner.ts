// 오토드림 백그라운드 잡 러너 (Phase 6) — 원본 AutodreamAutonomousLoop/_buildTasks
// (L4879–5354)의 서버판. Web Worker 타이머·탭 가시성·stuck 감지 기계장치는 전부 폐기
// (PLAN §5), 단순 인터벌 루프 + jobs 테이블로 붕괴.
//
// 활동 기반 트리거 (PLAN §5 확정 설계):
//  - 잡 등록은 파이프라인/after-request 호출(=실제 채팅 발생) 시에만 → 유휴 서버는 LLM 호출 0회
//  - dream 잡은 마지막 실행 이후 새 메시지 autodreamAutoMinMessages개 이상일 때만 실행 (원본 L169 계승)
//  - 채팅별 시간당 실행 상한(DREAM_MAX_RUNS_PER_HOUR)으로 폭주 방어
//
// 의도적 차이 (원본 대비):
//  - 잡 실행은 session.runExclusive 안에서 — 파이프라인과 store 변조가 경합하지 않음
//    (원본은 _pipelineLock 검사로 협조적 중단 — 서버판은 태스크 사이에 pipelineWaiting
//    검사로 대체: 파이프라인이 대기 중이면 남은 태스크를 다음 dream으로 미룸)
//  - LTM 변환 잡은 워터마크가 payload의 batchStart와 일치할 때만 적용 (잡 지연 중
//    롤백/리롤로 워터마크가 움직였으면 스킵 — 원본엔 없는 가드, 비동기화로 생긴 창)
//  - worldSim 실행 주기: 원본의 _runsTriggered 카운터 대신 완료된 dream 잡 수 % interval (단순화)
import type Database from 'better-sqlite3';
import type { ChatStateRepo } from '../persistence/chat-state-repo.js';
import type { SessionManager, ChatSession } from '../pipeline/session.js';
import type { ConfigStore, OmniConfig } from '../config-store.js';
import type { NodeEditAgentDeps } from '../pipeline/helpers.js';
import { convertToLTMNodes } from '../pipeline/helpers.js';
import { LOG_PREFIX, contentHash } from '../core/util.js';
import {
  runCommunityDetectionAgent, runOrphanLinkingAgent, runWorldSimAgent, runCompactionAgent,
  generateAtlasMdUpdate, shouldRunCommunityDetection,
} from './agents.js';
import { importLorebookToNodes, coldStartFromHistory, splitForColdStart } from './lore-import.js';
import { _findOrphanNodes } from '../pipeline/node-edit-agent.js';

const DREAM_MAX_RUNS_PER_HOUR = 12; // 채팅별 레이트 캡 (배포판 "띄워두고 잊어도 비용 안 나가는" 기본 동작)
const MAX_ATTEMPTS = 3;
const CLEANUP_KEEP = 500; // done/error 잡 보존 행 수

export type JobKind = 'dream' | 'ltm' | 'import-lorebook' | 'cold-start';

export interface JobRow {
  id: number;
  chat_key: string;
  kind: JobKind;
  status: string;
  payload_json: string;
  run_after: number;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface JobEnqueuer {
  enqueue(chatKey: string, kind: JobKind, payload?: Record<string, unknown>, opts?: { delayMs?: number }): void;
}

export class JobRunner implements JobEnqueuer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private ticks = 0;
  // 원본 _lastAutonomousMdTurn의 서버판 (비영속 — 재시작 시 같은 턴에 한 번 더 돌 수 있으나 무해)
  private lastMdTurn = new Map<string, number>();

  constructor(
    private db: Database.Database,
    private repo: ChatStateRepo,
    private sessions: SessionManager,
    private configStore: ConfigStore,
    private agentDeps: NodeEditAgentDeps,
  ) {}

  start(pollMs = 15000) {
    if (this.timer) return;
    // 크래시/재시작 복구: 이전 프로세스가 남긴 'running' 잔류 잡을 pending으로 되돌린다
    // (LLM fetch 행 등으로 완주 못 한 잡 — 잡 함수는 멱등하거나 flush 전이므로 재실행 안전)
    const orphaned = this.db.prepare(
      `UPDATE jobs SET status = 'pending', updated_at = ? WHERE status = 'running'`,
    ).run(Date.now());
    if (orphaned.changes > 0) {
      console.log(`${LOG_PREFIX} Job runner: recovered ${orphaned.changes} orphaned running job(s) → pending`);
    }
    this.timer = setInterval(() => { void this.tick(); }, pollMs);
    this.timer.unref?.();
    console.log(`${LOG_PREFIX} Job runner started (poll ${pollMs}ms)`);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // 잡 등록. 같은 (chatKey, kind)의 pending 잡이 있으면 run_after만 뒤로 민다
  // (디바운스 — 채팅이 활발한 동안엔 실행을 미루고, 잠잠해진 뒤 한 번 돈다).
  enqueue(chatKey: string, kind: JobKind, payload: Record<string, unknown> = {}, opts: { delayMs?: number } = {}) {
    const now = Date.now();
    const runAfter = now + (opts.delayMs ?? 0);
    const existing = this.db.prepare(
      `SELECT id FROM jobs WHERE chat_key = ? AND kind = ? AND status = 'pending' LIMIT 1`,
    ).get(chatKey, kind) as { id: number } | undefined;
    if (existing) {
      this.db.prepare(`UPDATE jobs SET run_after = ?, payload_json = ?, updated_at = ? WHERE id = ?`)
        .run(runAfter, JSON.stringify(payload), now, existing.id);
      return;
    }
    this.db.prepare(
      `INSERT INTO jobs (chat_key, kind, status, payload_json, run_after, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
    ).run(chatKey, kind, JSON.stringify(payload), runAfter, now, now);
  }

  listJobs(chatKey?: string, limit = 50): JobRow[] {
    if (chatKey) {
      return this.db.prepare(`SELECT * FROM jobs WHERE chat_key = ? ORDER BY id DESC LIMIT ?`)
        .all(chatKey, limit) as JobRow[];
    }
    return this.db.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit) as JobRow[];
  }

  // 인터벌 틱 — 기한이 된 잡을 오래된 순으로 하나 실행 (전역 직렬 — LLM 부하 억제)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.ticks++;
      if (this.ticks % 40 === 1) this.cleanup();
      const job = this.db.prepare(
        `SELECT * FROM jobs WHERE status = 'pending' AND run_after <= ? ORDER BY id LIMIT 1`,
      ).get(Date.now()) as JobRow | undefined;
      if (!job) return;
      await this.runJob(job);
    } catch (e) {
      console.error(`${LOG_PREFIX} Job runner tick error:`, e);
    } finally {
      this.running = false;
    }
  }

  private setStatus(id: number, status: string, patch: { error?: string; payload?: Record<string, unknown> } = {}) {
    if (patch.payload !== undefined) {
      this.db.prepare(`UPDATE jobs SET status = ?, last_error = ?, payload_json = ?, updated_at = ? WHERE id = ?`)
        .run(status, patch.error ?? null, JSON.stringify(patch.payload), Date.now(), id);
    } else {
      this.db.prepare(`UPDATE jobs SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(status, patch.error ?? null, Date.now(), id);
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    const config = this.configStore.load();
    if (!config.customLlm?.apiUrl || !config.customLlm?.model) {
      // LLM 미설정 — 잡을 소비하지 않고 미룬다 (설정되면 자연 재개)
      this.db.prepare(`UPDATE jobs SET run_after = ?, updated_at = ? WHERE id = ?`)
        .run(Date.now() + 300_000, Date.now(), job.id);
      return;
    }

    this.db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?`)
      .run(Date.now(), job.id);

    const session = this.sessions.get(job.chat_key);
    try {
      const payload = JSON.parse(job.payload_json || '{}') as Record<string, any>;
      let dreamRan = true; // dream 외 잡 종류는 실행 자체가 곧 수행
      await session.runExclusive(async () => {
        if (job.kind === 'import-lorebook' || job.kind === 'cold-start') {
          session.enabled = true;
          // 실행 시작 자체가 명시적 옵트인이다. 작업 실패 전에도 설정이 남아야 한다.
          this.repo.flush(job.chat_key, session.store, session.diffManager, session.simulBot, session.enabled);
        }
        if (job.kind === 'ltm') {
          await this.runLtmJob(session, config, payload);
        } else if (job.kind === 'import-lorebook') {
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          const r = await importLorebookToNodes(session.store, config, entries);
          payload.result = r as unknown as Record<string, unknown>;
        } else if (job.kind === 'cold-start') {
          const messages = Array.isArray(payload.messages) ? payload.messages : [];
          this.repo.syncMessages(job.chat_key, messages); // 원문 로그도 함께 확보 (D2)
          const { cut } = splitForColdStart(messages, config);
          const r = await coldStartFromHistory(
            cut, session.store, config,
            String(payload.personaName || session.lastPersonaName || ''),
            String(payload.charName || session.lastCharName || ''),
            typeof payload.simulBot === 'boolean' ? payload.simulBot : session.simulBot,
            this.agentDeps, session.diffManager,
          );
          payload.result = r as unknown as Record<string, unknown>;
          // 페이로드의 채팅 전문은 완료 후 버린다 (jobs 테이블 비대 방지)
          delete payload.messages;
          // 과반 청크 실패 = 사실상 실패 (2026-08-31 GLM 제보: 전 청크 실패인데 "완료 ✅"로 보임).
          // throw로 재시도 경로에 태운다 — 성공 청크는 node-edit 결과 캐시가 있어 재시도가 싸다.
          if (r.failedChunks > 0 && r.failedChunks >= Math.ceil(r.chunks / 2)) {
            throw new Error(`콜드 스타트 청크 ${r.failedChunks}/${r.chunks}개 실패 — 메인 LLM 응답/파싱 문제. 서버 로그와 data/debug/를 확인하세요`);
          }
        } else {
          dreamRan = await this.runDreamJob(job, session, config, payload);
        }
        this.repo.flush(job.chat_key, session.store, session.diffManager, session.simulBot, session.enabled);
      });
      // ⚠️ ranTurn은 "실제로 태스크를 수행한" 잡에만 기록 — 게이트 스킵도 기록하면
      // 다음 잡이 스킵 기준으로 새 메시지를 세어 영원히 게이트에 막힌다
      // (E2E 실측 2026-08-01: dream 7연속 헛스킵, 커뮤니티 탐지 0회)
      const donePayload = dreamRan
        ? { ...payload, ranTurn: session.store.currentTurn }
        : { ...payload, gated: true };
      this.setStatus(job.id, 'done', { payload: donePayload });
    } catch (e) {
      if ((e as { _defer?: boolean })._defer) {
        // 레이트 캡 등 정상적 연기 — 시도 횟수 소모 없이 뒤로 민다
        this.db.prepare(`UPDATE jobs SET status = 'pending', attempts = attempts - 1, run_after = ?, updated_at = ? WHERE id = ?`)
          .run(Date.now() + 600_000, Date.now(), job.id);
        return;
      }
      const msg = (e as Error).message;
      console.error(`${LOG_PREFIX} Job ${job.id} (${job.kind}) failed: ${msg}`);
      if (job.attempts + 1 >= MAX_ATTEMPTS) {
        this.setStatus(job.id, 'error', { error: msg });
      } else {
        this.db.prepare(`UPDATE jobs SET status = 'pending', run_after = ?, last_error = ?, updated_at = ? WHERE id = ?`)
          .run(Date.now() + 60_000 * (job.attempts + 1), msg, Date.now(), job.id);
      }
    }
  }

  // LTM 변환 잡 — 파이프라인 동기 경로에서 이관 (HANDOFF §1.C 최우선 목표)
  private async runLtmJob(session: ChatSession, config: OmniConfig, payload: Record<string, any>): Promise<void> {
    const ns = session.store;
    const batchStart = Number(payload.batchStart);
    const batchEnd = Number(payload.batchEnd);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    if (!messages.length || !Number.isFinite(batchStart) || !Number.isFinite(batchEnd)) {
      console.log(`${LOG_PREFIX} LTM job: invalid payload, skipping`);
      return;
    }
    // 잡 지연 중 롤백/리롤로 워터마크가 움직였으면 이 배치는 낡은 것 — 스킵
    if (ns._ltmConvertedUpTo !== batchStart) {
      console.log(`${LOG_PREFIX} LTM job: watermark moved (${ns._ltmConvertedUpTo} ≠ ${batchStart}), skipping stale batch`);
      return;
    }
    const conversion = await convertToLTMNodes(
      messages,
      config,
      String(payload.personaName || session.lastPersonaName || ''),
      String(payload.charName || session.lastCharName || ''),
      typeof payload.simulBot === 'boolean' ? payload.simulBot : session.simulBot,
      ns,
      this.agentDeps,
    );
    const ok = conversion.ok;
    // 의도적 차이(원본 결함 수정 — 버그 5호 후보): 원본은 LLM 무응답/파싱 실패에도
    // 워터마크를 전진시켜 해당 8메시지 기억이 영구 유실됨 (E2E 실측 2026-08-01,
    // 버그 3호와 같은 "조용한 기억 증발" 계열). 실패 시 throw → 잡 재시도(3회 백오프),
    // 최종 실패해도 워터마크가 남아 다음 턴에 같은 배치가 재등록된다.
    if (!ok) {
      throw new Error(`LTM conversion failed (LLM/parse) — batch [${batchStart}..${batchEnd}) kept for retry`);
    }
    // D2: 이 배치에서 생성된 LTM에 원문 구간 앵커 스탬핑 (발췌 조립용 — LLM에 안 묻고 배치 범위)
    let stamped = 0;
    for (const id of conversion.affectedNodeIds) {
      const n = ns.getNode(id);
      if (n && n.type === 'longTermMemory' && n.sourceTurnStart === undefined) {
        n.sourceTurnStart = batchStart;
        n.sourceTurnEnd = batchEnd - 1;
        stamped++;
      }
    }
    ns._ltmConvertedUpTo = batchEnd;
    const lastMsg = messages[messages.length - 1];
    ns._ltmWatermarkHash = contentHash(String(lastMsg?.content ?? ''));
    console.log(`${LOG_PREFIX} LTM job: batch [${batchStart}..${batchEnd}) done (watermark → ${batchEnd}, ${stamped} LTM anchored)`);
  }

  // dream 잡 — 원본 _buildTasks의 태스크 4종 (LTM은 별도 잡, MemRL은 파이프라인 동기 유지).
  // 반환: 실제로 태스크를 하나라도 수행했는가 (게이트/조건 스킵이면 false — ranTurn 미기록)
  private async runDreamJob(job: JobRow, session: ChatSession, config: OmniConfig, payload: Record<string, any>): Promise<boolean> {
    const ns = session.store;
    const currentTurn = ns.currentTurn;
    const personaName = String(payload.personaName || session.lastPersonaName || '');

    if (config.autodreamEnabled === false) {
      console.log(`${LOG_PREFIX} Dream job: autodream disabled, skipping`);
      return false;
    }

    // 활동 게이트: 마지막 dream 실행 이후 새 메시지 N개 (원본 조건 3 계승)
    const minMessages = Math.max(0, Math.trunc(Number(config.autodreamAutoMinMessages)) || 4);
    if (currentTurn < minMessages) {
      console.log(`${LOG_PREFIX} Dream job: paused (only ${currentTurn}/${minMessages} messages)`);
      return false;
    }
    const lastDone = this.db.prepare(
      `SELECT payload_json FROM jobs WHERE chat_key = ? AND kind = 'dream' AND status = 'done'
       AND json_extract(payload_json, '$.ranTurn') IS NOT NULL ORDER BY id DESC LIMIT 1`,
    ).get(job.chat_key) as { payload_json: string } | undefined;
    if (lastDone) {
      const lastTurn = Number((JSON.parse(lastDone.payload_json || '{}') as Record<string, unknown>).ranTurn) || 0;
      if (currentTurn - lastTurn < minMessages) {
        console.log(`${LOG_PREFIX} Dream job: paused (only ${currentTurn - lastTurn}/${minMessages} new messages since last run)`);
        return false;
      }
    }

    // 레이트 캡: 시간당 실행 상한
    const doneLastHour = (this.db.prepare(
      `SELECT COUNT(*) AS c FROM jobs WHERE chat_key = ? AND kind = 'dream' AND status = 'done'
       AND json_extract(payload_json, '$.ranTurn') IS NOT NULL AND updated_at > ?`,
    ).get(job.chat_key, Date.now() - 3_600_000) as { c: number }).c;
    if (doneLastHour >= DREAM_MAX_RUNS_PER_HOUR) {
      console.log(`${LOG_PREFIX} Dream job: rate cap hit (${doneLastHour}/h), deferring`);
      throw Object.assign(new Error('rate-capped'), { _defer: true });
    }

    const pipelineWaiting = () => session.pipelineWaiting > 0;
    let ran = 0;

    // 1. 커뮤니티 탐지 (우선순위 1)
    if (shouldRunCommunityDetection(ns) && !pipelineWaiting()) {
      await runCommunityDetectionAgent(ns, config);
      ran++;
    }

    // 2. 고아 링킹 (우선순위 1.5)
    if (!pipelineWaiting()) {
      const orphans = _findOrphanNodes(ns);
      if (orphans.length >= 3) {
        await runOrphanLinkingAgent(ns, config, orphans);
        ran++;
      }
    }

    // 3. 월드심 (우선순위 2.5) — 완료된 dream 잡 수 기준 주기 실행
    if (config.worldSimEnabled !== false && currentTurn >= 12 && !pipelineWaiting()) {
      const wsInterval = Math.max(1, Math.min(10, Math.trunc(Number(config.worldSimInterval)) || 3));
      const doneDreams = (this.db.prepare(
        `SELECT COUNT(*) AS c FROM jobs WHERE chat_key = ? AND kind = 'dream' AND status = 'done'
         AND json_extract(payload_json, '$.ranTurn') IS NOT NULL`,
      ).get(job.chat_key) as { c: number }).c;
      if (doneDreams % wsInterval === (wsInterval - 1)) {
        await runWorldSimAgent(ns, config, personaName);
        ran++;
      }
    }

    // 4. 재평가 노트 컴팩션 (서버판 추가 — [Updated] ≥ N 노드를 정합 서술로 재작성)
    if (config.reevalCompactionEnabled !== false && !pipelineWaiting()) {
      const c = await runCompactionAgent(ns, config);
      if (c > 0) ran++;
    }

    // 5. ATLAS.md 갱신 (남아 있는 단일 MD 기능)
    const atlasDue = config.mdAtlasEnabled && currentTurn >= 12
      && (currentTurn % 20 === 12 || !ns.atlasMd) && this.lastMdTurn.get(job.chat_key) !== currentTurn;
    if (atlasDue && !pipelineWaiting()) {
      const val = await generateAtlasMdUpdate(ns.atlasMd || '', config, ns);
      if (val) ns.atlasMd = val;
      this.lastMdTurn.set(job.chat_key, currentTurn);
      ran++;
    }

    if (pipelineWaiting()) {
      console.log(`${LOG_PREFIX} Dream job: pipeline waiting — yielded early after ${ran} tasks`);
    } else {
      console.log(`${LOG_PREFIX} Dream job: ${ran} tasks done (turn ${currentTurn})`);
    }
    return ran > 0;
  }

  private cleanup() {
    this.db.prepare(
      `DELETE FROM jobs WHERE status IN ('done','error')
       AND id NOT IN (SELECT id FROM jobs WHERE status IN ('done','error') ORDER BY id DESC LIMIT ?)`,
    ).run(CLEANUP_KEEP);
  }
}
