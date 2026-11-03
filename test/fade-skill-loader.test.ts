// FADE-011 Phase 2 S3 — skill loader tests: load + per-key validation +
// negative paths (missing key / type mismatch / non-JSON) + env dataDir guard.
// Law: S3 brief gate (458a302e6 §二); spec §2.6/§2.7/§7.4; 排期单 §七 风险③.
import { describe, test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadFadeSkill, loadFade011Skills, resolveTriSkillSkillsRoot,
  parseSkillOutput, validateSkillOutput,
  FadeSkillLoadError,
} from "../src/fade/skill-loader.js";
import { readEnv } from "../src/config/env.js";

let tmpDir = "";
const SAVED_DATA_DIR = process.env.TRILC_DATA_DIR;

function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), body, "utf-8");
}

const GOOD_SKILL = `---
name: tri-test-skill
description: fixture skill for loader tests
disable-model-invocation: true
---

# Test skill

## 输出 schema（v1.0）

\`\`\`json
{
  "schema": "tri-test/v1.0",
  "run_id": "<run 标识>",
  "verdict": "A|B|C",
  "gate_check": { "score_total": 0.0, "ok": true },
  "tags": ["<t>"]
}
\`\`\`
`;

const BROKEN_JSON_SKILL = `---
name: tri-bad-json
description: broken schema fence
---

## 输出 schema（v1.0）

\`\`\`json
{ "schema": "bad/v1", "k":
\`\`\`
`;

const NO_SCHEMA_SKILL = `---
name: tri-no-schema
description: no schema section at all
---

# Just prose
`;

// Valid instances matching the real v1.0 schemas (incl. CJK aggregated keys).
const GOOD_SCORE_OUTPUT = {
  schema: "tri-fade011-score/v1.0",
  run_id: "fade-s3-t1",
  question_id: "Q1",
  required: true,
  answered: true,
  scores: [{ item: "Q1", dim: "准确性", score: 0.9, reason: "一致", evidence_ref: "docs/a.md#L3" }],
  aggregated: { 准确性: 0.9, 完备性: 0.8, 文风口径一致: 1.0, 合成: 0.9 },
  divergence: false,
  reviewers: {
    cos: { scores: { 准确性: 0.9 }, reason_first: "r" },
    cao: { scores: { 准确性: 0.9 }, reason_first: "r" },
  },
  scored_at: "2026-11-04T00:00:00Z",
};

const GOOD_CLOSE_OUTPUT = {
  schema: "tri-fade011-close/v1.0",
  run_id: "fade-s3-t1",
  verdict: "APPROVED",
  gate_check: { score_total: 95, threshold: 90, required_all_passed: true, hash_match: true },
  evidence_refs: ["docs/workflow/x.md#L1"],
  pending_list: { items: [], owner: "", backfill_at: "" },
  decided_by: "m-cto",
  decided_at: "2026-11-04T00:00:00Z",
};

