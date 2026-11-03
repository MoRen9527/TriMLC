// FADE-011 Phase 2 S1 — durable FADE run store (independent keyspace).
// House layout: one db file per store concern under the daemon dataDir
//   (precedent: src/server/app.ts — createSessionStore(`${env.dataDir}/sessions.db`)),
//   so FADE runs persist to `${dataDir}/fade.db` — the live cron.db / job
//   configuration is never touched (dispatch brief §四.1 / plan §六 rollback
//   posture: revert code + drop this one file restores the old behavior).
// Deliberate divergences from src/cron/store.ts (documented per S1 report):
//   - no in-memory cache: write-through, each op reads sqlite (WAL is the
//     durable truth) — removes the mtime-guard cache-invalidation family;
//   - no <dbPath>.json mirror backup: the sqlite WAL file itself is the
//     recovery source for the S2 boot sweep.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { assertTransition, isTerminal } from "./state-machine.js";
import {
  FADE_PROFILES,
  FadeTransitionError,
  RUN_STATES,
  TERMINAL_STATES,
  TRANSITION_ACTORS,
  type FadeRunInput,
  type FadeRunRecord,
  type FadeRunState,
  type FadeTransitionActor,
  type FadeTransitionRecord,
} from "./types.js";

const DEFAULT_RETRY_BUDGET = 3;

// Schema freeze — state vocabulary mirrors spec §8.3 L469-478 verbatim.
const CREATE_RUNS_SQL = `
CREATE TABLE IF NOT EXISTS fade_runs (
  run_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  profile TEXT NOT NULL CHECK (profile IN ('runtime-owned-durable', 'agent-owned-interactive')),
  home_domain TEXT NOT NULL,
  write_authority TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL,
  version TEXT NOT NULL,
  source_revision TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'DETECTED', 'QUALIFYING', 'PLANNING', 'PLANNED', 'EXECUTING', 'VERIFYING',
    'SCORING', 'CLOSING', 'FINALIZING', 'APPROVED', 'FROZEN', 'ESCALATED', 'RETRY'
  )),
  retry_budget INTEGER NOT NULL DEFAULT ${DEFAULT_RETRY_BUDGET},
  retry_count INTEGER NOT NULL DEFAULT 0,
  checkpoint TEXT,
  plan_skill_version TEXT,
  score_skill_version TEXT,
  close_skill_version TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

// Audit schema (§8.3 L481). from_state NULL = registration row.
const CREATE_TRANSITIONS_SQL = `
CREATE TABLE IF NOT EXISTS fade_run_transitions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES fade_runs(run_id),
  from_state TEXT CHECK (from_state IS NULL OR from_state IN (
    'DETECTED', 'QUALIFYING', 'PLANNING', 'PLANNED', 'EXECUTING', 'VERIFYING',
    'SCORING', 'CLOSING', 'FINALIZING', 'APPROVED', 'FROZEN', 'ESCALATED', 'RETRY'
  )),
  to_state TEXT NOT NULL CHECK (to_state IN (
    'DETECTED', 'QUALIFYING', 'PLANNING', 'PLANNED', 'EXECUTING', 'VERIFYING',
    'SCORING', 'CLOSING', 'FINALIZING', 'APPROVED', 'FROZEN', 'ESCALATED', 'RETRY'
  )),
  actor TEXT NOT NULL CHECK (actor IN ('register', 'segment-advance', 'finalize', 'recovery')),
  reason TEXT,
  created_at TEXT NOT NULL
)`;

const RUN_COLUMNS = `
  run_id, idempotency_key, profile, home_domain, write_authority, authority_epoch,
  version, source_revision, state, retry_budget, retry_count, checkpoint,
  plan_skill_version, score_skill_version, close_skill_version, created_at, updated_at
