// FADE-011 Phase 2 S1 — segment transition law (pure functions, no I/O).
// Law anchor: TriCompany/docs/engineering/fade-protocol-spec.md
//   §8.3 L469-478  unified chain + terminal vocabulary
//   §8.1 L435 / §8.2 L454  "Verify CLI（可选）" — the only law-sanctioned skip
//   §8.1 L445      recovery law: after Agent interruption or host restart the
//                  runtime must still bring the run to CLOSING or a terminal state
//   §8.3 L481      retry budget is shared contract
// Recovery policy draft (候批, §8.1 addition proposed by S1 2026-11-04):
//   idempotent segments resume in place; the non-idempotent segment (EXECUTING,
//   the DCE file-rewriting stage) rolls back to CLOSING.
import {
  FadeTransitionError,
  RUN_STATES,
  SEGMENT_CHAIN,
  TERMINAL_STATES,
  type FadeRunState,
  type FadeTransitionActor,
} from "./types.js";

export interface TransitionRule {
  from: FadeRunState;
  to: FadeRunState;
  actor: FadeTransitionActor;
  /** spec line reference carried by every legal edge (schema-freeze discipline). */
  anchor: string;
}

function buildLegalTransitions(): TransitionRule[] {
  const rules: TransitionRule[] = [];

  // §8.3 L469-477 single-step forward chain.
  for (let i = 0; i < SEGMENT_CHAIN.length - 1; i++) {
    rules.push({
      from: SEGMENT_CHAIN[i]!,
      to: SEGMENT_CHAIN[i + 1]!,
      actor: "segment-advance",
      anchor: "§8.3 L469-477",
    });
  }

  // §8.1 L435 / §8.2 L454: Verify is optional — the single sanctioned skip.
  rules.push({
    from: "EXECUTING",
    to: "SCORING",
    actor: "segment-advance",
    anchor: "§8.1 L435 Verify CLI（可选）",
  });

  // §8.3 L478 terminal admission from FINALIZING.
  for (const terminal of TERMINAL_STATES) {
    rules.push({ from: "FINALIZING", to: terminal, actor: "finalize", anchor: "§8.3 L478" });
  }

  // §8.1 L445 recovery law: any non-terminal segment (except CLOSING itself —
  // same-state moves are not transitions) may be rolled back to CLOSING.
  for (const segment of SEGMENT_CHAIN) {
    if (segment === "CLOSING") continue;
    rules.push({ from: segment, to: "CLOSING", actor: "recovery", anchor: "§8.1 L445" });
  }

  return rules;
}

export const LEGAL_TRANSITIONS: readonly TransitionRule[] = buildLegalTransitions();

const ruleKey = (from: string, to: string, actor: string) => `${from}->${to}@${actor}`;

const LEGAL_INDEX = new Map<string, TransitionRule>(
  LEGAL_TRANSITIONS.map((rule) => [ruleKey(rule.from, rule.to, rule.actor), rule]),
);

export function isTerminal(state: FadeRunState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function isRunState(value: string): value is FadeRunState {
  return (RUN_STATES as readonly string[]).includes(value);
}

export function findTransitionRule(
  from: FadeRunState,
  to: FadeRunState,
  actor: FadeTransitionActor,
): TransitionRule | undefined {
  return LEGAL_INDEX.get(ruleKey(from, to, actor));
}

/**
 * Assert one transition against the frozen law table. Throws FadeTransitionError on:
 *  - unknown state                    (INVALID_STATE)
 *  - terminal re-entry / any terminal outgoing edge (TERMINAL_REENTRY)
 *  - same-state self move             (ILLEGAL_TRANSITION)
 *  - pair not in the law table        (ILLEGAL_TRANSITION)
 * Pure: throws, never mutates.
 */
export function assertTransition(
  from: FadeRunState,
  to: FadeRunState,
  actor: FadeTransitionActor,
): void {
  if (!isRunState(from) || !isRunState(to)) {
    throw new FadeTransitionError("INVALID_STATE", `unknown run state in ${from} -> ${to}`, {
      from,
      to,
    });
  }
  if (isTerminal(from)) {
    // Terminals have no outgoing edges; RETRY restarts as a new run instance.
    throw new FadeTransitionError(
      "TERMINAL_REENTRY",
      `terminal state ${from} admits no outgoing transition (attempted -> ${to})`,
      { from, to },
    );
  }
  if (from === to) {
    throw new FadeTransitionError("ILLEGAL_TRANSITION", `self transition ${from} -> ${to}`, {
      from,
      to,
    });
  }
  const rule = findTransitionRule(from, to, actor);
  if (!rule) {
    throw new FadeTransitionError(
      "ILLEGAL_TRANSITION",
      `illegal transition ${from} -> ${to} with actor ${actor}`,
      { from, to },
    );
  }
}

/**
 * Recovery policy primitive (候批 draft, mirrors the spec §8.1 addition proposed
 * by FADE-011 S1). Idempotent segments resume in place; the non-idempotent
 * segment (EXECUTING — DCE rewrites workspace files, re-entry would mutate
 * already-mutated artifacts) must roll back to CLOSING per §8.1 L445. Terminal
 * runs need no recovery.
 */
export const NON_IDEMPOTENT_STATES: readonly FadeRunState[] = ["EXECUTING"];

export const IDEMPOTENT_STATES: readonly FadeRunState[] = SEGMENT_CHAIN.filter(
  (state) => !(NON_IDEMPOTENT_STATES as readonly string[]).includes(state),
);

export type RecoveryAction = "resume" | "rollback-closing" | "none";

export function recoveryActionFor(state: FadeRunState): RecoveryAction {
  if (isTerminal(state)) return "none";
  if ((NON_IDEMPOTENT_STATES as readonly string[]).includes(state)) return "rollback-closing";
  return "resume";
}
