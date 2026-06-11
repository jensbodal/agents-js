/**
 * Deterministic docs-only path guard (M1, design packet items 3).
 *
 * Pure, code-only lane authority: given the changed-file list for `base..head`,
 * it deterministically PROVES the `docs-only` lane (every changed file is
 * documentation content) or falls back to `full-lane`. No LLM, no network, no
 * agent judgment — this is the authority the advisory classifier may never
 * override (see the M1 gate rule).
 *
 * Invariants enforced here (design packet §3, §4):
 * - default-deny: docs-only is proven IFF *every* changed file is docs-content.
 * - guard failure (caller-side diff/policy error) falls back to `full-lane`,
 *   recorded distinctly as `errored` vs `not-proven`.
 * - security-sensitive is additive and deterministic (sensitive-path denylist).
 *
 * The seam type {@link DocsOnlyGuardResult} (consumed verbatim by
 * `context-bundle.v0.classification`) lives in `@agents-js/schema-utils`; this
 * module produces the internal {@link GuardEvaluation} and a thin adapter maps
 * it to the shared type (see `toGuardResult`, added once schema-utils lands the
 * type — policy imports it, never redefines it).
 */

import { DOCS_ONLY_POLICY_V0, type DocsOnlyPolicy } from "./docs-only-policy.ts";

/** Git symlink mode — a symlink is never docs-content regardless of target. */
const GIT_SYMLINK_MODE = "120000";

/** A single changed file in a `base..head` diff (the guard's only input). */
export interface ChangedFile {
  /** Repo-relative POSIX path at head (new path for renames). */
  readonly path: string;
  readonly changeKind: "added" | "modified" | "deleted" | "renamed";
  /** Repo-relative POSIX path at base — required for renames. */
  readonly oldPath?: string;
  /** Git file mode at head, e.g. `120000` for a symlink. */
  readonly mode?: string;
}

/** Internal evaluation result (NOT the shared seam type). */
export interface GuardEvaluation {
  readonly lane: "docs-only" | "full-lane";
  readonly guardResult: "proven" | "not-proven" | "errored";
  /** Deterministic half of the human-review ratchet (sensitive denylist hit). */
  readonly humanReviewRequired: boolean;
  readonly matchedPaths: readonly string[];
  readonly unmatchedPaths: readonly string[];
  readonly sensitivePaths: readonly string[];
  readonly policyVersion: string;
  readonly erroredReason: string | null;
}

/**
 * Translate an explicit guard pattern to an anchored RegExp. Supported forms
 * (see `docs-only-policy.ts`): `dir/**`, `**​/seg/**`, `*.ext`, `dir/**​/*.ext`,
 * and exact paths. `*` matches within a single path segment; `**` spans
 * segments. Deterministic and dependency-free so the guard stays auditable.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    // `charAt` returns `string` (not `string | undefined` under
    // noUncheckedIndexedAccess); the loop guard guarantees `i` is in range.
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // `**​/` — zero or more leading directories.
          re += "(?:.*/)?";
          i += 3;
          continue;
        }
        // trailing `**` (typically after a `/`) — span the rest.
        re += ".*";
        i += 2;
        continue;
      }
      // single `*` — one path segment.
      re += "[^/]*";
      i += 1;
      continue;
    }
    re += "\\^$.|?+()[]{}/".includes(c) && c !== "/" ? `\\${c}` : c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

/**
 * Is this changed file documentation *content* (vs infrastructure)? The
 * predicate every file must satisfy for the docs-only lane to be proven.
 */
export function isDocsContent(file: ChangedFile, policy: DocsOnlyPolicy): boolean {
  // A symlink under a docs path matches the allowlist string but is not prose;
  // it can point at runtime. Never docs-content.
  if (file.mode === GIT_SYMLINK_MODE) {
    return false;
  }
  // Docs-infrastructure (tooling/CI/test-fixture markdown) forces full-lane even
  // under docs/.
  if (matchesAny(file.path, policy.docsInfraDenylist)) {
    return false;
  }
  // A rename is docs-only ONLY if BOTH endpoints are docs-content; otherwise it
  // is a code move/deletion wearing a docs hat.
  if (file.changeKind === "renamed") {
    const oldPath = file.oldPath ?? "";
    return (
      matchesAny(file.path, policy.allowlist) &&
      matchesAny(oldPath, policy.allowlist) &&
      !matchesAny(oldPath, policy.docsInfraDenylist)
    );
  }
  return matchesAny(file.path, policy.allowlist);
}

/** Deterministic security-sensitive check (additive escalation, §4.5). */
export function isSensitive(file: ChangedFile, policy: DocsOnlyPolicy): boolean {
  return (
    matchesAny(file.path, policy.sensitiveDenylist) ||
    (file.changeKind === "renamed" && matchesAny(file.oldPath ?? "", policy.sensitiveDenylist))
  );
}

/** Build an `errored` verdict — the guard could not run; fails closed to full-lane. */
export function erroredEvaluation(
  reason: string,
  policy: DocsOnlyPolicy = DOCS_ONLY_POLICY_V0,
): GuardEvaluation {
  return {
    lane: "full-lane",
    guardResult: "errored",
    humanReviewRequired: false,
    matchedPaths: [],
    unmatchedPaths: [],
    sensitivePaths: [],
    policyVersion: policy.version,
    erroredReason: reason,
  };
}

/**
 * Evaluate the docs-only guard over a changed-file list. Pure and deterministic.
 * Empty diff → `not-proven` (nothing to prove) → full-lane. Caller wraps diff
 * acquisition; on diff/policy failure use {@link erroredEvaluation}.
 */
export function evaluateDocsOnlyGuard(
  files: readonly ChangedFile[],
  policy: DocsOnlyPolicy = DOCS_ONLY_POLICY_V0,
): GuardEvaluation {
  if (files.length === 0) {
    return {
      lane: "full-lane",
      guardResult: "not-proven",
      humanReviewRequired: false,
      matchedPaths: [],
      unmatchedPaths: [],
      sensitivePaths: [],
      policyVersion: policy.version,
      erroredReason: null,
    };
  }

  const matchedPaths: string[] = [];
  const unmatchedPaths: string[] = [];
  const sensitivePaths: string[] = [];

  for (const file of files) {
    if (isDocsContent(file, policy)) {
      matchedPaths.push(file.path);
    } else {
      unmatchedPaths.push(file.path);
    }
    if (isSensitive(file, policy)) {
      sensitivePaths.push(file.path);
    }
  }

  const proven = unmatchedPaths.length === 0;
  return {
    lane: proven ? "docs-only" : "full-lane",
    guardResult: proven ? "proven" : "not-proven",
    humanReviewRequired: sensitivePaths.length > 0,
    matchedPaths,
    unmatchedPaths,
    sensitivePaths,
    policyVersion: policy.version,
    erroredReason: null,
  };
}
