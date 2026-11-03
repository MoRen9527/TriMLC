// FADE-011 Phase 2 S5 — ten-segment full-chain programmatic driver (final phase).
// Law anchors:
//   - fade-protocol-spec.md §1.1 L100 (ten segments 事件→登记→Qualify→Plan Skill
//     →DCE→Verify(可选)→Score CLI→Score Skill→Close Skill→Close CLI→终态),
//     §8.3 L469-478 chain vocabulary (frozen in state-machine.ts S1)
//   - §2.7 前置门 mechanical enforcement: the closing flip goes through
//     finalizeWithGate ONLY (S4) — the driver NEVER calls advanceRun with a
//     terminal target itself. 绕闸防御 (S4 debt → S5 obligation, CTO ruling):
//     gate FAIL = terminal unreachable (asserted in tests).
//   - 排期单 §四 S5「联调 + kill 实测」/ §五 验收门 / §六 (彩排树零改动·独立
//     run-id 序列·run 树由调用方给·零硬编码路径 — D-24)
//   - S3 consumption: loadFade011Skills + parseSkillOutput per-segment schema
//     gates (score/close 真身装载·校验失败=段失败不静默).
//   - S2 consumption: setCheckpoint per segment (boot sweep resume 消费面).
// Boundary notes (如实):
//   - Plan Skill structured output has no tri-fade011-plan SKILL.md yet (彩排
//     only created score/close — run-registry L39-40): the plan segment emits a
//     plan document + compliant report without a skill-schema gate (候件·
//     worker injection point reserved).
//   - Segment workers default to programmatic MVP form (compliant node reports
//     + synthetic skill outputs). Real per-segment work plugs in via opts.workers.
//   - R2.1: the heaviest IO in the chain is the closing gate (S4 upper bound
//     30s); segment work is in-process ms-level — no additional driver timeout.
//     R4.3: all timestamps new Date().toISOString() in-process (no spawn date).
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { finalizeWithGate, type ClosingGateOptions } from "./closing-gate.js";
import { loadFade011Skills, parseSkillOutput, resolveTriSkillSkillsRoot, type FadeSkillDefinition } from "./skill-loader.js";
import { isTerminal } from "./state-machine.js";
import {
  TERMINAL_STATES,
  type FadeRunRecord,
  type FadeRunState,
  type FadeRunInput,
} from "./types.js";
import type { FadeStore } from "./store.js";

export class FadeDriverError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FadeDriverError";
  }
}

/** Run tree metadata — run 创建时登记·驱动链全程取此处·零硬编码路径 (D-24). */
export interface FadeRunTreeMeta {
  /** Run tree root (the §2.7 checker target is <treeDir>/reports). */
  treeDir: string;
  /** Defaults to join(treeDir, "reports") — single-layer glob (S4 contract). */
  reportsDir?: string;
}

export interface FadeDriverOptions extends Omit<ClosingGateOptions, "reportsDir"> {
  // reportsDir 不在此接口——run 元数据贯通（brief §一.3）：reportsDir 从
  // FadeRunTreeMeta 解析（默认 join(treeDir,"reports")）·驱动链零硬编码路径。
  /** Per-segment worker overrides (tests / future real segment work). */
  workers?: Partial<Record<DriverWorkerKey, SegmentWorker>>;
  /** Inter-segment delay (kill-window tests); 0 = full speed (R2.1 note). */
  segmentDelayMs?: number;
  /** Segment-advance observer (polling/log/test assertions). */
  onSegment?: (run: FadeRunRecord, next: FadeRunState) => void;
}

export type DriverWorkerKey = "qualify" | "plan" | "dce" | "verify" | "score" | "close";

export interface SegmentWorkerContext {
  runId: string;
  meta: FadeRunTreeMeta;
  treeDir: string;
  reportsDir: string;
  /** Write a §2.7-compliant node report into reports/ (nine-key JSON+prose). */
  writeReport: (name: string, title: string, body?: string) => string;
  treeAbsPath: (rel: string) => string;
}

