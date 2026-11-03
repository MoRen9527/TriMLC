// FADE-011 event-watch 自动触发 · 立窗工程（automation-backlog 正式转现役）。
// Law anchors:
//   - spec §8.6 触发探测落地形态（event-watch v1.2.0）: 指纹 = 文件 hash ∪
//     git HEAD/refs，首扫建立基线（state_known），此后指纹变化即触发完整链；
//     审计落卷（daemon 侧承载 = fade.db fade_watch_audit 表——§8.6 的
//     .ade/event-watch/ 为 TriCompany 发布管线侧形态，实例管载体 §2.8 细则 1）。
//   - 触发链模式 = 定时巡检链（runtime-owned durable profile 对应面）：daemon
//     interval 为调度器（§8.6·cron/interval 语义），run 经 createAndDriveRun
//     幂等入口零旁路（S5 件）。
//   - 失败语义（A 件③裁语 2026-11-04）：门拒不自动重试——run 已建停
//     FINALIZING 时指纹已记忆化，同指纹永不重驱；触发/驱动失败 = 审计 failed
//     行 + 日志显面（禁静默）且指纹记忆化（同指纹零自动重试·禁重试风暴）。
//   - 触发规则显式化（brief §一.3）：配置驱动——env 三键缺省全关 = fail-closed
//     （零 watch 配置 = 零扫描零触发）；§8.6 未覆盖的业务映射（哪些路径触发
//     哪些 run 形态）禁自行发明，显式配置接入即显式规则。
//   - R2.1 同族：tick 内最重 IO = 指纹扫描（watch dirs 递归 hash）与驱动链
//     （驱动仅在有事件时发生）；interval 节拍为唯一调度面。
//   - R4.3: all timestamps new Date().toISOString() in-process (no spawn date).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { createAndDriveRun } from "./driver.js";
import type { FadeStore } from "./store.js";

// ── 显式常量（brief §一.2/§一.5·常量+注释显式化）────────────────────────────

/** 防抖窗（ms）：指纹变化后须在本窗内保持稳定（两连扫同值且距首见 ≥ 窗）
 * 方触发——批量变更风暴合并到最后一次指纹（brief §一.2 防抖窗参数显式）。 */
export const FADE_WATCH_DEBOUNCE_MS = 2_000;

/** 速率护栏时间窗（ms）：滚动窗内触发计数。 */
export const FADE_WATCH_RATE_WINDOW_MS = 60_000;

/** 速率护栏上限：滚动窗内至多触发 N 个 run（防事件风暴打爆 fade 键空间·
 * 超限显式跳过落审计+日志，brief §一.5）。 */
export const FADE_WATCH_RATE_MAX = 2;

// ── 配置面（env 三键·缺省全关）──────────────────────────────────────────────

export interface FadeWatchConfig {
  /** watch 名（审计/状态归因键）。 */
  name: string;
  /** §8.6 --watch-dirs 形：指纹扫描目录清单（递归）。 */
  dirs: string[];
  /** run 树根：<treeRoot>/<runId> 每 run 一树（UAT 形）。 */
  treeRoot: string;
  /** 扫描节拍（定时巡检链调度器·§8.6 cron/interval 语义）。 */
  intervalMs: number;
}

export function resolveFadeWatchConfigFromEnv(env: NodeJS.ProcessEnv): FadeWatchConfig | null {
  const dirsRaw = env.TRILC_FADE_WATCH_DIRS?.trim() ?? "";
  const treeRoot = env.TRILC_FADE_WATCH_TREE_ROOT?.trim() ?? "";
  // fail-closed：任一键缺省 = watch 关（零扫描零触发）——触发面存在但无业务
  // 映射即不运转（brief §一.3 禁自行发明·部署面显式接入才显式启用）。
  if (!dirsRaw || !treeRoot) return null;
  const dirs = dirsRaw.split(",").map((d) => d.trim()).filter((d) => d.length > 0);
  if (dirs.length === 0) return null;
  const intervalRaw = Number(env.TRILC_FADE_WATCH_INTERVAL_MS?.trim() ?? "");
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : 30_000;
  const name = env.TRILC_FADE_WATCH_NAME?.trim() || "default";
  return { name, dirs, treeRoot, intervalMs };
}

// ── 指纹引擎（§8.6 条款直译：文件 hash ∪ git HEAD/refs）────────────────────

function walkFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue; // 排除噪音面
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else if (entry.isFile()) out.push(p);
  }
}

function gitFingerprint(dir: string): string | null {
  // read-only git probe（HEAD + refs）——非 git 仓（rev-parse 失败）= 仅文件 hash。
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 5_000 });
  if (head.status !== 0) return null;
  const refs = spawnSync(
    "git",
    ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"],
    { cwd: dir, timeout: 5_000 },
  );
  const refsOut = refs.status === 0 ? refs.stdout.toString().trim() : "";
  return `git:HEAD=${head.stdout.toString().trim()};refs=${refsOut}`;
}

/** §8.6 指纹：文件 hash（relpath+content sha256 聚合）∪ git HEAD/refs。 */
export function computeFingerprint(dirs: string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    const files: string[] = [];
    walkFiles(dir, files);
    files.sort();
    const h = createHash("sha256");
    for (const f of files) {
      h.update(relative(dir, f).replaceAll("\\", "/"));
      h.update("\0");
      h.update(readFileSync(f));
      h.update("\0");
    }
    parts.push(`files(${dir})=${h.digest("hex")}`);
    const g = gitFingerprint(dir);
    if (g) parts.push(g);
  }
  return createHash("sha256").update(parts.join("\n"), "utf8").digest("hex");
}

// ── 速率护栏（滚动窗计数·daemon 进程内）─────────────────────────────────────

const recentTriggers: number[] = [];

export function resetRateWindowForTest(): void {
  recentTriggers.length = 0;
}

function rateLimitCheck(now: number): boolean {
  while (recentTriggers.length > 0 && now - recentTriggers[0]! > FADE_WATCH_RATE_WINDOW_MS) {
    recentTriggers.shift();
  }
  return recentTriggers.length < FADE_WATCH_RATE_MAX;
}

// ── 防抖（内存态：daemon 进程内 pending 指纹——重启丢 pending 无害·下 tick
// 重 pending 重走窗；持久指纹状态归 store 表）─────────────────────────────────

interface PendingFingerprint { fp: string; since: number }
const pendingByWatch = new Map<string, PendingFingerprint>();

export function resetDebounceForTest(): void {
  pendingByWatch.clear();
}

// ── tick ────────────────────────────────────────────────────────────────────

export type FadeWatchEvent =
  | "baseline"            // 首扫建基线（state_known·零触发）
  | "same"                // 指纹未变（无事件·零审计零日志）
  | "debounce-pending"    // 变化首见或窗内（合并窗口·零触发）
  | "triggered"           // 触发（run 已建·驱动毕·含 gated:false 合法门拒态）
  | "skip-rate-limit"     // 护栏超限（显式跳过·审计+日志）
  | "failed"              // 触发/驱动失败（审计+日志·指纹记忆化零自动重试）
  | "skip-failed-remembered"; // 同指纹曾 failed（显面·零重试）

export interface WatchTickResult {
  event: FadeWatchEvent;
  fingerprint: string;
  runId?: string;
  gated?: boolean;
  finalState?: string;
  detail?: string;
}

export interface WatchTickOptions {
  debounceMs?: number;      // 测试快径：0 = 变化当 tick 即触发（生产默认常量）
  now?: number;             // 测试注入时钟
  log?: (message: string) => void;
}

/** 单 watch 单 tick（app.ts interval 每 tick 调一次）。
 * 防抖两段确认形：变化首见 → pending 记档；下扫同值且距首见 ≥ 窗 → 触发；
 * 下扫又变 → pending 重置（合并到最后一次指纹）。持久记忆化归 store 表
 * （fingerprint 已处理 = 同指纹永不重驱重试）。 */
