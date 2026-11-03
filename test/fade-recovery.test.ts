// FADE-011 Phase 2 S2 — boot recovery chain unit tests.
// Law: spec §8.1 ratified recovery policy (be0fe20) — idempotent segments
// resume in place; EXECUTING rolls back to CLOSING (§8.1 L445).
import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBootRecovery, openFadeStoreAndRecover, summarizeBootRecovery } from "../src/fade/recovery.js";
import { createFadeStore, type FadeStore } from "../src/fade/store.js";
import { FadeTransitionError, type FadeRunInput } from "../src/fade/types.js";

let tmpDir = "";
const openStores: FadeStore[] = [];
let runSeq = 0;

function openStore(): FadeStore {
  const store = createFadeStore(path.join(tmpDir, "fade.db"));
  openStores.push(store);
  return store;
}

function makeInput(overrides: Partial<FadeRunInput> = {}): FadeRunInput {
  runSeq += 1;
  return {
    runId: `fade-rec-${runSeq}`,
    idempotencyKey: `idem-${runSeq}`,
    profile: "runtime-owned-durable",
    homeDomain: "M-plane-local",
    writeAuthority: "daemon:trmlc",
    authorityEpoch: 1,
    version: "fade011-s2-test",
    ...overrides,
  };
}

function driveTo(store: FadeStore, runId: string, target: string): void {
  for (const step of ["QUALIFYING", "PLANNING", "PLANNED", "EXECUTING", "VERIFYING", "SCORING", "CLOSING", "FINALIZING"] as const) {
    store.advanceRun(runId, step);
    if (step === target) return;
  }
  assert.fail(`driveTo: cannot reach ${target}`);
}

describe("fade boot recovery — sweep semantics (spec §8.1 ratified)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-fade-s2-"));
    openStores.length = 0;
  });

  test("empty store sweeps zero", () => {
    const store = openStore();
    const report = runBootRecovery(store);
    assert.equal(report.swept, 0);
    assert.equal(report.resumed.length, 0);
    assert.equal(report.rolledBack.length, 0);
    assert.equal(report.failed.length, 0);
  });

  test("idempotent-segment runs resume in place: no state change, no audit row, checkpoint surfaced", () => {
    const store = openStore();
    const planned = store.createRun(makeInput()).run;
    driveTo(store, planned.runId, "PLANNED");
    store.setCheckpoint(planned.runId, '{"segment":"PLANNED","cursor":12}');
    const detected = store.createRun(makeInput()).run;
    const auditBefore = store.listTransitions(planned.runId).length;

    const report = runBootRecovery(store);
    assert.equal(report.swept, 2);
    assert.equal(report.rolledBack.length, 0);
    assert.equal(report.failed.length, 0);
    assert.equal(report.resumed.length, 2);
    const plannedEntry = report.resumed.find((e) => e.runId === planned.runId)!;
    assert.equal(plannedEntry.action, "resume");
    assert.equal(plannedEntry.fromState, "PLANNED");
    // checkpoint round-trip through the recovery path (brief §一.3)
    assert.equal(plannedEntry.checkpoint, '{"segment":"PLANNED","cursor":12}');
    // resume must not mutate state or append audit rows
    assert.equal(store.getRun(planned.runId)!.state, "PLANNED");
    assert.equal(store.getRun(planned.runId)!.checkpoint, '{"segment":"PLANNED","cursor":12}');
    assert.equal(store.listTransitions(planned.runId).length, auditBefore);
    assert.equal(store.getRun(detected.runId)!.state, "DETECTED");
  });

  test("EXECUTING run rolls back to CLOSING with recovery audit row (§8.1 L445)", () => {
    const store = openStore();
    const run = store.createRun(makeInput()).run;
    driveTo(store, run.runId, "EXECUTING");
    store.setCheckpoint(run.runId, '{"segment":"EXECUTING","op":4}');

    const logs: string[] = [];
    const report = runBootRecovery(store, { log: (m) => logs.push(m) });
    assert.equal(report.swept, 1);
    assert.equal(report.resumed.length, 0);
    assert.equal(report.rolledBack.length, 1);
    const entry = report.rolledBack[0]!;
    assert.equal(entry.runId, run.runId);
    assert.equal(entry.fromState, "EXECUTING");
    assert.equal(entry.checkpoint, '{"segment":"EXECUTING","op":4}');
    assert.equal(store.getRun(run.runId)!.state, "CLOSING");
    const audit = store.listTransitions(run.runId);
    const last = audit[audit.length - 1]!;
    assert.equal(last.fromState, "EXECUTING");
    assert.equal(last.toState, "CLOSING");
    assert.equal(last.actor, "recovery");
    assert.ok(logs.some((m) => m.includes("EXECUTING -> CLOSING")), "rollback must be logged");
  });

  test("mixed sweep: rollback for EXECUTING, resume for the rest (single pass)", () => {
    const store = openStore();
    const a = store.createRun(makeInput()).run;
    driveTo(store, a.runId, "PLANNING");
    const b = store.createRun(makeInput()).run;
    driveTo(store, b.runId, "EXECUTING");
    const c = store.createRun(makeInput()).run;
    driveTo(store, c.runId, "SCORING");

    const report = runBootRecovery(store);
    assert.equal(report.swept, 3);
    assert.equal(report.rolledBack.length, 1);
    assert.equal(report.resumed.length, 2);
    assert.equal(store.getRun(a.runId)!.state, "PLANNING");
    assert.equal(store.getRun(b.runId)!.state, "CLOSING");
    assert.equal(store.getRun(c.runId)!.state, "SCORING");
  });

  test("sweep re-entry safety: second boot adds no duplicate rollback rows", () => {
    const store = openStore();
    const run = store.createRun(makeInput()).run;
    driveTo(store, run.runId, "EXECUTING");
    runBootRecovery(store);
    const auditAfterFirst = store.listTransitions(run.runId).filter((t) => t.actor === "recovery").length;
    const report2 = runBootRecovery(store);
    assert.equal(report2.rolledBack.length, 0, "CLOSING is idempotent-resume on re-sweep");
    assert.equal(report2.resumed.length, 1);
    const auditAfterSecond = store.listTransitions(run.runId).filter((t) => t.actor === "recovery").length;
    assert.equal(auditAfterSecond, auditAfterFirst);
  });

  test("per-run rollback failure is captured, sweep continues (fail-soft, never silent)", () => {
    const store = openStore();
    const ok = store.createRun(makeInput()).run;
    driveTo(store, ok.runId, "PLANNED");
    const broken = store.createRun(makeInput()).run;
    driveTo(store, broken.runId, "EXECUTING");
    // Stub out recoverRun to force a rollback failure for the EXECUTING run.
    const failingStore: FadeStore = Object.create(store);
    failingStore.recoverRun = () => {
      throw new FadeTransitionError("ILLEGAL_TRANSITION", "stubbed failure");
    };

    const report = runBootRecovery(failingStore);
    assert.equal(report.swept, 2);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]!.runId, broken.runId);
    assert.ok(report.failed[0]!.error!.includes("stubbed failure"));
    assert.equal(report.resumed.length, 1);
    assert.equal(report.resumed[0]!.runId, ok.runId);
  });
});