export type SegmentWorker = (ctx: SegmentWorkerContext) => Promise<void> | void;

export interface DriveResult {
  runId: string;
  finalState: FadeRunState;
  /** Segments the driver advanced THROUGH this call (resume-friendly log). */
  segmentsRun: FadeRunState[];
  /** Closing-gate verdict face (S4 唯一通道). */
  gated: boolean;
  gateDetail?: string;
  gateOutput?: string;
}

const FORWARD_CHAIN: readonly FadeRunState[] = [
  "DETECTED", "QUALIFYING", "PLANNING", "PLANNED", "EXECUTING",
  "VERIFYING", "SCORING", "CLOSING", "FINALIZING",
];

function nextStateOf(state: FadeRunState): FadeRunState | undefined {
  const idx = FORWARD_CHAIN.indexOf(state);
  if (idx === -1 || idx === FORWARD_CHAIN.length - 1) return undefined;
  return FORWARD_CHAIN[idx + 1]!;
}

function workerKeyFor(state: FadeRunState): DriverWorkerKey | undefined {
  switch (state) {
    case "QUALIFYING": return "qualify";
    case "PLANNING": return "plan";
    case "EXECUTING": return "dce";
    case "VERIFYING": return "verify";
    case "SCORING": return "score";
    case "CLOSING": return "close";
    default: return undefined; // DETECTED/PLANNED/FINALIZING: no worker
  }
}

function nowIso(): string {
  return new Date().toISOString(); // R4.3: in-process native
}

/** §2.7-compliant node report (nine keys, non-empty arrays, prose sections). */
function renderSegmentReport(opts: {
  nodeId: string; title: string; segment: string; runId: string; body?: string;
}): string {
  const { nodeId, title, segment, runId, body } = opts;
  return `# ${title}

\`\`\`json
{
  "nodeId": "${nodeId}",
  "agent": "fade-driver",
  "startedAt": "${nowIso()}",
  "finishedAt": "${nowIso()}",
  "baselineCommit": "fade-run:${runId}",
  "trigger": "programmatic (${segment} segment, FADE-011 S5 driver)",
  "actions": [{"t": "${segment}", "act": "segment work completed programmatically"}],
  "artifacts": [{"path": "run-tree:${runId}/${segment}", "note": "segment product"}],
  "gateResults": [{"gate": "${segment} segment work", "result": "PASS"}]
}
\`\`\`

## 异常与处置
无（程序化段工作零异常）。

## 断点交接
段 ${segment} 完成，checkpoint 已落 store。

## 使用依据
FADE-011 S5 driver（排期单 cd1a13f6c §四 S5·spec §1.1 十段链）。
${body ?? ""}`;
}

