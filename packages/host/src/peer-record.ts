/**
 * AJS-55 federation peer-record signing & verification.
 *
 * Pure-function surface for fleet-root-signed peer records (the static-trust
 * layer of the AJS-55 substrate). Consumed by `loadTrustManifest` at gateway
 * startup + hot-reload to populate the `TargetDirectory`.
 *
 * Design doc: `agents-js-federation-peer-record-signing-2026-05-22.md`
 * (vault: `~/workspace/syncthing/lifestone_ios/workspace/agents-js/docs/research/`).
 *
 * **Byte recipe** (§"Domain-separator exact byte spec" in vault doc):
 *
 *   signedBytes = UTF8(PEER_RECORD_DOMAIN_SEPARATOR) || 0x0A || UTF8(JCS(record))
 *   sig         = ed25519.sign(privKey, signedBytes)
 *
 * Where `record` is the unsigned record (no `sig` field) canonicalized via
 * JCS (RFC 8785). Verify reconstructs the same signed bytes and checks the
 * signature against the fleet-root trust anchor public key.
 *
 * **Ratified contracts** (cognee-codex primary pass 2026-05-22, event
 * `$ilWBvby4qvyS2JWVG7DTfKn3IxBT3J_Dytk4X9rlxCs`):
 *   - **B1**: `pubkey` field is raw base64-encoded ed25519 32-byte
 *     public key. SPKI PEM input → rejected as malformed-record.
 *     Enforced at validateSignedRecordShape.
 *   - **A2**: `signed_at` field is operator-facing metadata; verifier
 *     does NOT enforce time-validity at request path. Rotate-by-redeploy.
 *     v1.1 rotation protocol adds staleness + future-skew tests.
 *
 * **Fail-closed verifier contract**: `verifyPeerRecord` MUST NOT throw
 * on any input, regardless of how malformed. Throwing on the request
 * path would be a DoS lever (an attacker floods malformed records to
 * trigger exception-handling cost). Defense is belt-and-suspenders:
 * `validateSignedRecordShape` checks individual scope types before
 * JCS canonicalization, AND `buildPeerRecordSignedBytes` is wrapped
 * in try/catch as a last-resort guard. codex-hostname-null catch
 * 2026-05-22 (event `$13_MQScDp3DXPe3vL65aL73ykoh2uM7xq-yJWE-RrI8`).
 */

import { createPublicKey } from "node:crypto";
import { base64ToBytes, bytesToBase64, signEd25519, verifyEd25519 } from "./ed25519.ts";
import { jcs } from "./jcs.ts";

/**
 * Unsigned peer record. The `signer` field carries the expected signing
 * authority (v1: always `"fleet-root"`); `signed_at` is the operator-ceremony
 * timestamp at which the fleet-root signed this record.
 *
 * @internal AJS-55 implementation surface; consumers should not construct
 *           UnsignedPeerRecord directly — operators sign records via the
 *           future `agents-js fleet-root sign-peer` CLI subcommand which
 *           wraps `signPeerRecord`.
 */
export interface UnsignedPeerRecord {
  entity: string;
  pubkey: string; // base64-encoded ed25519 public key (raw 32 bytes; NOT SPKI PEM)
  capabilities: {
    scopes: string[];
    matrix?: { room: string };
    inbox?: { session: string };
  };
  signed_at: string; // ISO 8601 UTC
  signer: string; // v1: always "fleet-root"
}

/**
 * Signed peer record = unsigned record + base64-encoded ed25519 signature
 * over the canonical signed bytes (per §"Domain-separator exact byte spec"
 * in the vault design doc).
 *
 * @internal AJS-55 wire shape; emitted by `signPeerRecord` and consumed by
 *           `verifyPeerRecord` + `loadTrustManifest`.
 */
export interface SignedPeerRecord extends UnsignedPeerRecord {
  sig: string; // base64-encoded ed25519 signature
}

