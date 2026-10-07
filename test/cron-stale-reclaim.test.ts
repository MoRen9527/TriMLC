// ── 运行期 stale-running reclaim sweep（根治包：run 永卡 running 无自愈，
// CTO APPROVE d38a3eae，2026-10-07）行为锚卷 ──
// 缺陷类：settle 断链（P1 settle 写失败穿 withLock / P2 补跑洪峰半亡态）残留
// running 行永卡——互斥与 tick 过滤双重封死复活通道，boot sweep（03c6197）
// 只封重启入口。根治=onTimerTick 锁内最前挂载 sweepStaleRunning，判据
// state==='running' AND (now−updatedAt) > 10min+grace(缺省120s)。
//
// 判据红线（CTO 附条件①）：updatedAt=行面突变事实代理启动时刻（settle 前
// 无第二写）；API PATCH 刷 updatedAt → sweep 顺延 = 设计行为非 bug（案⑥
// 双向钉死：顺延非免疫）。nextRun 滚动禁入判据（TriMMC executor 家族红线）。
//
// 锚位（设计稿 §四 五条 + CTO 附条件① 第六条）：
//   案1 stale 行归位三件套：idle+执行账 error 行+error_count+1+nextRunAt 未来
//   案2 合法在跑行（updatedAt 新鲜）不误收
//   案3 timeout-run 正常 settle 后 sweep 零触碰（同 store 双 job 选择性）
//   案4 TRIMLC_CRON_STALE_RECLAIM=0 → sweep 禁用零行为
//   案5 非循环断言：真 onTimerTick 全链（armTimer 驱动）——reclaim 同 tick
//       不补跑（nextRunAt 严格未来 + onJobTrigger 零触发）
//   案6 PATCH 刷 updatedAt 顺延 reclaim=设计行为（再回拨即归位——顺延非免疫）
//
// 布景注：回拨 updated_at 走 store.db 直写（白盒——updateJobRun 无条件盖
// now，无公开面可造 stale；boot-recovery 卷同族真 store 实测形）。
// mock.timers 仅接管 setTimeout（skipped-degraded 卷先例：漏清定时器拖住
// 事件循环 node:test 挂起被杀；Date 不 mock——nextRunMs 纯计算需真钟）。
//
// Run: npx tsx --test test/cron-stale-reclaim.test.ts
import { test, describe, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createCronStore } from "../src/cron/store.js";
import {
  createCronTimerState,
  armTimer,
  sweepStaleRunning,
  type CronTimerDeps,
  type CronTimerState,
} from "../src/cron/timer.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-cron-reclaim-"));
const openStores: { db: { close(): void } }[] = [];
const prevEnv: Record<string, string | undefined> = {};

before(() => {
  for (const key of ["TRIMLC_CRON_STALE_RECLAIM", "TRIMLC_CRON_RECLAIM_GRACE_MS"]) {
    prevEnv[key] = process.env[key];
    delete process.env[key];
  }
});

