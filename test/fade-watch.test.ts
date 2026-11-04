// FADE-011 event-watch 立窗 — in-process watch tests (§8.6 定时巡检链).
// 实锚①: baseline 首扫建基线（state_known）零触发（fade_runs 0 行）。
// 实锚②: 端到端自动触发——受控文件事件→防抖→触发→十段全自动→APPROVED
//         （真全链含收口门·同 fade-driver full chain 形·默认真身 skillsRoot）。
// 实锚③: 防抖合并——同源风暴（连续变更）合并到最后一次指纹·恰一 run 零重复。
// 实锚④: skip-same 幂等——同指纹重复扫描零新 run 零审计行（防审计膨胀）。
// 实锚⑤: 失败语义（A 件③裁语）——触发失败=audit failed+state 记忆化·同指纹
//         下 tick skip-failed-remembered 零自动重试零风暴。
// 实锚⑥: 速率护栏——滚动窗内 MAX 次后超限注入=skip-rate-limit 显式跳过落审计。
// 实锚⑦: fail-closed 配置面——env 键缺省/部分缺省=null（零 watch 零触发）。
// 实锚⑧: §8.6 指纹直译——文件 hash ∪ git HEAD/refs：文件变更或 git commit
//         任一面变化均翻指纹。
// Form: process-internal（no daemon spawn）·全链真 gate 跑 2 次（端到端+速率
// 前置两次触发）≈ 2×(ms-level segments + ≤30s gate)——suite 预算显式 80s。
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createFadeStore, type FadeStore } from "../src/fade/store.js";
import {
  resolveFadeWatchConfigFromEnv,
  runWatchTick,
  computeFingerprint,
  expandTreeRootTemplate,
  isoWeekString,
  resetDebounceForTest,
  resetRateWindowForTest,
  FADE_WATCH_RATE_MAX,
  type FadeWatchConfig,
} from "../src/fade/watch.js";
import { resolveTmvRepoRoot } from "../src/fade/closing-gate.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUITE_BUDGET_MS = 80_000; // 2 real full-chain drives (gate ≤30s each) + ms-level rest

