// FADE-011 Phase 2 S1 — Run lifecycle durable state machine (gap ②).
// Sole law anchor: TriCompany/docs/engineering/fade-protocol-spec.md
//   §8.1 L427-445 (runtime-owned durable chain + L445 recovery law)
//   §8.3 L466-481 (unified state machine vocabulary + shared contract)
//   §8.5 L494    (unique writer four keys)
// Frozen per FADE-011 dispatch brief 2026-11-04T01:45:21+0800 (fade011-s1-state-machine/brief.md).
import type { DatabaseSync } from "node:sqlite";

/** §8.3 L469-478 vocabulary, in chain order (9 segments then 4 terminals). */
export const RUN_STATES = [
  "DETECTED",
  "QUALIFYING",
  "PLANNING",
  "PLANNED",
  "EXECUTING",
  "VERIFYING",
  "SCORING",
  "CLOSING",
  "FINALIZING",
  "APPROVED",
  "FROZEN",
  "ESCALATED",
  "RETRY",
] as const;
export type FadeRunState = (typeof RUN_STATES)[number];

/** §8.3 L469-477 the nine segment states (pre-terminal). */
export const SEGMENT_CHAIN: readonly FadeRunState[] = RUN_STATES.slice(0, 9);

/** §8.3 L478 terminal vocabulary. Terminals have no outgoing edges; RETRY is
 * closed with a fresh run instance sharing the idempotency-key family. */
export const TERMINAL_STATES: readonly FadeRunState[] = [
  "APPROVED",
  "FROZEN",
  "ESCALATED",
  "RETRY",
];
export type FadeTerminalState = Extract<FadeRunState, "APPROVED" | "FROZEN" | "ESCALATED" | "RETRY">;

/** §8.1 L427 runtime-owned durable / §8.2 L447 agent-owned interactive. */
export const FADE_PROFILES = ["runtime-owned-durable", "agent-owned-interactive"] as const;
export type FadeProfile = (typeof FADE_PROFILES)[number];

/** Who drove a transition; persisted in the audit table. */
export const TRANSITION_ACTORS = [
  "register",
  "segment-advance",
  "finalize",
  "recovery",
] as const;
export type FadeTransitionActor = (typeof TRANSITION_ACTORS)[number];

export type FadeTransitionErrorCode =
  | "INVALID_STATE"
  | "ILLEGAL_TRANSITION"
  | "TERMINAL_REENTRY"
  | "BUDGET_EXHAUSTED"
  | "RUN_NOT_FOUND";

export class FadeTransitionError extends Error {
  readonly code: FadeTransitionErrorCode;
  readonly from?: FadeRunState;
  readonly to?: FadeRunState;

  constructor(
    code: FadeTransitionErrorCode,
    message: string,
    meta?: { from?: FadeRunState; to?: FadeRunState },
  ) {
    super(message);
    this.name = "FadeTransitionError";
    this.code = code;
    this.from = meta?.from;
    this.to = meta?.to;
  }
}

/** §8.3 L481 shared contract: run identity carries an idempotency key. */
export interface FadeRunInput {
  runId: string;
  idempotencyKey: string;
  profile: FadeProfile;
  /** §8.5 L494 unique-writer keys. */
  homeDomain: string;
  writeAuthority: string;
  authorityEpoch: number;
  version: string;
  /** §8.3 L481 source revision. */
  sourceRevision?: string | null;
  /** §8.3 L481 retry budget; default 3. Entering RETRY past the budget is rejected. */
  retryBudget?: number;
  /** §8.3 L481 checkpoint (opaque JSON string; runtime-owned). */
  checkpoint?: string | null;
  /** §8.3 L481 Plan / Score / Close Skill version references. */
  planSkillVersion?: string | null;
  scoreSkillVersion?: string | null;
  closeSkillVersion?: string | null;
}

export interface FadeRunRecord {
  runId: string;
  idempotencyKey: string;
  profile: FadeProfile;
  homeDomain: string;
  writeAuthority: string;
  authorityEpoch: number;
  version: string;
  sourceRevision: string | null;
  state: FadeRunState;
  retryBudget: number;
  retryCount: number;
  checkpoint: string | null;
  planSkillVersion: string | null;
  scoreSkillVersion: string | null;
  closeSkillVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FadeTransitionRecord {
  seq: number;
  runId: string;
  /** NULL on the registration row. */
  fromState: FadeRunState | null;
  toState: FadeRunState;
  actor: FadeTransitionActor;
  reason: string | null;
  createdAt: string;
}

/** Convenience for callers that already hold a database handle (e.g. the daemon
 * boot sweep opening both stores on one dataDir). */
export type FadeDatabase = DatabaseSync;
