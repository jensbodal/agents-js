/**
 * Read-only reviewer-bundle boundary (M1, design packet item 4).
 *
 * The deterministic guard (item 3) decides the lane and freezes it. This module
 * is the boundary the *advisory* code-reviewer bundle sits behind: given a frozen
 * {@link GuardEvaluation} and the reviewer's advisory output, it applies the
 * monotonic ratchet from the design packet (§3, §5):
 *
 * - lane is taken from the GUARD, never the reviewer (Axis A is not exposed).
 * - human-review only ratchets UP — raised by the guard's deterministic sensitive
 *   denylist OR the reviewer's advisory `security-sensitive`, never cleared.
 * - unknown/ambiguous tags fail closed to human review.
 * - there is NO blocking / pass / fail / merge-authority field anywhere in the
 *   output — "agents never gate merges" is enforced by ABSENCE of capability, not
 *   by convention. `confidence` is carried but NEVER consulted to authorize.
 *
 * The reviewer is therefore provably incapable of *reducing* scrutiny: it can
 * only observe and escalate.
 */

import type { GuardEvaluation } from "./docs-only-path-guard.ts";

/** Narrowed M1 reviewer tag vocabulary (design packet §5; addendum tag set). */
export const M1_REVIEWER_TAGS = ["docs-only", "security-sensitive", "full-lane"] as const;
export type M1ReviewerTag = (typeof M1_REVIEWER_TAGS)[number];

export function isKnownReviewerTag(tag: string): tag is M1ReviewerTag {
  return (M1_REVIEWER_TAGS as readonly string[]).includes(tag);
}

/**
 * The advisory output of the read-only code-reviewer bundle — the INPUT to this
 * boundary (not a shared seam type). Note the deliberate absence of any
 * pass/fail/block/merge field: the reviewer cannot express a merge gate.
 */
export interface ReviewerAdvisory {
  /** Required literal — the reviewer output is advisory by construction. */
  readonly advisoryOnly: true;
  /** Controlled tags; anything outside {@link M1_REVIEWER_TAGS} fails closed. */
  readonly tags: readonly string[];
  /** Additive escalation into the human-review ratchet; can raise, never lower. */
  readonly securitySensitive: boolean;
  /** Advisory weight for a human reader only — NEVER an authorization input. */
  readonly confidence: number;
}

/** The bounded outcome after folding a reviewer advisory into a guard verdict. */
export interface ReviewerBoundedDecision {
  /** Taken verbatim from the guard; the reviewer cannot change it. */
  readonly lane: "docs-only" | "full-lane";
  /** Monotonic: guard escalation OR advisory escalation OR fail-closed. Never lowered. */
  readonly humanReviewRequired: boolean;
  /** Tags accepted from the controlled vocabulary. */
  readonly advisoryTags: readonly string[];
  /** Tags outside the vocabulary — their presence forces human review. */
  readonly unknownTags: readonly string[];
  /** Integrity marker: the boundary never recomputes the lane. */
  readonly laneRecomputed: false;
}

/**
 * Fold a read-only reviewer's advisory into a FROZEN guard evaluation.
 *
 * Monotonicity invariant (design packet §3): the only effect the reviewer can
 * have is to raise `humanReviewRequired`. It cannot move the lane in either
 * direction, and it cannot clear a guard-set review requirement.
 */
export function applyReviewerAdvisory(
  guard: GuardEvaluation,
  advisory: ReviewerAdvisory,
): ReviewerBoundedDecision {
  const unknownTags = advisory.tags.filter((tag) => !isKnownReviewerTag(tag));

  // Ratchet: any source can RAISE human review; none can lower it.
  // `advisory.confidence` is intentionally not referenced — confidence never
  // authorizes anything.
  const humanReviewRequired =
    guard.humanReviewRequired || advisory.securitySensitive || unknownTags.length > 0;

  return {
    lane: guard.lane, // Axis A is owned by the guard; reviewer has no input.
    humanReviewRequired,
    advisoryTags: advisory.tags.filter(isKnownReviewerTag),
    unknownTags,
    laneRecomputed: false,
  };
}
