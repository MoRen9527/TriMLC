// FADE-011 Phase 2 S5 — in-process driver tests (ten-segment full chain +
// 绕闸防御 negative path + resume + fail-soft).
// 实锚①: full chain DETECTED→…→FINALIZING→gate→APPROVED with all segment
//         reports §2.7-compliant (gate re-runs the real checker — dev 真仓在位).
// 实锚②: 绕闸防御 (S4 debt → S5 obligation, CTO ruling) — a bad closing
//         report makes the terminal UNREACHABLE: gated:false, run stuck at
//         FINALIZING, rejection ledger row, zero terminal audit rows.
// 实锚③: the ONLY transition into a terminal state in the whole chain is the
//         finalizeWithGate one (actor=finalize, reason cites §2.7 PASS).
// 实锚④: resume — checkpoint-carried tree metadata lets resumeUnfinishedRuns
//         drive a mid-chain run to APPROVED; a run without driver checkpoint
//         metadata is reported failed (explicit, never silently dropped).
// Form: process-internal (no daemon spawn) — the process-level two-round
// acceptance gate lives in fade-kill-drive.test.ts (排期单 §五 BOD 照立).
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createFadeStore, type FadeStore } from "../src/fade/store.js";
import {
  driveRun, createAndDriveRun, resumeUnfinishedRuns, metaFromCheckpoint,
  FadeDriverError, type FadeRunTreeMeta, type SegmentWorkerContext,
} from "../src/fade/driver.js";
import { runClosingGate, resolveTmvRepoRoot } from "../src/fade/closing-gate.js";
import { FadeSkillLoadError } from "../src/fade/skill-loader.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// R2.1: heaviest IO per drive = the closing gate (S4 upper bound 30s) — this
// suite drives N runs sequentially, so the whole-suite wall-clock bound is
// explicit: 4 runs × (ms-level segments + ≤30s gate).
const SUITE_GATE_BUDGET_MS = 130_000;

function makeRunInput(runId: string, idempotencyKey?: string) {
  return {
    runId,
    idempotencyKey: idempotencyKey ?? `idem-${runId}`,
    profile: "runtime-owned-durable" as const,
    homeDomain: "M-plane-local",
    writeAuthority: "daemon:trmlc",
    authorityEpoch: 1,
    version: "fade011-s5-driver",
  };
}

interface AuditRow { fromState: string | null; toState: string; actor: string; reason: string }

function auditRows(dbPath: string, runId: string): AuditRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(
      "SELECT from_state, to_state, actor, reason FROM fade_run_transitions WHERE run_id = ? ORDER BY seq",
    ).all(runId) as unknown as Array<{
      from_state: string | null; to_state: string; actor: string; reason: string;
    }>).map((r) => ({ fromState: r.from_state, toState: r.to_state, actor: r.actor, reason: r.reason }));
  } finally {
    db.close();
  }
}

function runRow(dbPath: string, runId: string): { state: string; checkpoint: string | null } {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT state, checkpoint FROM fade_runs WHERE run_id = ?").get(runId) as
      | { state: string; checkpoint: string | null } | undefined;
    assert.ok(row, `run ${runId} missing`);
    return { state: row.state, checkpoint: row.checkpoint };
  } finally {
    db.close();
  }
}

