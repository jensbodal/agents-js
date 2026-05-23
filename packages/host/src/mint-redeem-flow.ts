/**
 * AJS-55 challenge-mint redeem flow — pure logic for the canonical
 * challenge-redeem path.
 *
 * The gateway HTTP handler at `POST /api/agents/mint/redeem` wraps this
 * with request parsing + JWT signing + Response shaping. This file is
 * the pure logic that does:
 *
 * 1. Validate request shape ({ challenge, entity, requested_scopes, sig })
 * 2. Look up entity's pubkey + capabilities from PeerKeyDirectory
 * 3. Reconstruct canonical signed bytes:
 *      UTF8("agents-js:challenge-mint:v1") || 0x0A || UTF8(JCS({challenge, entity, requested_scopes}))
 * 4. Decode sig from base64 + verify against entity pubkey
 * 5. Redeem challenge in ChallengeMintStore (single-use)
 * 6. Check requested_scopes ⊆ entity capabilities (REJECT with
 *    `invalid-scope`; NO silent downgrade per cognee-codex contract)
 * 7. Return success with sub + scopes + cid so caller can mint JWT
 *
 * Vault doc: §"Challenge mint flow" + §"Domain-separator exact byte spec".
 *
 * @internal AJS-55 implementation surface.
 */

import { createPublicKey, verify as nodeVerify } from "node:crypto";
import type { ChallengeMintStore } from "./challenge-mint-store.ts";
import { base64ToBytes } from "./ed25519.ts";
import { jcs } from "./jcs.ts";
import type { PeerKeyDirectory } from "./load-trust-manifest.ts";

/**
 * Domain-separator string for challenge-mint signing (vault doc
 * §"Domain-separator exact byte spec"). The signed bytes for a redeem
 * request are:
 *   UTF8(CHALLENGE_MINT_DOMAIN_SEPARATOR) || 0x0A || UTF8(JCS({challenge, entity, requested_scopes}))
 *
 * Bumping the `:v1` suffix is the only path forward for a wire-format
 * change to the challenge-mint signing shape.
 *
 * @internal AJS-55 implementation constant.
 */
export const CHALLENGE_MINT_DOMAIN_SEPARATOR = "agents-js:challenge-mint:v1";

const DOMAIN_BYTES = new TextEncoder().encode(CHALLENGE_MINT_DOMAIN_SEPARATOR);
const DELIMITER_BYTE = 0x0a;

/** Request body shape for `POST /api/agents/mint/redeem`. */
export interface MintRedeemRequest {
  challenge: string;
  entity: string;
  requested_scopes: string[];
  sig: string;
  /** Optional caller correlation id; gateway generates a UUIDv7 if absent. */
  cid?: string;
}

/** Result of {@link redeemMintChallenge}. */
export type MintRedeemResult =
  | {
      ok: true;
      /** Validated entity (= request.entity). */
      sub: string;
      /** Validated requested scopes (already verified ⊆ entity capabilities). */
      scopes: string[];
      /** Resolved correlation id (caller-supplied UUID or gateway-generated). */
      cid: string;
    }
  | {
      ok: false;
      reason:
        | "invalid-args"
        | "unknown-entity"
        | "invalid-signature"
        | "invalid-challenge"
        | "invalid-scope";
      message: string;
      /** Offending scopes (only for `invalid-scope` reason). */
      offending_scopes?: string[];
    };

/** Validate that a string is a UUID. */
function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Reconstruct the canonical signed bytes for a mint-redeem request.
 * The verifier reconstructs from the request fields independently
 * rather than trusting any wire-supplied bytes.
 *
 * @internal AJS-55 implementation primitive. Exposed for tests that
 *           need to construct valid challenge sigs without bypassing
 *           the byte-recipe contract.
 */
export function buildChallengeMintSignedBytes(payload: {
  challenge: string;
  entity: string;
  requested_scopes: string[];
}): Uint8Array {
  const jcsBytes = new TextEncoder().encode(jcs(payload));
  const out = new Uint8Array(DOMAIN_BYTES.length + 1 + jcsBytes.length);
  out.set(DOMAIN_BYTES, 0);
  out[DOMAIN_BYTES.length] = DELIMITER_BYTE;
  out.set(jcsBytes, DOMAIN_BYTES.length + 1);
  return out;
}

/**
 * Construct a Node KeyObject from a base64-encoded raw 32-byte ed25519
 * public key (the format pinned by AJS-55 B1 contract). Returns null
 * on any failure — caller treats as invalid-signature (defense against
 * an attacker timing valid-vs-invalid pubkey shapes).
 */
