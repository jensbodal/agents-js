import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_EVIDENCE_EXTENSION_URI,
  type ArtifactEvidenceV0,
  isArtifactEvidence,
  parseArtifactEvidence,
  readArtifactEvidence,
} from "../src/index.ts";

const ULID = "01J9Z3K8XBETP9R0CTV2N7QW5A";
const SHA = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

const VALID: ArtifactEvidenceV0 = {
  schema: "artifact-evidence.v0",
  run_id: `run_${ULID}`,
  part_digest: SHA,
  evidence_digests: [SHA_B],
  recorded_at: "2026-06-11T18:30:00-07:00",
};

describe("artifact-evidence.v0 — accepts valid linkage payloads", () => {
  test("a valid payload validates and round-trips through parse", () => {
    expect(isArtifactEvidence(VALID)).toBe(true);
    expect(parseArtifactEvidence(VALID)).toEqual(VALID);
  });

  test("accepts multiple evidence-digest selectors and a winter (PST) offset", () => {
    const multi: ArtifactEvidenceV0 = {
      ...VALID,
      evidence_digests: [SHA, SHA_B, `sha256:${"c".repeat(64)}`],
      recorded_at: "2026-01-15T08:00:00-08:00",
    };
    expect(isArtifactEvidence(multi)).toBe(true);
  });

  test("accepts an empty evidence_digests list (an append may carry only a part digest)", () => {
    expect(isArtifactEvidence({ ...VALID, evidence_digests: [] })).toBe(true);
  });
});

describe("artifact-evidence.v0 — D2 single-authority is enforced by the schema", () => {
  test("rejects EMBEDDED EvidenceRef objects — evidence lives only on run-ledger", () => {
    // The authoritative {kind, ref, digest} home is RunLedgerRecordV0.evidence.
    // This payload links by digest; embedding the objects would be a second
    // authoritative copy that can drift (split-brain). It must not validate.
    expect(
      isArtifactEvidence({
        ...VALID,
        evidence_digests: [{ kind: "test", ref: "r", digest: SHA }],
      }),
    ).toBe(false);
  });

  test("rejects a stray `evidence: EvidenceRef[]` key (the old embedding shape)", () => {
    expect(
      isArtifactEvidence({ ...VALID, evidence: [{ kind: "test", ref: "r", digest: SHA }] }),
    ).toBe(false);
  });
});

describe("artifact-evidence.v0 — envelope-safety is structural (no wire duplication)", () => {
  test("rejects re-encoded A2A wire fields as unknown keys", () => {
    // append / lastChunk / artifact_id / task_id / context_id live on the
    // enclosing TaskArtifactUpdateEvent — repeating them is a second source of
    // truth. (run_id is the exception: A2A does NOT supply it.)
    expect(isArtifactEvidence({ ...VALID, append: true })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, task_id: "task_1" })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, artifact_id: "art_1" })).toBe(false);
  });

  test("rejects a missing key", () => {
    const { part_digest: _omit, ...withoutDigest } = VALID;
    expect(isArtifactEvidence(withoutDigest)).toBe(false);
  });
});

describe("artifact-evidence.v0 — strict rejection", () => {
  test("rejects a wrong schema discriminant", () => {
    expect(isArtifactEvidence({ ...VALID, schema: "artifact-append.v0" })).toBe(false);
  });

  test("rejects a malformed run_id", () => {
    expect(isArtifactEvidence({ ...VALID, run_id: "run_bad" })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, run_id: ULID })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, run_id: `ledger_${ULID}` })).toBe(false);
  });

  test("rejects a non-sha256 part_digest", () => {
    expect(isArtifactEvidence({ ...VALID, part_digest: "deadbeef" })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, part_digest: `sha256:${"A".repeat(64)}` })).toBe(false);
  });

  test("rejects evidence_digests that are not all sha256 refs", () => {
    expect(isArtifactEvidence({ ...VALID, evidence_digests: "nope" })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, evidence_digests: [SHA, "x"] })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, evidence_digests: [123] })).toBe(false);
  });

  test("rejects a Zulu / naive / non-Pacific recorded_at", () => {
    expect(isArtifactEvidence({ ...VALID, recorded_at: "2026-06-11T18:30:00Z" })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, recorded_at: "2026-06-11T18:30:00" })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, recorded_at: "2026-06-11T18:30:00+00:00" })).toBe(false);
    expect(isArtifactEvidence({ ...VALID, recorded_at: "2026-06-11T18:30:00-05:00" })).toBe(false);
  });

  test("parse throws on an invalid payload", () => {
    expect(() => parseArtifactEvidence({ ...VALID, part_digest: "x" })).toThrow();
  });
});

describe("readArtifactEvidence — lenient reader of the A2A metadata slot", () => {
  test("extracts + validates a payload riding in the extension-keyed slot", () => {
    const metadata = { [ARTIFACT_EVIDENCE_EXTENSION_URI]: VALID, "agents-js/a2a/audit": { x: 1 } };
    expect(readArtifactEvidence(metadata)).toEqual(VALID);
  });

  test("returns null when metadata is absent or the slot is missing", () => {
    expect(readArtifactEvidence(undefined)).toBeNull();
    expect(readArtifactEvidence(null)).toBeNull();
    expect(readArtifactEvidence({})).toBeNull();
    expect(readArtifactEvidence({ "agents-js/a2a/audit": { x: 1 } })).toBeNull();
  });

  test("returns null (fail-soft) when the slot is present but malformed", () => {
    expect(
      readArtifactEvidence({ [ARTIFACT_EVIDENCE_EXTENSION_URI]: { schema: "wrong" } }),
    ).toBeNull();
  });

  test("the extension URI follows the agents-js namespace convention", () => {
    expect(ARTIFACT_EVIDENCE_EXTENSION_URI).toBe("agents-js/a2a/artifact-evidence/v0");
  });
});
