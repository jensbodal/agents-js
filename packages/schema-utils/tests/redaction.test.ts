import { describe, expect, test } from "bun:test";
import { isRedactionRecord, REDACTION_REASONS, type RedactionRecord } from "../src/index.ts";

const VALID: RedactionRecord = {
  path: "evidence[0].ref",
  reason: "secret-token",
  digest: `sha256:${"a".repeat(64)}`,
};

describe("RedactionRecord (shared §4 rule)", () => {
  test("accepts a well-formed record and exposes the v0 reason enum", () => {
    expect(isRedactionRecord(VALID)).toBe(true);
    expect(REDACTION_REASONS).toEqual(["secret-token", "pii", "oversized", "policy"]);
  });

  test("rejects an out-of-enum reason", () => {
    expect(isRedactionRecord({ ...VALID, reason: "because" })).toBe(false);
  });

  test("rejects a digest that is not a sha256 ref (the redacted value's hash)", () => {
    expect(isRedactionRecord({ ...VALID, digest: "deadbeef" })).toBe(false);
    expect(isRedactionRecord({ ...VALID, digest: `sha256:${"A".repeat(64)}` })).toBe(false);
  });

  test("rejects unknown keys and missing keys (no silent extra data)", () => {
    expect(isRedactionRecord({ ...VALID, note: "x" })).toBe(false);
    const { digest: _omit, ...withoutDigest } = VALID;
    expect(isRedactionRecord(withoutDigest)).toBe(false);
  });

  test("rejects a non-string path", () => {
    expect(isRedactionRecord({ ...VALID, path: 7 })).toBe(false);
  });
});
