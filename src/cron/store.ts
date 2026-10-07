// ── TriLC Cron Store ──
// SQLite persistence for cron jobs (cron.db in the TriLC data directory).
// Schema is auto-created on first access.
//
// Phase 2: minimal CRUD + startup load.
// Phase 3: atomic write, mtime detection, execution_log table, updateJob.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type { CronJob, CronJobCreate, CronJobPatch, ExecutionLogEntry, ExecutionLogStatus } from "./types.js";
import { parseCronSchedule } from "./scheduler.js";

const LOG_PREFIX = "[trilc:cron]";

// ── Schema ──

const CREATE_JOBS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS cron_jobs (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    schedule_kind   TEXT NOT NULL CHECK(schedule_kind IN ('every','cron')),
    schedule_value  TEXT NOT NULL,
    schedule_tz     TEXT,
    system_prompt   TEXT NOT NULL DEFAULT '',
    command         TEXT,
    role_id         TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    state           TEXT NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','running','failed')),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_run_at     TEXT,
    last_run_status TEXT CHECK(last_run_status IN ('ok','error','skipped')),
    next_run_at     TEXT,
    run_count       INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0
  );
`;

const CREATE_EXECUTION_LOG_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS execution_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id        TEXT NOT NULL,
    status        TEXT NOT NULL CHECK(status IN ('ok','error','skipped','timeout')),
    started_at    TEXT NOT NULL,
    duration_ms   INTEGER,
    error_message TEXT,
    FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
  );
`;