after(() => {
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

/** 白盒：回拨 updated_at（updateJobRun 无公开 stale 面，直写 db 造事实）。 */
function backdateUpdatedAt(store: ReturnType<typeof createCronStore>, jobId: string, minutesAgo: number): string {
  const iso = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  (store.db as DatabaseSync).prepare("UPDATE cron_jobs SET updated_at = ? WHERE id = ?").run(iso, jobId);
  return iso;
}

function seedRunning(store: ReturnType<typeof createCronStore>, name: string, opts?: { nextRunAtPast?: boolean }): { id: string; startedAtIso: string } {
  const job = store.addJob({ name, schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
  store.updateJobRun(job.id, { state: "running", ...(opts?.nextRunAtPast ? { nextRunAt: new Date(Date.now() - 5 * 60_000).toISOString() } : {}) });
  const startedAtIso = backdateUpdatedAt(store, job.id, 15);
  return { id: job.id, startedAtIso };
}

function makeDeps(store: ReturnType<typeof createCronStore>, onJobTrigger?: (id: unknown) => void): CronTimerDeps {
  return {
    store,
    sessionStore: {
      createSession: () => { throw new Error("sessionStore must not be touched by reclaim sweep"); },
      saveMessages: () => { throw new Error("sessionStore must not be touched by reclaim sweep"); },
      updateSessionStatus: () => { throw new Error("sessionStore must not be touched by reclaim sweep"); },
    },
    cwd: tmpDir,
    ...(onJobTrigger ? { onJobTrigger: onJobTrigger as never } : {}),
  };
}

describe("reclaimStaleRunningJobs / sweepStaleRunning (runtime self-heal, d38a3eae)", () => {

  test("案1 stale 行归位三件套：idle+执行账 error 行+error_count+1+nextRunAt 未来", () => {
    const store = makeStore();
    const { id, startedAtIso } = seedRunning(store, "stale-p1-settle-broken");
    assert.equal(store.getJob(id)?.state, "running", "precondition: running seeded");
    const errorCountBefore = store.getJob(id)?.errorCount ?? -1;

    sweepStaleRunning(makeDeps(store));

    const job = store.getJob(id);
    assert.equal(job?.state, "idle", "归位 idle");
    assert.equal(job?.lastRunStatus, "error", "账面 last_run_status=error");
    assert.equal(job?.errorCount, errorCountBefore + 1, "error_count+1");

    const logs = store.getExecutionLogs(id, 10);
    assert.equal(logs.length, 1, "执行账补记恰一行（boot sweep 不补账缺口封住）");
    assert.equal(logs[0].status, "error");
    assert.equal(logs[0].startedAt, startedAtIso, "startedAt=归位前行面 updatedAt（启动时刻代理）");
    assert.ok(String(logs[0].errorMessage ?? "").includes("stale running reclaimed"), "errorMessage 点名 reclaim");

    const nextAt = job?.nextRunAt ? new Date(job.nextRunAt).getTime() : 0;
    assert.ok(nextAt > Date.now(), "nextRunAt=未来槽位（重排三件之三）");
    const dbRow = (store.db as DatabaseSync).prepare("SELECT state FROM cron_jobs WHERE id = ?").get(id) as { state: string };
    assert.equal(dbRow.state, "idle", "db 行面归位（非仅内存面）");
  });

  test("案2 合法在跑行（updatedAt 新鲜）不误收", () => {
    const store = makeStore();
    const job = store.addJob({ name: "fresh-running", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    store.updateJobRun(job.id, { state: "running" }); // updated_at=now（合法 run 窗内）

    sweepStaleRunning(makeDeps(store));

    const after = store.getJob(job.id);
    assert.equal(after?.state, "running", "新鲜 running 不误收");
    assert.equal(after?.errorCount, 0, "error_count 零动");
    assert.equal(store.getExecutionLogs(job.id, 10).length, 0, "执行账零补记");
  });

  test("案3 timeout-run 正常 settle 后 sweep 零触碰（同 store 双 job 选择性）", () => {
    // timeout-run 的 settle 终态=state failed/invalid + 新鲜 updatedAt（与
    // executeJobScheduled timeout 分支 settle 写同形——settle 与 sweep 同 timer
    // 锁串行，结构上无双写竞态窗）。同 store 一 failed 一 stale running：
    // sweep 只收 running，failed 行零触碰。
    const store = makeStore();
    const settled = store.addJob({ name: "timeout-settled", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    // 模拟 timeout settle 写（对齐 executeJobScheduled catch/timeout 分支字段形）
    store.updateJobRun(settled.id, {
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
      lastRunStatus: "error", state: "failed", incrementRun: true, incrementError: true,
    });
    const { id: staleId } = seedRunning(store, "stale-beside-settled");

    sweepStaleRunning(makeDeps(store));

    const s = store.getJob(settled.id);
    assert.equal(s?.state, "failed", "settle 后 failed 行零触碰");
    assert.equal(s?.errorCount, 1, "failed 行 error_count 零动（无双计）");
    assert.equal(store.getExecutionLogs(settled.id, 10).length, 0, "failed 行执行账零补记");
    assert.equal(store.getJob(staleId)?.state, "idle", "同 store stale 行照常归位（选择性）");
  });

  test("案4 TRIMLC_CRON_STALE_RECLAIM=0 → sweep 禁用零行为", () => {
    const store = makeStore();
    const { id } = seedRunning(store, "stale-killswitch");
    process.env.TRIMLC_CRON_STALE_RECLAIM = "0";
    try {
      sweepStaleRunning(makeDeps(store));
      assert.equal(store.getJob(id)?.state, "running", "kill-switch 下零归位");
      assert.equal(store.getExecutionLogs(id, 10).length, 0, "kill-switch 下零补账");
    } finally {
      delete process.env.TRIMLC_CRON_STALE_RECLAIM;
    }
  });

  test("案5 非循环断言：真 onTimerTick 全链——reclaim 同 tick 不补跑", async () => {
    const store = makeStore();
    const { id } = seedRunning(store, "stale-hotloop", { nextRunAtPast: true }); // nextRunAt 冻结在保（永卡现势形）
    let triggered = 0;
    const deps = makeDeps(store, () => { triggered += 1; });
    const state: CronTimerState = createCronTimerState();
    state.started = true;

    const clock = mock.timers;
    clock.enable({ apis: ["setTimeout"] });
    try {
      armTimer(state, deps); // nextRunAt 过期 → delay 0 → floored MIN_REFIRE_GAP=2s
      clock.tick(2_100); // 同步触发 tick 定时器（本机 node:timers mock 无 tickAsync）
      await new Promise<void>((r) => setImmediate(r)); // 排空微任务——onTimerTick async 链（sweep→dueJobs→re-arm）走完
    } finally {
      clock.reset(); // 清 onTimerTick 末尾 re-arm 的挂起定时器（事件循环退出保障）
    }

    const job = store.getJob(id);
    assert.equal(job?.state, "idle", "tick 链上 sweep 已归位（挂载点实证）");
    const nextAt = job?.nextRunAt ? new Date(job.nextRunAt).getTime() : 0;
    assert.ok(nextAt > Date.now(), "nextRunAt 严格未来——同 tick 不补跑");
    assert.equal(triggered, 0, "onJobTrigger 零触发（无执行拉起）");
  });

  test("案6 PATCH 刷 updatedAt 顺延 reclaim=设计行为（再回拨即归位——顺延非免疫）", () => {
    const store = makeStore();
    const job = store.addJob({ name: "stale-patched", schedule: { kind: "every", everyMs: 60_000 }, systemPrompt: "t", enabled: true });
    store.updateJobRun(job.id, { state: "running" });
    backdateUpdatedAt(store, job.id, 15);

    // API PATCH（updateJob 改名）无条件刷 updated_at=now → 同一 sweep 窗内顺延
    store.updateJob(job.id, { name: "stale-patched-renamed" });
    sweepStaleRunning(makeDeps(store));
    assert.equal(store.getJob(job.id)?.state, "running", "PATCH 刷 updatedAt 后顺延（CTO 附条件①：保守向只顺延不误杀=设计行为非 bug）");

    // 顺延非免疫：时间再过去，行再次入 stale 窗 → 照常归位
    backdateUpdatedAt(store, job.id, 15);
    sweepStaleRunning(makeDeps(store));
    assert.equal(store.getJob(job.id)?.state, "idle", "再入 stale 窗照常归位");
  });
});
