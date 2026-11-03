// FADE-011 Phase 2 S3 — Plan/Close Skill structured loader (gap ①).
// Law anchors:
//   - fade-protocol-spec.md §6.1 L349 (gap declaration), §7.4 L415
//     ("Plan Skill 输出结构化计划；Close Skill 输出结构化语义裁决；Score Skill
//     输出结构化质量评分"), §2.6/§2.7 (评分合同 / 报告校验·协议管不变量实例管载体).
//   - 排期单 §七 风险③: Skill 单一装载通道 = daemon 读 skill 文件·禁内嵌副本.
//     The output schema below is EXTRACTED from the SKILL.md file at load
//     time — this module never hardcodes a copy of the schema definition.
//     (TS consumer types mirror the frozen v1.0 shape for the S5 segment
//     chain's compile-time contract; runtime validation always reads the file.)
//   - Skill 正身位 (彩排 run a 实锚, run-registry L39-40 / TriSkill 35ec18d):
//       TriSkill/skills/engineering/tri-fade011-score/SKILL.md v1.0
//       TriSkill/skills/engineering/tri-fade011-close/SKILL.md v1.0
//     (engineering/ category layer included — rehearsal paths are the record.)
//   - R1.1 note: schema keys include CJK dimension names (准确性/完备性/…) —
//     key sets come from JSON.parse + Object.keys (Unicode-safe), never from
//     a [A-Za-z_]-style character-class regex.
// Scope (S3 brief §一): loader + per-key validation only. Run triggering and
// segment-chain driving are S5 domain — nothing here wires into a chain.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the FADE engineering skills root (…/TriSkill/skills/engineering). Env override wins. */
export function resolveTriSkillSkillsRoot(envOverride?: string): string {
  if (envOverride && envOverride.trim()) return resolve(envOverride.trim());
  // src/fade/skill-loader.ts → ../../.. = dev workspace root (D:/Code/ai);
  // FADE instance skills live under the engineering/ category (run-registry
  // rehearsal anchor: TriSkill/skills/engineering/tri-fade011-{score,close}/).
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, "..", "..", "..", "TriSkill", "skills", "engineering");
}

// ── loading errors ──────────────────────────────────────────────────────────

export type FadeSkillLoadErrorCode =
  | "NOT_FOUND"          // SKILL.md missing on disk
  | "NO_FRONTMATTER"     // no --- fenced frontmatter
  | "FRONTMATTER_NO_NAME"
  | "NO_SCHEMA_SECTION"  // no 「## 输出 schema」 heading
  | "NO_SCHEMA_FENCE"    // section exists but no ```json fence
  | "SCHEMA_NOT_JSON";   // fence content is not valid JSON (非 JSON 面 gate)

export class FadeSkillLoadError extends Error {
  constructor(readonly code: FadeSkillLoadErrorCode, message: string, readonly skillName?: string) {
    super(message);
    this.name = "FadeSkillLoadError";
  }
}

// ── example-shaped schema inference ─────────────────────────────────────────
// The SKILL.md schema fence is an example-instance shape ("key": placeholder),
// not standard JSON Schema. Inference rules (v1.0 contract):
//   number  ← 0.0 / any JSON number
//   boolean ← true / false
//   enum    ← string containing '|' after stripping <…> (value domain)
//   string  ← other "<…>" placeholder or plain string
//   array   ← [ … ] (first element describes the item shape)
//   object  ← { … } (recursed — nested keys become required too)
// Extra keys in an instance are NOT rejected (spec §2.7: 协议管不变量实例管载体).

export type FadeKeyKind = "string" | "number" | "boolean" | "array" | "object";

export interface FadeKeyRule {
  kind: FadeKeyKind;
  enumValues?: string[];
  /** For arrays: rule for each element (object elements recurse). */
  itemRule?: FadeKeyRule;
  /** For objects: required child-key rules (recursed). */
  children?: Map<string, FadeKeyRule>;
}

export interface FadeSchemaSpec {
  schemaName: string;
  root: Map<string, FadeKeyRule>;
}

function inferRule(value: unknown): FadeKeyRule {
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "string") {
    const stripped = value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
    if (stripped.includes("|")) {
      const enumValues = stripped.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
      if (enumValues.length > 1) return { kind: "string", enumValues };
    }
    return { kind: "string" };
  }
  if (Array.isArray(value)) {
    const rule: FadeKeyRule = { kind: "array" };
    if (value.length > 0) rule.itemRule = inferRule(value[0]);
    return rule;
  }
  if (value !== null && typeof value === "object") {
    return { kind: "object", children: walkObject(value as Record<string, unknown>) };
  }
  // null in the example schema — treat as unconstrained (should not occur in v1.0)
  return { kind: "string" };
}