const CREATE_EXECUTION_LOG_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_execution_log_job_id ON execution_log(job_id);
`;

// ── Row Types ──

interface CronJobRow {
  id: string;
  name: string;
  schedule_kind: string;
  schedule_value: string;
  schedule_tz: string | null;
  system_prompt: string;
  command: string | null;
  role_id: string | null;
  enabled: number;
  state: string;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_run_status: string | null;
  next_run_at: string | null;
  run_count: number;
  error_count: number;
}

interface ExecutionLogRow {
  id: number;
  job_id: string;
  status: string;
  started_at: string;
  duration_ms: number | null;
  error_message: string | null;
}

// ── Conversion ──

function rowToJob(row: CronJobRow): CronJob {
  return {
    id: row.id,
    name: row.name,
    schedule:
      row.schedule_kind === "every"
        ? { kind: "every", everyMs: parseInt(row.schedule_value, 10) }
        : { kind: "cron", expr: row.schedule_value, ...(row.schedule_tz ? { tz: row.schedule_tz } : {}) },
    systemPrompt: row.system_prompt,
    command: row.command ?? undefined,
    roleId: row.role_id ?? undefined,
    enabled: row.enabled === 1,
    state: row.state as CronJob["state"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastRunStatus: (row.last_run_status as CronJob["lastRunStatus"]) ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    runCount: row.run_count,
    errorCount: row.error_count,
  };
}

function rowToExecutionLog(row: ExecutionLogRow): ExecutionLogEntry {
  return {
    id: row.id,
    jobId: row.job_id,
    status: row.status as ExecutionLogStatus,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
  };
}

// ── Store API ──

export function createCronStore(dbPath: string) {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(CREATE_JOBS_TABLE_SQL);
  db.exec(CREATE_EXECUTION_LOG_TABLE_SQL);
  db.exec(CREATE_EXECUTION_LOG_INDEX_SQL);

  // REQ-019: migration — add command column to pre-existing cron.db
  try {
    const cols = db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "command")) {
      db.exec("ALTER TABLE cron_jobs ADD COLUMN command TEXT");
    }
  } catch { /* best-effort */ }

  // FADE-ASSESS-005: migration — add role_id column to pre-existing cron.db
  try {
    const cols2 = db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
    if (!cols2.some((c) => c.name === "role_id")) {
      db.exec("ALTER TABLE cron_jobs ADD COLUMN role_id TEXT");
    }
  } catch { /* best-effort */ }

  // ── In-memory cache ──
  let jobs: CronJob[] = [];
  let lastLoadMtimeMs = 0;

  // ── Load all jobs on init (or reload if mtime changed) ──

  function getDbMtime(): number {
    try {
      return fs.statSync(dbPath).mtimeMs;
    } catch {
      return 0;
    }
  }

  function loadAll(): CronJob[] {
    const mtime = getDbMtime();
    // mtime detection: skip reload if file hasn't changed since last load
    if (mtime > 0 && mtime === lastLoadMtimeMs && jobs.length > 0) {
      console.log(`${LOG_PREFIX} store: mtime unchanged, using cached ${jobs.length} jobs`);
      return jobs;
    }

    const stmt = db.prepare("SELECT * FROM cron_jobs ORDER BY created_at ASC");
    const rows = stmt.all() as unknown as CronJobRow[];
    jobs = rows.map(rowToJob);
    lastLoadMtimeMs = mtime;
    console.log(`${LOG_PREFIX} store: loaded ${jobs.length} jobs from ${dbPath} (mtime=${mtime})`);
    return jobs;
  }

  // ── Atomic JSON backup ──
  // Writes jobs as JSON to <dbPath>.json via tmp+rename for atomicity.

  function saveCronStore(): void {
    const jsonPath = dbPath + ".json";
    const tmpPath = jsonPath + ".tmp";
    try {
      const data = JSON.stringify(jobs, null, 2);
      fs.writeFileSync(tmpPath, data, "utf-8");
      fs.renameSync(tmpPath, jsonPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} store: atomic save failed: ${msg}`);
      // Clean up tmp file on failure
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  function loadCronStore(): CronJob[] | null {
    const jsonPath = dbPath + ".json";
    try {
      if (!fs.existsSync(jsonPath)) return null;
      const raw = fs.readFileSync(jsonPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      return parsed as CronJob[];
    } catch {
      return null;
    }
  }

  // ── CRUD ──

  function addJob(input: CronJobCreate): CronJob {
    const id = `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const now = new Date().toISOString();

    const scheduleKind = input.schedule.kind;
    const scheduleValue = scheduleKind === "every"
      ? String(input.schedule.everyMs)
      : input.schedule.expr;
    const scheduleTz = scheduleKind === "cron" ? input.schedule.tz ?? null : null;

    // F-3 fix: compute the first trigger point at INSERT time — same semantics as the
    // updateJob PATCH path (which recomputes nextRunAt whenever patch.schedule is set).
    // Before this fix an API-inserted job had next_run_at = NULL and was permanently
    // invisible to the timer (armTimer/onTimerTick/runMissedJobs all filter on
    // nextRunAt truthiness), staying unscheduled until a manual force-run happened to
    // write the value back via the post-run updateJobRun path.
    let nextRunAt: string | null = null;
    try {
      const sched = parseCronSchedule(input.schedule);
      const nextMs = sched.nextRunMs();
      nextRunAt = nextMs ? new Date(nextMs).toISOString() : null;
    } catch {
      // Unparseable schedule: keep NULL (fail-open, same semantics as updateJob).
      nextRunAt = null;
    }

    const stmt = db.prepare(`
      INSERT INTO cron_jobs (id, name, schedule_kind, schedule_value, schedule_tz,
        system_prompt, command, role_id, enabled, state, created_at, updated_at, next_run_at, run_count, error_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, 0, 0)
    `);
    stmt.run(
      id, input.name, scheduleKind, scheduleValue, scheduleTz,
      input.systemPrompt, input.command ?? null, input.roleId ?? null,
      input.enabled ? 1 : 0, now, now, nextRunAt,
    );

    const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as unknown as CronJobRow;
    const job = rowToJob(row);
    jobs.push(job);
    saveCronStore();
    return job;
  }

  function removeJob(id: string): boolean {
    // Also remove execution logs for this job
    db.prepare("DELETE FROM execution_log WHERE job_id = ?").run(id);
    const stmt = db.prepare("DELETE FROM cron_jobs WHERE id = ?");
    const result = stmt.run(id);
    jobs = jobs.filter((j) => j.id !== id);
    if (result.changes > 0) {
      saveCronStore();
    }
    return result.changes > 0;
  }

  function getJob(id: string): CronJob | undefined {
    return jobs.find((j) => j.id === id);
  }

  function listJobs(): CronJob[] {
    return [...jobs];
  }

  // ── Update job (Phase 3) ──
  // Patchable fields: name, schedule, systemPrompt, enabled.

  function updateJob(id: string, patch: CronJobPatch): CronJob | null {
    const job = jobs.find((j) => j.id === id);
    if (!job) return null;

    const now = new Date().toISOString();
    const setClauses: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [now];

    if (patch.name !== undefined) {
      setClauses.push("name = ?");
      values.push(patch.name);
    }
    if (patch.schedule !== undefined) {
      setClauses.push("schedule_kind = ?", "schedule_value = ?");
      values.push(
        patch.schedule.kind,
        patch.schedule.kind === "every" ? String(patch.schedule.everyMs) : patch.schedule.expr,
      );
      if (patch.schedule.kind === "cron") {
        setClauses.push("schedule_tz = ?");
        values.push(patch.schedule.tz ?? null);
      } else {
        setClauses.push("schedule_tz = ?");
        values.push(null);
      }
      // Recompute nextRunAt so the timer picks up the new schedule immediately.
      try {
        const sched = parseCronSchedule(patch.schedule as never);
        const next = sched.nextRunMs();
        setClauses.push("next_run_at = ?");
        values.push(next ? new Date(next).toISOString() : null);
      } catch { /* keep previous nextRunAt on parse failure */ }
    }
    if (patch.systemPrompt !== undefined) {
      setClauses.push("system_prompt = ?");
      values.push(patch.systemPrompt);
    }
    if (patch.command !== undefined) {
      setClauses.push("command = ?");
      values.push(patch.command ?? null);
    }
    if (patch.roleId !== undefined) {
      setClauses.push("role_id = ?");
      values.push(patch.roleId ?? null);
    }
    if (patch.enabled !== undefined) {
      setClauses.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }

    values.push(id); // WHERE id = ?
    const sql = `UPDATE cron_jobs SET ${setClauses.join(", ")} WHERE id = ?`;
    db.prepare(sql).run(...values);

    // Refresh in-memory
    const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as unknown as CronJobRow;
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx >= 0) jobs[idx] = rowToJob(row);
    saveCronStore();
    return jobs[idx];
  }

  function updateJobRun(id: string, updates: {
    lastRunAt?: string;
    lastRunStatus?: string;
    nextRunAt?: string;
    state?: string;
    incrementRun?: boolean;
    incrementError?: boolean;
  }): void {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;

    const now = new Date().toISOString();
    const stmt = db.prepare(`
      UPDATE cron_jobs SET
        updated_at = ?,
        last_run_at = COALESCE(?, last_run_at),
        last_run_status = COALESCE(?, last_run_status),
        next_run_at = COALESCE(?, next_run_at),
        state = COALESCE(?, state),
        run_count = run_count + ?,
        error_count = error_count + ?
      WHERE id = ?
    `);
    stmt.run(
      now,
      updates.lastRunAt ?? null,
      updates.lastRunStatus ?? null,
      updates.nextRunAt ?? null,
      updates.state ?? null,
      updates.incrementRun ? 1 : 0,
      updates.incrementError ? 1 : 0,
      id,
    );

    // Refresh in-memory
    const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(id) as unknown as CronJobRow;
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx >= 0) jobs[idx] = rowToJob(row);
    // Maintenance ④ (2026-10-03): keep the JSON backup in sync — addJob/updateJob/
    // removeJob all call saveCronStore(); updateJobRun (9 call sites in timer.ts =
    // every post-run write) was the only mutation path that left <dbPath>.json stale.
    saveCronStore();
  }

  // ── Boot recovery sweep（LG-064 §八裁决② TriMLC 移植，2026-10-06）──

  /**
   * 上一 boot 崩溃/强停残留的 running 态归位 idle（engine start 时调用，先于
   * runMissedJobs）。残留 running 会使补跑洪峰竞态后引擎互斥永不重触发
   * （l2-scan 永卡族实证形态：nextRun 冻结+不自愈；l2-scan PATCH 破案另证
   * state 非 API 可写面——CronJobPatch 无 state 字段，归位只此 boot 通道）。
   * TriRLC 同构正形 03b3220 移植；CTO 排程=段2 部署窗前置项（卷 851382a9）。
   */
  function resetStaleRunningJobs(): number {
    const now = new Date().toISOString();
    const result = db
      .prepare("UPDATE cron_jobs SET state = 'idle', updated_at = ? WHERE state = 'running'")
      .run(now);
    const changed = Number(result.changes ?? 0);
    if (changed > 0) {
      // 逐行刷新内存（不能用 loadAll：其 mtime 守卫在 WAL 模式下看不到主 db
      // 文件变化 → 缓存陈旧 → 判定面仍读 running；TriRLC 段1 白盒同签名实证）。
      // 对齐 updateJobRun 刷新形态（含 saveCronStore，Maintenance ④ 同步 json 备份）。
      for (let i = 0; i < jobs.length; i++) {
        if (jobs[i].state === 'running') {
          const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobs[i].id) as unknown as CronJobRow;
          jobs[i] = rowToJob(row);
        }
      }
      saveCronStore();
      console.log(`${LOG_PREFIX} boot recovery: reset ${changed} stale running job(s) to idle`);
    }
    return changed;
  }

  // ── Runtime stale-running reclaim sweep（根治包：run 永卡 running 无自愈，
  // CTO APPROVE d38a3eae，2026-10-07）──

  /**
   * 运行期 stale-running 对账（timer tick 锁内驱动；boot sweep 之外的第二道）：
   * settle 断链（P1 settle 写失败穿 withLock / P2 补跑洪峰半亡态）残留的
   * running 行永卡——互斥与 tick 过滤双重封死复活通道，boot sweep 只封重启
   * 入口，daemon 长活期间零自愈。本 sweep 把 updated_at 早于 cutoff 的 running
   * 行归位 idle + 执行账补记，nextRunAt 重排由 timer 层逐 id 接力（本层不管
   * schedule 语义）。
   *
   * 判据红线（CTO 附条件① 语义边界钉注）：updated_at 是「行面突变事实」代理
   * 启动时刻——executeJobScheduled 先写 state=running（updateJobRun 无条件盖
   * updated_at），settle 前行面无第二写；故 API PATCH（updateJob 改名/排程）
   * 刷新 updated_at 使本 sweep 顺延一轮 = 设计行为非 bug（保守向：只顺延不误
   * 杀，CTO 裁①采 updatedAt 代理案的定谳理由）。nextRun 滚动禁入判据
   * （TriMMC executor 家族红线）。
   *
   * 返回归位的 job id 列表（timer 层逐 id 重排 nextRunAt；count=length）。
   */
  function reclaimStaleRunningJobs(cutoffIso: string): string[] {
    const staleRows = db
      .prepare("SELECT id, updated_at FROM cron_jobs WHERE state = 'running' AND updated_at <= ?")
      .all(cutoffIso) as unknown as Array<{ id: string; updated_at: string }>;
    if (staleRows.length === 0) return [];

    // 执行账补记（boot sweep 不补账的缺口本 sweep 封住）：startedAt=归位前行面
    // 的 updated_at（启动时刻代理）；durationMs 记 0 + errorMessage 注明未知——
    // addExecutionLog 形参为 number（零 types 变更写入面），真实时长已不可考。
    const now = new Date().toISOString();
    for (const row of staleRows) {
      addExecutionLog(
        row.id,
        "error",
        row.updated_at,
        0,
        "stale running reclaimed (runtime sweep): exceeded timeout+grace (duration unknown)",
      );
    }

    const result = db
      .prepare(
        "UPDATE cron_jobs SET state = 'idle', last_run_status = 'error', " +
        "error_count = error_count + 1, updated_at = ? " +
        "WHERE state = 'running' AND updated_at <= ?",
      )
      .run(now, cutoffIso);
    const changed = Number(result.changes ?? 0);

    if (changed > 0) {
      // 逐行刷新内存（同 boot sweep：禁 loadAll——其 mtime 守卫在 WAL 模式下
      // 看不到主 db 文件变化 → 缓存陈旧；对齐 updateJobRun 刷新形态，含
      // saveCronStore，Maintenance ④ json 备份同步）。
      for (let i = 0; i < jobs.length; i++) {
        if (jobs[i].state === 'running') {
          const row = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobs[i].id) as unknown as CronJobRow;
          jobs[i] = rowToJob(row);
        }
      }
      saveCronStore();
    }
    return staleRows.map((r) => r.id);
  }

  // ── Execution Log (Phase 3) ──

  function addExecutionLog(
    jobId: string,
    status: ExecutionLogStatus,
    startedAt: string,
    durationMs: number,
    errorMessage?: string,
  ): ExecutionLogEntry {
    const stmt = db.prepare(`
      INSERT INTO execution_log (job_id, status, started_at, duration_ms, error_message)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(jobId, status, startedAt, durationMs, errorMessage ?? null);
    return {
      id: Number(result.lastInsertRowid ?? 0),
      jobId,
      status,
      startedAt,
      durationMs,
      errorMessage: errorMessage ?? null,
    };
  }

  function getExecutionLogs(jobId: string, limit = 50): ExecutionLogEntry[] {
    const stmt = db.prepare(
      "SELECT * FROM execution_log WHERE job_id = ? ORDER BY started_at DESC LIMIT ?",
    );
    const rows = stmt.all(jobId, limit) as unknown as ExecutionLogRow[];
    return rows.map(rowToExecutionLog);
  }

  function getRecentExecutionLogs(limit = 20): ExecutionLogEntry[] {
    const stmt = db.prepare(
      "SELECT * FROM execution_log ORDER BY started_at DESC LIMIT ?",
    );
    const rows = stmt.all(limit) as unknown as ExecutionLogRow[];
    return rows.map(rowToExecutionLog);
  }

  // ── Init ──
  loadAll();

  return {
    addJob,
    removeJob,
    getJob,
    listJobs,
    updateJob,
    updateJobRun,
    resetStaleRunningJobs,
    reclaimStaleRunningJobs,
    addExecutionLog,
    getExecutionLogs,
    getRecentExecutionLogs,
    saveCronStore,
    loadCronStore,
    reloadIfChanged: loadAll,
    db,
  };
}