/**
 * Reasons a peer record may fail verification. The verifier returns these
 * as the `reason` field of its discriminated-union result rather than
 * throwing — peer-record verification is on the request-path of every
 * trust-manifest reload, so exception-handling cost would be a DoS lever.
 *
 * @internal AJS-55 wire shape.
 */
export type PeerRecordRejectionReason =
  | "invalid-signature" // sig verification fails against trust-root pubkey
  | "malformed-record" // record missing required field, empty-string field, or sig not base64
  | "wrong-signer" // record's signer field is not "fleet-root"
  | "non-ed25519-trust-root"; // operator misconfig: trust-root PEM not ed25519

/**
 * Discriminated-union return shape for `verifyPeerRecord`. Matches the
 * existing `VerifyResult` shape used by the AJS-57 JWT verifier
 * (`packages/host/src/jwt-verifier.ts`) so the two surfaces narrow with
 * the same pattern.
 *
 * @internal AJS-55 wire shape.
 */
export type VerifyPeerRecordResult =
  | { ok: true; entity: string }
  | { ok: false; reason: PeerRecordRejectionReason };

/**
 * Domain-separator string for peer-record signing.
 *
 * The signed bytes for a peer record are:
 *   UTF8(PEER_RECORD_DOMAIN_SEPARATOR) || 0x0A || UTF8(JCS(recordWithoutSig))
 *
 * Bumping the `:v1` suffix is the only path forward for a wire-format change
 * to the peer-record signing shape. Never reuse this string for any other
 * signing operation (use a different separator with the same byte protocol).
 *
 * @internal AJS-55 implementation constant.
 */
export const PEER_RECORD_DOMAIN_SEPARATOR = "agents-js:peer-record:v1";

const DOMAIN_BYTES = new TextEncoder().encode(PEER_RECORD_DOMAIN_SEPARATOR);
const DELIMITER_BYTE = 0x0a;

/**
 * Compute the canonical signed bytes for a peer record. Private to this
 * module; the cross-domain-replay test deliberately reconstructs the
 * bytes INDEPENDENTLY (inline via `Buffer.concat`) rather than calling
 * this helper, because the test acts as an independent oracle on the
 * byte-recipe. If the test called this helper, both code paths would
 * share any bug and the test would silently pass through it.
 *
 * @internal AJS-55 implementation primitive.
 */
function buildPeerRecordSignedBytes(record: UnsignedPeerRecord): Uint8Array {
  const jcsBytes = new TextEncoder().encode(jcs(record));
  const out = new Uint8Array(DOMAIN_BYTES.length + 1 + jcsBytes.length);
  out.set(DOMAIN_BYTES, 0);
  out[DOMAIN_BYTES.length] = DELIMITER_BYTE;
  out.set(jcsBytes, DOMAIN_BYTES.length + 1);
  return out;
}

/**
 * Sign an unsigned peer record with the fleet-root ed25519 private key,
 * returning a `SignedPeerRecord` ready for serialization to disk +
 * distribution via the trust manifest.
 *
 * The signed bytes are constructed per §"Domain-separator exact byte spec"
 * in the vault doc: `UTF8("agents-js:peer-record:v1") || 0x0A || UTF8(JCS(record))`
 * where `record` is the unsigned record canonicalized via JCS (RFC 8785).
 *
 * Throws if `fleetRootPrivateKeyPem` is not an ed25519 key (algorithm-confusion
 * defense; this is operator-side, signing-ceremony code path — loud failure
 * is the right shape because misconfiguration here can't quietly succeed).
 *
 * @internal AJS-55 implementation surface; wrapped by the future
 *           `agents-js fleet-root sign-peer` CLI subcommand.
 */