function defaultWorkers(): Record<DriverWorkerKey, SegmentWorker> {
  return {
    qualify: (ctx) => {
      if (!existsSync(ctx.treeDir)) {
        throw new FadeDriverError("TREE_DIR_MISSING", `run treeDir missing: ${ctx.treeDir}`);
      }
      mkdirSync(ctx.reportsDir, { recursive: true });
      ctx.writeReport("node-qualify.md", "Qualify 段报告（程序化）", "资格判定：treeDir 在位可写。");
    },
    plan: (ctx) => {
      // Plan Skill structured output 候件（无 tri-fade011-plan SKILL.md）——
      // plan 段 MVP=计划文档落树+合规报告；schema 门候 plan skill 立法。
      writeFileSync(ctx.treeAbsPath("plan.md"), `# Run Plan（${ctx.runId}）\n\n- 程序化计划产物（FADE-011 S5 driver MVP）\n- treeDir: ${ctx.treeDir}\n`, "utf-8");
      ctx.writeReport("node-plan.md", "Plan 段报告（程序化）", "plan.md 落树（Plan Skill schema 门候件·worker 注入点在案）。");
    },
    dce: (ctx) => {
      // DCE = the non-idempotent segment (S1 §8.1 L445). MVP product: a file
      // rewrite inside the run tree (isolated side effect).
      const artifact = ctx.treeAbsPath("artifacts");
      mkdirSync(artifact, { recursive: true });
      writeFileSync(join(artifact, "dce-output.md"), `# DCE 产物（${ctx.runId}）\n\n- 程序化执行产物（确定性最小形）\n`, "utf-8");
      ctx.writeReport("node-dce.md", "DCE 段报告（程序化）", "artifacts/dce-output.md 落树。");
    },
    verify: (ctx) => {
      const product = join(ctx.treeAbsPath("artifacts"), "dce-output.md");
      if (!existsSync(product)) {
        throw new FadeDriverError("DCE_PRODUCT_MISSING", `verify 段读回失败: ${product}`);
      }
      const content = readFileSync(product, "utf-8");
      if (!content.includes("DCE 产物")) {
        throw new FadeDriverError("DCE_PRODUCT_UNRECOGNIZED", `verify 段内容校验失败: ${product}`);
      }
      ctx.writeReport("node-verify.md", "Verify 段报告（程序化）", "DCE 产物读回校验通过。");
    },
    score: async (ctx) => {
      const def = await loadScoreSkill();
      const output = {
        schema: "tri-fade011-score/v1.0",
        run_id: ctx.runId,
        question_id: "auto",
        required: true,
        answered: true,
        scores: [{ item: "auto", dim: "准确性", score: 1.0, reason: "程序化段工作全过", evidence_ref: "reports/node-verify.md" }],
        aggregated: { 准确性: 1.0, 完备性: 1.0, 文风口径一致: 1.0, 合成: 1.0 },
        divergence: false,
        reviewers: {
          cos: { scores: { 合成: 1.0 }, reason_first: "程序化评分（MVP）" },
          cao: { scores: { 合成: 1.0 }, reason_first: "程序化评分（MVP）" },
        },
        scored_at: nowIso(),
      };
      const parsed = parseSkillOutput(def, JSON.stringify(output));
      if (!parsed.ok) {
        throw new FadeDriverError("SCORE_OUTPUT_INVALID", `score skill 输出校验拒: ${JSON.stringify(parsed.errors)}`);
      }
      writeFileSync(join(ctx.reportsDir, "score-output.json"), JSON.stringify(output, null, 2), "utf-8");
      ctx.writeReport("node-score.md", "Score 段报告（程序化）", "score skill 输出结构校验过（S3 装载器）。");
    },
    close: async (ctx) => {
      const def = await loadCloseSkill();
      const output = {
        schema: "tri-fade011-close/v1.0",
        run_id: ctx.runId,
        verdict: "APPROVED",
        gate_check: { score_total: 100, threshold: 90, required_all_passed: true, hash_match: true },
        evidence_refs: ["reports/score-output.json", "reports/node-verify.md"],
        pending_list: { items: [], owner: "", backfill_at: "" },
        decided_by: "fade-driver",
        decided_at: nowIso(),
      };
      const parsed = parseSkillOutput(def, JSON.stringify(output));
      if (!parsed.ok) {
        throw new FadeDriverError("CLOSE_OUTPUT_INVALID", `close skill 输出校验拒: ${JSON.stringify(parsed.errors)}`);
      }
      writeFileSync(join(ctx.reportsDir, "close-output.json"), JSON.stringify(output, null, 2), "utf-8");
      ctx.writeReport("node-close.md", "Close 段报告（程序化）", "close skill 四态裁决=APPROVED（结构校验过·S3 装载器）。");
    },
  };
}

