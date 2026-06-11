import { describe, expect, test } from "bun:test";
import {
  type ContextBundleV0,
  FILE_CHANGES,
  isContextBundle,
  parseContextBundle,
} from "../src/index.ts";

const ULID = "01J9Z3K8XBETP9R0CTV2N7QW5A";
const SHA = `sha256:${"b".repeat(64)}`;

const VALID: ContextBundleV0 = {
  schema: "context-bundle.v0",
  bundle_id: `bundle_${ULID}`,
  run_id: `run_${ULID}`,
  created_at: "2026-06-10T23:30:00-07:00",
  workstream: "agents-js",
  subject: { repo: "agents-js", base: "f58cd8d8", head: "9ced1832" },
  classification: {
    guard: "docs-only-path-guard.v0",
    lane: "full-lane",
    guard_result: "not-proven",
    guard_authoritative: true,
    human_review_required: false,
    matched_paths: [],
    unmatched_paths: ["packages/host/src/testing.ts"],
    sensitive_paths: [],
    policy_version: "policy.v0",
    errored_reason: null,
  },
  files: [
    { path: "packages/host/src/testing.ts", change: "modified", diff_ref: SHA, redacted: false },
  ],
  redactions: [],
  advisory_only: true,
  bundle_digest: SHA,
};

describe("context-bundle.v0 — accepts valid bundles", () => {
  test("a valid bundle validates and exposes the change enum", () => {
    expect(parseContextBundle(VALID)).toEqual(VALID);
    expect(isContextBundle(VALID)).toBe(true);
    expect(FILE_CHANGES).toEqual(["added", "modified", "deleted", "renamed"]);
  });

  test("classification embeds a valid DocsOnlyGuardResult (the type-level seam)", () => {
    const docsOnly: ContextBundleV0 = {
      ...VALID,
      classification: {
        ...VALID.classification,
        lane: "docs-only",
        guard_result: "proven",
        matched_paths: ["docs/foo.md"],
        unmatched_paths: [],
      },
      files: [{ path: "docs/foo.md", change: "modified", diff_ref: SHA, redacted: false }],
    };
    expect(isContextBundle(docsOnly)).toBe(true);
  });
});

describe("context-bundle.v0 — agents-never-gate is enforced structurally", () => {
  test("rejects advisory_only !== true (the bundle is never a merge gate)", () => {
    expect(isContextBundle({ ...VALID, advisory_only: false })).toBe(false);
  });

  test("rejects a missing advisory_only", () => {
    const { advisory_only: _omit, ...withoutFlag } = VALID;
    expect(isContextBundle(withoutFlag)).toBe(false);
  });

  test("rejects any injected blocking/merge-authority field (unknown key)", () => {
    expect(isContextBundle({ ...VALID, blocking: true })).toBe(false);
    expect(isContextBundle({ ...VALID, merge_authority: "block" })).toBe(false);
    expect(isContextBundle({ ...VALID, verdict: "fail" })).toBe(false);
  });
});

describe("context-bundle.v0 — strict rejection", () => {
  test("rejects a leaked Matrix-projection field", () => {
    expect(isContextBundle({ ...VALID, matrix_event_id: "$abc" })).toBe(false);
  });

  test("rejects a top-level `lane` field — the only lane in M1 is the guard's", () => {
    const { workstream, ...rest } = VALID;
    // classification.lane (the guard's) stays; a top-level `lane` would be a
    // second, unconstrained lane vocabulary and is rejected as an unknown key.
    expect(isContextBundle({ ...rest, lane: workstream })).toBe(false);
  });

  test("rejects a classification that is not a valid DocsOnlyGuardResult", () => {
    expect(
      isContextBundle({
        ...VALID,
        classification: { ...VALID.classification, guard_authoritative: false },
      }),
    ).toBe(false);
    expect(
      isContextBundle({ ...VALID, classification: { ...VALID.classification, lane: "code" } }),
    ).toBe(false);
  });

  test("rejects malformed bundle_id / run_id", () => {
    expect(isContextBundle({ ...VALID, bundle_id: `run_${ULID}` })).toBe(false);
    expect(isContextBundle({ ...VALID, run_id: "run_bad" })).toBe(false);
  });

  test("rejects a Zulu/naive created_at", () => {
    expect(isContextBundle({ ...VALID, created_at: "2026-06-10T23:30:00Z" })).toBe(false);
  });

  test("rejects a malformed subject", () => {
    expect(isContextBundle({ ...VALID, subject: { repo: "agents-js", base: "x" } })).toBe(false);
    expect(
      isContextBundle({ ...VALID, subject: { repo: "agents-js", base: "x", head: "y", extra: 1 } }),
    ).toBe(false);
  });

  test("rejects a file with a bad change enum or non-sha256 diff_ref", () => {
    expect(
      isContextBundle({
        ...VALID,
        files: [{ path: "a", change: "tweaked", diff_ref: SHA, redacted: false }],
      }),
    ).toBe(false);
    expect(
      isContextBundle({
        ...VALID,
        files: [{ path: "a", change: "modified", diff_ref: "x", redacted: false }],
      }),
    ).toBe(false);
  });

  test("rejects a malformed bundle_digest", () => {
    expect(isContextBundle({ ...VALID, bundle_digest: "nope" })).toBe(false);
  });
});
