import { describe, expect, test } from "bun:test";
import {
  EVIDENCE_KINDS,
  isRunLedgerRecord,
  parseRunLedgerRecord,
  RUN_STATUSES,
  type RunLedgerRecordV0,
} from "../src/index.ts";

// A valid 26-char Crockford base32 ULID (first char 0-7, excludes I/L/O/U).
const ULID = "01J9Z3K8XBETP9R0CTV2N7QW5A";
const SHA = `sha256:${"a".repeat(64)}`;

const VALID: RunLedgerRecordV0 = {
  schema: "run-ledger.v0",
  run_id: `run_${ULID}`,
  ledger_seq: 142,
  attempt_group_key: "ajs:test:examples:input-7f3a",
  supersedes: null,
  actor: "ajs-claude",
  workstream: "agents-js",
  command: "bun run test:examples",
  input_digest: SHA,
  started_at: "2026-06-10T23:27:00-07:00",
  finished_at: "2026-06-10T23:28:14-07:00",
  status: "succeeded",
  attempt: 1,
  exit_code: 0,
  evidence: [{ kind: "test", ref: "examples/agui-transport-smoke", digest: SHA }],
  summary: "10/10 example smokes green",
  redactions: [],
  prev_digest: SHA,
  record_digest: SHA,
};

describe("run-ledger.v0 — accepts valid records", () => {
  test("a complete succeeded record validates and exposes the enums", () => {
    expect(parseRunLedgerRecord(VALID)).toEqual(VALID);
    expect(isRunLedgerRecord(VALID)).toBe(true);
    expect(RUN_STATUSES).toEqual(["in_flight", "succeeded", "failed", "retried", "cancelled"]);
    expect(EVIDENCE_KINDS).toEqual(["run", "test", "story", "doc", "live"]);
  });

  test("an in-flight genesis record (nulls + seq 0 + no prev) validates", () => {
    const genesis: RunLedgerRecordV0 = {
      ...VALID,
      ledger_seq: 0,
      supersedes: null,
      input_digest: null,
      finished_at: null,
      status: "in_flight",
      exit_code: null,
      evidence: [],
      prev_digest: null,
    };
    expect(isRunLedgerRecord(genesis)).toBe(true);
  });

  test("a retry record supersedes a prior run", () => {
    const retry: RunLedgerRecordV0 = {
      ...VALID,
      supersedes: `run_${ULID}`,
      status: "retried",
      attempt: 2,
    };
    expect(isRunLedgerRecord(retry)).toBe(true);
  });
});

describe("run-ledger.v0 — strict rejection (boundaries enforced at runtime)", () => {
  test("rejects a leaked Matrix-projection field (no matrix_* in the record)", () => {
    expect(isRunLedgerRecord({ ...VALID, matrix_event_id: "$abc" })).toBe(false);
  });

  test("rejects unknown keys and missing required keys", () => {
    expect(isRunLedgerRecord({ ...VALID, extra: 1 })).toBe(false);
    const { summary: _omit, ...withoutSummary } = VALID;
    expect(isRunLedgerRecord(withoutSummary)).toBe(false);
  });

  test("rejects a top-level `lane` field (no second lane vocabulary beside the guard's)", () => {
    const { workstream, ...rest } = VALID;
    // Using the OLD name reintroduces the lane-vocabulary collision the guard
    // seam removes: `lane` is reserved for the guard; the work-stream is `workstream`.
    expect(isRunLedgerRecord({ ...rest, lane: workstream })).toBe(false);
  });

  test("rejects a malformed run_id (wrong prefix / not a ULID)", () => {
    expect(isRunLedgerRecord({ ...VALID, run_id: "run_not-a-ulid" })).toBe(false);
    expect(isRunLedgerRecord({ ...VALID, run_id: ULID })).toBe(false);
  });

  test("rejects a non-integer or negative ledger_seq", () => {
    expect(isRunLedgerRecord({ ...VALID, ledger_seq: -1 })).toBe(false);
    expect(isRunLedgerRecord({ ...VALID, ledger_seq: 1.5 })).toBe(false);
  });

  test("rejects attempt < 1", () => {
    expect(isRunLedgerRecord({ ...VALID, attempt: 0 })).toBe(false);
  });

  test("rejects an out-of-enum status", () => {
    expect(isRunLedgerRecord({ ...VALID, status: "done" })).toBe(false);
  });

  test("rejects a non-Pacific / Zulu / naive timestamp", () => {
    expect(isRunLedgerRecord({ ...VALID, started_at: "2026-06-10T23:27:00Z" })).toBe(false);
    expect(isRunLedgerRecord({ ...VALID, started_at: "2026-06-10T23:27:00+00:00" })).toBe(false);
    expect(isRunLedgerRecord({ ...VALID, started_at: "2026-06-10T23:27:00" })).toBe(false);
  });

  test("rejects a malformed digest-chain field", () => {
    expect(isRunLedgerRecord({ ...VALID, record_digest: "nope" })).toBe(false);
    expect(isRunLedgerRecord({ ...VALID, prev_digest: "sha1:abc" })).toBe(false);
  });

  test("rejects a nested evidence entry with a bad kind", () => {
    expect(
      isRunLedgerRecord({ ...VALID, evidence: [{ kind: "screenshot", ref: "x", digest: SHA }] }),
    ).toBe(false);
  });

  test("rejects a nested redaction entry that is malformed", () => {
    expect(
      isRunLedgerRecord({ ...VALID, redactions: [{ path: "p", reason: "nope", digest: SHA }] }),
    ).toBe(false);
  });
});
