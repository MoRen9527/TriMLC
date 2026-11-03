// FADE-011 Phase 2 S4 — closing-gate (编排层收口复跑门) tests:
//   real-run gate (live checker, PASS surface) / negative FAIL surface (RC≠0
//   refused flip + detail landed) / spawn-error + timeout fail-closed /
//   finalizeWithGate mechanical enforcement / resolver explicitness.
// Law: S4 brief (bf272815a §一/§二); spec §2.7 (exit≠0 不得翻转); R2.1 timeout.
import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  resolveTmvRepoRoot, resolvePythonExecutable, DEFAULT_PYTHON_EXECUTABLE,
  DEFAULT_GATE_TIMEOUT_MS, spawnWithTimeout, runClosingGate, finalizeWithGate,
} from "../src/fade/closing-gate.js";
import { createFadeStore, type FadeStore } from "../src/fade/store.js";

let tmpDir = "";
const SAVED_TMV_ROOT = process.env.TMV_REPO_ROOT;
const SAVED_FADE_PY = process.env.TRILC_FADE_PYTHON;

function writeReports(dir: string, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body, "utf-8");
  }
}

const PASS_REPORT = `# 节点收口报告 demo（合规九键面）

\`\`\`json
{
  "nodeId": "node-demo",
  "agent": "FSD",
  "startedAt": "2026-11-04T00:00:00Z",
  "finishedAt": "2026-11-04T00:01:00Z",
  "baselineCommit": "fixture",
  "trigger": "fixture",
  "actions": [{"t": "a", "act": "demo"}],
  "artifacts": [{"path": "x", "note": "y"}],
  "gateResults": [{"gate": "g", "result": "PASS"}]
}
\`\`\`

## 异常与处置
无。

## 断点交接
无。

## 使用依据
fixture。
`;

// Missing seven of the nine core keys → checker RC=1 → refused flip.
const FAIL_REPORT = `# 节点收口报告（缺键件）

\`\`\`json
{
  "nodeId": "node-broken",
  "agent": "FSD"
}
\`\`\`

## 异常与处置
无。

## 断点交接
无。

## 使用依据
fixture。
`;

function seedRunThroughFinalizing(store: FadeStore, runId: string): void {
  store.createRun({
    runId,
    idempotencyKey: `key-${runId}`,
    profile: "runtime-owned-durable",
    homeDomain: "test",
    writeAuthority: "test",
    authorityEpoch: 1,
    version: "v1.0",
  });
  const chain = ["QUALIFYING", "PLANNING", "PLANNED", "EXECUTING", "VERIFYING", "SCORING", "CLOSING", "FINALIZING"];
  for (const state of chain) store.advanceRun(runId, state);
}

describe("closing-gate resolvers (explicitness)", () => {
  test("resolveTmvRepoRoot: override wins and is trimmed", () => {
    assert.equal(resolveTmvRepoRoot("  /tmp/tmv  "), resolve("/tmp/tmv"));
  });

  test("resolveTmvRepoRoot: env override wins over dev default", () => {
    process.env.TMV_REPO_ROOT = "/tmp/from-env";
    try {
      assert.equal(resolveTmvRepoRoot(), resolve("/tmp/from-env"));
    } finally {
      if (SAVED_TMV_ROOT === undefined) delete process.env.TMV_REPO_ROOT;
      else process.env.TMV_REPO_ROOT = SAVED_TMV_ROOT;
    }
  });

  test("resolvePythonExecutable: explicit default, env wins, override wins", () => {
    assert.equal(resolvePythonExecutable(), DEFAULT_PYTHON_EXECUTABLE);
    process.env.TRILC_FADE_PYTHON = "py-313";
    try {
      assert.equal(resolvePythonExecutable(), "py-313");
      assert.equal(resolvePythonExecutable("explicit-python"), "explicit-python");
    } finally {
      if (SAVED_FADE_PY === undefined) delete process.env.TRILC_FADE_PYTHON;
      else process.env.TRILC_FADE_PYTHON = SAVED_FADE_PY;
    }
  });

  test("dev default resolves at the TriMetaverse repo root (live checker present)", () => {
    const root = resolveTmvRepoRoot("");
    assert.ok(
      existsSync(join(root, "scripts", "node_report_check.py")),
      `live checker not found under dev default root: ${root}`,
    );
  });
});

describe("spawnWithTimeout (R2.1)", () => {
  test("timeout kills a wedged child → timedOut=true (fail-closed input)", async () => {
    const py = resolvePythonExecutable();
    const probed = await spawnWithTimeout(py, ["-c", "import sys; sys.exit(0)"], 15_000);
    if (probed.error || probed.code !== 0) {
      console.log(`skip: python not usable for timeout probe (${probed.error?.message ?? `code=${probed.code}`})`);
      return;
    }
    const slow = await spawnWithTimeout(py, ["-c", "import time; time.sleep(5)"], 500);
    assert.equal(slow.timedOut, true);
    assert.ok(slow.code !== 0 || slow.signal !== null, "wedged child must be killed");
  });

  test("spawn error surfaces (ENOENT family) instead of hanging", async () => {
    const dead = await spawnWithTimeout("definitely-not-a-real-exe-fsd-s4", ["--version"], 5000);
    assert.ok(dead.error, "nonexistent executable must surface an error");
  });
});