export function signPeerRecord(
  record: UnsignedPeerRecord,
  fleetRootPrivateKeyPem: string,
): SignedPeerRecord {
  // signEd25519 throws on non-ed25519 PEM (algorithm-confusion defense
  // surfaced loudly at the operator-action layer).
  const signedBytes = buildPeerRecordSignedBytes(record);
  const sig = signEd25519(fleetRootPrivateKeyPem, signedBytes);
  return { ...record, sig: bytesToBase64(sig) };
}

/**
 * Validate a signed record's shape before attempting cryptographic
 * verification. Returns `true` on well-formed input; returns `false` if
 * any required field is missing, empty-string, or wrong format. Upstream
 * maps `false` to the `malformed-record` rejection reason.
 *
 * Per cognee-codex AC: verify must validate shape BEFORE JCS canonicalization
 * (a partial record JCS-canonicalizes to different bytes than the full
 * record that was signed, which could match a captured sig from a
 * different record).
 *
 * The `pubkey` field is enforced as raw base64-encoded 32-byte ed25519
 * public key per the B1 contract (cognee-codex primary-pass blocker fix
 * 2026-05-22): doc said "B1: raw base64 32-byte; SPKI PEM rejected as
 * malformed" but the prior shape check only required non-empty string.
 * SPKI PEM input or wrong-length base64 now rejects here, not at the
 * downstream challenge-mint verifier where the bad key would surface as
 * an opaque sig failure.
 *
 * Capabilities shape validation (folded back from loadTrustManifest per
 * codex-hostname-null catch 2026-05-22): the prior version deferred
 * "scopes is string[], matrix.room is string if present, inbox.session
 * is string if present" to loadTrustManifest. Bug: with `scopes:
 * [undefined]`, validateSignedRecordShape accepted (Array.isArray
 * passes), then `jcs()` threw on the undefined, propagating out of
 * verifyPeerRecord — fail-closed verifier contract violation. Now
 * each scope is checked to be a string before JCS canonicalization.
 * matrix.room/inbox.session optional fields are also typed-checked
 * if present. Route-shape validation at the verify boundary +
 * separately at loadTrustManifest is correct: defense-in-depth, and
 * verifyPeerRecord's no-throw guarantee depends on it.
 */
function validateSignedRecordShape(signed: SignedPeerRecord): boolean {
  if (typeof signed !== "object" || signed === null) return false;
  if (typeof signed.entity !== "string" || signed.entity.length === 0) return false;
  if (typeof signed.pubkey !== "string" || signed.pubkey.length === 0) return false;
  if (typeof signed.signed_at !== "string" || signed.signed_at.length === 0) return false;
  if (typeof signed.signer !== "string" || signed.signer.length === 0) return false;
  if (typeof signed.sig !== "string" || signed.sig.length === 0) return false;
  if (typeof signed.capabilities !== "object" || signed.capabilities === null) return false;
  if (!Array.isArray(signed.capabilities.scopes)) return false;

  // Each scope must be a string (catches `[undefined]`, `[123]`, etc.
  // BEFORE JCS would throw on the undefined or canonicalize non-strings
  // to the wrong target-directory shape).
  for (const scope of signed.capabilities.scopes) {
    if (typeof scope !== "string") return false;
  }

  // Optional matrix.room must be string if present.
  if (signed.capabilities.matrix !== undefined) {
    if (typeof signed.capabilities.matrix !== "object" || signed.capabilities.matrix === null) {
      return false;
    }
    if (typeof signed.capabilities.matrix.room !== "string") return false;
  }

  // Optional inbox.session must be string if present.
  if (signed.capabilities.inbox !== undefined) {
    if (typeof signed.capabilities.inbox !== "object" || signed.capabilities.inbox === null) {
      return false;
    }
    if (typeof signed.capabilities.inbox.session !== "string") return false;
  }

  // B1 enforcement: pubkey must be raw base64-encoded 32-byte ed25519 key.
  // Anything else (SPKI PEM text, invalid base64, wrong-length base64)
  // rejects as malformed-record.
  try {
    const pubkeyBytes = base64ToBytes(signed.pubkey);
    if (pubkeyBytes.byteLength !== 32) return false;
  } catch {
    return false;
  }

  return true;
}

