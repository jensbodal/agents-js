/**
 * AJS-55 `signPeerRecord` / `verifyPeerRecord` — behavior tests.
 *
 * Implementation: `../src/peer-record.ts`. Tests cover the AC + PR review
 * checklist from cognee-codex's 2026-05-22 APPROVE
 * (event `$RvTudGgQDFp_0y3ZjUFP7vz05-uQKKvcWR4rclJMWPg`), plus three
 * additional findings from cognee-claude's backup-contract pre-review pass
 * (event `$3uy6F8QPWZGRAYOHz-vqxl-OmcCv_ziKibIpDsRcoNg`):
 *   2: capabilities-tamper (higher-value threat model than entity-tamper)
 *   3: empty-string fields treated as malformed
 *   5: signer case-sensitivity (defense against future .toLowerCase() refactor)
 *
 * The byte-fixture test (§"DOMAIN-SEPARATOR BYTE FIXTURES") uses an
 * INDEPENDENT ORACLE — `_oracles/peer-record-byte-fixture.py` — to derive
 * the expected sig value via Python's `cryptography` library. The TS impl
 * is regressed against the oracle's output. This breaks the byte-fixture
 * circularity that "capture first run, commit, regress" would create
 * (advisor flagged 2026-05-22). If the oracle and TS impl diverge, one of
 * them has a bug.
 *
 * Pre-review confirmations folded:
 *   - signer != "fleet-root" → wrong-signer: KEEP (cognee-claude, defense-
 *     in-depth becomes load-bearing in v1.1 intermediate-CA landing)
 *
 * Carry-forward questions still open for @cognee-codex (impl assumes
 * A2 + B1 defaults pending override):
 *   (A) signed_at validation: NOT enforced at request path; rotate-by-
 *       re-deploy. The signed_at field is operator-facing metadata only.
 *   (B) pubkey field encoding: RAW base64-encoded 32-byte ed25519 public
 *       key. SPKI PEM input → rejected as malformed-record.
 */

import { describe, expect, test } from "bun:test";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  verify as nodeVerify,
} from "node:crypto";
import { base64ToBytes, bytesToBase64, generateEd25519KeyPair } from "../src/ed25519.ts";
import { jcs } from "../src/jcs.ts";
import {
  PEER_RECORD_DOMAIN_SEPARATOR,
  type SignedPeerRecord,
  signPeerRecord,
  type UnsignedPeerRecord,
  type VerifyPeerRecordResult,
  verifyPeerRecord,
} from "../src/peer-record.ts";

// Compile-time pins for the discriminated-union return shape. Matches the
// AJS-57 JwtVerifier ergonomics per cognee-codex unrequested-extension #1.
type _PinUnsigned = UnsignedPeerRecord;
type _PinSigned = SignedPeerRecord;
type _PinResult = VerifyPeerRecordResult;

// ============================================================================
// BYTE-FIXTURE ORACLE OUTPUTS
// Source: tests/_oracles/peer-record-byte-fixture.py (Python `cryptography`
// library). Regenerate by running the oracle script; this test asserts our
// TS impl produces byte-identical output.
// ============================================================================

/** Test-only ed25519 seed (32 bytes 0x00..0x1f). NEVER use for real identity. */
const TEST_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) TEST_SEED[i] = i;

/** PKCS#8 DER header for an ed25519 private key (16 bytes), followed by 32-byte seed. */
const PKCS8_ED25519_HEADER = Buffer.from("302e020100300506032b657004220420", "hex");

/** Expected pubkey for TEST_SEED, in raw-32-byte base64 (B1 default encoding). */
const EXPECTED_PEER_RECORD_PUBKEY_RAW = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=";

/** Expected sig for the FIXTURE_RECORD signed with TEST_SEED's privkey. */
const EXPECTED_PEER_RECORD_SIG_FIXTURE =
  "SpyC6iYyz0ElRnH0CLjBWQff3X20dgW4BYCuM4AuLMd5Uff+DuPbeLKZt4Df+bgmtnA8klMwKMg7ECOkshqVDA==";

/** Fixture record (must match exact shape used by the Python oracle). */
const FIXTURE_RECORD: UnsignedPeerRecord = {
  entity: "test-fixture-entity",
  pubkey: EXPECTED_PEER_RECORD_PUBKEY_RAW,
  capabilities: {
    scopes: ["matrix.send_message", "inbox.read"],
    matrix: { room: "!testroom:example.com" },
  },
  signed_at: "2026-05-22T18:00:00Z",
  signer: "fleet-root",
};

