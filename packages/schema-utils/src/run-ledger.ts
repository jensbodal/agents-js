import {
  hasExactKeys,
  isNonEmptyString,
  isOneOf,
  isPacificIso8601,
  isPlainObject,
  isPrefixedUlid,
  isSha256Ref,
} from "./_validate.ts";
import { isRedactionRecord, type RedactionRecord } from "./redaction.ts";

/** Outbound reference to an artifact, by digest — never an inline blob. */
export interface EvidenceRef {
  /** Reuses the `capability-status.json` evidence vocabulary. */
  kind: "run" | "test" | "story" | "doc" | "live";
  /** Locator for the artifact (path, example name, doc id, etc.). */
  ref: string;
  /** sha256 of the referenced artifact. */
  digest: string;
}

/**
 * `run-ledger.v0` — one append-only record of an agent/command run.
 *
 * The ledger is the ordered set of these records and is AUTHORITATIVE by
 * construction: `prev_digest` + `record_digest` form a tamper-evident hash
 * chain that Matrix (lossy, reorderable) cannot reproduce. There is
 * deliberately no `matrix_*` field — Matrix is a one-way projection of
 * `summary`, never a source. Records are never mutated; a re-run appends a new
 * record that `supersedes` the prior, preserving the chain.
 *
 * NOTE: digest *computation* and chain *verification* are the runtime writer's
 * concern (a follow-up slice). This schema validates the record's SHAPE,
 * including that the digest fields are well-formed `sha256:` refs.
 */
export interface RunLedgerRecordV0 {
  /** Schema discriminant. */
  schema: "run-ledger.v0";
  /** Globally-unique, time-sortable run identity (`run_<ULID>`). */
  run_id: string;
  /** Monotonic per-ledger integer = authoritative order (serial-append). */
  ledger_seq: number;
  /**
   * Caller-supplied key grouping records that are attempts of one logical
   * operation (drives the `supersedes` retry chain). Renamed from the design's
   * `idempotency_key`, which overpromised: a pure content digest cannot
   * distinguish a retry from an independent later re-run and never dedups, so
   * this is explicitly an attempt-grouping key, not an idempotency/dedup key.
   */
  attempt_group_key: string;
  /** Prior `run_id` this attempt replaces, or `null` for a first attempt. */
  supersedes: string | null;
  /** Agent identity that performed the run. */
  actor: string;
  /**
   * Agent work-stream identity (e.g. `agents-js`) — NOT the guard's CI-routing
   * `lane`. `lane` is reserved across M1 for the guard's authoritative
   * `docs-only | full-lane` vocabulary (see `DocsOnlyGuardResult.lane`); this
   * free-form field names the work-stream and must not be confused with it.
   */
  workstream: string;
  /** Canonical command/operation string. */
  command: string;
  /** Digest of the resolved inputs, or `null` when not applicable. */
  input_digest: string | null;
  /** Pacific ISO-8601 with explicit offset. */
  started_at: string;
  /** Pacific ISO-8601, or `null` while in-flight. */
  finished_at: string | null;
  /** Lifecycle status. */
  status: "in_flight" | "succeeded" | "failed" | "retried" | "cancelled";
  /** 1-based attempt number; increments along the `supersedes` chain. */
  attempt: number;
  /** Process exit code, or `null` when not applicable. */
  exit_code: number | null;
  /** Outbound artifact references (by digest). */
  evidence: EvidenceRef[];
  /** Human-displayable summary — the Matrix projection source. */
  summary: string;
  /** Recorded redactions (shared §4 rule); never silent. */
  redactions: RedactionRecord[];
  /** `record_digest` of `ledger_seq - 1`, or `null` at genesis. */
  prev_digest: string | null;
  /** Digest of THIS record's canonical form (computed by the writer). */
  record_digest: string;
}

/** Lifecycle status vocabulary. */
export const RUN_STATUSES = ["in_flight", "succeeded", "failed", "retried", "cancelled"] as const;