describe("fade boot recovery — open + sweep convenience", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-fade-s2-"));
    openStores.length = 0;
  });

  test("openFadeStoreAndRecover opens the dataDir keyspace and reports", () => {
    const { store, report } = openFadeStoreAndRecover(tmpDir);
    openStores.push(store);
    const run = store.createRun(makeInput()).run;
    driveTo(store, run.runId, "EXECUTING");
    const second = openFadeStoreAndRecover(tmpDir);
    openStores.push(second.store);
    assert.equal(second.report.swept, 1);
    assert.equal(second.report.rolledBack.length, 1);
    assert.equal(second.store.getRun(run.runId)!.state, "CLOSING");
  });

  test("summarizeBootRecovery: empty sweep -> empty string; counts reflected", () => {
    assert.equal(summarizeBootRecovery({ swept: 0, resumed: [], rolledBack: [], failed: [] }), "");
    const s = summarizeBootRecovery({
      swept: 5,
      resumed: [{ runId: "a", action: "resume", fromState: "PLANNED", checkpoint: null }],
      rolledBack: [
        { runId: "b", action: "rollback-closing", fromState: "EXECUTING", checkpoint: null },
        { runId: "c", action: "rollback-closing", fromState: "EXECUTING", checkpoint: null },
      ],
      failed: [{ runId: "d", action: "rollback-closing", fromState: "EXECUTING", checkpoint: null, error: "x" }],
    });
    assert.ok(s.includes("swept=5") && s.includes("resumed=1") && s.includes("rolledBack=2") && s.includes("failed=1"));
  });
});

after(() => {
  for (const s of openStores) {
    try { s.close(); } catch { /* already closed */ }
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
  }
});