describe("fade skill loader — loading", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trilc-fade-s3-"));
  });

  test("loads a valid SKILL.md and infers the example-shaped schema", () => {
    writeSkill(tmpDir, "tri-test-skill", GOOD_SKILL);
    const def = loadFadeSkill(tmpDir, "tri-test-skill");
    assert.equal(def.name, "tri-test-skill");
    assert.equal(def.outputSchemaName, "tri-test/v1.0");
    // inferred required keys (schema name handled separately)
    assert.ok(def.spec.root.has("run_id"));
    assert.ok(def.spec.root.has("verdict"));
    assert.ok(def.spec.root.has("gate_check"));
    assert.ok(def.spec.root.has("tags"));
    // enum inference from "A|B|C" and "<t>" placeholder stripping
    assert.deepEqual(def.spec.root.get("verdict")!.enumValues, ["A", "B", "C"]);
    assert.equal(def.spec.root.get("run_id")!.enumValues, undefined);
    // nested object keys become required children
    const gc = def.spec.root.get("gate_check")!;
    assert.equal(gc.kind, "object");
    assert.ok(gc.children!.has("score_total"));
    assert.equal(gc.children!.get("score_total")!.kind, "number");
    assert.equal(gc.children!.get("ok")!.kind, "boolean");
    // array item rule
    assert.equal(def.spec.root.get("tags")!.kind, "array");
    assert.equal(def.spec.root.get("tags")!.itemRule!.kind, "string");
  });

  test("negative: broken schema fence → SCHEMA_NOT_JSON (非 JSON 面 gate)", () => {
    writeSkill(tmpDir, "tri-bad-json", BROKEN_JSON_SKILL);
    assert.throws(
      () => loadFadeSkill(tmpDir, "tri-bad-json"),
      (err: unknown) => err instanceof FadeSkillLoadError && err.code === "SCHEMA_NOT_JSON",
    );
  });

  test("negative: missing schema section → NO_SCHEMA_SECTION", () => {
    writeSkill(tmpDir, "tri-no-schema", NO_SCHEMA_SKILL);
    assert.throws(
      () => loadFadeSkill(tmpDir, "tri-no-schema"),
      (err: unknown) => err instanceof FadeSkillLoadError && err.code === "NO_SCHEMA_SECTION",
    );
  });

  test("negative: missing SKILL.md → NOT_FOUND", () => {
    assert.throws(
      () => loadFadeSkill(tmpDir, "tri-ghost"),
      (err: unknown) => err instanceof FadeSkillLoadError && err.code === "NOT_FOUND",
    );
  });

  test("real TriSkill rehearsal skills load clean (真身冒烟·skip when repo absent)", (t) => {
    const root = resolveTriSkillSkillsRoot();
    if (!existsSync(join(root, "tri-fade011-score", "SKILL.md"))) {
      t.skip("TriSkill repo not present");
      return;
    }
    const { score, close } = loadFade011Skills(root);
    assert.equal(score.outputSchemaName, "tri-fade011-score/v1.0");
    assert.equal(close.outputSchemaName, "tri-fade011-close/v1.0");
    // per-key readout: score root keys (schema handled separately by the validator)
    for (const k of ["run_id", "question_id", "required", "answered", "scores", "aggregated", "divergence", "reviewers", "scored_at"]) {
      assert.ok(score.spec.root.has(k), `score schema missing key: ${k}`);
    }
    for (const k of ["run_id", "verdict", "gate_check", "evidence_refs", "pending_list", "decided_by", "decided_at"]) {
      assert.ok(close.spec.root.has(k), `close schema missing key: ${k}`);
    }
    // R1.1: CJK dimension keys round-trip (aggregated keys are Unicode identifiers)
    assert.ok(score.spec.root.has("aggregated"));
    // dim in the OUTPUT SCHEMA fence is a free string ("dim": "") — the
    // <准确性|完备性|文风口径一致> enum shape lives in the evidence_ref format
    // section, not the schema section. Semantic dimension domain = the dual-
    // reviewer judgment layer (实例管载体), not this structural loader.
    const dimRule = score.spec.root.get("scores")!.itemRule!.children!.get("dim")!;
    assert.equal(dimRule.kind, "string");
    assert.equal(dimRule.enumValues, undefined);
    // close verdict domain = §8.3 four terminal states (pipe enum IS in the schema fence)
    assert.deepEqual(close.spec.root.get("verdict")!.enumValues, ["APPROVED", "FROZEN", "ESCALATED", "RETRY"]);
  });

  test("resolveTriSkillSkillsRoot: explicit override wins (trimmed)", () => {
    assert.equal(resolveTriSkillSkillsRoot("  /tmp/x  "), resolve("/tmp/x"));
  });
});

