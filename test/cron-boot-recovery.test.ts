// ── Boot recovery sweep（LG-064 §八裁决② TriMLC 移植，2026-10-06）──
// 上一 boot 崩溃/强停残留 running 态归位 idle：真 SQLite store 全链实测
// （addJob → updateJobRun state:'running' → resetStaleRunningJobs）。
// 治的是「残留 running → 补跑过滤器跳过 + 引擎互斥永不重触发」的 l2-scan
// 永卡族（TriRLC 同构正形 03b3220 移植；CTO 排程=段2 部署窗前置项）。
// 防御要点：归位走逐行 SELECT+rowToJob 内存刷新，禁走 loadAll——其 mtime
// 守卫在 WAL 模式下看不到主 db 文件变化（TriRLC 段1 白盒同签名实证：
// SQL changes=2 但 getJob 仍读 running）。第 4 案钉死该内存读路径：
// sweep 后不经任何 reload，getJob 即读 idle，且 .json 备份同步（maint-④ 契约）。
//
// Run: npx tsx --test test/cron-boot-recovery.test.ts
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCronStore } from "../src/cron/store.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-cron-boot-"));
const openStores: { db: { close(): void } }[] = [];

after(() => {
  for (const s of openStores) {
    try { s.db.close(); } catch { /* already closed */ }
  }
  if (fs.existsSync(tmpDir)) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
  }
});

function makeStore(): ReturnType<typeof createCronStore> {
  const s = createCronStore(path.join(tmpDir, `cron-${Math.random().toString(36).slice(2)}.db`));
  openStores.push(s);
  return s;
}

describe("resetStaleRunningJobs (boot recovery sweep, TriMLC port)", () => {
  test("resets running → idle, leaves idle/failed untouched, returns count", () => {
    const store = makeStore();
    const running = store.addJob({ name: "stale-running", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    const idle = store.addJob({ name: "plain-idle", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    const failed = store.addJob({ name: "plain-failed", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    store.updateJobRun(running.id, { state: "running" });
    store.updateJobRun(failed.id, { state: "failed" });

    assert.equal(store.getJob(running.id)?.state, "running", "precondition: running seeded");

    const changed = store.resetStaleRunningJobs();
    assert.equal(changed, 1);
    assert.equal(store.getJob(running.id)?.state, "idle", "running reset to idle");
    assert.equal(store.getJob(idle.id)?.state, "idle", "idle untouched");
    assert.equal(store.getJob(failed.id)?.state, "failed", "failed untouched");
    assert.equal(store.getJob(running.id)?.runCount, 0, "runCount untouched");
  });

  test("idempotent: second sweep on clean store returns 0", () => {
    const store = makeStore();
    const job = store.addJob({ name: "never-ran", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    assert.equal(store.resetStaleRunningJobs(), 0);
    assert.equal(store.getJob(job.id)?.state, "idle");
    assert.equal(store.resetStaleRunningJobs(), 0);
  });

  test("multiple stale running jobs all reset in one sweep", () => {
    const store = makeStore();
    const a = store.addJob({ name: "stale-a", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    const b = store.addJob({ name: "stale-b", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    store.updateJobRun(a.id, { state: "running" });
    store.updateJobRun(b.id, { state: "running" });
    assert.equal(store.resetStaleRunningJobs(), 2);
    assert.equal(store.getJob(a.id)?.state, "idle");
    assert.equal(store.getJob(b.id)?.state, "idle");
  });

  test("WAL mtime-trap defense: sweep reflects via in-memory path WITHOUT reloadIfChanged, .json backup in sync", () => {
    // 钉死段1 自捕坑的 TriMLC 侧防御：归位后 getJob（内存判定面）立即可读
    // idle——不依赖 loadAll 的 mtime 守卫（WAL 下主 db mtime 可能不动，loadAll
    // 会 no-op 服务陈旧缓存）。同时按 maint-④ 契约断言 .json 备份同步归位值。
    const store = makeStore();
    const dbPath = path.join(tmpDir, "wal-trap.db");
    const s2 = createCronStore(dbPath);
    openStores.push(s2);
    const job = s2.addJob({ name: "wal-trap-running", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    s2.updateJobRun(job.id, { state: "running" });
    assert.equal(s2.getJob(job.id)?.state, "running", "precondition: running seeded");

    assert.equal(s2.resetStaleRunningJobs(), 1);
    // 关键断言：无 reloadIfChanged 介入，内存判定面已归位
    assert.equal(s2.getJob(job.id)?.state, "idle", "in-memory view must reflect sweep without reload");

    const backup = JSON.parse(fs.readFileSync(dbPath + ".json", "utf-8")) as Array<{ id: string; state: string }>;
    const row = backup.find((r) => r.id === job.id);
    assert.ok(row, "backup json must contain the job");
    assert.equal(row.state, "idle", ".json backup in sync (maint-④ contract)");
  });
});