export async function runWatchTick(
  store: FadeStore,
  config: FadeWatchConfig,
  opts: WatchTickOptions = {},
): Promise<WatchTickResult> {
  const log = opts.log ?? ((m: string) => console.log(`[trilc] fade watch: ${m}`));
  const now = opts.now ?? Date.now();
  const debounceMs = opts.debounceMs ?? FADE_WATCH_DEBOUNCE_MS;

  let fp: string;
  try {
    fp = computeFingerprint(config.dirs);
  } catch (err) {
    // 扫描失败（watch 目录缺等配置错）=failed 事件显面（不触碰 state 指纹——
    // 无指纹可记；下 tick 重试扫描本身·驱动链零涉）。
    const detail = `fingerprint scan failed: ${(err as Error).message}`;
    store.recordWatchAudit({ name: config.name, fingerprint: "", event: "failed", runId: null, detail });
    log(`tick FAILED name=${config.name}: ${detail}`);
    return { event: "failed", fingerprint: "", detail };
  }

  const row = store.getWatchState(config.name);
  if (!row) {
    store.setWatchState(config.name, fp, null, "baseline");
    store.recordWatchAudit({ name: config.name, fingerprint: fp, event: "baseline", runId: null, detail: null });
    log(`baseline established name=${config.name} fp=${fp.slice(0, 12)} (state_known·零触发)`);
    return { event: "baseline", fingerprint: fp };
  }
  if (fp === row.fingerprint) {
    pendingByWatch.delete(config.name);
    if (row.status === "failed") {
      // failed 记忆化显面：同指纹曾触发失败——零自动重试（A 件③裁语最严解·
      // 人工/上游修复后新事件（新指纹）自然走）。
      log(`skip-failed-remembered name=${config.name} fp=${fp.slice(0, 12)} (failed 记忆化·零重试)`);
      return { event: "skip-failed-remembered", fingerprint: fp };
    }
    return { event: "same", fingerprint: fp };
  }

  // 指纹变化面——防抖两段确认
  const pending = pendingByWatch.get(config.name);
  if (!pending || pending.fp !== fp) {
    pendingByWatch.set(config.name, { fp, since: now });
    if (!pending) {
      store.recordWatchAudit({ name: config.name, fingerprint: fp, event: "debounce-pending", runId: null, detail: null });
    }
    return { event: "debounce-pending", fingerprint: fp };
  }
  if (now - pending.since < debounceMs) {
    return { event: "debounce-pending", fingerprint: fp };
  }

  // 窗过+指纹稳定 = 触发（幂等键族底座：runId/idempotencyKey 从指纹派生）
  const runId = `fade-w-${config.name}-${fp.slice(0, 12)}`;
  const idempotencyKey = `fade-watch:${config.name}:${fp}`;
  if (!rateLimitCheck(now)) {
    const detail = `rate limit: ${FADE_WATCH_RATE_MAX} runs per ${FADE_WATCH_RATE_WINDOW_MS}ms window`;
    store.recordWatchAudit({ name: config.name, fingerprint: fp, event: "skip-rate-limit", runId, detail });
    log(`tick SKIP (rate-limit) name=${config.name} run=${runId}: ${detail}`);
    return { event: "skip-rate-limit", fingerprint: fp, runId, detail };
  }

  try {
    const { created, result } = await createAndDriveRun(
      store,
      {
        runId,
        idempotencyKey,
        profile: "runtime-owned-durable",
        homeDomain: "M-plane-local",
        writeAuthority: "daemon:trmlc",
        authorityEpoch: 1,
        version: "fade011-ew-watch",
        meta: { treeDir: join(config.treeRoot, runId) },
      },
    );
    // 门拒 = gated:false 合法业务结果（run 已建停 FINALIZING 可见）——状态记
    // ok + 指纹记忆化 → 同指纹永不重驱（门拒不自动重试兑现）。
    recentTriggers.push(now);
    store.setWatchState(config.name, fp, runId, "ok");
    store.recordWatchAudit({
      name: config.name, fingerprint: fp, event: "triggered", runId,
      detail: `created=${created} finalState=${result.finalState} gated=${result.gated}`,
    });
    log(`triggered name=${config.name} run=${runId} created=${created} finalState=${result.finalState} gated=${result.gated}`);
    return {
      event: "triggered", fingerprint: fp, runId,
      gated: result.gated, finalState: result.finalState,
    };
  } catch (err) {
    // 触发/驱动失败 = 显面（审计+日志）+ 指纹记忆化（status=failed）——同指纹
    // 零自动重试零重试风暴；run 未建（幂等键未落 store）由 failed 记忆化兜住。
    const detail = `trigger failed: ${(err as Error).message}`;
    store.setWatchState(config.name, fp, null, "failed");
    store.recordWatchAudit({ name: config.name, fingerprint: fp, event: "failed", runId, detail });
    log(`tick FAILED name=${config.name} run=${runId}: ${detail}`);
    return { event: "failed", fingerprint: fp, runId, detail };
  }
}
