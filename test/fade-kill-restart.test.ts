// FADE-011 Phase 2 S2 — process-level kill/restart gate (dispatch brief §二).
// 实锚①: seeded idempotent-segment run (PLANNED) survives kill/restart in
//         place — state unchanged, checkpoint intact (§8.1 ratified resume).
// 实锚②: seeded EXECUTING run rolls back to CLOSING with a recovery-actor
//         audit row after restart (§8.1 L445); second boot re-entry adds no
//         duplicate rollback rows.
// Form: fully independent test instance — own DATA_DIR, own PID dir, port 0
// (OS-assigned; real port read back from the ready line), zero touch on the
// live 8713 daemon. Kill = child.kill() → Windows TerminateProcess (hard kill,
// SIGTERM handlers do NOT run) = true mid-flight interruption semantics.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createFadeStore } from "../src/fade/store.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BOOT_TIMEOUT_MS = 60_000; // R2.1 explicit upper bound: tsx cold start + full boot chain
const HEALTH_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 15_000;

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
  e.TRILC_TRIMODEL_API_URL = "http://127.0.0.1:9"; // closed port → fail-soft sync attempts
  e.TRILC_INTERNAL_TOKEN = "fade-kill-test-token";
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

/** Parse `[trilc] ready — node=... port=<N> pid=<N>` with an explicit deadline. */
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

/** Poll /healthz (门前公开面, token-exempt) until 200, explicit deadline. */
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
      // Windows TerminateProcess reports signal='SIGTERM' with exitCode=null —
      // either marker means the process is gone.
      if (child.exitCode !== null || child.signalCode !== null) { res(); return; }
      if (Date.now() > deadline) { rej(new Error(`daemon did not exit within ${EXIT_TIMEOUT_MS}ms after kill`)); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}

interface ProbeRow { state: string; checkpoint: string | null }
interface ProbeAudit { fromState: string | null; toState: string; actor: string }

/** Fresh connection per probe phase (WAL: concurrent readers OK). Callers must close(). */
function probeDb(): {
  run: (id: string) => ProbeRow;
  audit: (id: string) => ProbeAudit[];
  close: () => void;
} {
  const db = new DatabaseSync(join(tmpDataDir, "fade.db"));
  const run = (id: string): ProbeRow => {
    const row = db.prepare("SELECT state, checkpoint FROM fade_runs WHERE run_id = ?").get(id) as
      | { state: string; checkpoint: string | null } | undefined;
    assert.ok(row, `run ${id} missing from fade.db`);
    return { state: row.state, checkpoint: row.checkpoint };
  };
  const audit = (id: string): ProbeAudit[] =>
    (db.prepare(
      "SELECT from_state, to_state, actor FROM fade_run_transitions WHERE run_id = ? ORDER BY seq",
    ).all(id) as unknown as Array<{ from_state: string | null; to_state: string; actor: string }>)
      .map((r) => ({ fromState: r.from_state, toState: r.to_state, actor: r.actor }));
  const close = (): void => { try { db.close(); } catch { /* already closed */ } };
  return { run, audit, close };
}

