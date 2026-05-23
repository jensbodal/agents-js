/**
 * Ed25519 sign / verify primitives for AJS-55.
 *
 * Wraps Node's native `crypto.sign` / `crypto.verify` with an
 * algorithm-pinned, fail-closed surface. Private keys are accepted as
 * PEM strings (gopass-friendly storage format); signatures and raw
 * key bytes are `Uint8Array` for wire-level work.
 *
 * Algorithm-confusion defense (AJS-55 §"Risk model"): `signEd25519`
 * throws when handed a non-ed25519 PEM; `verifyEd25519` returns
 * `false` instead of throwing on bad input so the request path
 * doesn't pay exception-handling cost for garbage signatures.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";

/**
 * @internal AJS-55 ed25519 keypair material. Public consumers should not
 *           handle raw keys directly — use `signPeerRecord` / `verifyPeerRecord`
 *           and the trust-manifest loader to operate on AJS-55 records.
 */
export interface Ed25519KeyPair {
  /** PEM-encoded private key (PKCS#8). gopass-friendly. */
  privateKeyPem: string;
  /** PEM-encoded public key (SPKI). gopass-friendly. */
  publicKeyPem: string;
}

/**
 * Generate a fresh ed25519 keypair. The private key is PKCS#8 PEM,
 * the public key is SPKI PEM. Suitable for storing under
 * `gopass services/agents-js/identity/<entity>/key` and
 * `gopass services/agents-js/identity/<entity>/pub`.
 *
 * @internal AJS-55 implementation primitive.
 */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
  };
}

/**
 * Sign `data` with the ed25519 private key in `privateKeyPem`. Throws
 * if the PEM is not an ed25519 key (algorithm-confusion defense).
 * Returns the raw 64-byte signature as a Uint8Array.
 *
 * @internal AJS-55 implementation primitive.
 */
export function signEd25519(privateKeyPem: string, data: Uint8Array): Uint8Array {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `[ed25519] private key must be ed25519, got ${key.asymmetricKeyType ?? "unknown"}`,
    );
  }
  // Node's ed25519 sign takes `null` as the algorithm — algorithm is
  // implicit in the key type. No SHA-prehash; ed25519 hashes internally.
  return new Uint8Array(nodeSign(null, data, key));
}

/**
 * Verify a 64-byte ed25519 `signature` over `data` against the
 * public key in `publicKeyPem`. Returns `true` on valid signature,
 * `false` on ANY failure (wrong key, wrong algorithm, malformed
 * input, tampered data, etc.). Never throws.
 *
 * Fail-closed semantics: a `false` return covers everything from
 * "signature genuinely doesn't match" to "PEM was garbled". Callers
 * MUST treat `false` as a hard reject regardless of cause.
 *
 * @internal AJS-55 implementation primitive.
 */
export function verifyEd25519(
  publicKeyPem: string,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.byteLength !== 64) return false;
  try {
    const key = createPublicKey(publicKeyPem);
    if (key.asymmetricKeyType !== "ed25519") return false;
    return nodeVerify(null, data, key, signature);
  } catch {
    // Malformed PEM, key import failure, etc. → fail closed.
    return false;
  }
}

/**
 * Encode `bytes` as a standard base64 string (RFC 4648 §4). Used for
 * peer-record serialization (signatures + pubkeys travel as base64
 * on the wire).
 *
 * @internal AJS-55 implementation primitive.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Decode a standard base64 string to bytes. Throws on malformed input
 * (non-base64 characters, wrong-length padding). Stricter than Node's
 * default `Buffer.from(str, "base64")` which silently skips invalid
 * chars — cryptographic input warrants loud failure on corruption.
 *
 * @internal AJS-55 implementation primitive.
 */
export function base64ToBytes(encoded: string): Uint8Array {
  // RFC 4648 §4: characters are A-Z a-z 0-9 + / and padding =.
  // Length must be a multiple of 4 (with padding).
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error(`[ed25519] invalid base64 input: contains non-base64 characters`);
  }
  if (encoded.length % 4 !== 0) {
    throw new Error(
      `[ed25519] invalid base64 input: length ${encoded.length} is not a multiple of 4`,
    );
  }
  return new Uint8Array(Buffer.from(encoded, "base64"));
}