`;

// S4 closing-gate rejections (§2.7 拒翻转失败明细落卷). Additive-only table —
// the S1 frozen schemas above are untouched. One row per refused flip.
const CREATE_GATE_REJECTIONS_SQL = `
CREATE TABLE IF NOT EXISTS fade_gate_rejections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  gate TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
)`;

interface FadeRunRow {
  run_id: string;
  idempotency_key: string;
  profile: string;
  home_domain: string;
  write_authority: string;
  authority_epoch: number;
  version: string;
  source_revision: string | null;
  state: string;
  retry_budget: number;
  retry_count: number;
  checkpoint: string | null;
  plan_skill_version: string | null;
  score_skill_version: string | null;
  close_skill_version: string | null;
  created_at: string;
  updated_at: string;
}

interface FadeTransitionRow {
  seq: number | bigint;
  run_id: string;
  from_state: string | null;
  to_state: string;
  actor: string;
  reason: string | null;
  created_at: string;
}

function rowToRun(row: FadeRunRow): FadeRunRecord {
  return {
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    profile: row.profile as FadeRunRecord["profile"],
    homeDomain: row.home_domain,
    writeAuthority: row.write_authority,
    authorityEpoch: Number(row.authority_epoch),
    version: row.version,
    sourceRevision: row.source_revision,
    state: row.state as FadeRunState,
    retryBudget: Number(row.retry_budget),
    retryCount: Number(row.retry_count),
    checkpoint: row.checkpoint,
    planSkillVersion: row.plan_skill_version,
    scoreSkillVersion: row.score_skill_version,
    closeSkillVersion: row.close_skill_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTransition(row: FadeTransitionRow): FadeTransitionRecord {
  return {
    seq: Number(row.seq),
    runId: row.run_id,
    fromState: (row.from_state as FadeRunState | null) ?? null,
    toState: row.to_state as FadeRunState,
    actor: row.actor as FadeTransitionActor,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

/** S4 closing-gate rejection卷面 row (§2.7 refused flip, detail landed). */
export interface FadeGateRejectionRecord {
  id: number;
  runId: string;
  gate: string;
  reason: string;
  detail: string | null;
  createdAt: string;
}

interface FadeGateRejectionRow {
  id: number | bigint;
  run_id: string;
  gate: string;
  reason: string;
  detail: string | null;
  created_at: string;
}

function rowToGateRejection(row: FadeGateRejectionRow): FadeGateRejectionRecord {
  return {
    id: Number(row.id),
    runId: row.run_id,
    gate: row.gate,
    reason: row.reason,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

export interface FadeStore {
  db: DatabaseSync;
  /** §8.1 L431 register, dedupe, anchor the run identity: same idempotency
   * key returns the existing run (created=false) instead of erroring. */
  createRun(input: FadeRunInput): { created: boolean; run: FadeRunRecord };
  getRun(runId: string): FadeRunRecord | undefined;
  getRunByIdempotencyKey(idempotencyKey: string): FadeRunRecord | undefined;
  listRuns(): FadeRunRecord[];
  /** Recovery sweep input (S2): every run not yet in a terminal state. */
  listUnfinishedRuns(): FadeRunRecord[];
  listTransitions(runId: string): FadeTransitionRecord[];
  /** Apply one law-checked transition and append the audit row atomically. */
  advanceRun(
    runId: string,
    toState: FadeRunState,
    opts?: { actor?: FadeTransitionActor; reason?: string },
  ): FadeRunRecord;
  /** §8.1 L445 shortcut: roll a non-terminal run back to CLOSING. */
  recoverRun(runId: string, reason?: string): FadeRunRecord;
  /** §8.3 L481 checkpoint contract. */
  setCheckpoint(runId: string, checkpoint: string | null): FadeRunRecord;
  /** S4 §2.7 refused-flip ledger: land a closing-gate rejection detail. */
  recordGateRejection(runId: string, gate: string, reason: string, detail?: string): void;
  listGateRejections(runId: string): FadeGateRejectionRecord[];
  close(): void;
}

export function createFadeStore(dbPath: string): FadeStore {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(CREATE_RUNS_SQL);
  db.exec(CREATE_TRANSITIONS_SQL);
  db.exec(CREATE_GATE_REJECTIONS_SQL);

  const nowIso = () => new Date().toISOString();

  const getRunStmt = db.prepare(`SELECT ${RUN_COLUMNS} FROM fade_runs WHERE run_id = ?`);
  const getByIdempotencyKeyStmt = db.prepare(
    `SELECT ${RUN_COLUMNS} FROM fade_runs WHERE idempotency_key = ?`,
  );
  const insertRunStmt = db.prepare(`
    INSERT INTO fade_runs (
      ${RUN_COLUMNS}
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, 'DETECTED', ?, 0, ?, ?, ?, ?, ?, ?
    )
  `);
  const insertTransitionStmt = db.prepare(`
    INSERT INTO fade_run_transitions (run_id, from_state, to_state, actor, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const listAllStmt = db.prepare(`SELECT ${RUN_COLUMNS} FROM fade_runs ORDER BY created_at, run_id`);
  const listUnfinishedStmt = db.prepare(
    `SELECT ${RUN_COLUMNS} FROM fade_runs
     WHERE state NOT IN ('APPROVED', 'FROZEN', 'ESCALATED', 'RETRY')
     ORDER BY created_at, run_id`,
  );
  const listTransitionsStmt = db.prepare(
    "SELECT seq, run_id, from_state, to_state, actor, reason, created_at FROM fade_run_transitions WHERE run_id = ? ORDER BY seq",
  );
  const insertGateRejectionStmt = db.prepare(
    "INSERT INTO fade_gate_rejections (run_id, gate, reason, detail, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const listGateRejectionsStmt = db.prepare(
    "SELECT id, run_id, gate, reason, detail, created_at FROM fade_gate_rejections WHERE run_id = ? ORDER BY id",
  );

  function getRun(runId: string): FadeRunRecord | undefined {
    const row = getRunStmt.get(runId) as unknown as FadeRunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  function getRunByIdempotencyKey(idempotencyKey: string): FadeRunRecord | undefined {
    const row = getByIdempotencyKeyStmt.get(idempotencyKey) as unknown as FadeRunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  function requireRun(runId: string): FadeRunRecord {
    const run = getRun(runId);
    if (!run) {
      throw new FadeTransitionError("RUN_NOT_FOUND", `run not found: ${runId}`);
    }
    return run;
  }

  function createRun(input: FadeRunInput): { created: boolean; run: FadeRunRecord } {
    if (!FADE_PROFILES.includes(input.profile)) {
      throw new FadeTransitionError(
        "INVALID_STATE",
        `unknown profile: ${input.profile} (expected one of ${FADE_PROFILES.join(", ")})`,
      );
    }
    // §8.1 L431 dedupe by idempotency key.
    const existing = getRunByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { created: false, run: existing };
    }
    const now = nowIso();
    insertRunStmt.run(
      input.runId,
      input.idempotencyKey,
      input.profile,
      input.homeDomain,
      input.writeAuthority,
      input.authorityEpoch,
      input.version,
      input.sourceRevision ?? null,
      input.retryBudget ?? DEFAULT_RETRY_BUDGET,
      input.checkpoint ?? null,
      input.planSkillVersion ?? null,
      input.scoreSkillVersion ?? null,
      input.closeSkillVersion ?? null,
      now,
      now,
    );
    // Registration row: from_state NULL, actor 'register' (§8.1 L431).
    insertTransitionStmt.run(input.runId, null, "DETECTED", "register", "register", now);
    return { created: true, run: requireRun(input.runId) };
  }

  function advanceRun(
    runId: string,
    toState: FadeRunState,
    opts?: { actor?: FadeTransitionActor; reason?: string },
  ): FadeRunRecord {
    if (!(RUN_STATES as readonly string[]).includes(toState)) {
      throw new FadeTransitionError("INVALID_STATE", `unknown target state: ${toState}`, {
        to: toState,
      });
    }
    const actor: FadeTransitionActor =
      opts?.actor ?? (isTerminal(toState) ? "finalize" : "segment-advance");
    if (!(TRANSITION_ACTORS as readonly string[]).includes(actor)) {
      throw new FadeTransitionError("INVALID_STATE", `unknown transition actor: ${actor}`);
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      const row = getRunStmt.get(runId) as unknown as FadeRunRow | undefined;
      if (!row) {
        throw new FadeTransitionError("RUN_NOT_FOUND", `run not found: ${runId}`);
      }
      const current = rowToRun(row);
      assertTransition(current.state, toState, actor);
      // §8.3 L481 retry budget: entering RETRY consumes one unit of budget.
      if (toState === "RETRY" && current.retryCount >= current.retryBudget) {
        throw new FadeTransitionError(
          "BUDGET_EXHAUSTED",
          `retry budget exhausted for ${runId} (count=${current.retryCount}, budget=${current.retryBudget})`,
          { from: current.state, to: toState },
        );
      }
      const now = nowIso();
      db.prepare(
        `UPDATE fade_runs
         SET state = ?,
             retry_count = CASE WHEN ? = 'RETRY' THEN retry_count + 1 ELSE retry_count END,
             updated_at = ?
         WHERE run_id = ?`,
      ).run(toState, toState, now, runId);
      insertTransitionStmt.run(runId, current.state, toState, actor, opts?.reason ?? null, now);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return requireRun(runId);
  }

  function recoverRun(runId: string, reason?: string): FadeRunRecord {
    return advanceRun(runId, "CLOSING", {
      actor: "recovery",
      reason: reason ?? "recovery rollback (§8.1 L445)",
    });
  }

  function setCheckpoint(runId: string, checkpoint: string | null): FadeRunRecord {
    requireRun(runId);
    db.prepare("UPDATE fade_runs SET checkpoint = ?, updated_at = ? WHERE run_id = ?").run(
      checkpoint,
      nowIso(),
      runId,
    );
    return requireRun(runId);
  }

  return {
    db,
    createRun,
    getRun,
    getRunByIdempotencyKey,
    listRuns: () => (listAllStmt.all() as unknown as FadeRunRow[]).map(rowToRun),
    listUnfinishedRuns: () => (listUnfinishedStmt.all() as unknown as FadeRunRow[]).map(rowToRun),
    listTransitions: (runId: string) =>
      (listTransitionsStmt.all(runId) as unknown as FadeTransitionRow[]).map(rowToTransition),
    advanceRun,
    recoverRun,
    setCheckpoint,
    recordGateRejection: (runId, gate, reason, detail) => {
      insertGateRejectionStmt.run(runId, gate, reason, detail ?? null, nowIso());
    },
    listGateRejections: (runId: string) =>
      (listGateRejectionsStmt.all(runId) as unknown as FadeGateRejectionRow[]).map(rowToGateRejection),
    close: () => db.close(),
  };
}
