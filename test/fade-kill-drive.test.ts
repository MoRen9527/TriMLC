// FADE-011 Phase 2 S5 — process-level acceptance gate, TWO consecutive rounds
// (排期单 §五 机械化判据·BOD 照立; brief 837b4770d §二):
//   判据① daemon 触发新 run → 十段全自动（零人工）→ 终态 APPROVED      [Round 1]
//   判据② 十段中途 kill daemon（随机段位）→ 重启 → 恢复续跑 → 终态可达  [Round 2]
//   判据③ 收口双门：编排层 node_report_check.py --tree-dir 复跑 RC=0    [both]
//   判据④ 连续两轮通过（本文件即两轮顺序执行）
// Form: fully independent test instance — own DATA_DIR/PID dir, port 0
// (OS-assigned), zero touch on the live 8713 daemon (S2 同形承袭).
// Kill = child.kill() → Windows TerminateProcess (hard kill, no graceful
// shutdown path) = true mid-flight interruption semantics.
// R2.1: boot ≤60s (tsx cold start), post-resume terminal reachability ≤60s,
// HTTP drive ≤35s (8 ms-level segments + S4 gate upper bound 30s).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { resolveTmvRepoRoot } from "../src/fade/closing-gate.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_TIMEOUT_MS = 60_000;
const HEALTH_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 15_000;
const DRIVE_HTTP_TIMEOUT_MS = 35_000;
const TERMINAL_POLL_TIMEOUT_MS = 60_000;
const TERMINAL_STATES = ["APPROVED", "FROZEN", "ESCALATED", "RETRY"];

let tmpDataDir = "";
let tmpPidDir = "";
const children: ChildProcess[] = [];

function daemonEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  e.TRILC_DATA_DIR = tmpDataDir;
  e.TRILC_PID_DIR = tmpPidDir;
  e.TRILC_PROJECT_ROOT = tmpDataDir;
  e.TRILC_PORT = "0";
  e.TRIMODEL_KEY_STORAGE_MODE = "s3";
  e.TRILC_TRIMODEL_API_URL = "http://127.0.0.1:9"; // closed port → fail-soft
  e.TRILC_INTERNAL_TOKEN = "fade-kill-drive-test-token";
  delete e.TRILC_WEEKLY_PLANE_ROOT;
  delete e.TRIMODEL_ADMIN_TOKEN;
  delete e.TRIMODEL_API_TOKEN;
  delete e.TRIMODEL_FACE_ID;
  return e;
}

function spawnDaemon(): { child: ChildProcess; out: () => string } {
  let buf = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: daemonEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (d: string) => { buf += d; });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (d: string) => { buf += d; });
  return { child, out: () => buf };
}

function tail(text: string, lines = 30): string {
  const arr = text.split(/\r?\n/).filter((l) => l.length > 0);
  return arr.slice(-lines).join("\n");
}

function waitReady(child: ChildProcess, out: () => string): Promise<number> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  return new Promise<number>((res, rej) => {
    const tick = () => {
      if (child.exitCode !== null) {
        rej(new Error(`daemon exited early (code=${child.exitCode}):\n${tail(out())}`));
        return;
      }
      const line = out().split(/\r?\n/).find((l) => l.includes("[trilc] ready"));
      const m = line?.match(/port=(\d+)/);
      if (line && m) { res(Number(m[1])); return; }
      if (Date.now() > deadline) {
        rej(new Error(`daemon ready line not seen within ${BOOT_TIMEOUT_MS}ms:\n${tail(out())}`));
        return;
      }
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function waitHealthy(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
      lastErr = `healthz HTTP ${r.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`healthz not green within ${HEALTH_TIMEOUT_MS}ms (last: ${lastErr})`);
}

function waitExit(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  return new Promise<void>((res, rej) => {
    const tick = () => {
      if (child.exitCode !== null || child.signalCode !== null) { res(); return; }
      if (Date.now() > deadline) { rej(new Error(`daemon did not exit within ${EXIT_TIMEOUT_MS}ms after kill`)); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** POST /internal/v1/fade/runs (X-Internal-Token 门内) — synchronous drive. */
async function postTrigger(port: number, runId: string, treeDir: string): Promise<{
  status: number; body: { object?: string; created?: boolean; finalState?: string; gated?: boolean; error?: string; message?: string };
}> {
  const r = await fetch(`http://127.0.0.1:${port}/internal/v1/fade/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-token": "fade-kill-drive-test-token" },
    body: JSON.stringify({ runId, treeDir }),
    signal: AbortSignal.timeout(DRIVE_HTTP_TIMEOUT_MS),
  });
  const body = (await r.json()) as {
    object?: string; created?: boolean; finalState?: string; gated?: boolean; error?: string; message?: string;
  };
  return { status: r.status, body };
}

/** 编排层门复跑（判据③）: real checker, real exit code. */
function orchestrationGateRerun(reportsDir: string): { rc: number; stdout: string } {
  const checker = join(resolveTmvRepoRoot(), "scripts", "node_report_check.py");
  const p = spawnSync("python", [checker, "--tree-dir", reportsDir], {
    timeout: 30_000, encoding: "utf-8",
  });
  return { rc: p.status ?? -1, stdout: `${p.stdout ?? ""}${p.stderr ?? ""}` };
}

/** Poll fade.db until the run reaches a terminal state (fresh connection per
 * probe — WAL concurrent readers OK). */
async function pollTerminal(runId: string): Promise<{ state: string; checkpoint: string | null }> {
  const dbPath = join(tmpDataDir, "fade.db");
  const deadline = Date.now() + TERMINAL_POLL_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT state, checkpoint FROM fade_runs WHERE run_id = ?").get(runId) as
        | { state: string; checkpoint: string | null } | undefined;
      if (row) {
        last = row.state;
        if (TERMINAL_STATES.includes(row.state)) return row;
      }
    } finally {
      db.close();
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`run ${runId} not terminal within ${TERMINAL_POLL_TIMEOUT_MS}ms (last state: ${last})`);
}