function walkObject(obj: Record<string, unknown>): Map<string, FadeKeyRule> {
  const out = new Map<string, FadeKeyRule>();
  for (const key of Object.keys(obj)) out.set(key, inferRule(obj[key]));
  return out;
}

// ── SKILL.md parsing ────────────────────────────────────────────────────────

export interface FadeSkillFrontmatter {
  name: string;
  description: string;
}

export function parseFrontmatter(markdown: string): FadeSkillFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!m) throw new FadeSkillLoadError("NO_FRONTMATTER", "no --- frontmatter block found");
  const fields = new Map<string, string>();
  for (const rawLine of m[1]!.split(/\r?\n/)) {
    const fm = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(rawLine.trim());
    if (fm) fields.set(fm[1]!, fm[2]!.trim());
  }
  const name = fields.get("name");
  if (!name) throw new FadeSkillLoadError("FRONTMATTER_NO_NAME", "frontmatter lacks name:");
  return { name, description: fields.get("description") ?? "" };
}

/**
 * Extract the 「## 输出 schema」 section's ```json fence and JSON.parse it.
 * Section-scan is line-walking (no character-class key matching — R1.1).
 */
export function extractOutputSchemaExample(markdown: string): Record<string, unknown> {
  const lines = markdown.split(/\r?\n/);
  const headingIdx = lines.findIndex((l) => /^##\s+输出\s*schema/.test(l));
  if (headingIdx === -1) {
    throw new FadeSkillLoadError("NO_SCHEMA_SECTION", "no 「## 输出 schema」 heading");
  }
  // Section body runs until the next same-or-higher heading (## …) or EOF.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) { end = i; break; }
  }
  const section = lines.slice(headingIdx + 1, end).join("\n");
  const fence = /```json\s*([\s\S]*?)```/.exec(section);
  if (!fence) throw new FadeSkillLoadError("NO_SCHEMA_FENCE", "no ```json fence in schema section");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]!);
  } catch (err) {
    throw new FadeSkillLoadError("SCHEMA_NOT_JSON", `schema fence is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new FadeSkillLoadError("SCHEMA_NOT_JSON", "schema fence must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

// ── loader ──────────────────────────────────────────────────────────────────

export interface FadeSkillDefinition {
  name: string;
  description: string;
  skillFilePath: string;
  outputSchemaName: string;
  spec: FadeSchemaSpec;
}

/** Load one FADE skill's definition from its SKILL.md (single loading channel). */
export function loadFadeSkill(skillsRoot: string, skillName: string): FadeSkillDefinition {
  const skillFilePath = join(resolve(skillsRoot), skillName, "SKILL.md");
  if (!existsSync(skillFilePath)) {
    throw new FadeSkillLoadError("NOT_FOUND", `SKILL.md not found: ${skillFilePath}`, skillName);
  }
  const markdown = readFileSync(skillFilePath, "utf-8");
  const fm = parseFrontmatter(markdown);
  const example = extractOutputSchemaExample(markdown);
  const schemaName = typeof example["schema"] === "string" ? example["schema"] : "";
  if (!schemaName) {
    throw new FadeSkillLoadError("SCHEMA_NOT_JSON", 'schema example lacks "schema" name key', skillName);
  }
  const { schema: _schemaName, ...exampleBody } = example;
  return {
    name: fm.name,
    description: fm.description,
    skillFilePath,
    outputSchemaName: schemaName,
    spec: { schemaName, root: walkObject(exampleBody) },
  };
}

// ── output instance validation ──────────────────────────────────────────────

export interface FadeOutputError {
  path: string;
  code: "missing-key" | "type-mismatch" | "enum-violation" | "item-error";
  detail: string;
}

export interface FadeValidationResult {
  ok: boolean;
  errors: FadeOutputError[];
}

function kindOf(value: unknown): FadeKeyKind | "other" {
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "object";
  return "other";
}

function validateRule(rule: FadeKeyRule, value: unknown, path: string, errors: FadeOutputError[]): void {
  const actual = kindOf(value);
  if (actual === "other") {
    errors.push({ path, code: "type-mismatch", detail: `null/undefined at ${path}` });
    return;
  }
  if (actual !== rule.kind) {
    errors.push({ path, code: "type-mismatch", detail: `expected ${rule.kind}, got ${actual} at ${path}` });
    return;
  }
  if (rule.enumValues && rule.kind === "string") {
    if (!rule.enumValues.includes(value as string)) {
      errors.push({ path, code: "enum-violation", detail: `"${value}" not in [${rule.enumValues.join("|")}] at ${path}` });
    }
    return; // enum strings carry no children
  }
  if (rule.kind === "array" && rule.itemRule && Array.isArray(value)) {
    value.forEach((item, i) => validateRule(rule.itemRule!, item, `${path}[${i}]`, errors));
    return;
  }
  if (rule.kind === "object" && rule.children && value && typeof value === "object") {
    validateChildren(rule.children, value as Record<string, unknown>, path, errors);
  }
}

function validateChildren(
  rules: Map<string, FadeKeyRule>,
  instance: Record<string, unknown>,
  path: string,
  errors: FadeOutputError[],
): void {
  for (const [key, rule] of rules) {
    const childPath = path ? `${path}.${key}` : key;
    if (!(key in instance)) {
      errors.push({ path: childPath, code: "missing-key", detail: `required key missing: ${childPath}` });
      continue;
    }
    validateRule(rule, instance[key], childPath, errors);
  }
}

/** Per-key validation of a skill output instance (extra keys not rejected). */
export function validateSkillOutput(def: FadeSkillDefinition, instance: unknown): FadeValidationResult {
  const errors: FadeOutputError[] = [];
  if (instance === null || typeof instance !== "object" || Array.isArray(instance)) {
    return { ok: false, errors: [{ path: "", code: "type-mismatch", detail: "output instance must be a JSON object" }] };
  }
  const obj = instance as Record<string, unknown>;
  // The schema name itself is part of the contract.
  if (typeof obj["schema"] !== "string" || obj["schema"] !== def.outputSchemaName) {
    errors.push({
      path: "schema",
      code: obj["schema"] === undefined ? "missing-key" : "enum-violation",
      detail: `schema must be "${def.outputSchemaName}", got ${JSON.stringify(obj["schema"])}`,
    });
  }
  validateChildren(def.spec.root, obj, "", errors);
  return { ok: errors.length === 0, errors };
}

/** Parse + validate a raw skill output payload (非 JSON instances fail here). */
export function parseSkillOutput(def: FadeSkillDefinition, raw: string): FadeValidationResult & { value?: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [{ path: "", code: "type-mismatch", detail: `not valid JSON: ${(err as Error).message}` }] };
  }
  const result = validateSkillOutput(def, parsed);
  return result.ok ? { ok: true, errors: [], value: parsed } : result;
}

// ── frozen v1.0 consumer types (compile-time contract for the S5 chain) ─────
// Mirrors the SKILL.md schema fences (tri-fade011-score/v1.0, tri-fade011-close/v1.0).
// Runtime validation always reads the skill file — these types only freeze the
// consumer-side shape so segment-chain code typechecks against it.

export interface FadeScoreEntry {
  item: string;
  dim: string;
  score: number;
  reason: string;
  evidence_ref: string;
}

export interface FadeScoreOutput {
  schema: string; // "tri-fade011-score/v1.0"
  run_id: string;
  question_id: string;
  required: boolean;
  answered: boolean;
  scores: FadeScoreEntry[];
  aggregated: Record<string, number>; // CJK dimension keys — Unicode-safe access
  divergence: boolean;
  reviewers: { cos: { scores: Record<string, number>; reason_first: string }; cao: { scores: Record<string, number>; reason_first: string } };
  scored_at: string;
}

export interface FadeCloseOutput {
  schema: string; // "tri-fade011-close/v1.0"
  run_id: string;
  verdict: "APPROVED" | "FROZEN" | "ESCALATED" | "RETRY";
  gate_check: { score_total: number; threshold: number; required_all_passed: boolean; hash_match: boolean };
  evidence_refs: string[];
  pending_list: { items: unknown[]; owner: string; backfill_at: string };
  decided_by: string;
  decided_at: string;
}

/** Convenience: load both rehearsal-proven skills (score + close). */
export function loadFade011Skills(skillsRoot: string): { score: FadeSkillDefinition; close: FadeSkillDefinition } {
  return {
    score: loadFadeSkill(skillsRoot, "tri-fade011-score"),
    close: loadFadeSkill(skillsRoot, "tri-fade011-close"),
  };
}
