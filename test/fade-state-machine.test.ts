// FADE-011 Phase 2 S1 — transition law tests.
// Gate (plan §四): legal-path full coverage + illegal-transition rejection
// assertions (>= 3 families: skip-ahead / unauthorized rollback / terminal
// re-entry). Law anchor: fade-protocol-spec.md §8.1 L427-445 / §8.3 L466-481.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  assertTransition,
  findTransitionRule,
  IDEMPOTENT_STATES,
  LEGAL_TRANSITIONS,
  NON_IDEMPOTENT_STATES,
  recoveryActionFor,
} from "../src/fade/state-machine.js";
import {
  SEGMENT_CHAIN,
  TERMINAL_STATES,
  type FadeRunState,
  type FadeTransitionActor,
} from "../src/fade/types.js";

const CHAIN_STEPS = SEGMENT_CHAIN.slice(1) as readonly FadeRunState[];

function assertThrowsCode(
  fn: () => void,
  code: string,
  label: string,
): void {
  try {
    fn();
  } catch (err) {
    assert.ok(
      err instanceof Error && "code" in err && (err as { code?: string }).code === code,
      `${label}: expected FadeTransitionError code=${code}, got ${(err as Error).message}`,
    );
    return;
  }
  assert.fail(`${label}: expected a throw, got none`);
}

describe("fade transition law — legal paths (full coverage)", () => {
  test("single-step forward chain §8.3 L469-477 passes in order", () => {
    for (let i = 0; i < SEGMENT_CHAIN.length - 1; i++) {
      const from = SEGMENT_CHAIN[i]!;
      const to = SEGMENT_CHAIN[i + 1]!;
      assert.doesNotThrow(
        () => assertTransition(from, to, "segment-advance"),
        `legal chain step ${from} -> ${to} must pass`,
      );
    }
  });

  test("terminal admission FINALIZING -> each of the four terminals (§8.3 L478)", () => {
    for (const terminal of TERMINAL_STATES) {
      assert.doesNotThrow(
        () => assertTransition("FINALIZING", terminal, "finalize"),
        `FINALIZING -> ${terminal} must pass`,
      );
    }
  });

  test("verify skip EXECUTING -> SCORING is the one sanctioned skip (§8.1 L435)", () => {
    assert.doesNotThrow(() => assertTransition("EXECUTING", "SCORING", "segment-advance"));
    const rule = findTransitionRule("EXECUTING", "SCORING", "segment-advance");
    assert.ok(rule, "verify-skip rule must exist");
    assert.ok(rule!.anchor.includes("L435"), "verify-skip rule must carry its spec anchor");
  });

  test("recovery edges: every non-CLOSING segment -> CLOSING via recovery actor (§8.1 L445)", () => {
    for (const segment of SEGMENT_CHAIN) {
      if (segment === "CLOSING") continue;
      assert.doesNotThrow(
        () => assertTransition(segment, "CLOSING", "recovery"),
        `recovery rollback ${segment} -> CLOSING must pass`,
      );
    }
  });

  test("every legal rule carries a spec line anchor", () => {
    assert.ok(LEGAL_TRANSITIONS.length > 0);
    for (const rule of LEGAL_TRANSITIONS) {
      assert.ok(rule.anchor.includes("§8."), `rule ${rule.from}->${rule.to} lacks spec anchor`);
    }
  });
});