describe("fade skill loader — output instance validation", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "trilc-fade-s3-"));
    writeSkill(tmpDir, "tri-test-skill", GOOD_SKILL);
  });

  function scoreDef() {
    return loadFade011Skills(resolveTriSkillSkillsRoot()).score;
  }
  function closeDef() {
    return loadFade011Skills(resolveTriSkillSkillsRoot()).close;
  }

  test("valid score instance passes (CJK keys, nested reviewers)", () => {
    const r = validateSkillOutput(scoreDef(), GOOD_SCORE_OUTPUT);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  test("valid close instance passes (four-state verdict, nested gate_check)", () => {
    const r = validateSkillOutput(closeDef(), GOOD_CLOSE_OUTPUT);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  test("negative ① missing required key (close without verdict)", () => {
    const broken: Record<string, unknown> = { ...GOOD_CLOSE_OUTPUT };
    delete broken["verdict"];
    const r = validateSkillOutput(closeDef(), broken);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "missing-key" && e.path === "verdict"), JSON.stringify(r.errors));
  });

  test("negative ② type mismatch (score as string, threshold as string)", () => {
    const broken = {
      ...GOOD_SCORE_OUTPUT,
      scores: [{ ...GOOD_SCORE_OUTPUT.scores[0]!, score: "0.9" }],
    };
    const r = validateSkillOutput(scoreDef(), broken);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "type-mismatch" && e.path === "scores[0].score"), JSON.stringify(r.errors));
    const broken2 = {
      ...GOOD_CLOSE_OUTPUT,
      gate_check: { ...GOOD_CLOSE_OUTPUT.gate_check, threshold: "90" },
    };
    const r2 = validateSkillOutput(closeDef(), broken2);
    assert.ok(r2.errors.some((e) => e.code === "type-mismatch" && e.path === "gate_check.threshold"), JSON.stringify(r2.errors));
  });

  test("negative ②b enum violation (verdict outside four-state domain)", () => {
    const broken = { ...GOOD_CLOSE_OUTPUT, verdict: "OK" };
    const r = validateSkillOutput(closeDef(), broken);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === "enum-violation" && e.path === "verdict"), JSON.stringify(r.errors));
  });

  test("boundary: unknown dim passes structurally (semantic domain = reviewer layer, 实例管载体)", () => {
    // The output-schema fence types dim as a free string; dimension-value
    // policing belongs to the score skill's dual-reviewer judgment, not the
    // structural loader. This pins the boundary explicitly.
    const unknownDim = {
      ...GOOD_SCORE_OUTPUT,
      scores: [{ ...GOOD_SCORE_OUTPUT.scores[0]!, dim: "胡说维度" }],
    };
    const r = validateSkillOutput(scoreDef(), unknownDim);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  test("negative ③ non-JSON instance via parseSkillOutput", () => {
    const r = parseSkillOutput(closeDef(), "{ this is not json");
    assert.equal(r.ok, false);
    assert.match(r.errors[0]!.detail, /not valid JSON/);
  });

  test("extra keys not rejected (协议管不变量实例管载体)", () => {
    const extra = { ...GOOD_CLOSE_OUTPUT, future_field: { whatever: 1 } };
    const r = validateSkillOutput(closeDef(), extra);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  });

  test("schema name mismatch rejected", () => {
    const wrong = { ...GOOD_CLOSE_OUTPUT, schema: "tri-fade011-close/v9" };
    const r = validateSkillOutput(closeDef(), wrong);
    assert.ok(r.errors.some((e) => e.path === "schema"), JSON.stringify(r.errors));
  });
});

describe("env dataDir guard (顺手修·S2 上呈项 CTO 裁)", () => {
  test('TRILC_DATA_DIR="" falls to default — no drive-root dataDir', () => {
    process.env.TRILC_DATA_DIR = "";
    const env = readEnv();
    assert.notEqual(env.dataDir, "");
    assert.ok(!/^[A-Za-z]:$/.test(env.dataDir), `dataDir rooted at drive: ${env.dataDir}`);
    const expectedDefault = `${process.env.LOCALAPPDATA ?? process.env.HOME ?? "/tmp"}/trilc`;
    assert.equal(env.dataDir, expectedDefault);
  });

  test('TRILC_DATA_DIR="   " (whitespace) falls to default', () => {
    process.env.TRILC_DATA_DIR = "   ";
    const env = readEnv();
    const expectedDefault = `${process.env.LOCALAPPDATA ?? process.env.HOME ?? "/tmp"}/trilc`;
    assert.equal(env.dataDir, expectedDefault);
  });

  test("legit path with surrounding whitespace is trimmed but preserved", () => {
    process.env.TRILC_DATA_DIR = "  D:\\tmp\\trilc-s3  ";
    const env = readEnv();
    assert.equal(env.dataDir, "D:\\tmp\\trilc-s3");
  });

  test("unset TRILC_DATA_DIR falls to default (nullish path unchanged)", () => {
    delete process.env.TRILC_DATA_DIR;
    const env = readEnv();
    const expectedDefault = `${process.env.LOCALAPPDATA ?? process.env.HOME ?? "/tmp"}/trilc`;
    assert.equal(env.dataDir, expectedDefault);
  });

  after(() => {
    if (SAVED_DATA_DIR === undefined) delete process.env.TRILC_DATA_DIR;
    else process.env.TRILC_DATA_DIR = SAVED_DATA_DIR;
  });
});

after(() => {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp best-effort */ }
  }
});