/**
 * Verify a signed peer record against the fleet-root trust anchor public key.
 *
 * Returns `{ ok: true, entity }` on full verification (signature valid +
 * signer field === "fleet-root" + record well-formed); returns
 * `{ ok: false, reason }` on any failure. Never throws.
 *
 * The verifier reconstructs the canonical signed bytes the same way
 * `signPeerRecord` produced them (domain separator + 0x0A + JCS(recordWithoutSig)),
 * then verifies the sig against `trustRootPublicKeyPem`. Cross-domain replay
 * defense: a signature produced under a different domain separator (e.g.
 * challenge-mint) will reconstruct different signed bytes here and fail.
 *
 * Fail-closed semantics: `ok: false` covers everything from "signature
 * genuinely doesn't match" to "PEM was garbled" to "trust-root key isn't
 * even ed25519". Callers MUST NOT branch on the `reason` to selectively
 * accept the record; the reason is for logs + telemetry only.
 *
 * @internal AJS-55 implementation surface; called by `loadTrustManifest`
 *           for each peer entry during startup + hot-reload.
 */
export function verifyPeerRecord(
  signed: SignedPeerRecord,
  trustRootPublicKeyPem: string,
): VerifyPeerRecordResult {
  // 1. Validate trust-root key type FIRST (cheapest reject + operator-misconfig
  //    surfaces with a distinct reason in logs). Catch any PEM-parse exceptions
  //    so the verifier never throws regardless of operator input.
  try {
    const key = createPublicKey(trustRootPublicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") {
      return { ok: false, reason: "non-ed25519-trust-root" };
    }
  } catch {
    return { ok: false, reason: "non-ed25519-trust-root" };
  }

  // 2. Validate signed-record shape BEFORE attempting JCS canonicalization.
  //    A partial record JCS-encodes to different bytes than the full record
  //    that was signed; without this guard, an attacker could craft a partial
  //    record whose bytes match a captured sig from a different record.
  if (!validateSignedRecordShape(signed)) {
    return { ok: false, reason: "malformed-record" };
  }

  // 3. Decode the sig field. strict base64ToBytes throws on malformed input —
  //    map to malformed-record so the request path never throws.
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(signed.sig);
  } catch {
    return { ok: false, reason: "malformed-record" };
  }

  // 4. Check signer field is the v1 fleet-root literal. Case-sensitive
  //    string equality. v1.1 intermediate-CA landing will widen this check
  //    to "signer is in the trust manifest's allowed-signer list"; v1 only
  //    accepts "fleet-root".
  if (signed.signer !== "fleet-root") {
    return { ok: false, reason: "wrong-signer" };
  }

  // 5. Reconstruct the canonical signed bytes from the record EXCLUDING
  //    the sig field. Destructure to omit sig from the JCS input.
  //    Wrap in try/catch as the fail-closed last guard: JCS throws on
  //    JSON-unrepresentable values (undefined, NaN, Infinity), and even
  //    though validateSignedRecordShape now catches the known cases,
  //    this guard ensures the no-throw contract holds for any future
  //    shape we haven't anticipated (codex-hostname-null catch 2026-05-22).
  const { sig: _omitted, ...unsignedRecord } = signed;
  let signedBytes: Uint8Array;
  try {
    signedBytes = buildPeerRecordSignedBytes(unsignedRecord);
  } catch {
    return { ok: false, reason: "malformed-record" };
  }

  // 6. Verify the sig. verifyEd25519 is fail-closed — returns false on any
  //    failure mode (malformed PEM, sig length wrong, signature mismatch).
  const valid = verifyEd25519(trustRootPublicKeyPem, signedBytes, sigBytes);
  if (!valid) {
    return { ok: false, reason: "invalid-signature" };
  }

  return { ok: true, entity: signed.entity };
}
