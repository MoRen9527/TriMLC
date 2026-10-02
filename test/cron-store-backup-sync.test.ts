// Maintenance ④ (2026-10-03): updateJobRun must keep the JSON backup in sync.
// Defect being pinned: updateJobRun was the only store mutation path (9 call sites
// in timer.ts = every pre/post-run write) that did NOT call saveCronStore(), leaving
// <dbPath>.json stale while SQLite held the truth. loadAll() reads SQLite so the
// scheduler was unaffected — the drift only hit backup/restore and any external
// .json reader (observers, recovery tooling).
import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCronStore } from "../src/cron/store.js";

let tmpDir = "";
const openStores: { db: { close(): void } }[] = [];

function readBackupJson(dbPath: string): Array<Record<string, unknown>> {
  const jsonPath = dbPath + ".json";
  assert.ok(fs.existsSync(jsonPath), "backup json must exist after mutations");
  return JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Array<Record<string, unknown>>;
}

describe("cron store updateJobRun backup sync (maint-④)", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-maint4-"));
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

  test("post-run write (lastRunAt/nextRunAt/state) is reflected in .json backup", () => {
    const dbPath = path.join(tmpDir, "cron.db");
    const store = createCronStore(dbPath);
    openStores.push(store);
    const job = store.addJob({
      name: "m4-backup",
      schedule: { kind: "every", everyMs: 60000 },
      systemPrompt: "",
      enabled: true,
    });

    const startedAt = new Date().toISOString();
    const nextAt = new Date(Date.now() + 60_000).toISOString();
    store.updateJobRun(job.id, {
      lastRunAt: startedAt,
      lastRunStatus: "ok",
      nextRunAt: nextAt,
      state: "idle",
      incrementRun: true,
    });

    const rows = readBackupJson(dbPath);
    const row = rows.find((r) => r.id === job.id) as Record<string, unknown> | undefined;
    assert.ok(row, "job must exist in backup json");
    assert.equal(row.lastRunAt, startedAt, "backup must carry post-run lastRunAt");
    assert.equal(row.nextRunAt, nextAt, "backup must carry post-run nextRunAt (no stale value)");
    assert.equal(row.lastRunStatus, "ok", "backup must carry post-run lastRunStatus");
    assert.equal(row.runCount, 1, "backup must carry incremented run_count");
  });

  test("COALESCE semantics preserved: null fields keep prior values (no wipe)", () => {
    const dbPath = path.join(tmpDir, "cron.db");
    const store = createCronStore(dbPath);
    openStores.push(store);
    const job = store.addJob({
      name: "m4-coalesce",
      schedule: { kind: "every", everyMs: 60000 },
      systemPrompt: "",
      enabled: true,
    });
    const firstNext = new Date(Date.now() + 60_000).toISOString();
    store.updateJobRun(job.id, { lastRunAt: new Date().toISOString(), nextRunAt: firstNext, incrementRun: true });

    // second run passes only state — nextRunAt must survive (cron state hygiene:
    // 手改 job state 禁抹 nextRunAtMs 同语义域)
    store.updateJobRun(job.id, { state: "idle" });

    const rows = readBackupJson(dbPath);
    const row = rows.find((r) => r.id === job.id) as Record<string, unknown>;
    assert.equal(row.nextRunAt, firstNext, "nextRunAt must survive a state-only post-run write");
    assert.equal(row.state, "idle", "state must be updated");
  });
});
