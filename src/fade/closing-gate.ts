// FADE-011 Phase 2 S4 —编排层收口复跑门（T6 校验器接线·零新写只接线）.
// Law anchors:
//   - fade-protocol-spec.md §2.7「执行与校验」: 置 done 前必须运行
//     node_report_check（exit≠0 不得翻转）；编排层收口对全部节点复跑（双门）。
//     This module is the daemon-side mechanical enforcement: the checker binary
//     is the LIVE TriMetaverse script (TMV 015bab659) — never a copy.
//   - 排期单 fade-011-automation-phase2-plan-20261103.md（cd1a13c6）工序 4:
//     收口节点 spawn `node_report_check.py --tree-dir <run树>/reports`，RC=0
//     方可翻转，RC≠0 拒翻转并落失败明细。
//   - D-24 机位断言: repo root resolves via TMV_REPO_ROOT env (sg /srv/fleet/
//     portable) with a dev sibling-layout default — absolute paths are NEVER
//     hardcoded.
//   - D-65 族三 CLI 消费面 + R2.1: interpreter resolution is explicit (env
//     override → documented default), spawn uses an argv array with zero shell,
//     timeout upper bound is explicit (default 30s), and every failure mode is
//     fail-closed = REFUSE the flip (gate semantics, §2.7).
// Scope (S4 brief §一): the closing-gate wiring + independently testable gate
// path only. Full chain driving stays in S5.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FadeRunRecord, FadeRunState } from "./types.js";
import { TERMINAL_STATES, FadeTransitionError } from "./types.js";
import { assertTransition } from "./state-machine.js";
import type { FadeStore } from "./store.js";

/** Repo root for the LIVE checker script. TMV_REPO_ROOT wins (D-24: portable
 * across machines); default = dev sibling layout (src/fade/*.ts → ../../.. =
 * the workspace root that contains TriMetaverse/). */
export function resolveTmvRepoRoot(envOverride?: string): string {
  if (envOverride && envOverride.trim()) return resolve(envOverride.trim());
  const env = process.env.TMV_REPO_ROOT;
  if (env && env.trim()) return resolve(env.trim());
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "..", "..", "..", "TriMetaverse");
}

/** Interpreter resolution is EXPLICIT (D-65 族三): env override first, then one
 * documented default. No PATH probing magic, no shell — callers can always
 * predict what will execute. TRILC_FADE_PYTHON is the override knob. */
export const DEFAULT_PYTHON_EXECUTABLE = "python";

export function resolvePythonExecutable(envOverride?: string): string {
  if (envOverride && envOverride.trim()) return envOverride.trim();
  const env = process.env.TRILC_FADE_PYTHON;
  if (env && env.trim()) return env.trim();
  return DEFAULT_PYTHON_EXECUTABLE;
}

/** R2.1 explicit upper bound: a wedged checker must not wedge the daemon. */
export const DEFAULT_GATE_TIMEOUT_MS = 30_000;

/** Cap for persisted failure detail (gate-rejection卷面防爆). */
const DETAIL_CAP = 4000;

function capDetail(text: string): string {
  return text.length > DETAIL_CAP ? text.slice(-DETAIL_CAP) : text;
}

export interface SpawnOutcome {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** spawn-level failure (ENOENT / permissions) — fail-closed at the caller. */
  error?: { message: string };
}

/** Spawn one child with an explicit timeout upper bound (R2.1). argv array,
 * zero shell, windowsHidden. Timeout → kill → timedOut=true (fail-closed). */
export function spawnWithTimeout(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let spawnError: { message: string } | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch { /* already dead — outcome below decides */ }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
    child.on("error", (err: Error) => { spawnError = { message: err.message }; });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code: code === null ? null : Number(code),
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        error: spawnError,
      });
    });
  });
}

export type ClosingGateFailureReason = "checker-fail" | "spawn-error" | "timeout";

export type ClosingGateResult =
  | { ok: true; output: string }
  | {
      ok: false;
      reason: ClosingGateFailureReason;
      /** Checker exit code when it actually ran and rejected (≠0, incl. usage 2). */
      exitCode?: number;
      /** Failure detail for卷面落载 (tail-capped). */
      output: string;
      error?: string;
    };