// Skill definitions load lazily per call (single loading channel — S3).
let skillCache: { score: FadeSkillDefinition; close: FadeSkillDefinition } | null = null;
let skillCacheRoot = "";
async function loadScoreSkill(): Promise<FadeSkillDefinition> {
  if (!skillCache || skillCacheRoot !== resolveTriSkillSkillsRoot()) {
    skillCache = loadFade011Skills(resolveTriSkillSkillsRoot());
    skillCacheRoot = resolveTriSkillSkillsRoot();
  }
  return skillCache.score;
}
async function loadCloseSkill(): Promise<FadeSkillDefinition> {
  if (!skillCache || skillCacheRoot !== resolveTriSkillSkillsRoot()) {
    skillCache = loadFade011Skills(resolveTriSkillSkillsRoot());
    skillCacheRoot = resolveTriSkillSkillsRoot();
  }
  return skillCache.close;
}

/** Drive one run from its CURRENT state to a terminal state (or stop at
 * FINALIZING with gated:false when the §2.7 gate refuses). The closing flip
 * goes through finalizeWithGate ONLY — this function never calls
 * store.advanceRun with a terminal target (绕闸防御·唯一通道). */
export async function driveRun(
  store: FadeStore,
  runId: string,
  meta: FadeRunTreeMeta,
  opts: FadeDriverOptions = {},
): Promise<DriveResult> {
  const run = store.getRun(runId);
  if (!run) throw new FadeDriverError("RUN_NOT_FOUND", `run not found: ${runId}`);
  if (isTerminal(run.state)) {
    return { runId, finalState: run.state, segmentsRun: [], gated: true };
  }

  const treeDir = resolve(meta.treeDir);
  const reportsDir = resolve(meta.reportsDir ?? join(treeDir, "reports"));
  // 统一建树：resume 场景可能从链中段进入（前段 worker 未跑）——reports/
  // 是所有 worker 写报告/技能输出的共享前提，入口建一次（幂等 recursive）。
  mkdirSync(reportsDir, { recursive: true });
  const workers = { ...defaultWorkers(), ...opts.workers };

  const ctx: SegmentWorkerContext = {
    runId,
    meta: { ...meta, treeDir, reportsDir },
    treeDir,
    reportsDir,
    writeReport: (name, title, body) => {
      mkdirSync(reportsDir, { recursive: true });
      const md = renderSegmentReport({ nodeId: name.replace(/\.md$/, ""), title, segment: name, runId, body });
      const path = join(reportsDir, name);
      writeFileSync(path, md, "utf-8");
      return path;
    },
    treeAbsPath: (rel) => join(treeDir, rel),
  };

  const segmentsRun: FadeRunState[] = [];
  let current = store.getRun(runId)!.state;

  while (!isTerminal(current)) {
    if (current === "FINALIZING") {
      const gate = await finalizeWithGate(store, runId, "APPROVED", {
        reportsDir,
        tmvRepoRoot: opts.tmvRepoRoot,
        pythonExecutable: opts.pythonExecutable,
        timeoutMs: opts.timeoutMs,
      });
      if (gate.gated) {
        // FINALIZING→APPROVED 的 gate 翻转记录 APPROVED（FINALIZING 已由
        // CLOSING→FINALIZING 的 advance 记过·不重复计数）。
        segmentsRun.push("APPROVED");
        opts.onSegment?.(gate.run, "APPROVED");
        return {
          runId,
          finalState: "APPROVED",
          segmentsRun,
          gated: true,
          gateOutput: gate.gateOutput,
        };
      }
      // §2.7 refused flip — terminal unreachable (绕闸防御负向形态).
      return {
        runId,
        finalState: gate.state,
        segmentsRun,
        gated: false,
        gateDetail: gate.detail,
        ...(gate.exitCode !== undefined ? { gateOutput: `exit=${gate.exitCode}` } : {}),
      };
    }

    const key = workerKeyFor(current);
    if (key) {
      await workers[key](ctx);
    }
    const next = nextStateOf(current);
    if (!next) {
      throw new FadeDriverError("NO_FORWARD_EDGE", `no forward edge from ${current}`);
    }
    const advanced = store.advanceRun(runId, next);
    // checkpoint 载树元数据（S1 既有恢复语义字段·零 schema 变更）——daemon
    // 重启后 resumeUnfinishedRuns 从 checkpoint 读回 treeDir/reportsDir（run
    // 元数据贯通·D-24 零硬编码）。
    store.setCheckpoint(runId, JSON.stringify({
      segment: next, at: nowIso(), treeDir, reportsDir,
    }));
    segmentsRun.push(next);
    opts.onSegment?.(advanced, next);
    current = advanced.state;
    if (opts.segmentDelayMs && opts.segmentDelayMs > 0 && !isTerminal(current) && current !== "FINALIZING") {
      await new Promise((r) => setTimeout(r, opts.segmentDelayMs));
    }
  }

  return { runId, finalState: current, segmentsRun, gated: true };
}