describe("fade kill-drive acceptance gate (process level, two consecutive rounds)", () => {
  before(() => {
    // 环境前置（S4 同形双 probe）：checker 在位 + python 可用。
    const checker = join(resolveTmvRepoRoot(), "scripts", "node_report_check.py");
    assert.ok(existsSync(checker), `dev TriMetaverse checker missing: ${checker}`);
    const py = spawnSync("python", ["-c", "import sys; sys.exit(0)"], { timeout: 10_000 });
    assert.equal(py.status, 0, `python interpreter probe failed (status=${py.status})`);
    tmpDataDir = mkdtempSync(join(tmpdir(), "trimlc-fade-kd-data-"));
    tmpPidDir = mkdtempSync(join(tmpdir(), "trimlc-fade-kd-pid-"));
  });

  test("Round1: daemon-triggered full-auto run → APPROVED + gate RC=0", async () => {
    const treeDir = mkdtempSync(join(tmpdir(), "trimlc-fade-kd-tree-r1-"));
    const boot = spawnDaemon();
    const port = await waitReady(boot.child, boot.out);
    await waitHealthy(port);

    const { status, body } = await postTrigger(port, "fade-kd-r1", treeDir);
    assert.equal(status, 200, `trigger failed: ${JSON.stringify(body)}`);
    assert.equal(body.created, true, "Round1 run must be newly created");
    assert.equal(body.finalState, "APPROVED", `判据①: full-auto run must reach APPROVED (got ${body.finalState})`);
    assert.equal(body.gated, true);

    const gate = orchestrationGateRerun(join(treeDir, "reports"));
    assert.equal(gate.rc, 0, `判据③: orchestration gate rerun RC=${gate.rc}\n${gate.stdout.slice(-2000)}`);

    boot.child.kill();
    await waitExit(boot.child);
    rmSync(treeDir, { recursive: true, force: true });
  }, 180_000);

  test("Round2: random-segment kill → restart → resume → terminal APPROVED + gate RC=0", async () => {
    const treeDir = mkdtempSync(join(tmpdir(), "trimlc-fade-kd-tree-r2-"));
    mkdirSync(join(treeDir, "reports"), { recursive: true });
    const boot = spawnDaemon();
    const port = await waitReady(boot.child, boot.out);
    await waitHealthy(port);

    // fire the trigger and hard-kill the daemon at a RANDOM point in the
    // chain (300–900ms covers segment work through the in-flight gate)
    const drivePromise = postTrigger(port, "fade-kd-r2", treeDir).catch(() => null);
    const killDelayMs = 300 + Math.floor(Math.random() * 600);
    await new Promise((res) => setTimeout(res, killDelayMs));
    boot.child.kill();
    await waitExit(boot.child);
    await drivePromise; // observe (response may never arrive — that's the kill)

    // ── restart on the SAME dataDir: boot sweep + resume drives it home ──
    const boot2 = spawnDaemon();
    const port2 = await waitReady(boot2.child, boot2.out);
    await waitHealthy(port2);

    const row = await pollTerminal("fade-kd-r2");
    assert.equal(row.state, "APPROVED", `判据②: resumed run must reach APPROVED (kill at ~${killDelayMs}ms; got ${row.state})`);
    // checkpoint survived the kill (S2 恢复面·resume 消费面证据)
    assert.ok(row.checkpoint !== null && row.checkpoint.includes("treeDir"), "checkpoint with tree metadata must survive the kill/restart cycle");

    const gate = orchestrationGateRerun(join(treeDir, "reports"));
    assert.equal(gate.rc, 0, `判据③: orchestration gate rerun RC=${gate.rc}\n${gate.stdout.slice(-2000)}`);

    boot2.child.kill();
    await waitExit(boot2.child);
    rmSync(treeDir, { recursive: true, force: true });
  }, 180_000);

  after(async () => {
    for (const c of children) {
      try { if (c.exitCode === null) c.kill(); } catch { /* already dead */ }
    }
    await new Promise((res) => setTimeout(res, 400));
    for (const dir of [tmpDataDir, tmpPidDir]) {
      if (!dir) continue;
      try { rmSync(dir, { recursive: true, force: true }); } catch {
        await new Promise((res) => setTimeout(res, 600));
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
      }
    }
  });
});
