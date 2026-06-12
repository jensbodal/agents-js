/**
 * `artifact-evidence.v0` — per-append evidence LINKAGE for an A2A artifact
 * update (M1 design packet item 7).
 *
 * This schema does NOT introduce a wire envelope. The A2A
 * `TaskArtifactUpdateEvent` already carries the append mechanism (`append`,
 * `lastChunk`, `artifactId`, `taskId`, `contextId`, `parts[]`) plus a
 * spec-blessed `metadata` extension hook. This payload RIDES inside that hook,
 * keyed by {@link ARTIFACT_EVIDENCE_EXTENSION_URI}.
 *
 * Single-authority (design packet D2 / ADR-0003): the authoritative
 * `EvidenceRef` objects (`{kind, ref, digest}`) live in exactly ONE place —
 * `RunLedgerRecordV0.evidence`. This payload therefore carries LINKAGE ONLY: a
 * `run_id` locator plus `evidence_digests`, a closed list of sha256 selectors
 * pointing at evidence entries already on the ledger record. It deliberately
 * does NOT embed the evidence objects — embedding would be a second
 * authoritative copy that can drift from the ledger (split-brain).
 *
 * Identity (task/context/artifact) is supplied by the enclosing A2A event and
 * is not repeated here. `run_id` is the one exception: A2A does not carry it,
 * so the ledger locator must live on the payload.
 *
 * The schema validates linkage SHAPE only; that a selector actually resolves to
 * an entry on the ledger record is a runtime cross-check (the same
 * shape-not-chain split run-ledger.v0 uses for its digest chain). The runtime
 * that EMITS this into a metadata slot (a2a-client) and the host that READS it
 * are a follow-up wiring slice; this module ships the type, a strict validator,
 * and a lenient slot reader.
 */

import {
  hasExactKeys,
  isPacificIso8601,
  isPlainObject,
  isPrefixedUlid,
  isSha256Ref,
} from "./_validate.ts";

/**
 * Extension URI keying the artifact-evidence payload inside an A2A
 * `TaskArtifactUpdateEvent.metadata` (or `Artifact.metadata`) slot. Follows the
 * `agents-js/<namespace>` identifier convention (cf. `agents-js/a2a/audit`).
 */
export const ARTIFACT_EVIDENCE_EXTENSION_URI = "agents-js/a2a/artifact-evidence/v0";

export interface ArtifactEvidenceV0 {
  /** Discriminant inside the metadata slot. */
  schema: "artifact-evidence.v0";
  /**
   * Ledger locator: `run_<ULID>`. A2A supplies task/context/artifact ids but
   * NOT `run_id`, so it must live on the payload to reach the evidence home.
   */
  run_id: string;
  /** sha256 of the appended part(s). The wire carries `parts` but no digest. */
  part_digest: string;
  /**
   * LINKAGE-ONLY selectors into `RunLedgerRecordV0.evidence`: sha256 digests of
   * evidence entries whose authoritative `{kind, ref, digest}` lives on the
   * ledger. Never the embedded objects — that would be a second authoritative
   * copy (D2 single-authority).
   */
  evidence_digests: string[];
  /** Pacific ISO-8601 provenance timestamp for the append. */
  recorded_at: string;
}

const KEYS = ["schema", "run_id", "part_digest", "evidence_digests", "recorded_at"] as const;

function check(value: unknown): string | null {
  if (!isPlainObject(value)) return "not a plain object";
  if (!hasExactKeys(value, KEYS)) return `keys must be exactly [${KEYS.join(", ")}]`;
  if (value.schema !== "artifact-evidence.v0") return 'schema must be "artifact-evidence.v0"';
  if (!isPrefixedUlid(value.run_id, "run")) return "run_id must be a run_<ULID>";
  if (!isSha256Ref(value.part_digest)) return "part_digest must be a sha256 ref";
  if (!Array.isArray(value.evidence_digests) || !value.evidence_digests.every(isSha256Ref)) {
    return "evidence_digests must be a sha256-ref selector list (linkage only, not embedded objects)";
  }
  if (!isPacificIso8601(value.recorded_at)) {
    return "recorded_at must be a Pacific ISO-8601 timestamp";
  }
  return null;
}

/** Type guard: true iff `value` is a structurally-valid `ArtifactEvidenceV0`. */
export function isArtifactEvidence(value: unknown): value is ArtifactEvidenceV0 {
  return check(value) === null;
}

/** Strict parse: returns the validated payload or throws with the reason. */
export function parseArtifactEvidence(value: unknown): ArtifactEvidenceV0 {
  const reason = check(value);
  if (reason !== null) throw new TypeError(`invalid artifact-evidence.v0: ${reason}`);
  return value as ArtifactEvidenceV0;
}

/**
 * Lenient reader for the artifact-evidence slot of an A2A metadata object.
 * Returns the validated payload, or `null` when the metadata is absent, the
 * slot is missing, or the slot is present-but-malformed. A malformed extension
 * from a peer must not crash a consumer — strict callers use
 * {@link parseArtifactEvidence} instead.
 */
export function readArtifactEvidence(
  metadata: Record<string, unknown> | undefined | null,
): ArtifactEvidenceV0 | null {
  if (!isPlainObject(metadata)) return null;
  const slot = metadata[ARTIFACT_EVIDENCE_EXTENSION_URI];
  if (slot === undefined) return null;
  return isArtifactEvidence(slot) ? slot : null;
}