export interface CreateAndDriveInput extends FadeRunInput {
  meta: FadeRunTreeMeta;
}

/** Trigger entry: register a run (idempotency-key dedupe) and drive it. */
export async function createAndDriveRun(
  store: FadeStore,
  input: CreateAndDriveInput,
  opts: FadeDriverOptions = {},
): Promise<{ created: boolean; result: DriveResult }> {
  const { created, run } = store.createRun(input);
  const result = await driveRun(store, run.runId, input.meta, opts);
  return { created, result };
}

export interface ResumeSummary {
  attempted: number;
  terminalReached: string[];
  stopped: { runId: string; state: FadeRunState; detail: string }[];
  failed: { runId: string; error: string }[];
}

/** Boot-sweep follow-up: drive every unfinished run forward (per-run fail-soft,
 * S2 recovery 同形). Run-tree metadata is read back from the checkpoint the
 * driver wrote per segment (S1 既有恢复语义字段·零 schema 变更) — a run
 * without a driver checkpoint (killed before the first advance) is reported
 * failed with an explicit reason, never silently dropped. Runs whose gate
 * refuses stop at FINALIZING (visible, not silent — S4 rejection ledger). */
export async function resumeUnfinishedRuns(
  store: FadeStore,
  opts: FadeDriverOptions = {},
): Promise<ResumeSummary> {
  const summary: ResumeSummary = { attempted: 0, terminalReached: [], stopped: [], failed: [] };
  for (const run of store.listUnfinishedRuns()) {
    summary.attempted += 1;
    const meta = metaFromCheckpoint(run);
    if (!meta) {
      summary.failed.push({
        runId: run.runId,
        error: `no run-tree metadata in checkpoint (state=${run.state}, checkpoint=${run.checkpoint ?? "null"})`,
      });
      continue;
    }
    try {
      const result = await driveRun(store, run.runId, meta, opts);
      if (isTerminal(result.finalState)) summary.terminalReached.push(run.runId);
      else summary.stopped.push({ runId: run.runId, state: result.finalState, detail: result.gateDetail ?? "" });
    } catch (err) {
      summary.failed.push({ runId: run.runId, error: (err as Error).message });
    }
  }
  return summary;
}

/** Parse the tree metadata a previous driveRun left in the checkpoint. */
export function metaFromCheckpoint(run: Pick<FadeRunRecord, "checkpoint">): FadeRunTreeMeta | null {
  if (!run.checkpoint) return null;
  try {
    const parsed = JSON.parse(run.checkpoint) as { treeDir?: unknown; reportsDir?: unknown };
    if (typeof parsed.treeDir !== "string" || parsed.treeDir.length === 0) return null;
    return {
      treeDir: parsed.treeDir,
      ...(typeof parsed.reportsDir === "string" && parsed.reportsDir.length > 0
        ? { reportsDir: parsed.reportsDir }
        : {}),
    };
  } catch {
    return null;
  }
}

export { TERMINAL_STATES };