describe("fade transition law — illegal rejections (gate: >= 3 families)", () => {
  test("family 1 — skip-ahead is rejected", () => {
    assertThrowsCode(
      () => assertTransition("QUALIFYING", "EXECUTING", "segment-advance"),
      "ILLEGAL_TRANSITION",
      "skip QUALIFYING->EXECUTING",
    );
    assertThrowsCode(
      () => assertTransition("DETECTED", "SCORING", "segment-advance"),
      "ILLEGAL_TRANSITION",
      "skip DETECTED->SCORING",
    );
  });

  test("family 2 — rollback to an unauthorized (non-CLOSING) segment is rejected", () => {
    assertThrowsCode(
      () => assertTransition("SCORING", "EXECUTING", "segment-advance"),
      "ILLEGAL_TRANSITION",
      "rollback SCORING->EXECUTING",
    );
    assertThrowsCode(
      () => assertTransition("PLANNED", "QUALIFYING", "segment-advance"),
      "ILLEGAL_TRANSITION",
      "rollback PLANNED->QUALIFYING",
    );
  });

  test("family 3 — terminal re-entry is rejected (terminals have no outgoing edges)", () => {
    for (const terminal of TERMINAL_STATES) {
      assertThrowsCode(
        () => assertTransition(terminal, "FINALIZING", "segment-advance"),
        "TERMINAL_REENTRY",
        `terminal re-entry ${terminal}->FINALIZING`,
      );
    }
    assertThrowsCode(
      () => assertTransition("FROZEN", "CLOSING", "recovery"),
      "TERMINAL_REENTRY",
      "terminal re-entry FROZEN->CLOSING (recovery)",
    );
    assertThrowsCode(
      () => assertTransition("RETRY", "QUALIFYING", "segment-advance"),
      "TERMINAL_REENTRY",
      "RETRY restart must be a new run instance, not an edge",
    );
  });

  test("actor escalation is rejected (recovery/finalize edges are actor-bound)", () => {
    assertThrowsCode(
      () => assertTransition("EXECUTING", "CLOSING", "segment-advance"),
      "ILLEGAL_TRANSITION",
      "rollback with segment-advance actor",
    );
    assertThrowsCode(
      () => assertTransition("FINALIZING", "APPROVED", "segment-advance"),
      "ILLEGAL_TRANSITION",
      "terminal admission with segment-advance actor",
    );
    assertThrowsCode(
      () => assertTransition("EXECUTING", "VERIFYING", "recovery"),
      "ILLEGAL_TRANSITION",
      "forward step with recovery actor",
    );
  });

  test("same-state self transition is rejected", () => {
    assertThrowsCode(
      () => assertTransition("PLANNING", "PLANNING", "segment-advance"),
      "ILLEGAL_TRANSITION",
      "self transition PLANNING->PLANNING",
    );
  });

  test("unknown states are rejected with INVALID_STATE", () => {
    assertThrowsCode(
      () => assertTransition("NOT_A_STATE" as FadeRunState, "PLANNING", "segment-advance"),
      "INVALID_STATE",
      "unknown from-state",
    );
    assertThrowsCode(
      () => assertTransition("DETECTED", "NOT_A_STATE" as FadeRunState, "segment-advance"),
      "INVALID_STATE",
      "unknown to-state",
    );
  });

  test("every forbidden segment pair with segment-advance actor is rejected (exhaustive sweep)", () => {
    // Beyond the sanctioned skip and the single-step chain, nothing advances.
    const legalForward = new Set(
      LEGAL_TRANSITIONS
        .filter((r) => r.actor === "segment-advance")
        .map((r) => `${r.from}->${r.to}`),
    );
    for (const from of SEGMENT_CHAIN) {
      for (const to of SEGMENT_CHAIN) {
        if (from === to) continue;
        const key = `${from}->${to}`;
        if (legalForward.has(key)) continue;
        assertThrowsCode(
          () => assertTransition(from, to, "segment-advance" as FadeTransitionActor),
          "ILLEGAL_TRANSITION",
          `exhaustive sweep ${key}`,
        );
      }
    }
  });
});

describe("recovery policy primitives (候批 draft: idempotent resume / non-idempotent rollback)", () => {
  test("EXECUTING (DCE file rewriting) is the only non-idempotent segment", () => {
    assert.deepEqual([...NON_IDEMPOTENT_STATES], ["EXECUTING"]);
    assert.equal(recoveryActionFor("EXECUTING"), "rollback-closing");
  });

  test("all other segments resume in place", () => {
    for (const state of IDEMPOTENT_STATES) {
      assert.equal(recoveryActionFor(state), "resume", `${state} must resume in place`);
    }
    assert.equal(IDEMPOTENT_STATES.length, SEGMENT_CHAIN.length - 1);
  });

  test("terminal runs need no recovery", () => {
    for (const terminal of TERMINAL_STATES) {
      assert.equal(recoveryActionFor(terminal), "none");
    }
  });
});
