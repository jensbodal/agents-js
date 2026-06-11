import { hasExactKeys, isOneOf, isPlainObject, isStringArray } from "./_validate.ts";

/**
 * Deterministic docs-only path-guard output — the locked M1 §4.7 seam contract.
 *
 * This is the SINGLE source of the guard-output type for the whole M1 surface.
 * The guard in `@agents-js/policy` produces values of this shape; the
 * `context-bundle.v0` `classification` block embeds it (plus `advisory_only`)
 * by importing this type — it never redefines or recomputes it. `schema-utils`
 * imports nothing from `policy`, so the dependency edge is one-way.
 *
 * The guard owns the `lane` axis authoritatively; consumers COPY
 * `guard_authoritative`/`human_review_required` verbatim and may only escalate
 * scrutiny, never lower it.
 */
export interface DocsOnlyGuardResult {
  /** Discriminant — always the guard's versioned identifier. */
  guard: "docs-only-path-guard.v0";
  /** Authoritative lane decision. The guard proves `docs-only` or falls back. */
  lane: "docs-only" | "full-lane";
  /** Why the lane was chosen. `errored` ⇒ fail-closed to `full-lane`. */
  guard_result: "proven" | "not-proven" | "errored";
  /** The guard's literal claim of authority. Consumers copy, never author. */
  guard_authoritative: true;
  /** Deterministic half of the human-review ratchet (one-way; never lowered). */
  human_review_required: boolean;
  /** Changed files that proved docs-content (guard proof, not the review set). */
  matched_paths: string[];
  /** Changed files that did NOT prove docs-content — the reason for `full-lane`. */
  unmatched_paths: string[];
  /** Files that hit the deterministic security denylist (additive escalation). */
  sensitive_paths: string[];
  /** Which versioned policy file produced this verdict (reproducibility anchor). */
  policy_version: string;
  /** Populated only when `guard_result === "errored"`; otherwise `null`. */
  errored_reason: string | null;
}

/** The guard's versioned discriminant literal. */
export const DOCS_ONLY_GUARD_ID = "docs-only-path-guard.v0" as const;
/** The ratified two-lane vocabulary. */
export const GUARD_LANES = ["docs-only", "full-lane"] as const;
/** The guard-result vocabulary. */
export const GUARD_RESULTS = ["proven", "not-proven", "errored"] as const;

const KEYS = [
  "guard",
  "lane",
  "guard_result",
  "guard_authoritative",
  "human_review_required",
  "matched_paths",
  "unmatched_paths",
  "sensitive_paths",
  "policy_version",
  "errored_reason",
] as const;

/** Returns a human-readable reason string when invalid, or `null` when valid. */
function check(value: unknown): string | null {
  if (!isPlainObject(value)) return "not a plain object";
  if (!hasExactKeys(value, KEYS)) return `keys must be exactly [${KEYS.join(", ")}]`;
  if (value.guard !== DOCS_ONLY_GUARD_ID) return `guard must be "${DOCS_ONLY_GUARD_ID}"`;
  if (!isOneOf(value.lane, GUARD_LANES)) return `lane must be one of [${GUARD_LANES.join(", ")}]`;
  if (!isOneOf(value.guard_result, GUARD_RESULTS)) {
    return `guard_result must be one of [${GUARD_RESULTS.join(", ")}]`;
  }
  if (value.guard_authoritative !== true) return "guard_authoritative must be the literal true";
  if (typeof value.human_review_required !== "boolean") {
    return "human_review_required must be a boolean";
  }
  if (!isStringArray(value.matched_paths)) return "matched_paths must be string[]";
  if (!isStringArray(value.unmatched_paths)) return "unmatched_paths must be string[]";
  if (!isStringArray(value.sensitive_paths)) return "sensitive_paths must be string[]";
  if (typeof value.policy_version !== "string") return "policy_version must be a string";
  if (value.errored_reason !== null && typeof value.errored_reason !== "string") {
    return "errored_reason must be a string or null";
  }
  return null;
}

/** Type guard: true iff `value` is a structurally-valid `DocsOnlyGuardResult`. */
export function isDocsOnlyGuardResult(value: unknown): value is DocsOnlyGuardResult {
  return check(value) === null;
}

/**
 * Parse-or-throw. Returns the validated `DocsOnlyGuardResult`; throws
 * `TypeError` with the first failing constraint when `value` is invalid.
 */
export function parseDocsOnlyGuardResult(value: unknown): DocsOnlyGuardResult {
  const reason = check(value);
  if (reason !== null) throw new TypeError(`invalid DocsOnlyGuardResult: ${reason}`);
  return value as DocsOnlyGuardResult;
}
