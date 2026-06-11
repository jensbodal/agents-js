import { describe, expect, test } from "bun:test";
import {
  type DocsOnlyGuardResult,
  isDocsOnlyGuardResult,
  parseDocsOnlyGuardResult,
} from "../src/index.ts";

// A valid §4.7 guard-output object (matches the blessed M1 packet lines 85-97
// and cognee-claude's locked DocsOnlyGuardResult shape verbatim).
const VALID: DocsOnlyGuardResult = {
  guard: "docs-only-path-guard.v0",
  lane: "docs-only",
  guard_result: "proven",
  guard_authoritative: true,
  human_review_required: false,
  matched_paths: ["docs/foo.md"],
  unmatched_paths: [],
  sensitive_paths: [],
  policy_version: "policy.v0",
  errored_reason: null,
};

describe("DocsOnlyGuardResult — accepts valid §4.7 output", () => {
  test("parse returns the object and the guard recognises it", () => {
    expect(parseDocsOnlyGuardResult(VALID)).toEqual(VALID);
    expect(isDocsOnlyGuardResult(VALID)).toBe(true);
  });

  test("full-lane / not-proven with unmatched + errored shapes are valid", () => {
    const fullLane: DocsOnlyGuardResult = {
      ...VALID,
      lane: "full-lane",
      guard_result: "not-proven",
      matched_paths: [],
      unmatched_paths: ["packages/host/src/testing.ts"],
    };
    expect(isDocsOnlyGuardResult(fullLane)).toBe(true);

    const errored: DocsOnlyGuardResult = {
      ...VALID,
      lane: "full-lane",
      guard_result: "errored",
      errored_reason: "unreadable policy file",
    };
    expect(isDocsOnlyGuardResult(errored)).toBe(true);
  });
});

describe("DocsOnlyGuardResult — strict rejection (boundaries enforced at runtime)", () => {
  test("rejects unknown keys (no projection/authority leak)", () => {
    expect(isDocsOnlyGuardResult({ ...VALID, matrix_event_id: "$x" })).toBe(false);
    expect(() => parseDocsOnlyGuardResult({ ...VALID, extra: 1 })).toThrow();
  });

  test("rejects a forged guard_authoritative !== true", () => {
    expect(isDocsOnlyGuardResult({ ...VALID, guard_authoritative: false })).toBe(false);
  });

  test("rejects the wrong guard literal", () => {
    expect(isDocsOnlyGuardResult({ ...VALID, guard: "some-other-guard.v0" })).toBe(false);
  });

  test("rejects an out-of-enum lane", () => {
    expect(isDocsOnlyGuardResult({ ...VALID, lane: "code" })).toBe(false);
  });

  test("rejects an out-of-enum guard_result", () => {
    expect(isDocsOnlyGuardResult({ ...VALID, guard_result: "maybe" })).toBe(false);
  });

  test("rejects non-boolean human_review_required", () => {
    expect(isDocsOnlyGuardResult({ ...VALID, human_review_required: "yes" })).toBe(false);
  });

  test("rejects path lists that are not arrays of strings", () => {
    expect(isDocsOnlyGuardResult({ ...VALID, matched_paths: "docs/foo.md" })).toBe(false);
    expect(isDocsOnlyGuardResult({ ...VALID, unmatched_paths: [1, 2] })).toBe(false);
  });

  test("rejects errored_reason that is neither string nor null", () => {
    expect(isDocsOnlyGuardResult({ ...VALID, errored_reason: 42 })).toBe(false);
  });

  test("rejects a missing required field", () => {
    const { policy_version: _omit, ...withoutPolicy } = VALID;
    expect(isDocsOnlyGuardResult(withoutPolicy)).toBe(false);
  });

  test("rejects non-objects", () => {
    expect(isDocsOnlyGuardResult(null)).toBe(false);
    expect(isDocsOnlyGuardResult("string")).toBe(false);
    expect(isDocsOnlyGuardResult([])).toBe(false);
    expect(() => parseDocsOnlyGuardResult(null)).toThrow();
  });
});