/** Evidence-kind vocabulary (shared with `capability-status.json`). */
export const EVIDENCE_KINDS = ["run", "test", "story", "doc", "live"] as const;

const EVIDENCE_KEYS = ["kind", "ref", "digest"] as const;

const KEYS = [
  "schema",
  "run_id",
  "ledger_seq",
  "attempt_group_key",
  "supersedes",
  "actor",
  "workstream",
  "command",
  "input_digest",
  "started_at",
  "finished_at",
  "status",
  "attempt",
  "exit_code",
  "evidence",
  "summary",
  "redactions",
  "prev_digest",
  "record_digest",
] as const;

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  if (!isPlainObject(value)) return false;
  if (!hasExactKeys(value, EVIDENCE_KEYS)) return false;
  if (!isOneOf(value.kind, EVIDENCE_KINDS)) return false;
  if (typeof value.ref !== "string") return false;
  return isSha256Ref(value.digest);
}

function check(value: unknown): string | null {
  if (!isPlainObject(value)) return "not a plain object";
  if (!hasExactKeys(value, KEYS)) return `keys must be exactly [${KEYS.join(", ")}]`;
  if (value.schema !== "run-ledger.v0") return 'schema must be "run-ledger.v0"';
  if (!isPrefixedUlid(value.run_id, "run")) return "run_id must be a run_<ULID>";
  if (!isNonNegativeInteger(value.ledger_seq)) return "ledger_seq must be a non-negative integer";
  if (typeof value.attempt_group_key !== "string") return "attempt_group_key must be a string";
  if (value.supersedes !== null && !isPrefixedUlid(value.supersedes, "run")) {
    return "supersedes must be a run_<ULID> or null";
  }
  if (!isNonEmptyString(value.actor)) return "actor must be a non-empty string";
  if (!isNonEmptyString(value.workstream)) return "workstream must be a non-empty string";
  if (!isNonEmptyString(value.command)) return "command must be a non-empty string";
  if (value.input_digest !== null && !isSha256Ref(value.input_digest)) {
    return "input_digest must be a sha256 ref or null";
  }
  if (!isPacificIso8601(value.started_at)) return "started_at must be a Pacific ISO-8601 timestamp";
  if (value.finished_at !== null && !isPacificIso8601(value.finished_at)) {
    return "finished_at must be a Pacific ISO-8601 timestamp or null";
  }
  if (!isOneOf(value.status, RUN_STATUSES))
    return `status must be one of [${RUN_STATUSES.join(", ")}]`;
  if (
    !(typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt >= 1)
  ) {
    return "attempt must be an integer >= 1";
  }
  if (
    value.exit_code !== null &&
    !(typeof value.exit_code === "number" && Number.isInteger(value.exit_code))
  ) {
    return "exit_code must be an integer or null";
  }
  if (!Array.isArray(value.evidence) || !value.evidence.every(isEvidenceRef)) {
    return "evidence must be EvidenceRef[]";
  }
  if (!isNonEmptyString(value.summary)) return "summary must be a non-empty string";
  if (!Array.isArray(value.redactions) || !value.redactions.every(isRedactionRecord)) {
    return "redactions must be RedactionRecord[]";
  }
  if (value.prev_digest !== null && !isSha256Ref(value.prev_digest)) {
    return "prev_digest must be a sha256 ref or null";
  }
  if (!isSha256Ref(value.record_digest)) return "record_digest must be a sha256 ref";
  return null;
}

/** Type guard: true iff `value` is a structurally-valid `RunLedgerRecordV0`. */
export function isRunLedgerRecord(value: unknown): value is RunLedgerRecordV0 {
  return check(value) === null;
}

/** Parse-or-throw; throws `TypeError` with the first failing constraint. */
export function parseRunLedgerRecord(value: unknown): RunLedgerRecordV0 {
  const reason = check(value);
  if (reason !== null) throw new TypeError(`invalid RunLedgerRecordV0: ${reason}`);
  return value as RunLedgerRecordV0;
}