describe("fade event-watch (in-process)", () => {
  const dirs: string[] = [];
  const stores: FadeStore[] = [];

  function freshCtx(): {
    store: FadeStore;
    watchDir: string;
    treeRoot: string;
    config: FadeWatchConfig;
  } {
    const dataDir = mkdtempSync(join(tmpdir(), "trimlc-fade-watch-"));
    const watchDir = mkdtempSync(join(tmpdir(), "trimlc-fade-watch-src-"));
    const treeRoot = mkdtempSync(join(tmpdir(), "trimlc-fade-watch-trees-"));
    dirs.push(dataDir, watchDir, treeRoot);
    const store = createFadeStore(join(dataDir, "fade.db"));
    stores.push(store);
    writeFileSync(join(watchDir, "input.txt"), "v0", "utf8");
    const config: FadeWatchConfig = {
      name: "test-watch",
      dirs: [watchDir],
      treeRoot,
      intervalMs: 30_000,
    };
    return { store, watchDir, treeRoot, config };
  }

  function fadeRunCount(store: FadeStore): number {
    return (store.db.prepare("SELECT COUNT(*) AS n FROM fade_runs").get() as { n: number | bigint }).n as number;
  }

  function auditEvents(store: FadeStore): string[] {
    return (store.db.prepare("SELECT event FROM fade_watch_audit ORDER BY id").all() as unknown as Array<{ event: string }>).map((r) => r.event);
  }

  before(async () => {
    // 真仓可用性前置（fade-driver 同形双 probe）：两个真全链用例需要
    // checker 脚本+python 解释器。环境缺位=显式失败（不静默变形）。
    const checker = join(resolveTmvRepoRoot(), "scripts", "node_report_check.py");
    assert.ok(existsSync(checker), `dev TriMetaverse checker missing: ${checker}`);
    const py = spawnSync("python", ["-c", "import sys; sys.exit(0)"], { timeout: 10_000 });
    assert.equal(py.status, 0, `python interpreter probe failed (status=${py.status})`);
  });

  after(() => {
    for (const s of stores) {
      try { s.close(); } catch { /* already closed */ }
    }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("baseline: first scan establishes state, zero runs triggered", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, config } = freshCtx();
    const r = await runWatchTick(store, config, { now: 1_000 });
    assert.equal(r.event, "baseline");
    assert.equal(fadeRunCount(store), 0, "baseline must not trigger a run");
    const state = store.getWatchState(config.name);
    assert.ok(state, "watch state row established");
    assert.equal(state!.status, "baseline");
    assert.equal(state!.fingerprint, r.fingerprint);
    assert.deepEqual(auditEvents(store), ["baseline"]);
  });

  test("end-to-end: controlled event → debounce → trigger → ten-segment chain → APPROVED", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, watchDir, treeRoot, config } = freshCtx();
    await runWatchTick(store, config, { now: 1_000 }); // baseline

    // 受控事件：文件变更（§8.6 文件 hash 面翻指纹）
    writeFileSync(join(watchDir, "input.txt"), "e2e-payload", "utf8");
    const p = await runWatchTick(store, config, { now: 2_000 });
    assert.equal(p.event, "debounce-pending"); // 变化首见·零触发
    assert.equal(fadeRunCount(store), 0);

    // 窗过+指纹稳定 → 触发（debounceMs:0 = 注入时钟快径·生产默认常量 2000）
    const t = await runWatchTick(store, config, { now: 3_000, debounceMs: 0 });
    assert.equal(t.event, "triggered");
    assert.match(t.runId!, /^fade-w-test-watch-[0-9a-f]{12}$/);
    assert.equal(t.finalState, "APPROVED"); // 十段全自动（真全链含收口门）
    assert.equal(t.gated, true);
    assert.equal(fadeRunCount(store), 1);

    const run = store.getRun(t.runId!);
    assert.ok(run, "triggered run registered");
    assert.equal(run!.state, "APPROVED");
    assert.equal(run!.idempotencyKey, `fade-watch:${config.name}:${t.fingerprint}`); // 幂等键族底座
    // 树产物贯通：<treeRoot>/<runId>/reports/
    assert.ok(
      existsSync(join(treeRoot, t.runId!, "reports", "node-close.md")),
      "tree products landed under treeRoot/<runId>",
    );

    // 持久状态与审计
    const state = store.getWatchState(config.name);
    assert.equal(state!.status, "ok");
    assert.equal(state!.runId, t.runId);
    assert.deepEqual(auditEvents(store), ["baseline", "debounce-pending", "triggered"]);
  });

  test("debounce merge: rapid same-source storm coalesces to exactly one run", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, watchDir, config } = freshCtx();
    await runWatchTick(store, config, { now: 1_000 }); // baseline

    // 风暴：v1 首见（t2）→ v2 重置窗口（t3）→ 稳定后触发（t4）——合并到最后一次指纹
    writeFileSync(join(watchDir, "input.txt"), "storm-v1", "utf8");
    assert.equal((await runWatchTick(store, config, { now: 2_000 })).event, "debounce-pending");
    writeFileSync(join(watchDir, "input.txt"), "storm-v2", "utf8");
    assert.equal((await runWatchTick(store, config, { now: 3_000 })).event, "debounce-pending");
    const t = await runWatchTick(store, config, { now: 4_000, debounceMs: 0 });
    assert.equal(t.event, "triggered");
    assert.equal(fadeRunCount(store), 1, "storm must coalesce to exactly one run");
    // 触发的是最后指纹（v2）——runId 从最终指纹派生
    assert.equal(store.getRun(t.runId!)!.state, "APPROVED");
    // debounce-pending 审计恰 2 行（v1 首见 1+v2 跳变 1·审计链完整可溯——CTO
    // 扩面裁 2026-11-04：首见或跳变均落行；skip-same 仍零行防膨胀）
    assert.equal(auditEvents(store).filter((e) => e === "debounce-pending").length, 2);
  });

  // ── 实锚⑫: 跳变落行（CTO 扩面加件 gate）——首见→跳变→触发三行链断言，
  //    审计链完整可溯（SDE 勘定 OBS1 根因：非首见跳变不落行→审计链缺前置）。
  test("audit chain: first-seen and window jump both land debounce-pending rows (full chain traceable)", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, watchDir, config } = freshCtx();
    await runWatchTick(store, config, { now: 1_000 }); // baseline（零 pending 行）

    writeFileSync(join(watchDir, "input.txt"), "jump-v1", "utf8");
    assert.equal((await runWatchTick(store, config, { now: 2_000 })).event, "debounce-pending");
    writeFileSync(join(watchDir, "input.txt"), "jump-v2", "utf8");
    assert.equal((await runWatchTick(store, config, { now: 3_000 })).event, "debounce-pending");
    const t = await runWatchTick(store, config, { now: 4_000, debounceMs: 0 });
    assert.equal(t.event, "triggered");

    // 三行链：baseline → pending(v1 首见) → pending(v2 跳变) → triggered
    assert.deepEqual(auditEvents(store), ["baseline", "debounce-pending", "debounce-pending", "triggered"]);
    // 触发的是跳变后最终指纹（v2）——审计链前置行可溯至触发行
    assert.equal(store.getRun(t.runId!)!.state, "APPROVED");
  });

  test("skip-same idempotency: stable fingerprint re-scan = zero new runs, zero audit rows", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, config } = freshCtx();
    await runWatchTick(store, config, { now: 1_000 }); // baseline
    const auditBefore = store.listWatchAudit().length;
    const runsBefore = fadeRunCount(store);

    const r = await runWatchTick(store, config, { now: 2_000 });
    assert.equal(r.event, "same");
    assert.equal(fadeRunCount(store), runsBefore, "same fingerprint must not re-trigger");
    assert.equal(store.listWatchAudit().length, auditBefore, "skip-same lands no audit row");
  });

  test("failure semantics: trigger failure → failed audit + memorized, next tick skips (no retry storm)", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, watchDir, config } = freshCtx();
    await runWatchTick(store, config, { now: 1_000 }); // baseline
    writeFileSync(join(watchDir, "input.txt"), "doomed", "utf8");
    await runWatchTick(store, config, { now: 2_000 }); // debounce-pending

    // 注入触发失败：treeRoot 指向一个普通文件 → run 树 mkdir 必败（ENOTDIR）。
    // 语义如实：createRun 先于驱动落行——失败 run 已建停非终态（§8.1 resume
    // 显面兜底·boot sweep 一次性显面非 watch 重试）；watch 层承诺=同指纹零重驱
    // （failed 记忆化）零风暴。
    const notADir = join(watchDir, "input.txt");
    const badConfig: FadeWatchConfig = { ...config, treeRoot: notADir };
    const f = await runWatchTick(store, badConfig, { now: 3_000, debounceMs: 0 });
    assert.equal(f.event, "failed");
    assert.match(f.detail!, /trigger failed:/);
    assert.equal(fadeRunCount(store), 1, "failed drive leaves the registered run visible (non-terminal)");
    const doomedRun = store.getRun(f.runId!);
    assert.ok(doomedRun, "run id surfaced in failed tick");
    assert.equal(["APPROVED", "FROZEN", "ESCALATED", "RETRY"].includes(doomedRun!.state), false, "failed run stays non-terminal");
    const state = store.getWatchState(config.name);
    assert.equal(state!.status, "failed", "fingerprint memorized as failed");
    assert.deepEqual(auditEvents(store), ["baseline", "debounce-pending", "failed"]);

    // 同指纹下 tick → skip-failed-remembered（零自动重试·显面不静默）
    const s = await runWatchTick(store, badConfig, { now: 4_000 });
    assert.equal(s.event, "skip-failed-remembered");
    assert.equal(fadeRunCount(store), 1, "watch layer never re-drives the same fingerprint");
    assert.equal(store.listWatchAudit().length, 3, "skip-failed-remembered adds no audit row");

    // 上游修复后新事件（新指纹）自然走触发面——记忆化只挡同指纹
    writeFileSync(join(watchDir, "input.txt"), "recovered-payload", "utf8");
    await runWatchTick(store, badConfig, { now: 5_000 }); // 新指纹首见 pending
    const okTreeRoot = mkdtempSync(join(tmpdir(), "trimlc-fade-watch-trees2-"));
    dirs.push(okTreeRoot);
    const goodConfig: FadeWatchConfig = { ...config, treeRoot: okTreeRoot };
    const r2 = await runWatchTick(store, goodConfig, { now: 6_000, debounceMs: 0 });
    assert.equal(r2.event, "triggered", "new fingerprint after upstream fix triggers normally");
    assert.equal(r2.finalState, "APPROVED");
    assert.equal(fadeRunCount(store), 2, "doomed run remains visible + recovered run added");
  });

  test("rate guard: after MAX triggers in window, further events skip with audit row", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, watchDir, config } = freshCtx();
    await runWatchTick(store, config, { now: 1_000 }); // baseline

    // 真触发 #1（填护栏计数 1/2）
    writeFileSync(join(watchDir, "input.txt"), "rate-a", "utf8");
    await runWatchTick(store, config, { now: 2_000 }); // pending
    const t1 = await runWatchTick(store, config, { now: 3_000, debounceMs: 0 });
    assert.equal(t1.event, "triggered");

    // 真触发 #2（计数 2/2 = MAX）
    writeFileSync(join(watchDir, "input.txt"), "rate-b", "utf8");
    await runWatchTick(store, config, { now: 4_000 }); // pending
    const t2 = await runWatchTick(store, config, { now: 5_000, debounceMs: 0 });
    assert.equal(t2.event, "triggered");

    // #3：窗内超限 → 显式跳过+审计行·零 run（护栏挡事件风暴）
    writeFileSync(join(watchDir, "input.txt"), "rate-c", "utf8");
    await runWatchTick(store, config, { now: 6_000 }); // pending
    const t3 = await runWatchTick(store, config, { now: 7_000, debounceMs: 0 });
    assert.equal(t3.event, "skip-rate-limit");
    assert.match(t3.detail!, /rate limit/);
    assert.equal(fadeRunCount(store), FADE_WATCH_RATE_MAX, "rate guard caps runs in window");
    assert.ok(auditEvents(store).includes("skip-rate-limit"));

    // 窗滑出（>60s）→ 计数清 → 恢复触发
    const t4 = await runWatchTick(store, config, { now: 70_000, debounceMs: 0 });
    assert.equal(t4.event, "triggered", "window slide restores triggering");
    assert.equal(fadeRunCount(store), FADE_WATCH_RATE_MAX + 1);
  });

  test("fail-closed config: missing/partial env = null (no watch, no trigger)", () => {
    assert.equal(resolveFadeWatchConfigFromEnv({}), null, "empty env = disabled");
    assert.equal(
      resolveFadeWatchConfigFromEnv({ TRILC_FADE_WATCH_DIRS: "C:\\x" }),
      null,
      "dirs without treeRoot = disabled",
    );
    assert.equal(
      resolveFadeWatchConfigFromEnv({ TRILC_FADE_WATCH_TREE_ROOT: "C:\\y" }),
      null,
      "treeRoot without dirs = disabled",
    );
    assert.equal(
      resolveFadeWatchConfigFromEnv({ TRILC_FADE_WATCH_DIRS: " , ,", TRILC_FADE_WATCH_TREE_ROOT: "C:\\y" }),
      null,
      "blank dir entries = disabled",
    );
    const full = resolveFadeWatchConfigFromEnv({
      TRILC_FADE_WATCH_DIRS: "C:\\a , C:\\b",
      TRILC_FADE_WATCH_TREE_ROOT: "C:\\trees",
    });
    assert.ok(full, "both keys = enabled");
    assert.deepEqual(full!.dirs, ["C:\\a", "C:\\b"]);
    assert.equal(full!.intervalMs, 30_000, "interval default explicit");
    assert.equal(full!.name, "default", "name default explicit");
    const custom = resolveFadeWatchConfigFromEnv({
      TRILC_FADE_WATCH_DIRS: "C:\\a",
      TRILC_FADE_WATCH_TREE_ROOT: "C:\\trees",
      TRILC_FADE_WATCH_INTERVAL_MS: "bogus",
      TRILC_FADE_WATCH_NAME: "repo-x",
    });
    assert.equal(custom!.intervalMs, 30_000, "invalid interval falls back to default");
    assert.equal(custom!.name, "repo-x");
  });

  test("fingerprint: §8.6 文件 hash ∪ git HEAD/refs — either face flipping moves the fingerprint", () => {
    const repoDir = mkdtempSync(join(tmpdir(), "trimlc-fade-watch-git-"));
    dirs.push(repoDir);
    const git = (args: string, cwd = repoDir) =>
      spawnSync("git", args, { cwd, timeout: 15_000, env: { ...process.env, GIT_CONFIG_GLOBAL: "NUL" } });
    writeFileSync(join(repoDir, "a.txt"), "one", "utf8");
    git(["init"]);
    git(["add", "."]);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "c1"]);

    const fp1 = computeFingerprint([repoDir]);
    // 文件面变化 → 指纹翻
    writeFileSync(join(repoDir, "a.txt"), "two", "utf8");
    const fp2 = computeFingerprint([repoDir]);
    assert.notEqual(fp1, fp2, "file-content change flips fingerprint");
    // 还原内容 → git 面未变 → 指纹回到 fp1 域（内容 hash 是聚合唯一来源）
    writeFileSync(join(repoDir, "a.txt"), "one", "utf8");
    assert.equal(computeFingerprint([repoDir]), fp1, "restoring content restores fingerprint");
    // git 面变化（新 commit·文件内容同 fp1）→ 指纹翻（∪ 条款实锚）
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "c2"]);
    const fp3 = computeFingerprint([repoDir]);
    assert.notEqual(fp1, fp3, "git HEAD change flips fingerprint with identical file content");
    // 确定性：同态重扫同值
    assert.equal(computeFingerprint([repoDir]), fp3);
  });

  // ── 实锚⑨: {week} 模板展开（P3 尾增强·跨周滚动语义裁决 2026-11-04）────────
  // gate1: {week} → ISO 周（W45 形·operating-records 同构）+ 换周模拟（注入
  //        时钟·展开值随周变）+ ISO 边界（周日/周一换周点 + 跨年 W53/W01）。
  // gate2: 向后兼容——无占位符静态值恒等（行为零变化·现役部署形照跑）。
  test("week template: {week} expands at injected clock; ISO boundaries; static values pass through", () => {
    const D = (y: number, m: number, d: number) => new Date(y, m, d);
    // 同构锚：2026-11-04（周三）→ 2026-W45（现役周目录同形）
    assert.equal(isoWeekString(D(2026, 10, 4)), "2026-W45");
    // 换周点：周日属本周，周一翻新周
    assert.equal(isoWeekString(D(2026, 10, 8)), "2026-W45");
    assert.equal(isoWeekString(D(2026, 10, 9)), "2026-W46");
    // ISO 跨年边界：2026 长年（53 周）+ 元旦归上年 W53
    assert.equal(isoWeekString(D(2026, 11, 28)), "2026-W53");
    assert.equal(isoWeekString(D(2027, 0, 1)), "2026-W53");
    assert.equal(isoWeekString(D(2027, 0, 4)), "2027-W01");
    assert.equal(isoWeekString(D(2026, 0, 1)), "2026-W01");

    // 展开函数：{week} 注入时钟展开（同构锚实测）+ 换周模拟随周变
    const root = "D:/rec/{week}/trees/fade011-ew-runs";
    assert.equal(expandTreeRootTemplate(root, D(2026, 10, 4)), "D:/rec/2026-W45/trees/fade011-ew-runs");
    assert.equal(expandTreeRootTemplate(root, D(2026, 10, 9)), "D:/rec/2026-W46/trees/fade011-ew-runs");
    assert.equal(expandTreeRootTemplate("{week}", D(2026, 11, 28)), "2026-W53");

    // gate2 向后兼容：无占位符静态值恒等（含现役部署形 …/2026-W45/trees/…）
    const staticRoot = "D:/rec/2026-W45/trees/fade011-ew-runs";
    assert.equal(expandTreeRootTemplate(staticRoot, D(2026, 10, 4)), staticRoot);
    assert.equal(expandTreeRootTemplate(staticRoot, D(2027, 0, 1)), staticRoot);
  });

  // ── 实锚⑩: fail-closed 非法占位符（gate3）——run 不创建 + audit failed 显面
  //    + failed 记忆化（同指纹零重试·走触发段现役 failed 通道）。
  test("fail-closed: unknown placeholder = run NOT created + failed audit + memorized skip", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, watchDir, config } = freshCtx();
    await runWatchTick(store, config, { now: 1_000 }); // baseline（合法静态树根）
    writeFileSync(join(watchDir, "input.txt"), "bad-template", "utf8");
    await runWatchTick(store, config, { now: 2_000 }); // debounce-pending

    // 非法占位符树根（{weekx}——唯一合法占位符={week}）
    const badRoot = join(treeRootBad(), "{weekx}");
    const badConfig: FadeWatchConfig = { ...config, treeRoot: badRoot };
    const f = await runWatchTick(store, badConfig, { now: 3_000, debounceMs: 0 });
    assert.equal(f.event, "failed");
    assert.match(f.detail!, /treeRoot template expand failed:/);
    assert.match(f.detail!, /\{weekx\}/);
    // run 不创建（零新行·派生 runId 无 run 行——禁静默落根路径）
    assert.equal(fadeRunCount(store), 0, "template expand failure must NOT create a run");
    assert.ok(!store.getRun(f.runId!), "derived runId has no run row");
    // audit failed 显面 + failed 记忆化
    assert.ok(auditEvents(store).includes("failed"));
    assert.equal(store.getWatchState(config.name)!.status, "failed");

    // 同指纹下 tick → skip-failed-remembered（零自动重试零风暴）
    const s = await runWatchTick(store, badConfig, { now: 4_000 });
    assert.equal(s.event, "skip-failed-remembered");
    assert.equal(fadeRunCount(store), 0);
  });

  // ── 实锚⑪: 模板化端到端——真全链触发后树落当前 ISO 周目录（对周·动态同值
  //    断言不随时间漂移）。
  test("end-to-end templated treeRoot: run tree lands under current ISO week dir", async () => {
    resetDebounceForTest(); resetRateWindowForTest();
    const { store, watchDir, treeRoot, config } = freshCtx();
    await runWatchTick(store, config, { now: 1_000 }); // baseline
    const templated: FadeWatchConfig = { ...config, treeRoot: join(treeRoot, "{week}", "trees", "ew") };

    writeFileSync(join(watchDir, "input.txt"), "templated-payload", "utf8");
    await runWatchTick(store, templated, { now: 2_000 }); // debounce-pending
    const t = await runWatchTick(store, templated, { now: 3_000, debounceMs: 0 });
    assert.equal(t.event, "triggered");
    assert.equal(t.finalState, "APPROVED");
    assert.equal(t.gated, true);

    // 树落对周：<treeRoot>/<当前 ISO 周>/trees/ew/<runId>/reports/node-close.md
    const weekDir = isoWeekString(new Date());
    assert.ok(
      existsSync(join(treeRoot, weekDir, "trees", "ew", t.runId!, "reports", "node-close.md")),
      `tree products must land under the ISO-week dir (${weekDir})`,
    );
    // 旧形路径（无周层）零落盘——展开真发生在 run 创建时
    assert.ok(!existsSync(join(treeRoot, t.runId!)), "no legacy root-level run tree");
  });
});

/** fail-closed 用例专用树根目录（独立于 freshCtx 树根·隔离断言面）。 */
function treeRootBad(): string {
  return mkdtempSync(join(tmpdir(), "trimlc-fade-watch-badroot-"));
}