export interface ClosingGateOptions {
  /** <run树>/reports — the checker's --tree-dir target. */
  reportsDir: string;
  tmvRepoRoot?: string;
  pythonExecutable?: string;
  timeoutMs?: number;
}

/** Run the LIVE §2.7 checker against one reports dir. RC=0 → pass; ANY other
 * outcome (RC≠0 incl. usage-error 2, spawn failure, timeout) → fail-closed. */
export async function runClosingGate(opts: ClosingGateOptions): Promise<ClosingGateResult> {
  const repoRoot = resolveTmvRepoRoot(opts.tmvRepoRoot);
  const checker = resolve(repoRoot, "scripts", "node_report_check.py");
  if (!existsSync(checker)) {
    return {
      ok: false,
      reason: "spawn-error",
      output: "",
      error: `checker script not found: ${checker} (TMV_REPO_ROOT=${repoRoot})`,
    };
  }
  const exe = resolvePythonExecutable(opts.pythonExecutable);
  const outcome = await spawnWithTimeout(
    exe,
    [checker, "--tree-dir", opts.reportsDir],
    opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
  );
  if (outcome.error) {
    return { ok: false, reason: "spawn-error", output: capDetail(outcome.stderr), error: outcome.error.message };
  }
  if (outcome.timedOut) {
    return {
      ok: false,
      reason: "timeout",
      output: capDetail(outcome.stdout),
      error: `checker timed out after ${opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS}ms (fail-closed)`,
    };
  }
  if (outcome.code === 0) {
    return { ok: true, output: capDetail(outcome.stdout) };
  }
  return {
    ok: false,
    reason: "checker-fail",
    exitCode: outcome.code ?? undefined,
    output: capDetail(`${outcome.stdout}\n${outcome.stderr}`.trim()),
  };
}

export type ClosingGateFinalizeResult =
  | { gated: true; run: FadeRunRecord; gateOutput: string }
  | {
      gated: false;
      /** Run state is UNCHANGED (refused flip, §2.7). */
      state: FadeRunRecord["state"];
      reason: ClosingGateFailureReason;
      detail: string;
      exitCode?: number;
    };

/**
 * Mechanical §2.7 enforcement of the FINALIZING → terminal flip: run the live
 * checker against the run tree's reports/ first; only RC=0 lets the transition
 * through. Any failure → record the rejection明细 (fade_gate_rejections) and
 * return gated:false with the run state untouched. The law table still checks
 * the edge itself (assertTransition inside advanceRun).
 * Throws (before any gate run) if toState is not terminal or the run is
 * unknown — this primitive only guards closing flips.
 */
export async function finalizeWithGate(
  store: FadeStore,
  runId: string,
  toState: FadeRunState,
  opts: ClosingGateOptions,
): Promise<ClosingGateFinalizeResult> {
  if (!(TERMINAL_STATES as readonly string[]).includes(toState)) {
    throw new FadeTransitionError("INVALID_STATE", `closing gate only guards terminal flips, got: ${toState}`, {
      to: toState,
    });
  }
  const run = store.getRun(runId);
  if (!run) {
    throw new FadeTransitionError("RUN_NOT_FOUND", `run not found: ${runId}`);
  }
  // Edge legality is still the law table's job — fail fast pre-gate so a
  // doomed flip never burns a checker run.
  assertTransition(run.state, toState, "finalize");

  const gate = await runClosingGate(opts);
  if (gate.ok) {
    const advanced = store.advanceRun(runId, toState, {
      actor: "finalize",
      reason: "closing gate PASS (§2.7 RC=0)",
    });
    return { gated: true, run: advanced, gateOutput: gate.output };
  }
  const detail = gate.error ? `${gate.error}\n${gate.output}`.trim() : gate.output;
  store.recordGateRejection(runId, "closing-report-check", gate.reason, capDetail(detail));
  return {
    gated: false,
    state: store.getRun(runId)!.state,
    reason: gate.reason,
    detail,
    exitCode: gate.reason === "checker-fail" ? gate.exitCode : undefined,
  };
}
