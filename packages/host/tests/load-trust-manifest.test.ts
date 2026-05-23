/**
 * AJS-55 `loadTrustManifest` behavior tests.
 *
 * Tests pin the contract from the folded AJS-55 vault design doc:
 * `agents-js-federation-peer-record-signing-2026-05-22.md` §"Trust
 * manifest loader" + §"Hot-reload".
 *
 * Scope notes:
 * - V1 deviation from vault spec: manifest format is JSON (not YAML).
 *   Operator-editable + comment support deferred to v1.1; v1 matches the
 *   signed peer record format for consistency + zero new deps. Loader
 *   accepts only `.json` extension or no-extension manifest files in
 *   the tri-source path resolution.
 * - Trust-root file format: PEM (SPKI) — matches Node's `createPublicKey`
 *   native format + `verifyPeerRecord` trust-root argument shape.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateEd25519KeyPair } from "../src/ed25519.ts";
import { loadTrustManifest, watchTrustManifest } from "../src/load-trust-manifest.ts";
import {
  type SignedPeerRecord,
  signPeerRecord,
  type UnsignedPeerRecord,
} from "../src/peer-record.ts";

// ============================================================================
// FIXTURE HELPERS
// ============================================================================

/** Create a temp directory for the test. Cleaned up via afterEach in caller. */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "ajs55-load-test-"));
}

/** Write a signed peer record JSON file to a path. Returns the path. */
function writeSignedRecord(
  path: string,
  record: UnsignedPeerRecord,
  fleetRootPrivateKeyPem: string,
): string {
  const signed = signPeerRecord(record, fleetRootPrivateKeyPem);
  writeFileSync(path, `${JSON.stringify(signed, null, 2)}\n`, "utf-8");
  return path;
}

/** Write a manifest JSON file. Returns the path. */
function writeManifest(
  path: string,
  peers: Array<{ entity: string; record_path: string }>,
): string {
  writeFileSync(path, `${JSON.stringify({ peers }, null, 2)}\n`, "utf-8");
  return path;
}

/** A fresh, well-formed unsigned peer record fixture for a given entity. */
function makeUnsignedRecord(entity: string, peerPubKeyBase64: string): UnsignedPeerRecord {
  return {
    entity,
    pubkey: peerPubKeyBase64,
    capabilities: {
      scopes: ["matrix.send_message", "inbox.deliver", "inbox.read"],
      matrix: { room: `!${entity}:matrix.example` },
      inbox: { session: entity },
    },
    signed_at: "2026-05-23T10:00:00Z",
    signer: "fleet-root",
  };
}

