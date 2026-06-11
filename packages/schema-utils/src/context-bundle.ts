import {
  hasExactKeys,
  isNonEmptyString,
  isOneOf,
  isPacificIso8601,
  isPlainObject,
  isPrefixedUlid,
  isSha256Ref,
} from "./_validate.ts";
import { type DocsOnlyGuardResult, isDocsOnlyGuardResult } from "./guard-output.ts";
import { isRedactionRecord, type RedactionRecord } from "./redaction.ts";

/** What's under review: a repo and a base..head range. */
export interface BundleSubject {
  repo: string;
  base: string;
  head: string;
}

/** One file in the reviewer payload (distinct from the guard's path lists). */
export interface BundleFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  /** sha256 of the file's diff (referenced, never inlined). */
  diff_ref: string;
  redacted: boolean;
}

/**
 * `context-bundle.v0` — the deterministic, bounded packet handed to the
 * read-only code-reviewer.
 *
 * The bundle is ADVISORY by schema shape: `advisory_only` is a required literal
 * `true`, and there is no field a reviewer could set to pass/fail/block/merge.
 * "Agents never gate merges" is therefore enforced by the ABSENCE of any such
 * field (and by strict validation rejecting one if injected), not by
 * convention. `classification` is the guard's `DocsOnlyGuardResult` verbatim —
 * imported from the single source, never recomputed or rewritten here.
 */
export interface ContextBundleV0 {
  /** Schema discriminant. */
  schema: "context-bundle.v0";
  /** Bundle identity (`bundle_<ULID>`). */
  bundle_id: string;
  /** Ledger back-ref to the run that produced the change (`run_<ULID>`). */
  run_id: string;
  /** Pacific ISO-8601 with explicit offset. */
  created_at: string;
  /**
   * Agent work-stream identity (e.g. `agents-js`) — NOT the guard's CI-routing
   * `lane`. The only `lane` in M1 is the guard's authoritative
   * `docs-only | full-lane` on `classification`; this names the work-stream.
   */
  workstream: string;
  /** What's under review. */
  subject: BundleSubject;
  /** The guard's authoritative classification (copied verbatim, not authored). */
  classification: DocsOnlyGuardResult;
  /** Reviewer payload — the change set with diff refs. */
  files: BundleFile[];
  /** Recorded redactions (shared §4 rule). */
  redactions: RedactionRecord[];
  /** Always `true` — the bundle is NEVER a merge gate. */
  advisory_only: true;
  /** Digest of the bundle's canonical form (computed by the writer). */
  bundle_digest: string;
}

/** File-change vocabulary. */
export const FILE_CHANGES = ["added", "modified", "deleted", "renamed"] as const;

const SUBJECT_KEYS = ["repo", "base", "head"] as const;
const FILE_KEYS = ["path", "change", "diff_ref", "redacted"] as const;

const KEYS = [
  "schema",
  "bundle_id",
  "run_id",
  "created_at",
  "workstream",
  "subject",
  "classification",
  "files",
  "redactions",
  "advisory_only",
  "bundle_digest",
] as const;

function isBundleSubject(value: unknown): value is BundleSubject {
  if (!isPlainObject(value)) return false;
  if (!hasExactKeys(value, SUBJECT_KEYS)) return false;
  return (
    isNonEmptyString(value.repo) && isNonEmptyString(value.base) && isNonEmptyString(value.head)
  );
}

function isBundleFile(value: unknown): value is BundleFile {
  if (!isPlainObject(value)) return false;
  if (!hasExactKeys(value, FILE_KEYS)) return false;
  if (typeof value.path !== "string") return false;
  if (!isOneOf(value.change, FILE_CHANGES)) return false;
  if (!isSha256Ref(value.diff_ref)) return false;
  return typeof value.redacted === "boolean";
}

function check(value: unknown): string | null {
  if (!isPlainObject(value)) return "not a plain object";
  if (!hasExactKeys(value, KEYS)) return `keys must be exactly [${KEYS.join(", ")}]`;
  if (value.schema !== "context-bundle.v0") return 'schema must be "context-bundle.v0"';
  if (!isPrefixedUlid(value.bundle_id, "bundle")) return "bundle_id must be a bundle_<ULID>";
  if (!isPrefixedUlid(value.run_id, "run")) return "run_id must be a run_<ULID>";
  if (!isPacificIso8601(value.created_at)) return "created_at must be a Pacific ISO-8601 timestamp";
  if (!isNonEmptyString(value.workstream)) return "workstream must be a non-empty string";
  if (!isBundleSubject(value.subject)) return "subject must be { repo, base, head }";
  if (!isDocsOnlyGuardResult(value.classification)) {
    return "classification must be a valid DocsOnlyGuardResult";
  }
  if (!Array.isArray(value.files) || !value.files.every(isBundleFile)) {
    return "files must be BundleFile[]";
  }
  if (!Array.isArray(value.redactions) || !value.redactions.every(isRedactionRecord)) {
    return "redactions must be RedactionRecord[]";
  }
  if (value.advisory_only !== true) return "advisory_only must be the literal true";
  if (!isSha256Ref(value.bundle_digest)) return "bundle_digest must be a sha256 ref";
  return null;
}

/** Type guard: true iff `value` is a structurally-valid `ContextBundleV0`. */
export function isContextBundle(value: unknown): value is ContextBundleV0 {
  return check(value) === null;
}

/** Parse-or-throw; throws `TypeError` with the first failing constraint. */
export function parseContextBundle(value: unknown): ContextBundleV0 {
  const reason = check(value);
  if (reason !== null) throw new TypeError(`invalid ContextBundleV0: ${reason}`);
  return value as ContextBundleV0;
}
