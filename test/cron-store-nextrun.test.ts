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

  // 勘修窗 2026-10-11 件C（F-3 第三型回归钉）：enabled 字段缺省 → 库落 1 回读
  // true。缺陷原貌：store INSERT `input.enabled ? 1 : 0`（undefined→0）绕过
  // schema DEFAULT 1，HTTP 路由展开 body 缺 enabled 时 job 静默禁用（GET 可见
  // 却永不调度·2026-10-11 凌晨三查实锚）。
  test("enabled omitted: defaults to true (F-3 third-form regression pin)", () => {
    const store = createCronStore(path.join(tmpDir, "cron.db"));
    openStores.push(store);
    const job = store.addJob({
      name: "f3-enabled-default",
      schedule: { kind: "every", everyMs: 300000 },
      systemPrompt: "",
      // enabled 故意缺省——HTTP body 缺字段透传路径的 store 层等价形
    } as Parameters<typeof store.addJob>[0]);
    assert.equal(job.enabled, true, "omitted enabled must normalize to true at store layer");
    // 回读面：新实例从库加载（非内存对象）同断言
    const store2 = createCronStore(path.join(tmpDir, "cron.db"));
    openStores.push(store2);
    const loaded = store2.getJob(job.id);
    assert.ok(loaded, "job must round-trip via db");
    assert.equal(loaded.enabled, true, "db row must carry enabled=1");
  });

  test("enabled explicit false: stays false (no over-normalization)", () => {
    const store = createCronStore(path.join(tmpDir, "cron.db"));
    openStores.push(store);
    const job = store.addJob({
      name: "f3-enabled-false",
      schedule: { kind: "every", everyMs: 300000 },
      systemPrompt: "",
      enabled: false,
    });
    assert.equal(job.enabled, false, "explicit false must stay false");
  });
});