describe("fade kill/restart gate (process level, independent instance)", () => {
  test("kill + restart: PLANNED resumes in place; EXECUTING rolls back to CLOSING; re-entry safe", async () => {
    // ── pre-seed independent keyspace before ANY daemon boots ──
    tmpDataDir = mkdtempSync(join(tmpdir(), "trimlc-fade-kill-data-"));
    tmpPidDir = mkdtempSync(join(tmpdir(), "trimlc-fade-kill-pid-"));
    const seed = createFadeStore(join(tmpDataDir, "fade.db"));
    seed.createRun({
      runId: "fade-kill-A", idempotencyKey: "idem-kill-A",
      profile: "runtime-owned-durable", homeDomain: "M-plane-local",
      writeAuthority: "daemon:trmlc", authorityEpoch: 1, version: "fade011-s2-kill",
    });
    seed.advanceRun("fade-kill-A", "QUALIFYING");
    seed.advanceRun("fade-kill-A", "PLANNING");
    seed.advanceRun("fade-kill-A", "PLANNED");
    seed.setCheckpoint("fade-kill-A", '{"segment":"PLANNED","cursor":42}');
    seed.createRun({
      runId: "fade-kill-B", idempotencyKey: "idem-kill-B",
      profile: "runtime-owned-durable", homeDomain: "M-plane-local",
      writeAuthority: "daemon:trmlc", authorityEpoch: 1, version: "fade011-s2-kill",
    });
    seed.advanceRun("fade-kill-B", "QUALIFYING");
    seed.advanceRun("fade-kill-B", "PLANNING");
    seed.advanceRun("fade-kill-B", "PLANNED");
    seed.advanceRun("fade-kill-B", "EXECUTING");
    seed.setCheckpoint("fade-kill-B", '{"segment":"EXECUTING","op":9}');
    seed.close();

    // ── boot #1 ──
    const boot1 = spawnDaemon();
    const port1 = await waitReady(boot1.child, boot1.out);
    await waitHealthy(port1);
    const stdout1 = boot1.out();

    const db1 = probeDb();
    // 实锚② (rollback happened at boot): EXECUTING → CLOSING, recovery actor
    const b1 = db1.run("fade-kill-B");
    assert.equal(b1.state, "CLOSING", "seeded EXECUTING must be rolled back to CLOSING after boot");
    assert.equal(b1.checkpoint, '{"segment":"EXECUTING","op":9}', "checkpoint must survive rollback");
    const auditB1 = db1.audit("fade-kill-B");
    const last1 = auditB1[auditB1.length - 1]!;
    assert.equal(last1.fromState, "EXECUTING");
    assert.equal(last1.toState, "CLOSING");
    assert.equal(last1.actor, "recovery");
    // 实锚① (resume-in-place at boot): PLANNED untouched, checkpoint intact
    const a1 = db1.run("fade-kill-A");
    assert.equal(a1.state, "PLANNED");
    assert.equal(a1.checkpoint, '{"segment":"PLANNED","cursor":42}');
    db1.close();
    // boot log carries the summary line (never silent)
    assert.ok(
      stdout1.includes("fade boot recovery: swept=2") && stdout1.includes("rolledBack=1"),
      `boot summary line missing:\n${tail(stdout1)}`,
    );

    // ── hard kill (TerminateProcess — no graceful shutdown path runs) ──
    boot1.child.kill();
    await waitExit(boot1.child);

    // ── boot #2 on the SAME dataDir: re-entry safety ──
    const boot2 = spawnDaemon();
    const port2 = await waitReady(boot2.child, boot2.out);
    await waitHealthy(port2);
    const stdout2 = boot2.out();
    assert.notEqual(port2, port1, "second boot should bind its own OS-assigned port");

    const db2 = probeDb();
    // 实锚① reprise: PLANNED still untouched after a full kill/restart cycle
    const a2 = db2.run("fade-kill-A");
    assert.equal(a2.state, "PLANNED", "idempotent-segment run must survive kill/restart unchanged");
    assert.equal(a2.checkpoint, '{"segment":"PLANNED","cursor":42}', "checkpoint must survive kill/restart");
    // 实锚② reprise: CLOSING stays CLOSING — exactly ONE recovery rollback row, no duplicates
    const b2 = db2.run("fade-kill-B");
    assert.equal(b2.state, "CLOSING");
    const recoveryRows = db2.audit("fade-kill-B").filter((t) => t.actor === "recovery");
    assert.equal(recoveryRows.length, 1, "second boot sweep must NOT duplicate the rollback row");
    db2.close();
    // boot #2 log: swept=2 (both unfinished), both resumed in place
    assert.ok(
      stdout2.includes("fade boot recovery: swept=2") && stdout2.includes("resumed=2"),
      `second boot summary line missing:\n${tail(stdout2)}`,
    );

    boot2.child.kill();
    await waitExit(boot2.child);
  });
});

after(async () => {
  for (const c of children) {
    try { if (c.exitCode === null) c.kill(); } catch { /* already dead */ }
  }
  // Windows: file handles may linger briefly after TerminateProcess.
  await new Promise((res) => setTimeout(res, 400));
  for (const dir of [tmpDataDir, tmpPidDir]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); } catch {
      await new Promise((res) => setTimeout(res, 600));
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
    }
  }
});