describe("packages/host/tests/load-trust-manifest.test.ts — AJS-55 loader contract", () => {
  // ============================================================
  // TRI-SOURCE PATH RESOLUTION (vault doc §"Trust manifest loader")
  // ============================================================

  /**
   * WHAT: When `AGENTS_MCP_TRUST_MANIFEST_PATH` env override is set,
   *       loader uses it (highest precedence). Same for trust-root path
   *       via `AGENTS_MCP_TRUST_ROOT_PATH`.
   * WHY: Env override is for CI + local-dev tests where /etc/ and ~/
   *       both undesirable. Without explicit env-priority handling, the
   *       loader would fall through to system paths during tests +
   *       leak state across runs.
   */
  test("env-override path resolution: AGENTS_MCP_TRUST_MANIFEST_PATH + AGENTS_MCP_TRUST_ROOT_PATH win over /etc + ~", async () => {
    const tmpDir = makeTempDir();
    try {
      const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, publicKeyPem, "utf-8");

      const peerPubKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      const peerRecordPath = join(tmpDir, "peer.signed.json");
      writeSignedRecord(
        peerRecordPath,
        makeUnsignedRecord("ajs-claude", peerPubKey),
        privateKeyPem,
      );

      const manifestPath = join(tmpDir, "trust.json");
      writeManifest(manifestPath, [{ entity: "ajs-claude", record_path: peerRecordPath }]);

      const result = await loadTrustManifest({
        manifestPath, // explicit override (simulates env)
        trustRootPath,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok=true");
      const entry = result.targetDirectory.resolve("ajs-claude");
      expect(entry).not.toBeNull();
      expect(entry?.matrix?.room).toBe("!ajs-claude:matrix.example");
      expect(entry?.inbox?.session).toBe("ajs-claude");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // FAIL-CLOSED TRUST-ROOT (vault doc §"Trust manifest loader" step 2)
  // ============================================================

  /**
   * WHAT: Missing/unreadable trust-root.pub file causes loader to log
   *       ERROR and register NO peers (empty TargetDirectory).
   * WHY: Without a trust anchor, the verifier has nothing to verify
   *       against. Loading peers from an unverified manifest would be
   *       indistinguishable from forging — failing-open silently would
   *       defeat the entire AJS-55 substrate.
   */
  test("missing trust-root.pub → ok: true with empty TargetDirectory + error logged (fail-closed)", async () => {
    const tmpDir = makeTempDir();
    try {
      const trustRootPath = join(tmpDir, "does-not-exist.pub");
      const manifestPath = join(tmpDir, "trust.json");
      writeManifest(manifestPath, []);

      const errors: string[] = [];
      const result = await loadTrustManifest({
        manifestPath,
        trustRootPath,
        logger: {
          warn: () => {},
          error: (msg) => {
            errors.push(String(msg));
          },
        },
      });
      expect(result.ok).toBe(true); // loader doesn't crash; just no peers
      if (!result.ok) throw new Error("expected ok=true (loader returns empty directory)");
      expect(result.targetDirectory.resolve("anyone")).toBeNull();
      // ERROR logged so operator sees the misconfig.
      expect(errors.some((e) => /trust.root|missing|not found/i.test(e))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * WHAT: trust-root.pub exists but is not an ed25519 SPKI PEM (e.g.
   *       RSA key, garbage text) → loader logs ERROR + registers no
   *       peers.
   * WHY: Operator-misconfig defense parallel to verifyPeerRecord's
   *       `non-ed25519-trust-root` rejection. The loader catches at
   *       startup so peer verification never sees the bad key.
   */
  test("non-ed25519 trust-root (RSA or garbage) → ok: true with empty TargetDirectory + error logged", async () => {
    const tmpDir = makeTempDir();
    try {
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, "NOT-A-VALID-PEM-TEXT", "utf-8");
      const manifestPath = join(tmpDir, "trust.json");
      writeManifest(manifestPath, []);

      const errors: string[] = [];
      const result = await loadTrustManifest({
        manifestPath,
        trustRootPath,
        logger: { warn: () => {}, error: (m) => errors.push(String(m)) },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok=true");
      expect(result.targetDirectory.resolve("anyone")).toBeNull();
      expect(errors.some((e) => /trust.root|ed25519|invalid/i.test(e))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // PEER VERIFICATION (vault doc §"Trust manifest loader" step 5)
  // ============================================================

  /**
   * WHAT: Each peer entry in the manifest gets its record_path read +
   *       JCS-canonicalized + signature verified against the trust-root.
   *       Valid records register in TargetDirectory; failed-verify
   *       records WARN-skip (don't fail-startup).
   * WHY: Per-peer fail-closed: one bad record shouldn't take down the
   *       gateway. Operator sees the WARN + can fix that peer record
   *       without restarting.
   */
  test("manifest with 1 valid + 1 tampered peer record → only valid registered; tampered WARN-logged", async () => {
    const tmpDir = makeTempDir();
    try {
      const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, publicKeyPem, "utf-8");

      const peerPubKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      const validRecord = join(tmpDir, "valid.signed.json");
      writeSignedRecord(validRecord, makeUnsignedRecord("good-peer", peerPubKey), privateKeyPem);

      const tamperedRecord = join(tmpDir, "tampered.signed.json");
      const signed = signPeerRecord(makeUnsignedRecord("bad-peer", peerPubKey), privateKeyPem);
      // Tamper: flip entity in the signed record (sig won't match).
      const tampered: SignedPeerRecord = { ...signed, entity: "evil-peer" };
      writeFileSync(tamperedRecord, JSON.stringify(tampered), "utf-8");

      const manifestPath = join(tmpDir, "trust.json");
      writeManifest(manifestPath, [
        { entity: "good-peer", record_path: validRecord },
        { entity: "bad-peer", record_path: tamperedRecord },
      ]);

      const warnings: string[] = [];
      const result = await loadTrustManifest({
        manifestPath,
        trustRootPath,
        logger: { warn: (m) => warnings.push(String(m)), error: () => {} },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok=true");
      // Valid peer registered:
      expect(result.targetDirectory.resolve("good-peer")).not.toBeNull();
      // Tampered + evil entries NOT in directory:
      expect(result.targetDirectory.resolve("bad-peer")).toBeNull();
      expect(result.targetDirectory.resolve("evil-peer")).toBeNull();
      // WARN logged for the tampered record:
      expect(warnings.some((w) => /bad-peer|tampered|invalid|verify/i.test(w))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * WHAT: A peer manifest entry whose `record_path` doesn't exist → that
   *       peer is WARN-skipped (not in directory). Other peers continue
   *       to be processed; loader doesn't fail-startup.
   * WHY: Operator-misconfig defense. A typo in record_path shouldn't
   *       prevent the gateway from booting.
   */
  test("peer entry with missing record_path → WARN-skip; other peers still load", async () => {
    const tmpDir = makeTempDir();
    try {
      const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, publicKeyPem, "utf-8");

      const validRecord = join(tmpDir, "valid.signed.json");
      writeSignedRecord(
        validRecord,
        makeUnsignedRecord("good-peer", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
        privateKeyPem,
      );

      const manifestPath = join(tmpDir, "trust.json");
      writeManifest(manifestPath, [
        { entity: "good-peer", record_path: validRecord },
        { entity: "ghost-peer", record_path: join(tmpDir, "does-not-exist.signed.json") },
      ]);

      const warnings: string[] = [];
      const result = await loadTrustManifest({
        manifestPath,
        trustRootPath,
        logger: { warn: (m) => warnings.push(String(m)), error: () => {} },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok=true");
      expect(result.targetDirectory.resolve("good-peer")).not.toBeNull();
      expect(result.targetDirectory.resolve("ghost-peer")).toBeNull();
      expect(warnings.some((w) => /ghost-peer|missing|not found|read/i.test(w))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // MANIFEST VALIDATION (defensive)
  // ============================================================

  /**
   * WHAT: Missing manifest file → loader logs WARN, returns ok: true
   *       with empty TargetDirectory. Different from missing trust-root
   *       (which is fail-CLOSED with ERROR) because manifest absence
   *       could be legitimate dev state (no peers configured yet).
   * WHY: Dev-friendly default; ERROR would block local gateway startup
   *       when no peers are configured.
   */
  test("missing manifest file → ok: true with empty directory + WARN logged", async () => {
    const tmpDir = makeTempDir();
    try {
      const { publicKeyPem } = generateEd25519KeyPair();
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, publicKeyPem, "utf-8");

      const warnings: string[] = [];
      const result = await loadTrustManifest({
        manifestPath: join(tmpDir, "does-not-exist.json"),
        trustRootPath,
        logger: { warn: (m) => warnings.push(String(m)), error: () => {} },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok=true");
      expect(result.targetDirectory.resolve("anyone")).toBeNull();
      expect(warnings.some((w) => /manifest|not found|missing/i.test(w))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * WHAT: Malformed manifest (invalid JSON, missing `peers` field,
   *       wrong-typed entries) → loader logs WARN, returns ok: true
   *       with empty TargetDirectory. Doesn't fail-startup.
   * WHY: Operator-misconfig defense. Bad-JSON shouldn't take down the
   *       gateway; the WARN tells the operator what's wrong.
   */
  test("malformed manifest JSON → ok: true with empty directory + WARN logged", async () => {
    const tmpDir = makeTempDir();
    try {
      const { publicKeyPem } = generateEd25519KeyPair();
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, publicKeyPem, "utf-8");

      const manifestPath = join(tmpDir, "bad.json");
      writeFileSync(manifestPath, "{ not valid json", "utf-8");

      const warnings: string[] = [];
      const result = await loadTrustManifest({
        manifestPath,
        trustRootPath,
        logger: { warn: (m) => warnings.push(String(m)), error: () => {} },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok=true");
      expect(result.targetDirectory.resolve("anyone")).toBeNull();
      expect(warnings.some((w) => /manifest|parse|invalid/i.test(w))).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ============================================================
  // HOT-RELOAD (vault doc §"Hot-reload")
  // ============================================================

  /**
   * WHAT: After `watchTrustManifest` is set up, editing the manifest to
   *       REMOVE a peer (Case A — revocation path) causes that peer to
   *       drop from `targetDirectory.resolve` on the next reload.
   *       Editing to ADD a peer or change capabilities is also picked
   *       up via the watcher.
   * WHY: Vault doc §"Hot-reload" Case A pins the revocation path (no
   *       restart required to remove a peer). Tests use `reloadNow()`
   *       to bypass the fs.watch + debounce timing rather than relying
   *       on real filesystem events.
   */
  test("hot-reload Case A: manifest entry removed → peer drops from directory on reload", async () => {
    const tmpDir = makeTempDir();
    try {
      const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, publicKeyPem, "utf-8");

      const peerPubKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      const peerARecord = join(tmpDir, "peer-a.signed.json");
      writeSignedRecord(peerARecord, makeUnsignedRecord("peer-a", peerPubKey), privateKeyPem);
      const peerBRecord = join(tmpDir, "peer-b.signed.json");
      writeSignedRecord(peerBRecord, makeUnsignedRecord("peer-b", peerPubKey), privateKeyPem);

      const manifestPath = join(tmpDir, "trust.json");
      writeManifest(manifestPath, [
        { entity: "peer-a", record_path: peerARecord },
        { entity: "peer-b", record_path: peerBRecord },
      ]);

      const handle = await watchTrustManifest({
        manifestPath,
        trustRootPath,
        debounceMs: 0, // disable debounce for test determinism
        logger: { warn: () => {}, error: () => {} },
      });
      try {
        // Initial load: both peers present.
        expect(handle.targetDirectory.resolve("peer-a")).not.toBeNull();
        expect(handle.targetDirectory.resolve("peer-b")).not.toBeNull();

        // Remove peer-a from the manifest.
        writeManifest(manifestPath, [{ entity: "peer-b", record_path: peerBRecord }]);
        await handle.reloadNow();

        // Case A: peer-a dropped from directory.
        expect(handle.targetDirectory.resolve("peer-a")).toBeNull();
        expect(handle.targetDirectory.resolve("peer-b")).not.toBeNull();
      } finally {
        handle.stop();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  /**
   * WHAT: If a hot-reload produces a transiently-empty directory (e.g.
   *       manifest file mid-edit + parses as empty `peers: []`), the
   *       watcher RETAINS the previous-valid directory rather than
   *       blast-dropping all peers.
   * WHY: Case B + C fail-open semantics. Operator editing a manifest
   *       atomically (write-then-rename) won't normally trigger this,
   *       but partial writes or temporary parse errors shouldn't take
   *       down the whole gateway. Documented in JSDoc on
   *       watchTrustManifest.
   */
  test("hot-reload Case C: reload produces empty directory → previous-valid retained (fail-open)", async () => {
    const tmpDir = makeTempDir();
    try {
      const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
      const trustRootPath = join(tmpDir, "trust-root.pub");
      writeFileSync(trustRootPath, publicKeyPem, "utf-8");

      const peerRecord = join(tmpDir, "peer.signed.json");
      writeSignedRecord(
        peerRecord,
        makeUnsignedRecord("retained-peer", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="),
        privateKeyPem,
      );

      const manifestPath = join(tmpDir, "trust.json");
      writeManifest(manifestPath, [{ entity: "retained-peer", record_path: peerRecord }]);

      const warnings: string[] = [];
      const handle = await watchTrustManifest({
        manifestPath,
        trustRootPath,
        debounceMs: 0,
        logger: { warn: (m) => warnings.push(String(m)), error: () => {} },
      });
      try {
        expect(handle.targetDirectory.resolve("retained-peer")).not.toBeNull();

        // Corrupt the manifest to empty-peers (simulates partial-write).
        writeFileSync(manifestPath, "{ not valid json", "utf-8");
        await handle.reloadNow();

        // Case C: previous-valid retained; peer still resolvable.
        expect(handle.targetDirectory.resolve("retained-peer")).not.toBeNull();
        expect(warnings.some((w) => /retaining previous|fail-open/i.test(w))).toBe(true);
      } finally {
        handle.stop();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
