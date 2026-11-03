// FADE-011 Phase 2 S1 — fade store persistence tests (independent keyspace).
// Gate (plan §四): schema freeze + law-checked transitions, atomic audit trail,
// idempotent registration (§8.1 L431), unique-writer keys (§8.5 L494),
// persistence across reopen (S2 recovery sweep prerequisite).
import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFadeStore, type FadeStore } from "../src/fade/store.js";
import { FadeTransitionError, type FadeRunInput } from "../src/fade/types.js";

const CHAIN_STEPS = ["QUALIFYING", "PLANNING", "PLANNED", "EXECUTING", "VERIFYING", "SCORING", "CLOSING", "FINALIZING"] as const;

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
    runId: `fade-test-${runSeq}`,
    idempotencyKey: `idem-${runSeq}`,
    profile: "runtime-owned-durable",
    homeDomain: "M-plane-local",
    writeAuthority: "daemon:trmlc",
    authorityEpoch: 1,
    version: "fade011-s1-test",
    ...overrides,
  };
}

function driveTo(store: FadeStore, runId: string, target: string): void {
  // Walk the single-step chain up to FINALIZING, then enter the terminal if asked.
  for (const step of CHAIN_STEPS) {
    store.advanceRun(runId, step);
    if (step === target) return;
  }
  if (target === "APPROVED" || target === "FROZEN" || target === "ESCALATED" || target === "RETRY") {
    store.advanceRun(runId, target, { actor: "finalize" });
    return;
  }
  assert.fail(`driveTo: cannot reach ${target}`);
}

describe("fade store — registration", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-fade-s1-"));
    openStores.length = 0;
  });

  test("registers at DETECTED with a NULL-from audit row (§8.1 L431)", () => {
    const store = openStore();
    const { created, run } = store.createRun(makeInput());
    assert.equal(created, true);
    assert.equal(run.state, "DETECTED");
    const audit = store.listTransitions(run.runId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.fromState, null);
    assert.equal(audit[0]!.toState, "DETECTED");
    assert.equal(audit[0]!.actor, "register");
  });

  test("same idempotency key dedupes to the existing run (§8.1 L431)", () => {
    const store = openStore();
    const input = makeInput();
    const first = store.createRun(input);
    const second = store.createRun({ ...input, runId: "fade-test-different-id" });
    assert.equal(second.created, false);
    assert.equal(second.run.runId, first.run.runId, "dedupe must anchor the original run identity");
    assert.equal(store.listRuns().length, 1);
  });

  test("unique-writer four keys persist verbatim (§8.5 L494)", () => {
    const store = openStore();
    const input = makeInput({
      homeDomain: "M-plane-local",
      writeAuthority: "daemon:trmlc",
      authorityEpoch: 7,
      version: "fade011-s1",
      sourceRevision: "abc1234",
    });
    const { run } = store.createRun(input);
    const loaded = store.getRun(run.runId)!;
    assert.equal(loaded.homeDomain, "M-plane-local");
    assert.equal(loaded.writeAuthority, "daemon:trmlc");
    assert.equal(loaded.authorityEpoch, 7);
    assert.equal(loaded.version, "fade011-s1");
    assert.equal(loaded.sourceRevision, "abc1234");
    assert.equal(loaded.retryBudget, 3, "default retry budget");
  });

  test("default budget 3; custom budget persists", () => {
    const store = openStore();
    const custom = store.createRun(makeInput({ retryBudget: 1 }));
    assert.equal(custom.run.retryBudget, 1);
  });
});

