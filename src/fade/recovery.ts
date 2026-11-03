// FADE-011 Phase 2 S2 — boot recovery chain (gap ③).
// Law anchor (ratified, normative): TriCompany/docs/engineering/fade-protocol-spec.md
//   §8.1 recovery policy (CTO 批认 be0fe20·2026-11-04): idempotent segments
//   resume in place (state unchanged); the non-idempotent segment EXECUTING
//   (DCE rewrites workspace files) rolls back to CLOSING for close-out
//   verification; RETRY is terminal with no outgoing edges.
//   §8.1 L445: runtime owns the run — after Agent interruption or host
//   restart it must still reach CLOSING or a terminal state.
// Scope (S2 dispatch brief a7098a469 §一): "已有 run 态→boot 后恢复" only —
// run triggering / ten-segment programmatic driving is S5 domain.
import { recoveryActionFor } from "./state-machine.js";
import { createFadeStore, type FadeStore } from "./store.js";
import type { FadeRunState } from "./types.js";

export type BootRecoveryAction = "resume" | "rollback-closing";

export interface BootRecoveryEntry {
  runId: string;
  action: BootRecoveryAction;
  /** State observed at sweep time. */
  fromState: FadeRunState;
  /** Checkpoint carried through the recovery path (driver consumes it in S5). */
  checkpoint: string | null;
  error?: string;
}

export interface BootRecoveryReport {
  /** Total unfinished runs swept at boot. */
  swept: number;
  /** Idempotent-segment runs: left in place, checkpoint surfaced. */
  resumed: BootRecoveryEntry[];
  /** EXECUTING runs rolled back to CLOSING (recoverRun executed). */
  rolledBack: BootRecoveryEntry[];
  /** Rollback attempts that threw (fail-soft per run; boot continues). */
  failed: BootRecoveryEntry[];
}

export interface BootRecoveryOptions {
  /** Per-run progress log (daemon boot wires console through it). */
  log?: (message: string) => void;
}

/**
 * Sweep unfinished runs and apply the ratified §8.1 recovery policy:
 *  - resume (idempotent segments incl. DETECTED/QUALIFYING/PLANNING/PLANNED/
 *    VERIFYING/SCORING/CLOSING/FINALIZING): no state change, no audit row —
 *    resumption of the actual segment work is the driver's job (S5); this
 *    chain only settles the persisted state and surfaces the checkpoint.
 *  - rollback-closing (EXECUTING): recoverRun appends a recovery-actor audit
 *    row EXECUTING -> CLOSING per §8.1 L445.
 * Per-run failures are captured in `failed` and do not abort the sweep
 * (one corrupt run must not block the rest; fail-soft is explicit, never
 * silent — failures are logged by the caller).
 */
export function runBootRecovery(store: FadeStore, opts?: BootRecoveryOptions): BootRecoveryReport {
  const log = opts?.log ?? (() => {});
  const runs = store.listUnfinishedRuns();
  const report: BootRecoveryReport = { swept: runs.length, resumed: [], rolledBack: [], failed: [] };

  for (const run of runs) {
    const action = recoveryActionFor(run.state);
    if (action === "rollback-closing") {
      try {
        store.recoverRun(run.runId, "boot recovery: EXECUTING interrupted -> CLOSING (spec §8.1)");
        report.rolledBack.push({
          runId: run.runId,
          action,
          fromState: run.state,
          checkpoint: run.checkpoint,
        });
        log(`run ${run.runId}: EXECUTING -> CLOSING (boot recovery rollback)`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failed.push({
          runId: run.runId,
          action,
          fromState: run.state,
          checkpoint: run.checkpoint,
          error: message,
        });
        log(`run ${run.runId}: boot recovery rollback FAILED: ${message}`);
      }
      continue;
    }
    // 'resume' (and defensive 'none' — terminals never appear in the
    // unfinished list, but if one ever does, in-place is still the safe move).
    report.resumed.push({
      runId: run.runId,
      action: "resume",
      fromState: run.state,
      checkpoint: run.checkpoint,
    });
    log(
      `run ${run.runId}: resumed in place at ${run.state}` +
        (run.checkpoint ? " (checkpoint present)" : ""),
    );
  }
  return report;
}

export interface FadeBootRecoveryResult {
  store: FadeStore;
  report: BootRecoveryReport;
}

/**
 * Daemon-boot convenience: open the independent-keyspace fade store
 * (`${dataDir}/fade.db` — zero touch on live cron.db) and run the sweep.
 * Callers that must not crash the boot path wrap this in try/catch.
 */
export function openFadeStoreAndRecover(
  dataDir: string,
  opts?: BootRecoveryOptions,
): FadeBootRecoveryResult {
  const store = createFadeStore(`${dataDir}/fade.db`);
  const report = runBootRecovery(store, opts);
  return { store, report };
}

/** One-line boot summary for daemon logs (empty sweep -> empty string). */
export function summarizeBootRecovery(report: BootRecoveryReport): string {
  if (report.swept === 0) return "";
  const parts = [`swept=${report.swept}`];
  if (report.resumed.length > 0) parts.push(`resumed=${report.resumed.length}`);
  if (report.rolledBack.length > 0) parts.push(`rolledBack=${report.rolledBack.length}`);
  if (report.failed.length > 0) parts.push(`failed=${report.failed.length}`);
  return parts.join(" ");
}