describe("runClosingGate (live checker wiring)", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trilc-fade-s4-"));
  });

  test("real-run gate: PASS surface → ok=true (RC=0 放行)", async () => {
    const reports = join(tmpDir, "reports");
    writeReports(reports, { "node-ok.md": PASS_REPORT });
    const r = await runClosingGate({ reportsDir: reports });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (r.ok) assert.match(r.output, /PASS/);
  });

  test("negative: FAIL surface (missing keys) → checker-fail + detail (RC≠0)", async () => {
    const reports = join(tmpDir, "reports");
    writeReports(reports, { "node-broken.md": FAIL_REPORT });
    const r = await runClosingGate({ reportsDir: reports });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "checker-fail");
      assert.equal(r.exitCode, 1);
      assert.match(r.output, /missing key|FAIL/);
    }
  });

  test("negative: checker script missing → spawn-error (fail-closed)", async () => {
    const r = await runClosingGate({
      reportsDir: join(tmpDir, "reports"),
      tmvRepoRoot: join(tmpDir, "empty-root"),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "spawn-error");
      assert.match(r.error!, /checker script not found/);
    }
  });

  test("negative: broken interpreter → spawn-error (fail-closed, explicit resolution)", async () => {
    const reports = join(tmpDir, "reports");
    writeReports(reports, { "node-ok.md": PASS_REPORT });
    const r = await runClosingGate({ reportsDir: reports, pythonExecutable: "definitely-not-a-real-exe-fsd-s4" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "spawn-error");
  });

  test("live rehearsal smoke: real S3 tree reports/ passes (skip when TMV absent)", async () => {
    const repoRoot = resolveTmvRepoRoot();
    const liveReports = join(repoRoot, "docs", "workflow", "operating-records", "2026-W45", "trees", "fade011-s3-skill-loading", "reports");
    if (!existsSync(join(repoRoot, "scripts", "node_report_check.py"))) {
      console.log("skip: TriMetaverse repo not present");
      return;
    }
    const r = await runClosingGate({ reportsDir: liveReports });
    assert.equal(r.ok, true, JSON.stringify(r));
  });
});

describe("finalizeWithGate (§2.7 mechanical enforcement)", () => {
  let store: FadeStore;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trilc-fade-s4-fin-"));
    dbPath = join(tmpDir, "fade.db");
    store = createFadeStore(dbPath);
  });

  test("gate PASS → flip lands (FINALIZING → APPROVED, actor=finalize)", async () => {
    const runId = "s4-run-pass";
    seedRunThroughFinalizing(store, runId);
    const reports = join(tmpDir, "reports");
    writeReports(reports, { "node-ok.md": PASS_REPORT });
    const r = await finalizeWithGate(store, runId, "APPROVED", { reportsDir: reports });
    assert.equal(r.gated, true, JSON.stringify(r));
    if (r.gated) {
      assert.equal(r.run.state, "APPROVED");
      const audit = store.listTransitions(runId);
      const last = audit[audit.length - 1]!;
      assert.equal(last.toState, "APPROVED");
      assert.equal(last.actor, "finalize");
    }
    assert.equal(store.listGateRejections(runId).length, 0);
  });

  test("gate FAIL → REFUSED flip: state unchanged, zero new audit rows, detail landed", async () => {
    const runId = "s4-run-fail";
    seedRunThroughFinalizing(store, runId);
    const auditBefore = store.listTransitions(runId).length;
    const reports = join(tmpDir, "reports");
    writeReports(reports, { "node-broken.md": FAIL_REPORT });
    const r = await finalizeWithGate(store, runId, "APPROVED", { reportsDir: reports });
    assert.equal(r.gated, false, "RC≠0 must refuse the flip");
    if (!r.gated) {
      assert.equal(r.reason, "checker-fail");
      assert.match(r.detail, /missing key|FAIL/);
    }
    assert.equal(store.getRun(runId)!.state, "FINALIZING", "state must be unchanged");
    assert.equal(store.listTransitions(runId).length, auditBefore, "no audit row on refused flip");
    const rejections = store.listGateRejections(runId);
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0]!.gate, "closing-report-check");
    assert.equal(rejections[0]!.reason, "checker-fail");
    assert.match(rejections[0]!.detail!, /missing key|FAIL/);
  });

  test("spawn failure → fail-closed refusal + rejection landed (spawn-error)", async () => {
    const runId = "s4-run-spawn";
    seedRunThroughFinalizing(store, runId);
    const r = await finalizeWithGate(store, runId, "APPROVED", {
      reportsDir: join(tmpDir, "reports"),
      pythonExecutable: "definitely-not-a-real-exe-fsd-s4",
    });
    assert.equal(r.gated, false);
    if (!r.gated) assert.equal(r.reason, "spawn-error");
    assert.equal(store.getRun(runId)!.state, "FINALIZING");
    assert.equal(store.listGateRejections(runId).length, 1);
    assert.equal(store.listGateRejections(runId)[0]!.reason, "spawn-error");
  });

  test("non-terminal target rejected pre-gate (INVALID_STATE)", async () => {
    const runId = "s4-run-nonterm";
    seedRunThroughFinalizing(store, runId);
    await assert.rejects(
      () => finalizeWithGate(store, runId, "CLOSING", { reportsDir: join(tmpDir, "reports") }),
      (err: unknown) => err instanceof Error && /closing gate only guards terminal flips/.test(err.message),
    );
  });

  test("unknown run rejected (RUN_NOT_FOUND)", async () => {
    await assert.rejects(
      () => finalizeWithGate(store, "s4-ghost", "APPROVED", { reportsDir: join(tmpDir, "reports") }),
      (err: unknown) => err instanceof Error && /run not found/.test(err.message),
    );
  });

  after(() => {
    try { store.close(); } catch { /* best-effort */ }
  });
});

after(() => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
  }
});