describe("fade store — transitions and audit", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-fade-s1-"));
    openStores.length = 0;
  });

  test("full chain to APPROVED leaves a complete chained audit trail", () => {
    const store = openStore();
    const { run } = store.createRun(makeInput());
    driveTo(store, run.runId, "APPROVED");
    assert.equal(store.getRun(run.runId)!.state, "APPROVED");
    const audit = store.listTransitions(run.runId);
    // register + 8 chain steps + FINALIZING->APPROVED
    assert.equal(audit.length, 10);
    assert.equal(audit[0]!.actor, "register");
    for (let i = 1; i < audit.length; i++) {
      assert.equal(audit[i]!.fromState, audit[i - 1]!.toState, `audit chain break at seq ${i}`);
    }
    assert.equal(audit[audit.length - 1]!.toState, "APPROVED");
    assert.equal(audit[audit.length - 1]!.actor, "finalize");
  });

  test("illegal advance throws and leaves run state + audit untouched", () => {
    const store = openStore();
    const { run } = store.createRun(makeInput());
    driveTo(store, run.runId, "PLANNED");
    const auditBefore = store.listTransitions(run.runId).length;
    // QUALIFYING from PLANNED is a backward unauthorized rollback
    assert.throws(() => store.advanceRun(run.runId, "QUALIFYING"), FadeTransitionError);
    assert.equal(store.getRun(run.runId)!.state, "PLANNED", "state must not move on rejection");
    assert.equal(store.listTransitions(run.runId).length, auditBefore, "audit must not grow on rejection");
  });

  test("verify skip EXECUTING -> SCORING advances via the sanctioned edge (§8.1 L435)", () => {
    const store = openStore();
    const { run } = store.createRun(makeInput());
    driveTo(store, run.runId, "EXECUTING");
    const after = store.advanceRun(run.runId, "SCORING");
    assert.equal(after.state, "SCORING");
  });

  test("terminal re-entry via store throws TERMINAL_REENTRY, state unchanged", () => {
    const store = openStore();
    const { run } = store.createRun(makeInput());
    driveTo(store, run.runId, "APPROVED");
    assert.throws(() => store.advanceRun(run.runId, "FINALIZING"), FadeTransitionError);
    assert.equal(store.getRun(run.runId)!.state, "APPROVED");
  });

  test("recoverRun rolls a non-terminal run back to CLOSING with recovery actor (§8.1 L445)", () => {
    const store = openStore();
    const { run } = store.createRun(makeInput());
    driveTo(store, run.runId, "EXECUTING");
    const recovered = store.recoverRun(run.runId);
    assert.equal(recovered.state, "CLOSING");
    const audit = store.listTransitions(run.runId);
    const last = audit[audit.length - 1]!;
    assert.equal(last.actor, "recovery");
    assert.equal(last.fromState, "EXECUTING");
    assert.equal(last.toState, "CLOSING");
  });

  test("RUN_NOT_FOUND on unknown run id", () => {
    const store = openStore();
    assert.throws(() => store.advanceRun("fade-missing", "QUALIFYING"), FadeTransitionError);
  });

  test("checkpoint set / read / clear (§8.3 L481)", () => {
    const store = openStore();
    const { run } = store.createRun(makeInput());
    const withCp = store.setCheckpoint(run.runId, JSON.stringify({ segment: "EXECUTING", note: "mid-dce" }));
    assert.equal(withCp.checkpoint, JSON.stringify({ segment: "EXECUTING", note: "mid-dce" }));
    const cleared = store.setCheckpoint(run.runId, null);
    assert.equal(cleared.checkpoint, null);
  });
});

describe("fade store — retry budget (§8.3 L481)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-fade-s1-"));
    openStores.length = 0;
  });

  test("entering RETRY past an exhausted budget is rejected with state intact", () => {
    const store = openStore();
    const { run } = store.createRun(makeInput({ retryBudget: 0 }));
    driveTo(store, run.runId, "FINALIZING");
    assert.throws(
      () => store.advanceRun(run.runId, "RETRY", { actor: "finalize" }),
      (err: unknown) => err instanceof FadeTransitionError && err.code === "BUDGET_EXHAUSTED",
    );
    assert.equal(store.getRun(run.runId)!.state, "FINALIZING", "budget rejection must not move state");
  });

  test("entering RETRY within budget consumes one unit", () => {
    const store = openStore();
    const { run } = store.createRun(makeInput({ retryBudget: 1 }));
    driveTo(store, run.runId, "FINALIZING");
    const retried = store.advanceRun(run.runId, "RETRY", { actor: "finalize" });
    assert.equal(retried.state, "RETRY");
    assert.equal(retried.retryCount, 1);
    assert.equal(store.getRun(run.runId)!.retryCount, 1);
  });
});

describe("fade store — sweep and persistence (S2 recovery prerequisites)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-fade-s1-"));
    openStores.length = 0;
  });

  test("listUnfinishedRuns sweeps only non-terminal runs", () => {
    const store = openStore();
    const mid = store.createRun(makeInput()).run;
    driveTo(store, mid.runId, "EXECUTING");
    const done = store.createRun(makeInput()).run;
    driveTo(store, done.runId, "APPROVED");
    const unfinished = store.listUnfinishedRuns().map((r) => r.runId);
    assert.ok(unfinished.includes(mid.runId), "mid-chain run must be swept");
    assert.ok(!unfinished.includes(done.runId), "APPROVED run must not be swept");
  });

  test("persistence survives close + reopen on the same db path", () => {
    const dbPath = path.join(tmpDir, "fade.db");
    const store = createFadeStore(dbPath);
    const { run } = store.createRun(makeInput());
    driveTo(store, run.runId, "EXECUTING");
    store.setCheckpoint(run.runId, '{"segment":"EXECUTING"}');
    store.close();

    const reopened = createFadeStore(dbPath);
    openStores.push(reopened);
    const loaded = reopened.getRun(run.runId);
    assert.ok(loaded, "run must survive reopen");
    assert.equal(loaded!.state, "EXECUTING");
    assert.equal(loaded!.checkpoint, '{"segment":"EXECUTING"}');
    assert.equal(loaded!.homeDomain, "M-plane-local");
    assert.equal(reopened.listUnfinishedRuns().map((r) => r.runId).includes(run.runId), true);
    assert.equal(reopened.listTransitions(run.runId).length, 5, "audit trail survives reopen");
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
