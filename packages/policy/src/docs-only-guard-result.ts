/**
 * Adapter: internal {@link GuardEvaluation} → the shared seam type
 * `DocsOnlyGuardResult`.
 *
 * The seam type is owned by `@agents-js/schema-utils` (it is consumed verbatim
 * by `context-bundle.v0.classification`); `packages/policy` imports it and never
 * redefines it. This module is the ONLY place the guard's internal evaluation is
 * mapped onto the shared wire shape — keeping the field-level seam in one spot.
 *
 * NOTE (M1 sequencing): the import below is wired once schema-utils publishes
 * `DocsOnlyGuardResult` (ajs-claude's first schema slice). Until then this file
 * is intentionally not added to `index.ts`. The mapping is a pure rename of the
 * fields already produced by `evaluateDocsOnlyGuard`, so it carries no logic of
 * its own.
 */

import type { DocsOnlyGuardResult } from "@agents-js/schema-utils";

import type { GuardEvaluation } from "./docs-only-path-guard.ts";

/**
 * Map an internal guard evaluation onto the shared `DocsOnlyGuardResult` seam.
 *
 * Pure field rename — no decision logic. `guard_authoritative` is the guard's
 * literal `true`: the bundle copies it but never authors it (design packet §4.7,
 * §7 seam reconciliation).
 *
 * CLOSED-SET CONTRACT (M1 §4.7): `DocsOnlyGuardResult` is a closed key-set, not
 * an open record. `@agents-js/schema-utils` validates it with `hasExactKeys`,
 * which rejects BOTH missing AND extra keys. So this emit and the validator's
 * `KEYS` array must stay byte-for-byte in agreement: adding an Nth field is a
 * LOCKSTEP bump — this object literal AND schema-utils' `DocsOnlyGuardResult` +
 * `KEYS` move together in one coordinated change, or the exact-key check rejects
 * at the consumer boundary. That rigidity is intentional; a stray field is a
 * bug, not a convenience. (Producer/consumer split confirmed w/ ajs-claude
 * 2026-06-11.)
 */
export function toGuardResult(evaluation: GuardEvaluation): DocsOnlyGuardResult {
  return {
    guard: "docs-only-path-guard.v0",
    lane: evaluation.lane,
    guard_result: evaluation.guardResult,
    guard_authoritative: true,
    human_review_required: evaluation.humanReviewRequired,
    matched_paths: [...evaluation.matchedPaths],
    unmatched_paths: [...evaluation.unmatchedPaths],
    sensitive_paths: [...evaluation.sensitivePaths],
    policy_version: evaluation.policyVersion,
    errored_reason: evaluation.erroredReason,
  };
}