/** Build a Node KeyObject from the deterministic TEST_SEED via PKCS#8 DER. */
function fixturePrivateKeyPem(): string {
  const der = Buffer.concat([PKCS8_ED25519_HEADER, Buffer.from(TEST_SEED)]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return key.export({ type: "pkcs8", format: "pem" }) as string;
}

/** Get the matching public key (SPKI PEM) for the fixture private key. */
function fixturePublicKeyPem(): string {
  const der = Buffer.concat([PKCS8_ED25519_HEADER, Buffer.from(TEST_SEED)]);
  const priv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return createPublicKey(priv).export({ type: "spki", format: "pem" }) as string;
}

describe("packages/host/tests/peer-record.test.ts — signPeerRecord/verifyPeerRecord contract", () => {
  // ============================================================
  // ROUND-TRIP + BASIC SIGNATURE BINDING (cognee-codex AC items 1-3)
  // ============================================================

  /**
   * WHAT: A record signed by the fleet-root key verifies under that key's
   *       public half and returns `{ ok: true, entity: <record.entity> }`.
   * WHY: Round-trip pin. Without this, every reject test below could pass
   *      while the positive path is broken. cognee-codex AC: "signPeerRecord
   *      + verifyPeerRecord round-trip".
   */
  test("happy path: fleet-root signs → verifies under same trust-root → ok: true + entity", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "happy-path-entity",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", // placeholder; unrelated to verify
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const result = verifyPeerRecord(signed, publicKeyPem);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entity).toBe("happy-path-entity");
    }
  });

  /**
   * WHAT: Flipping a byte in the record's `entity` field after signing
   *       causes verify to return `{ ok: false, reason: 'invalid-signature' }`.
   * WHY: Pins signature-binding to the entity field. cognee-codex AC:
   *      "Tampered record → verify rejects".
   */
  test("tampered record: byte-flip in entity field → ok: false, reason: 'invalid-signature'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "original-entity",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const tampered: SignedPeerRecord = { ...signed, entity: "tampered-entity" };
    const result = verifyPeerRecord(tampered, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-signature");
    }
  });

  /**
   * WHAT: Modifying a peer's `capabilities.scopes` after signing (e.g. adding
   *       `"inbox.read_all"` to widen the entity's privileges) causes verify
   *       to return `{ ok: false, reason: 'invalid-signature' }`.
   * WHY: Higher-value threat model — privilege escalation via scope expansion.
   *      cognee-claude backup-review finding #2 (2026-05-22).
   */
  test("tampered capabilities: add scope to capabilities.scopes → ok: false, reason: 'invalid-signature'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "scope-tamper-target",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const tampered: SignedPeerRecord = {
      ...signed,
      capabilities: { scopes: ["matrix.send_message", "inbox.read_all"] },
    };
    const result = verifyPeerRecord(tampered, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-signature");
    }
  });

  /**
   * WHAT: A record signed by key A does NOT verify when the trust-root
   *       is key B's public half.
   * WHY: Core trust-anchor property. cognee-codex AC: "Different key
   *      signing → verify rejects".
   */
  test("wrong key: record signed by key A, trust-root is key B's pubkey → ok: false, 'invalid-signature'", () => {
    const keypairA = generateEd25519KeyPair();
    const keypairB = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "wrong-key-target",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, keypairA.privateKeyPem);
    const result = verifyPeerRecord(signed, keypairB.publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-signature");
    }
  });

  // ============================================================
  // CANONICALIZATION INDEPENDENCE (cognee-codex AC item 4)
  // ============================================================

  /**
   * WHAT: Two records with the same logical content but different
   *       key-iteration orders produce IDENTICAL signatures.
   * WHY: cognee-codex AC: "JCS canonicalization independence (key order
   *      changes don't break verify)".
   */
  test("JCS independence: same record with reordered keys → identical sig + verifies", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    // Two records with reordered top-level keys + reordered capabilities keys.
    const recordA: UnsignedPeerRecord = {
      entity: "jcs-test",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: {
        scopes: ["matrix.send_message"],
        matrix: { room: "!r:example.com" },
      },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const recordB: UnsignedPeerRecord = {
      signer: "fleet-root",
      signed_at: "2026-05-22T18:00:00Z",
      capabilities: {
        matrix: { room: "!r:example.com" },
        scopes: ["matrix.send_message"],
      },
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      entity: "jcs-test",
    } as UnsignedPeerRecord;
    const signedA = signPeerRecord(recordA, privateKeyPem);
    const signedB = signPeerRecord(recordB, privateKeyPem);
    // Both must produce byte-identical sigs.
    expect(signedA.sig).toBe(signedB.sig);
    // Cross-verification: A's sig verifies over B-shaped record (and vice versa).
    expect(verifyPeerRecord(signedA, publicKeyPem).ok).toBe(true);
    expect(verifyPeerRecord(signedB, publicKeyPem).ok).toBe(true);
  });

  // ============================================================
  // DOMAIN-SEPARATOR BYTE FIXTURES (cognee-codex primary fix #4)
  // ============================================================

  /**
   * WHAT: For the deterministic FIXTURE_RECORD + TEST_SEED keypair,
   *       signPeerRecord produces `EXPECTED_PEER_RECORD_SIG_FIXTURE`
   *       (byte-identical to the Python oracle's output).
   * WHY: Byte-level fixture pins the exact wire-format. The oracle is the
   *      independent reference; if our impl diverges, one of us has a bug.
   *      cognee-codex primary fix #4 AC + advisor circularity catch.
   */
  test("byte fixture: TEST_SEED + FIXTURE_RECORD → sig matches Python oracle output exactly", () => {
    const privateKeyPem = fixturePrivateKeyPem();
    const signed = signPeerRecord(FIXTURE_RECORD, privateKeyPem);
    expect(signed.sig).toBe(EXPECTED_PEER_RECORD_SIG_FIXTURE);
    // Verify also confirms the round-trip against the matching trust-root.
    const result = verifyPeerRecord(signed, fixturePublicKeyPem());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entity).toBe("test-fixture-entity");
    }
  });

  /**
   * WHAT: A signature produced under the peer-record domain prefix does
   *       NOT verify when the signed bytes are reconstructed with the
   *       challenge-mint domain prefix.
   * WHY: Cross-protocol replay defense. cognee-codex primary fix #4 AC.
   *
   * Test shape: until challenge-mint impl exists, reconstruct the wrong-
   * domain bytes inline and call Node's `crypto.verify(null, ...)`
   * directly. When challenge-mint lands, fold this to call its verifier.
   */
  test("cross-domain replay: peer-record sig + challenge-mint domain reconstruction → verify fails", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "replay-target",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const sigBytes = base64ToBytes(signed.sig);

    // Reconstruct signed bytes with the WRONG domain separator (challenge-mint
    // instead of peer-record). If the impl's domain separation works, this
    // verifier call returns false even though the sig is genuinely valid
    // under the peer-record domain.
    const wrongDomain = "agents-js:challenge-mint:v1";
    const wrongBytes = Buffer.concat([
      Buffer.from(wrongDomain, "utf-8"),
      Buffer.from([0x0a]),
      Buffer.from(jcs(record), "utf-8"),
    ]);
    const pubKey = createPublicKey(publicKeyPem);
    const valid = nodeVerify(null, wrongBytes, pubKey, sigBytes);
    expect(valid).toBe(false);

    // Sanity-check: reconstructing with the CORRECT domain should verify.
    const correctBytes = Buffer.concat([
      Buffer.from(PEER_RECORD_DOMAIN_SEPARATOR, "utf-8"),
      Buffer.from([0x0a]),
      Buffer.from(jcs(record), "utf-8"),
    ]);
    expect(nodeVerify(null, correctBytes, pubKey, sigBytes)).toBe(true);
  });

  // ============================================================
  // OPERATOR MISCONFIG: TRUST-ROOT KEY TYPE (defensive)
  // ============================================================

  /**
   * WHAT: When `trustRootPublicKeyPem` is an RSA public key, verify returns
   *       `{ ok: false, reason: 'non-ed25519-trust-root' }`. Does NOT throw.
   * WHY: Operator misconfig defense. Throwing would be a DoS lever.
   */
  test("non-ed25519 trust-root (RSA PEM) → ok: false, reason: 'non-ed25519-trust-root'", () => {
    const { privateKeyPem } = generateEd25519KeyPair();
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPublicPem = publicKey.export({ type: "spki", format: "pem" }) as string;

    const record: UnsignedPeerRecord = {
      entity: "rsa-misconfig-target",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const result = verifyPeerRecord(signed, rsaPublicPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("non-ed25519-trust-root");
    }
  });

  // ============================================================
  // MALFORMED INPUT
  // ============================================================

  /**
   * WHAT: A signed record whose `sig` field is not valid base64 returns
   *       `{ ok: false, reason: 'malformed-record' }`. Does NOT throw.
   * WHY: Fail-closed catch-all on the request path.
   */
  test("malformed sig field (invalid base64) → ok: false, reason: 'malformed-record'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "malformed-sig-target",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const corrupted: SignedPeerRecord = { ...signed, sig: "not!valid@base64$$" };
    const result = verifyPeerRecord(corrupted, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed-record");
    }
  });

  /**
   * WHAT: A signed record missing a required field (e.g. `entity` is undefined)
   *       returns `{ ok: false, reason: 'malformed-record' }`.
   * WHY: Verify must validate shape BEFORE JCS canonicalization (a partial
   *      record JCS-encodes to different bytes than the full record signed).
   */
  test("missing required field (e.g. no `entity`) → ok: false, reason: 'malformed-record'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "valid-entity",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    // Drop the entity field via cast (TypeScript catches normal callers).
    const broken = { ...signed } as Partial<SignedPeerRecord>;
    delete (broken as Record<string, unknown>).entity;
    const result = verifyPeerRecord(broken as SignedPeerRecord, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed-record");
    }
  });

  /**
   * WHAT: A signed record with empty-string `entity` (or empty pubkey/sig)
   *       returns `{ ok: false, reason: 'malformed-record' }`. Empty string
   *       is distinguished from absent field.
   * WHY: TypeScript can't enforce non-empty-string at runtime. cognee-claude
   *      backup-review finding #3 (2026-05-22).
   */
  test("empty-string fields (entity='', pubkey='', sig='') → ok: false, reason: 'malformed-record'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "valid-entity",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);

    // Each empty-string variant must return malformed-record.
    const variants: Array<Partial<SignedPeerRecord>> = [
      { ...signed, entity: "" },
      { ...signed, pubkey: "" },
      { ...signed, sig: "" },
      { ...signed, signed_at: "" },
      { ...signed, signer: "" },
    ];
    for (const v of variants) {
      const result = verifyPeerRecord(v as SignedPeerRecord, publicKeyPem);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("malformed-record");
      }
    }
  });

  // ============================================================
  // B1 PUBKEY ENCODING ENFORCEMENT (cognee-codex primary-pass blocker fix)
  // ============================================================

  /**
   * WHAT: A signed record whose `pubkey` field is an SPKI PEM string
   *       (instead of the contracted raw base64-encoded 32-byte ed25519
   *       public key) returns `{ ok: false, reason: 'malformed-record' }`.
   * WHY: cognee-codex primary-pass blocker fix (2026-05-22, event
   *      `$ilWBvby4qvyS2JWVG7DTfKn3IxBT3J_Dytk4X9rlxCs`): doc claimed
   *      "B1: raw base64 32-byte; SPKI PEM rejected as malformed" but
   *      validateSignedRecordShape only enforced non-empty-string. A
   *      fleet-root-signed record with PEM-text pubkey would have
   *      verified ok, then downstream loadTrustManifest/challenge-mint
   *      would register a peer whose challenge-verify key is unusable
   *      or ambiguous. Pin the contract here, at the verify boundary.
   */
  test("pubkey = SPKI PEM string → ok: false, reason: 'malformed-record'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const spkiPubkey = publicKeyPem; // a PEM-formatted SPKI string, NOT raw base64
    const record: UnsignedPeerRecord = {
      entity: "pem-pubkey-target",
      pubkey: spkiPubkey,
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const result = verifyPeerRecord(signed, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed-record");
    }
  });

  /**
   * WHAT: A signed record whose `pubkey` field contains non-base64
   *       characters (e.g. `"not!valid@base64$$"`) returns
   *       `{ ok: false, reason: 'malformed-record' }`.
   * WHY: Same blocker-fix scope. The strict base64ToBytes path throws
   *      on non-base64 input; that throw must be caught and mapped to
   *      malformed-record in the shape validation, never propagated.
   */
  test("pubkey = invalid base64 → ok: false, reason: 'malformed-record'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "bad-base64-pubkey-target",
      pubkey: "not!valid@base64$$",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const result = verifyPeerRecord(signed, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed-record");
    }
  });

  /**
   * WHAT: A signed record with valid base64 but wrong byteLength (31 or 33
   *       instead of the required 32 for ed25519) returns
   *       `{ ok: false, reason: 'malformed-record' }`.
   * WHY: Same blocker-fix scope. ed25519 raw public keys are exactly 32
   *      bytes; any other length is malformed, even if the base64
   *      decoding itself succeeds.
   */
  test("pubkey = valid base64 but wrong length (31 or 33 bytes) → ok: false, reason: 'malformed-record'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const baseRecord = {
      entity: "wrong-length-pubkey-target",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    // 31-byte base64 (one byte short).
    const pubkey31 = bytesToBase64(new Uint8Array(31));
    // 33-byte base64 (one byte too long).
    const pubkey33 = bytesToBase64(new Uint8Array(33));
    for (const wrongLengthPubkey of [pubkey31, pubkey33]) {
      const record: UnsignedPeerRecord = { ...baseRecord, pubkey: wrongLengthPubkey };
      const signed = signPeerRecord(record, privateKeyPem);
      const result = verifyPeerRecord(signed, publicKeyPem);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("malformed-record");
      }
    }
  });

  /**
   * WHAT: A signed record with a valid raw base64-encoded 32-byte
   *       ed25519 pubkey verifies cleanly (round-trip).
   * WHY: Negative-test counterpart to the three rejection tests above —
   *      proves the impl doesn't over-reject by mistake. The happy-path
   *      test at the top of this file already exercises 32-byte raw
   *      base64 (the `"AAAA..."` 32-byte-zeros pubkey passes shape
   *      validation), so this test is a redundant explicit pin against
   *      a future "all base64 input is malformed" regression.
   */
  test("pubkey = valid 32-byte raw base64 → ok: true (impl does not over-reject)", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    // Generate a fresh ed25519 keypair to use as the peer's pubkey.
    const peerKeyPair = generateEd25519KeyPair();
    const peerPubKey = createPublicKey(peerKeyPair.publicKeyPem);
    // Export raw 32-byte form, then base64-encode.
    const peerPubKeyRaw = peerPubKey.export({ type: "spki", format: "der" });
    // SPKI DER for ed25519 is 44 bytes; last 32 are the raw key.
    const rawKey32 = new Uint8Array(peerPubKeyRaw.subarray(peerPubKeyRaw.length - 32));
    const validPubkey = bytesToBase64(rawKey32);
    const record: UnsignedPeerRecord = {
      entity: "valid-pubkey-target",
      pubkey: validPubkey,
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const result = verifyPeerRecord(signed, publicKeyPem);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entity).toBe("valid-pubkey-target");
    }
  });

  // ============================================================
  // FAIL-CLOSED VERIFIER CONTRACT (codex-hostname-null catch 2026-05-22)
  // ============================================================

  /**
   * WHAT: A signed record whose `capabilities.scopes` array contains
   *       JSON-unrepresentable values (e.g. `undefined`) returns
   *       `{ ok: false, reason: 'malformed-record' }`. The verifier
   *       MUST NOT throw, even though the underlying JCS encoder
   *       throws-loudly on `undefined` values (correct shape for the
   *       encoder, since silent null-substitution would compromise sig
   *       integrity).
   * WHY: codex-hostname-null catch (2026-05-22, event
   *      `$13_MQScDp3DXPe3vL65aL73ykoh2uM7xq-yJWE-RrI8`): layering bug
   *      where validateSignedRecordShape accepted scopes-is-array
   *      without checking individual scope types, then JCS rebuild
   *      hit undefined + threw, propagating out of verify. The
   *      "verifier never throws" contract is load-bearing for the
   *      request-path: an attacker could flood the gateway with
   *      malformed-capability records to trigger exception-handling
   *      cost. Belt + suspenders fix: (a) validateSignedRecordShape
   *      checks scopes is string[]; (b) buildPeerRecordSignedBytes
   *      wrapped in try/catch as a fail-closed last guard.
   */
  test("fail-closed: scopes contains undefined → ok: false, reason: 'malformed-record' (NEVER throws)", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const validBaseSigned: SignedPeerRecord = signPeerRecord(
      {
        entity: "fail-closed-target",
        pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        capabilities: { scopes: ["matrix.send_message"] },
        signed_at: "2026-05-22T18:00:00Z",
        signer: "fleet-root",
      },
      privateKeyPem,
    );
    const malformed = {
      ...validBaseSigned,
      capabilities: { scopes: [undefined as unknown as string] },
    } as SignedPeerRecord;
    let result: VerifyPeerRecordResult;
    try {
      result = verifyPeerRecord(malformed, publicKeyPem);
    } catch (err) {
      throw new Error(
        `verifyPeerRecord MUST NOT throw on malformed input; got: ${(err as Error).message}`,
      );
    }
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed-record");
    }
  });

  /**
   * WHAT: A signed record with an unexpected enumerable extra field
   *       (e.g. `capabilities.unauthorized_extension: { ... }`) still
   *       follows the verifier contract: never throws. Either the
   *       signature verifies (extra field part of signed JCS bytes)
   *       or fails as invalid-signature (extra field added after
   *       signing). The verifier MUST NOT throw on unexpected shapes.
   * WHY: Untrusted manifest records may carry unexpected enumerable
   *      fields before JCS rebuild. codex-hostname-null catch part 2.
   */
  test("fail-closed: unexpected enumerable extra field → verify never throws", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const signed = signPeerRecord(
      {
        entity: "extra-field-target",
        pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        capabilities: { scopes: ["matrix.send_message"] },
        signed_at: "2026-05-22T18:00:00Z",
        signer: "fleet-root",
      },
      privateKeyPem,
    );
    const withExtra = {
      ...signed,
      capabilities: {
        ...signed.capabilities,
        unauthorized_extension: { foo: "bar" },
      },
    } as SignedPeerRecord;
    let result: VerifyPeerRecordResult;
    try {
      result = verifyPeerRecord(withExtra, publicKeyPem);
    } catch (err) {
      throw new Error(
        `verifyPeerRecord MUST NOT throw on extra-field input; got: ${(err as Error).message}`,
      );
    }
    expect(result.ok).toBe(false);
  });

  /**
   * WHAT: A signed record whose `capabilities.scopes` is not an array
   *       of strings (e.g. `scopes: [123, "matrix.send_message"]`,
   *       numbers mixed in) returns `{ ok: false, reason:
   *       'malformed-record' }`.
   * WHY: Pull deferred capabilities shape validation back to verify
   *      boundary: scopes must be string[]. JCS would canonicalize
   *      numbers fine, but downstream target directory consumers
   *      expect string scopes.
   */
  test("capabilities.scopes contains non-string value → ok: false, reason: 'malformed-record'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const signed = signPeerRecord(
      {
        entity: "non-string-scope-target",
        pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        capabilities: { scopes: ["matrix.send_message"] },
        signed_at: "2026-05-22T18:00:00Z",
        signer: "fleet-root",
      },
      privateKeyPem,
    );
    const malformed = {
      ...signed,
      capabilities: { scopes: [123 as unknown as string, "matrix.send_message"] },
    } as SignedPeerRecord;
    const result = verifyPeerRecord(malformed, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed-record");
    }
  });

  // ============================================================
  // SIGNER FIELD ENFORCEMENT (defensive)
  // ============================================================

  /**
   * WHAT: signer = "rogue-ca" → wrong-signer. The verifier checks the signer
   *       string BEFORE attempting sig verify.
   * WHY: Defense-in-depth. cognee-claude pre-review confirmed KEEP (v1.1
   *      intermediate-CA landing makes this load-bearing).
   */
  test("signer field != 'fleet-root' (e.g. 'rogue-ca') → ok: false, reason: 'wrong-signer'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "rogue-test",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "rogue-ca",
    };
    const signed = signPeerRecord(record, privateKeyPem);
    const result = verifyPeerRecord(signed, publicKeyPem);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("wrong-signer");
    }
  });

  /**
   * WHAT: signer = "Fleet-Root" or "FLEET-ROOT" → wrong-signer. Case-
   *       sensitive equality.
   * WHY: Defends against a future .toLowerCase() refactor silently widening
   *      the trust model. cognee-claude backup-review finding #5.
   */
  test("signer case variation: 'Fleet-Root' or 'FLEET-ROOT' → ok: false, reason: 'wrong-signer'", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const baseRecord = {
      entity: "case-test",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
    };
    for (const wrongCase of ["Fleet-Root", "FLEET-ROOT", "fleet_root", "fleetroot"]) {
      const record: UnsignedPeerRecord = { ...baseRecord, signer: wrongCase };
      const signed = signPeerRecord(record, privateKeyPem);
      const result = verifyPeerRecord(signed, publicKeyPem);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("wrong-signer");
      }
    }
  });

  // ============================================================
  // SIGN PATH: ALGORITHM-CONFUSION DEFENSE
  // ============================================================

  /**
   * WHAT: signPeerRecord with RSA private key throws (algorithm-confusion
   *       defense; operator-action path; loud failure on misconfig).
   * WHY: Parallels signEd25519's algorithm-confusion test. An operator who
   *      misconfigured the fleet-root key path would otherwise silently
   *      produce records that no verifier could ever validate.
   */
  test("signPeerRecord with RSA private key PEM → throws (algorithm-confusion defense)", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPrivatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const record: UnsignedPeerRecord = {
      entity: "rsa-sign-target",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    expect(() => signPeerRecord(record, rsaPrivatePem)).toThrow(/ed25519/);
  });

  // ============================================================
  // META: TYPE NARROWING (compile-time guard, not behavior test)
  // ============================================================

  /**
   * WHAT: The discriminated-union return type narrows correctly. If
   *       `result.ok === true`, accessing `result.entity` requires no
   *       cast; if `result.ok === false`, accessing `result.reason`
   *       requires no cast.
   * WHY: Pins the discriminated-union ergonomics (cognee-codex
   *      unrequested-extension #1).
   */
  test("type narrowing: ok-branch exposes entity, fail-branch exposes reason, no casts", () => {
    const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
    const record: UnsignedPeerRecord = {
      entity: "narrow-test",
      pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      capabilities: { scopes: ["matrix.send_message"] },
      signed_at: "2026-05-22T18:00:00Z",
      signer: "fleet-root",
    };
    const okResult = verifyPeerRecord(signPeerRecord(record, privateKeyPem), publicKeyPem);
    if (okResult.ok) {
      // No cast required to access entity:
      const entity: string = okResult.entity;
      expect(entity).toBe("narrow-test");
      // @ts-expect-error — reason field MUST NOT be accessible on the ok-branch.
      const _shouldNotCompile = okResult.reason;
    } else {
      throw new Error("ok-branch test expected ok: true");
    }

    // Force a failure to exercise the fail-branch narrowing.
    const failResult = verifyPeerRecord(
      { ...record, signer: "rogue", sig: bytesToBase64(new Uint8Array(64)) } as SignedPeerRecord,
      publicKeyPem,
    );
    if (!failResult.ok) {
      // No cast required to access reason:
      const reason:
        | "invalid-signature"
        | "malformed-record"
        | "wrong-signer"
        | "non-ed25519-trust-root" = failResult.reason;
      expect(reason).toBe("wrong-signer");
      // @ts-expect-error — entity field MUST NOT be accessible on the fail-branch.
      const _shouldNotCompile = failResult.entity;
    } else {
      throw new Error("fail-branch test expected ok: false");
    }
  });

  // ============================================================
  // CONTRACT NOTES — ratified by @cognee-codex primary pass 2026-05-22
  // ============================================================
  //
  // (A) `signed_at` field validation: ratified at A2 — operator-facing
  //     metadata only, no request-path time validity enforcement in v1.
  //     v1.1 rotation protocol adds `signed_at < now - 90d → stale` +
  //     `signed_at > now + 5min → future-skew` tests as part of rotation
  //     acceptance criteria.
  //
  // (B) `pubkey` field encoding: ratified at B1 — raw base64-encoded
  //     32-byte ed25519 public key. SPKI PEM input → malformed-record.
  //     Invalid base64 → malformed-record. Wrong-length base64 (31, 33
  //     bytes) → malformed-record. Enforced at validateSignedRecordShape
  //     (commit `19803109`); tests above pin all four rejection cases
  //     plus the valid happy path.
});