function rawBase64PubkeyToKeyObject(base64: string): ReturnType<typeof createPublicKey> | null {
  try {
    const rawBytes = base64ToBytes(base64);
    if (rawBytes.byteLength !== 32) return null;
    // Wrap raw 32-byte ed25519 in SPKI DER. The 12-byte header is the
    // canonical ed25519 SPKI prefix (RFC 8410).
    const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
    const spkiDer = Buffer.concat([spkiHeader, Buffer.from(rawBytes)]);
    return createPublicKey({ key: spkiDer, format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/**
 * Verify the redeem-request signature against the entity's pubkey.
 * Returns true iff the signature is valid; never throws (fail-closed
 * on any error mode).
 */
function verifyRedeemSignature(request: MintRedeemRequest, peerPubkeyBase64: string): boolean {
  const keyObject = rawBase64PubkeyToKeyObject(peerPubkeyBase64);
  if (keyObject === null) return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64ToBytes(request.sig);
  } catch {
    return false;
  }
  if (sigBytes.byteLength !== 64) return false;
  const signedBytes = buildChallengeMintSignedBytes({
    challenge: request.challenge,
    entity: request.entity,
    requested_scopes: request.requested_scopes,
  });
  try {
    return nodeVerify(null, signedBytes, keyObject, sigBytes);
  } catch {
    return false;
  }
}

/**
 * Execute the AJS-55 challenge-mint redeem flow.
 *
 * Pre-flight validation: request shape, entity lookup, sig verify against
 * the entity's pubkey, then challenge redemption (single-use), then
 * scope-subset check. Each failure has a distinctive reason for telemetry.
 *
 * **Scope-subset enforcement** (vault doc §"Challenge mint flow" step 5e
 * per cognee-codex primary fix #2): if ANY requested_scope is NOT in the
 * entity's capabilities.scopes, returns `invalid-scope` with the
 * offending scope set. NO silent downgrade. JWT NOT minted.
 *
 * **CID resolution** (cognee-codex secondary fix #5): if request.cid is
 * a valid UUID, use it; otherwise generate UUIDv7 via the cidGenerator
 * callback (gateway-supplied so tests are deterministic).
 *
 * @internal AJS-55 implementation surface; gateway HTTP handler wraps
 *           this + uses returned {sub, scopes, cid} to mint the JWT.
 */
export function redeemMintChallenge(opts: {
  request: MintRedeemRequest;
  store: ChallengeMintStore;
  peerKeyDirectory: PeerKeyDirectory;
  now: number;
  /** Generate a fresh cid when request.cid is absent or invalid. */
  cidGenerator: () => string;
}): MintRedeemResult {
  const { request, store, peerKeyDirectory, now, cidGenerator } = opts;

  // Step 1: request shape validation.
  if (typeof request.challenge !== "string" || request.challenge.length === 0) {
    return { ok: false, reason: "invalid-args", message: "`challenge` (string) is required" };
  }
  if (typeof request.entity !== "string" || request.entity.length === 0) {
    return { ok: false, reason: "invalid-args", message: "`entity` (string) is required" };
  }
  if (
    !Array.isArray(request.requested_scopes) ||
    !request.requested_scopes.every((s) => typeof s === "string")
  ) {
    return {
      ok: false,
      reason: "invalid-args",
      message: "`requested_scopes` (string[]) is required",
    };
  }
  if (typeof request.sig !== "string" || request.sig.length === 0) {
    return { ok: false, reason: "invalid-args", message: "`sig` (string) is required" };
  }

  // Step 2: entity lookup.
  const peerPubkey = peerKeyDirectory.getPubkey(request.entity);
  if (peerPubkey === null) {
    return {
      ok: false,
      reason: "unknown-entity",
      message: `entity '${request.entity}' is not in the trust manifest`,
    };
  }
  const capabilities = peerKeyDirectory.getCapabilities(request.entity);
  if (capabilities === null) {
    // Should not happen if getPubkey returned non-null, but defensive.
    return {
      ok: false,
      reason: "unknown-entity",
      message: `entity '${request.entity}' has no registered capabilities`,
    };
  }

  // Step 3: sig verify.
  if (!verifyRedeemSignature(request, peerPubkey)) {
    return {
      ok: false,
      reason: "invalid-signature",
      message: "challenge signature did not verify against the entity's pubkey",
    };
  }

  // Step 4: challenge redemption (single-use).
  const redeemResult = store.redeemChallenge(request.challenge, { now });
  if (!redeemResult.ok) {
    return {
      ok: false,
      reason: "invalid-challenge",
      message: `challenge ${redeemResult.reason}`,
    };
  }

  // Step 5: scope-subset check. REJECT (no silent downgrade) per
  // cognee-codex primary fix #2.
  const entityScopes = new Set(capabilities.scopes);
  const offending = request.requested_scopes.filter((s) => !entityScopes.has(s));
  if (offending.length > 0) {
    return {
      ok: false,
      reason: "invalid-scope",
      message: `requested scopes [${offending.join(", ")}] not in entity capabilities`,
      offending_scopes: offending,
    };
  }

  // Step 6: cid resolution.
  const cid = typeof request.cid === "string" && isUuid(request.cid) ? request.cid : cidGenerator();

  return {
    ok: true,
    sub: request.entity,
    scopes: request.requested_scopes,
    cid,
  };
}
