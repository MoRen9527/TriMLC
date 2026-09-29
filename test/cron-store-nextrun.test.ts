// F-3 regression: addJob must write next_run_at at INSERT time.
// Defect being pinned: API-inserted jobs previously got next_run_at = NULL and were
// permanently invisible to the timer (armTimer/onTimerTick/runMissedJobs all filter on
// nextRunAt truthiness) until a manual force-run wrote the value back via the post-run
// updateJobRun path (the 2026-09-29 23:23 "self-heal" mechanism).
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCronStore } from "../src/cron/store.js";

let tmpDir = "";
const openStores: { db: { close(): void } }[] = [];

describe("cron store addJob next_run_at (F-3)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-f3-"));
    openStores.length = 0;
  });

  after(() => {
    for (const s of openStores) {
      try { s.db.close(); } catch { /* already closed */ }
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
    }
  });

  test("every-job: INSERT writes a future ISO next_run_at", () => {
    const store = createCronStore(path.join(tmpDir, "cron.db"));
    openStores.push(store);
    const before = Date.now();
    const job = store.addJob({
      name: "f3-every",
      schedule: { kind: "every", everyMs: 300000 },
      systemPrompt: "",
      enabled: true,
    });
    assert.ok(job.nextRunAt, "nextRunAt must be set at insert time");
    const nextMs = Date.parse(job.nextRunAt);
    assert.ok(Number.isFinite(nextMs), `nextRunAt must be ISO date, got ${job.nextRunAt}`);
    assert.ok(nextMs >= before, "next run must not be in the past");
    // every-300s maps to a 5-minute croner step pattern → next fire within 5 min
    assert.ok(nextMs <= before + 300000 + 60_000, `next run too far out: ${job.nextRunAt}`);
  });

  test("cron-expr job: INSERT writes next_run_at", () => {
    const store = createCronStore(path.join(tmpDir, "cron.db"));
    openStores.push(store);
    const job = store.addJob({
      name: "f3-cron",
      schedule: { kind: "cron", expr: "0 12 * * *" },
      systemPrompt: "",
      enabled: true,
    });
    assert.ok(job.nextRunAt, "cron jobs must get a computed first trigger");
    assert.ok(Number.isFinite(Date.parse(job.nextRunAt)));
  });

  test("persisted row: a fresh store instance loads the job with nextRunAt", () => {
    const dbPath = path.join(tmpDir, "cron.db");
    const store1 = createCronStore(dbPath);
    openStores.push(store1);
    const job = store1.addJob({
      name: "f3-persist",
      schedule: { kind: "every", everyMs: 60000 },
      systemPrompt: "",
      enabled: true,
    });
    // second instance on the same file = the startup path a real daemon uses
    const store2 = createCronStore(dbPath);
    openStores.push(store2);
    const loaded = store2.getJob(job.id);
    assert.ok(loaded, "job must load in a fresh instance");
    assert.equal(loaded.nextRunAt, job.nextRunAt, "next_run_at column must round-trip");
  });

  test("unparseable schedule: fail-open to NULL, job still created (same as updateJob)", () => {
    const store = createCronStore(path.join(tmpDir, "cron.db"));
    openStores.push(store);
    const job = store.addJob({
      name: "f3-invalid",
      // minimum interval is 1s in parseCronSchedule → 500ms throws
      schedule: { kind: "every", everyMs: 500 },
      systemPrompt: "",
      enabled: true,
    });
    assert.ok(job.id, "job must still be created");
    assert.equal(job.nextRunAt, undefined, "unparseable schedule keeps next_run_at NULL");
  });
});
