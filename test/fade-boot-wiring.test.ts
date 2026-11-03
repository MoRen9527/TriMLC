// FADE-011 Phase 2 S2 — in-process wiring test: daemon boot executes the
// recovery sweep; getters expose report + store; stop() closes and nulls.
// Pattern mirror: test/server/config-endpoints.test.ts (env save/override,
// dynamic readEnv import after overrides, port=0 with real port written back).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTriLCApp } from "../src/server/app.js";
import { stopKeyCache } from "../src/config/key-cache.js";
import { createFadeStore } from "../src/fade/store.js";

const SAVED_ENV: Record<string, string | undefined> = {};

let tmpDataDir = "";
let app: ReturnType<typeof createTriLCApp> | null = null;
let appPort = 0;
let seededA = "";
let seededB = "";

function driveTo(
  store: ReturnType<typeof createFadeStore>,
  runId: string,
  target: "QUALIFYING" | "PLANNING" | "PLANNED" | "EXECUTING",
): void {
  const chain = ["QUALIFYING", "PLANNING", "PLANNED", "EXECUTING"] as const;
  for (const step of chain) {
    store.advanceRun(runId, step);
    if (step === target) return;
  }
}

describe("fade boot wiring (in-process app)", () => {
  before(async () => {
    for (const k of [
      "TRILC_DATA_DIR", "TRILC_WEEKLY_PLANE_ROOT", "TRILC_PORT", "TRILC_PROJECT_ROOT",
      "TRIMODEL_API_TOKEN", "TRILC_TRIMODEL_API_URL", "TRILC_INTERNAL_TOKEN",
      "TRIMODEL_KEY_STORAGE_MODE", "TRIMODEL_ADMIN_TOKEN", "TRIMODEL_FACE_ID",
    ]) {
      SAVED_ENV[k] = process.env[k];
    }

    tmpDataDir = mkdtempSync(join(tmpdir(), "trimlc-fade-wiring-"));
    process.env.TRILC_DATA_DIR = tmpDataDir;
    process.env.TRILC_PROJECT_ROOT = tmpDataDir;
    delete process.env.TRILC_WEEKLY_PLANE_ROOT;
    process.env.TRILC_PORT = "0";
    process.env.TRIMODEL_KEY_STORAGE_MODE = "s3"; // 明文沙箱模式
    delete process.env.TRIMODEL_ADMIN_TOKEN;
    delete process.env.TRIMODEL_API_TOKEN;
    delete process.env.TRIMODEL_FACE_ID;
    process.env.TRILC_TRIMODEL_API_URL = "http://127.0.0.1:9"; // closed port: sync attempts fail soft
    process.env.TRILC_INTERNAL_TOKEN = "fade-wiring-token";

    // Pre-seed the independent keyspace BEFORE the daemon boots:
    //  A = PLANNED (idempotent segment) + checkpoint  -> must resume in place
    //  B = EXECUTING (non-idempotent) + checkpoint    -> must roll back to CLOSING
    const seed = createFadeStore(join(tmpDataDir, "fade.db"));
    seededA = seed.createRun({
      runId: "fade-wiring-A", idempotencyKey: "idem-wiring-A",
      profile: "runtime-owned-durable", homeDomain: "M-plane-local",
      writeAuthority: "daemon:trmlc", authorityEpoch: 1, version: "fade011-s2-wiring",
    }).run.runId;
    driveTo(seed, seededA, "PLANNED");
    seed.setCheckpoint(seededA, '{"segment":"PLANNED","cursor":7}');
    seededB = seed.createRun({
      runId: "fade-wiring-B", idempotencyKey: "idem-wiring-B",
      profile: "runtime-owned-durable", homeDomain: "M-plane-local",
      writeAuthority: "daemon:trmlc", authorityEpoch: 1, version: "fade011-s2-wiring",
    }).run.runId;
    driveTo(seed, seededB, "EXECUTING");
    seed.setCheckpoint(seededB, '{"segment":"EXECUTING","op":2}');
    seed.close();

    const { readEnv } = await import("../src/config/env.js");
    const env = readEnv();
    env.port = 0;
    app = createTriLCApp(env);
    await app.start();
    appPort = env.port;
    assert.ok(appPort > 0, "app did not bind a port");
  });

  test("boot executed the recovery sweep and exposes it via getters", () => {
    assert.ok(app, "app not started");
    const report = app.fadeBootRecovery;
    assert.ok(report, "fadeBootRecovery getter must surface the boot report");
    assert.equal(report.swept, 2);
    assert.equal(report.rolledBack.length, 1);
    assert.equal(report.resumed.length, 1);
    const resume = report.resumed[0]!;
    assert.equal(resume.runId, seededA);
    assert.equal(resume.fromState, "PLANNED");
    assert.equal(resume.checkpoint, '{"segment":"PLANNED","cursor":7}');
    const rollback = report.rolledBack[0]!;
    assert.equal(rollback.runId, seededB);
    assert.equal(rollback.fromState, "EXECUTING");
  });

  test("persisted effects: PLANNED untouched with checkpoint; EXECUTING now CLOSING with recovery audit", () => {
    assert.ok(app, "app not started");
    // Read through the app-exposed store handle (same db the boot chain used).
    const store = app.fadeStore;
    assert.ok(store, "fadeStore getter must expose the boot-opened handle");
    const a = store.getRun(seededA)!;
    assert.equal(a.state, "PLANNED");
    assert.equal(a.checkpoint, '{"segment":"PLANNED","cursor":7}');
    const b = store.getRun(seededB)!;
    assert.equal(b.state, "CLOSING");
    const audit = store.listTransitions(seededB);
    const last = audit[audit.length - 1]!;
    assert.equal(last.fromState, "EXECUTING");
    assert.equal(last.toState, "CLOSING");
    assert.equal(last.actor, "recovery");
  });

  test("stop() closes the fade store and nulls the boot handle", async () => {
    assert.ok(app, "app not started");
    await app.stop();
    assert.equal(app.fadeBootRecovery, null);
    assert.equal(app.fadeStore, null);
    app = null;
  });

  after(async () => {
    for (const [k, v] of Object.entries(SAVED_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (app) { try { await app.stop(); } catch { /* swallow */ } app = null; }
    try { stopKeyCache(); } catch { /* swallow */ }
    if (tmpDataDir) {
      try { rmSync(tmpDataDir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
    }
  });
});