describe("fade driver (in-process)", () => {
  const dirs: string[] = [];
  const dbPaths: string[] = [];
  const stores: FadeStore[] = [];

  function freshCtx(): { store: FadeStore; dbPath: string; treeDir: string; reportsDir: string; meta: FadeRunTreeMeta } {
    const dataDir = mkdtempSync(join(tmpdir(), "trimlc-fade-driver-"));
    const treeDir = mkdtempSync(join(tmpdir(), "trimlc-fade-driver-tree-"));
    dirs.push(dataDir, treeDir);
    const dbPath = join(dataDir, "fade.db");
    const store = createFadeStore(dbPath);
    stores.push(store);
    dbPaths.push(dbPath);
    const meta: FadeRunTreeMeta = { treeDir };
    return { store, dbPath, treeDir, reportsDir: join(treeDir, "reports"), meta };
  }

  before(async () => {
    // 真仓可用性前置（S4 同形双 probe）：① checker 脚本在 dev 真仓在位
    // ② python 解释器可用。环境事实缺位=显式失败（不静默变形为链败）。
    const checker = join(resolveTmvRepoRoot(), "scripts", "node_report_check.py");
    assert.ok(existsSync(checker), `dev TriMetaverse checker missing: ${checker}`);
    const py = spawnSync("python", ["-c", "import sys; sys.exit(0)"], { timeout: 10_000 });
    assert.equal(py.status, 0, `python interpreter probe failed (status=${py.status})`);
  });

  test("full chain: DETECTED→…→FINALIZING→gate→APPROVED, reports compliant, audit cites §2.7 PASS", async () => {
    const { store, dbPath, treeDir, reportsDir, meta } = freshCtx();
    const { created, result } = await createAndDriveRun(store, { ...makeRunInput("drv-full-1"), meta });

    assert.equal(created, true);
    assert.equal(result.finalState, "APPROVED");
    assert.equal(result.gated, true);
    // ten segments traversed: 8 forward advances + FINALIZING gate flip
    assert.deepEqual(result.segmentsRun, [
      "QUALIFYING", "PLANNING", "PLANNED", "EXECUTING",
      "VERIFYING", "SCORING", "CLOSING", "FINALIZING", "APPROVED",
    ]);

    // segment products: every driver-written report exists and the tree
    // carries plan + DCE artifact + synthetic skill outputs
    const files = readdirSync(reportsDir).sort();
    for (const seg of ["qualify", "plan", "dce", "verify", "score", "close"]) {
      assert.ok(files.includes(`node-${seg}.md`), `node-${seg}.md missing in ${reportsDir}`);
    }
    assert.ok(existsSync(join(treeDir, "plan.md")), "plan.md missing");
    assert.ok(existsSync(join(treeDir, "artifacts", "dce-output.md")), "dce artifact missing");
    assert.ok(existsSync(join(reportsDir, "score-output.json")), "score-output.json missing");
    assert.ok(existsSync(join(reportsDir, "close-output.json")), "close-output.json missing");

    // S5.1 plan 真身接线实锚: plan-output.json schema 门过 + DCE 输入 hash
    // 对表（立法放行条件④: DCE 输入=方案卷 sha256 内容 hash）+ 可达性两通道
    assert.ok(existsSync(join(reportsDir, "plan-output.json")), "plan-output.json missing (S5.1 plan skill gate)");
    const planOut = JSON.parse(readFileSync(join(reportsDir, "plan-output.json"), "utf-8")) as {
      schema: string; release: { dce_input: string }; skill_reachability: { run_registry_pointer: boolean; agents_md_mapping: boolean };
    };
    assert.equal(planOut.schema, "tri-fade011-plan/v1.0");
    const planMdOnDisk = readFileSync(join(treeDir, "plan.md"), "utf-8");
    assert.equal(
      planOut.release.dce_input,
      createHash("sha256").update(planMdOnDisk, "utf8").digest("hex"),
      "release.dce_input must equal sha256(plan.md content) — 立法放行条件④",
    );
    assert.equal(planOut.skill_reachability.run_registry_pointer, true);
    assert.equal(planOut.skill_reachability.agents_md_mapping, true);

    // 编排层门复跑（验收门③形态）: real checker against the run tree — RC=0
    const gate = await runClosingGate({ reportsDir });
    assert.equal(gate.ok, true, `orchestration gate rerun failed: ${gate.detail}`);

    // 实锚③: exactly ONE terminal transition, via finalize, citing §2.7 PASS
    const rows = auditRows(dbPath, "drv-full-1");
    const terminalRows = rows.filter((r) => r.toState === "APPROVED");
    assert.equal(terminalRows.length, 1, "terminal APPROVED flip must happen exactly once");
    assert.equal(terminalRows[0]!.actor, "finalize");
    assert.match(terminalRows[0]!.reason, /closing gate PASS \(§2\.7 RC=0\)/);
    // no other row targets a terminal state
    const nonFinalizeTerminal = rows.filter(
      (r) => r.toState !== "APPROVED" && ["APPROVED", "FROZEN", "ESCALATED", "RETRY"].includes(r.toState),
    );
    assert.equal(nonFinalizeTerminal.length, 0, "non-finalize terminal flips are forbidden");
    // checkpoint carries tree metadata (resume 面贯通证据)
    const row = runRow(dbPath, "drv-full-1");
    const cp = JSON.parse(row.checkpoint ?? "{}") as { treeDir?: string; reportsDir?: string };
    assert.equal(cp.treeDir, resolve(treeDir));
    assert.equal(cp.reportsDir, resolve(reportsDir));
  }, SUITE_GATE_BUDGET_MS);

  test("绕闸防御: bad closing report → gated:false, stuck at FINALIZING, zero terminal rows", async () => {
    const { store, dbPath, reportsDir, meta } = freshCtx();
    store.createRun(makeRunInput("drv-guard-1"));
    const poisonClose = (ctx: SegmentWorkerContext): void => {
      // a §2.7-noncompliant report (one key instead of nine) — the checker
      // MUST refuse the flip
      writeFileSync(
        join(ctx.reportsDir, "node-close.md"),
        "# Close 段报告（坏形）\n\n```json\n{\"nodeId\": \"node-close\"}\n```\n\n## 异常与处置\n坏报告注入（绕闸防御测试）。\n\n## 断点交接\n无。\n\n## 使用依据\n绕闸防御负向测试。\n",
        "utf-8",
      );
    };
    const result = await driveRun(store, "drv-guard-1", meta, { workers: { close: poisonClose } });

    // terminal UNREACHABLE — this is the S4 debt repaid as a mechanical fact
    assert.equal(result.gated, false);
    assert.equal(result.finalState, "FINALIZING", "run must stay at FINALIZING when the gate refuses");
    assert.ok((result.gateDetail ?? "").length > 0, "gate rejection detail must be surfaced");
    const row = runRow(dbPath, "drv-guard-1");
    assert.equal(row.state, "FINALIZING");

    // rejection ledger: exactly one row, gate name as S4 fixed
    const db = new DatabaseSync(dbPath);
    const rejections = (db.prepare(
      "SELECT gate, reason FROM fade_gate_rejections WHERE run_id = ?",
    ).all("drv-guard-1") as unknown as Array<{ gate: string; reason: string }>);
    db.close();
    assert.equal(rejections.length, 1);
    assert.equal(rejections[0]!.gate, "closing-report-check");
    assert.equal(rejections[0]!.reason, "checker-fail");

    // zero terminal audit rows — nothing bypassed the gate
    const rows = auditRows(dbPath, "drv-guard-1");
    assert.equal(
      rows.filter((r) => ["APPROVED", "FROZEN", "ESCALATED", "RETRY"].includes(r.toState)).length,
      0,
      "no terminal flip may exist when the closing gate refuses",
    );
    assert.ok(reportsDir.length > 0);
  }, SUITE_GATE_BUDGET_MS);

  test("resume: checkpoint-carried metadata drives a mid-chain run to APPROVED; metadata-less runs reported failed", async () => {
    const { store, dbPath, treeDir, meta } = freshCtx();

    // run A: seed to SCORING with a driver-shaped checkpoint (as if killed
    // mid-chain), tree metadata in the checkpoint
    store.createRun({ ...makeRunInput("drv-resume-a") });
    store.advanceRun("drv-resume-a", "QUALIFYING");
    store.advanceRun("drv-resume-a", "PLANNING");
    store.advanceRun("drv-resume-a", "PLANNED");
    store.advanceRun("drv-resume-a", "EXECUTING");
    store.advanceRun("drv-resume-a", "VERIFYING");
    store.advanceRun("drv-resume-a", "SCORING");
    store.setCheckpoint("drv-resume-a", JSON.stringify({
      segment: "SCORING", at: "seed", treeDir: resolve(treeDir), reportsDir: join(resolve(treeDir), "reports"),
    }));

    // run B: unfinished with NO driver checkpoint (killed before first advance)
    store.createRun({ ...makeRunInput("drv-resume-b") });

    const summary = await resumeUnfinishedRuns(store);
    assert.equal(summary.attempted, 2);
    assert.deepEqual(summary.terminalReached, ["drv-resume-a"]);
    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0]!.runId, "drv-resume-b");
    assert.match(summary.failed[0]!.error, /no run-tree metadata in checkpoint/);

    const row = runRow(dbPath, "drv-resume-a");
    assert.equal(row.state, "APPROVED", "mid-chain run must reach APPROVED via the resumed gate flip");
    // b untouched (fail-soft per run)
    assert.equal(runRow(dbPath, "drv-resume-b").state, "DETECTED");
  }, SUITE_GATE_BUDGET_MS);

  test("metaFromCheckpoint: parses driver checkpoints; null on missing/bad shapes", () => {
    assert.deepEqual(
      metaFromCheckpoint({ checkpoint: JSON.stringify({ segment: "CLOSING", treeDir: "T", reportsDir: "R" }) }),
      { treeDir: "T", reportsDir: "R" },
    );
    assert.deepEqual(
      metaFromCheckpoint({ checkpoint: JSON.stringify({ segment: "CLOSING", treeDir: "T" }) }),
      { treeDir: "T" },
    );
    assert.equal(metaFromCheckpoint({ checkpoint: null }), null);
    assert.equal(metaFromCheckpoint({ checkpoint: "not-json" }), null);
    assert.equal(metaFromCheckpoint({ checkpoint: JSON.stringify({ segment: "CLOSING" }) }), null);
    assert.equal(metaFromCheckpoint({ checkpoint: JSON.stringify({ treeDir: "" }) }), null);
  });

  test("idempotent re-trigger: same idempotencyKey returns the existing terminal run", async () => {
    const { store, meta } = freshCtx();
    const first = await createAndDriveRun(store, {
      ...makeRunInput("drv-idem-1", "idem-fixed"), meta,
    });
    assert.equal(first.created, true);
    assert.equal(first.result.finalState, "APPROVED");

    const second = await createAndDriveRun(store, {
      ...makeRunInput("drv-idem-2", "idem-fixed"), meta,
    });
    assert.equal(second.created, false, "same idempotency key must dedupe");
    assert.equal(second.result.finalState, "APPROVED", "existing terminal run returned as-is");
  }, SUITE_GATE_BUDGET_MS);

  // ── S5.1 plan 真身接线·负路径（brief 门禁 2·禁替身）─────────────────────
  // fake root 形: <tmp>/skills/engineering — resolveTriSkillAgentsMd(root)
  // = <tmp>/AGENTS.md（隔离在 tmp 内·禁触真实 TriSkill）。

  function makeFakeSkillsRoot(opts: { packages: string[]; agentsMdLine?: string | null }): string {
    const base = mkdtempSync(join(tmpdir(), "trimlc-fade-skillroot-"));
    dirs.push(base);
    const root = join(base, "skills", "engineering");
    const realRoot = resolve(REPO_ROOT, "..", "TriSkill", "skills", "engineering");
    for (const pkg of opts.packages) {
      cpSync(join(realRoot, pkg), join(root, pkg), { recursive: true });
    }
    if (opts.agentsMdLine !== null) {
      // channel ②载体在位（默认含 plan 行；传 null = 不写文件·通道缺位）
      writeFileSync(
        join(base, "AGENTS.md"),
        `# TriSkill skill 映射表\n\n| tri-fade011-plan | ${opts.agentsMdLine ?? "FADE Plan 段"} | FADE ④ |\n`,
        "utf-8",
      );
    }
    return root;
  }

  test("S5.1 negative a: plan package missing → NOT_FOUND FAIL-EXPECTED, run stuck at PLANNING, zero stand-in products", async () => {
    const { store, dbPath, treeDir, reportsDir, meta } = freshCtx();
    const fakeRoot = makeFakeSkillsRoot({ packages: ["tri-fade011-score", "tri-fade011-close"] });

    await assert.rejects(
      createAndDriveRun(store, { ...makeRunInput("drv-plan-missing"), meta }, { skillsRoot: fakeRoot }),
      (err: unknown) => err instanceof FadeSkillLoadError && err.code === "NOT_FOUND",
      "missing plan SKILL.md must throw NOT_FOUND (Unknown skill = FAIL-EXPECTED)",
    );
    // 段失败可见: run 停在 PLANNING（worker throw 于 advance 前）
    assert.equal(runRow(dbPath, "drv-plan-missing").state, "PLANNING");
    // 禁替身: 零替身产物（无 plan.md / plan-output.json / node-plan.md）
    assert.ok(!existsSync(join(treeDir, "plan.md")), "no stand-in plan.md may exist");
    assert.ok(!existsSync(join(reportsDir, "plan-output.json")), "no stand-in plan-output.json may exist");
    const files = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
    assert.ok(!files.includes("node-plan.md"), "no stand-in node-plan.md may exist");
  });

  test("S5.1 negative b: AGENTS.md mapping line missing → SKILL_REACHABILITY_FAIL (禁替身·如实 FAIL-EXPECTED)", async () => {
    const { store, dbPath, treeDir, reportsDir, meta } = freshCtx();
    const fakeRoot = makeFakeSkillsRoot({ packages: ["tri-fade011-score", "tri-fade011-close", "tri-fade011-plan"], agentsMdLine: null });

    await assert.rejects(
      createAndDriveRun(store, { ...makeRunInput("drv-plan-unreachable"), meta }, { skillsRoot: fakeRoot }),
      (err: unknown) => {
        assert.ok(err instanceof FadeDriverError, `expected FadeDriverError, got ${String(err)}`);
        assert.equal(err.code, "SKILL_REACHABILITY_FAIL");
        assert.match(err.message, /agents_md_mapping=false/);
        return true;
      },
      "missing AGENTS.md mapping line must fail the reachability check visibly",
    );
    assert.equal(runRow(dbPath, "drv-plan-unreachable").state, "PLANNING");
    assert.ok(!existsSync(join(reportsDir, "plan-output.json")), "reachability FAIL must refuse to release plan products");
  });

  test("S5.1 negative c: poisoned plan schema (extra required key) → PLAN_OUTPUT_INVALID, gate is no rubber stamp", async () => {
    const { store, dbPath, treeDir, reportsDir, meta } = freshCtx();
    const fakeRoot = makeFakeSkillsRoot({ packages: ["tri-fade011-score", "tri-fade011-close", "tri-fade011-plan"] });
    // 注入额外必填键 → worker output 缺该键 → 结构门必须拒（证明非橡皮图章）
    const skillMdPath = join(fakeRoot, "tri-fade011-plan", "SKILL.md");
    const poisoned = readFileSync(skillMdPath, "utf-8").replace(
      '"release": {',
      '"extra_required_gate": "<must-fail-missing-key>",\n  "release": {',
    );
    assert.notEqual(poisoned, readFileSync(skillMdPath, "utf-8"), "poison injection must take effect");
    writeFileSync(skillMdPath, poisoned, "utf-8");

    await assert.rejects(
      createAndDriveRun(store, { ...makeRunInput("drv-plan-poison"), meta }, { skillsRoot: fakeRoot }),
      (err: unknown) => {
        assert.ok(err instanceof FadeDriverError, `expected FadeDriverError, got ${String(err)}`);
        assert.equal(err.code, "PLAN_OUTPUT_INVALID");
        assert.match(err.message, /extra_required_gate/);
        return true;
      },
      "a poisoned plan schema must make the structural gate refuse the segment",
    );
    assert.equal(runRow(dbPath, "drv-plan-poison").state, "PLANNING");
    // 拒后不落盘: plan.md 已落树（结构门前的方案卷）·plan-output.json 不在
    assert.ok(existsSync(join(treeDir, "plan.md")), "plan.md lands before the gate");
    assert.ok(!existsSync(join(reportsDir, "plan-output.json")), "refused output must not be persisted");
  });

  after(async () => {
    for (const s of stores) { try { s.close(); } catch { /* already closed */ } }
    await new Promise((res) => setTimeout(res, 300));
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
    }
  });
});
