// ── TriLC Cron Service ──
// Phase 2: basic cron job scheduling with croner + SQLite persistence.
// Phase 3: full CronService with updateJob, runJob, execution logs, timer, and locked mutex.

import type { CronJob, CronJobCreate, CronJobPatch, ExecutionLogEntry } from "./types.js";
import { createCronStore } from "./store.js";
import { parseCronSchedule } from "./scheduler.js";
import {
  createCronTimerState,
  armTimer,
  stopTimer,
  runMissedJobs,
  enqueueRun,
  type CronTimerDeps,
  type CronTimerState,
} from "./timer.js";
import type { SessionRecord } from "../session-store/types.js";
import { publish } from "../localbus/bus.js";

const LOG_PREFIX = "[trilc:cron]";

export interface CronService {
  start(): Promise<void>;
  stop(): void;
  addJob(input: CronJobCreate): Promise<CronJob>;
  removeJob(id: string): Promise<void>;
  updateJob(id: string, patch: CronJobPatch): Promise<CronJob | null>;
  listJobs(): Promise<CronJob[]>;
  getJob(id: string): CronJob | undefined;
  runJob(id: string, force?: boolean): Promise<{ ok: boolean; ran: boolean; reason?: string }>;
  getExecutionLogs(jobId: string, limit?: number): Promise<ExecutionLogEntry[]>;
  getRecentExecutionLogs(limit?: number): Promise<ExecutionLogEntry[]>;
  /** Whether the cron engine has entered degraded state (3+ consecutive failures). */
  isDegraded(): boolean;
  /** Current number of consecutive failures (resets to 0 on success). */
  readonly consecutiveFailures: number;
  readonly jobCount: number;
  readonly isRunning: boolean;
}

export interface CronServiceDeps {
  dataDir: string;
  sessionStore: {
    createSession(session: { id: string; model: string; systemPrompt: string; cwd: string; title?: string }): void;
    saveMessages(sessionId: string, messages: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string | null; toolCalls?: unknown; toolCallId?: string; reasoningContent?: string }>): void;
    updateSessionStatus(sessionId: string, status: SessionRecord["status"]): void;
  };
  cwd: string;
  onJobTrigger?: (job: CronJob) => void;
  /** FADE-ASSESS-005: 员工岗在岗校验（透传至 timer，调度拉起前门禁）。 */
  isRoleActive?: (roleId: string) => Promise<boolean>;
  /** FADE-ASSESS-003 小乔指标：roleId 门禁拒绝回调（透传至 timer；缺省静默）。 */
  onRoleGateDenied?: (roleId: string) => void;
}

// Backward-compatible alias
export type MinimalCronEngine = CronService;
export type MinimalCronEngineDeps = CronServiceDeps;

export function createMinimalCronEngine(deps: MinimalCronEngineDeps): MinimalCronEngine {
  return createCronService(deps);
}

export function createCronService(deps: CronServiceDeps): CronService {
  const store = createCronStore(`${deps.dataDir}/cron.db`);
  const { sessionStore, cwd, onJobTrigger } = deps;
  const state: CronTimerState = createCronTimerState();

  const timerDeps: CronTimerDeps = {
    store,
    sessionStore,
    cwd,
    onJobTrigger,
    isRoleActive: deps.isRoleActive,
    onRoleGateDenied: deps.onRoleGateDenied,
  };

  // ── Public API ──

  return {
    get jobCount(): number {
      return store.listJobs().length;
    },

    get isRunning(): boolean {
      return state.started;
    },

    get consecutiveFailures(): number {
      return state.consecutiveFailures;
    },

    isDegraded(): boolean {
      return state.degraded;
    },

    async start(): Promise<void> {
      if (state.started) return;
      state.started = true;

      // Boot recovery sweep（LG-064 §八裁决② TriMLC 移植，2026-10-06）：上一 boot
      // 崩溃/强停残留的 running 态先归位 idle，必须先于 runMissedJobs——残留
      // running 会让补跑洪峰过滤器（timer.ts runMissedJobs 的 state==="running"
      // 剔除）跳过该 job，且引擎互斥永不重触发 = l2-scan 永卡族。
      store.resetStaleRunningJobs();

      // Run missed jobs from before restart
      await runMissedJobs(state, timerDeps);

      // F-3 Part B: self-heal legacy rows whose next_run_at is NULL. The INSERT
      // fix (0fd9c6f) only covers newly created jobs; rows created before the
      // fix stay permanently unscheduled until backfilled here. Write path =
      // updateJobRun, same channel the post-run re-schedule uses (timer.ts).
      for (const j of store.listJobs()) {
        if (j.enabled && !j.nextRunAt) {
          try {
            const { nextRunMs } = parseCronSchedule(j.schedule);
            const v = nextRunMs();
            if (v != null) {
              store.updateJobRun(j.id, { nextRunAt: new Date(v).toISOString() });
            }
          } catch { /* unparseable schedule: leave NULL (fail-open) */ }
        }
      }

      // Arm the global timer
      armTimer(state, timerDeps);

      const jobs = store.listJobs();
      console.log(`${LOG_PREFIX} engine started with ${jobs.length} jobs`);
    },

    stop(): void {
      state.started = false;
      stopTimer(state);
      // Clear per-job timers (Phase 2 compat)
      for (const [, timer] of state.timers) { clearTimeout(timer); }
      state.timers.clear();
      console.log(`${LOG_PREFIX} engine stopped`);
    },

    async addJob(input: CronJobCreate): Promise<CronJob> {
      const job = store.addJob(input);
      console.log(`${LOG_PREFIX} job added: ${job.name} (${job.id})`);
      if (state.started) armTimer(state, timerDeps);
      return job;
    },

    async removeJob(id: string): Promise<void> {
      const removed = store.removeJob(id);
      if (removed) {
        console.log(`${LOG_PREFIX} job removed: ${id}`);
        if (state.started) armTimer(state, timerDeps);
      }
    },

    async updateJob(id: string, patch: CronJobPatch): Promise<CronJob | null> {
      const existing = store.getJob(id);
      if (!existing) {
        console.error(`${LOG_PREFIX} updateJob: job not found: ${id}`);
        return null;
      }

      const job = store.updateJob(id, patch);
      if (job) {
        console.log(`${LOG_PREFIX} job updated: ${job.name} (${id})`);
        if (state.started) armTimer(state, timerDeps);
      }
      return job;
    },

    listJobs(): Promise<CronJob[]> {
      return Promise.resolve(store.listJobs());
    },

    getJob(id: string): CronJob | undefined {
      return store.getJob(id);
    },

    async runJob(id: string, force?: boolean): Promise<{ ok: boolean; ran: boolean; reason?: string }> {
      const result = await enqueueRun(state, timerDeps, id, { force });
      if (result && result.ran) {
        publish({ type: "cron:sweep", count: 1 });
      }
      return result;
    },

    getExecutionLogs(jobId: string, limit?: number): Promise<ExecutionLogEntry[]> {
      return Promise.resolve(store.getExecutionLogs(jobId, limit));
    },

    getRecentExecutionLogs(limit?: number): Promise<ExecutionLogEntry[]> {
      const logs = store.getRecentExecutionLogs(limit);
      return Promise.resolve(logs);
    },
  };
}
