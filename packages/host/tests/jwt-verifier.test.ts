/**
 * AJS-57 runtime session JWT verifier — contract tests (test-stub-first per
 * Jens directive `$DcaiOw-k0UuXWvwTuTsruyEXD9MsqMeHiQf8SgJQQbc`).
 *
 * These tests pin the verifier's behavior as a CALLER CONTRACT, not its
 * internal scaffolding. Every test states WHAT we're verifying and WHY
 * that property matters at the deployment boundary — not "does the
 * function we wrote call the function we wrote" tautologies.
 *
 * AJS-56 Phase 1 (delivery router + Matrix provider) depends on this
 * verifier being correct: a broken verifier means caller identity can
 * be forged or scopes bypassed, which would re-introduce the
 * "trust-the-network" gap that `agents-js-primitives-contract-map`
 * already flagged.
 *
 * Verifier surface (locked at contract-design time, NOT implementation):
 *
 *   await verifyJwt(jwt, {
 *     signingKey: Uint8Array,   // HS256 per-gateway secret from gopass
 *     issuer: string,           // expected `iss` claim
 *     audience: string,         // expected `aud` claim
 *     denylist?: ReadonlySet<string>,  // revoked `sub|cid` pairs
 *     now?: () => Date,         // clock injection for testability
 *   }) → { ok: true, identity } | { ok: false, reason, message }
 *
 *   AuthenticatedIdentity = {
 *     agentName: string,        // from `sub`
 *     scopes: readonly string[], // from `scopes`
 *     correlationId: string,    // from `cid`
 *     issuer: string,
 *     expiresAt: number,        // epoch seconds
 *   }
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { SignJWT } from "jose";
import { extractBearerToken, verifyJwt } from "../src/jwt-verifier.ts";

const SIGNING_KEY = new TextEncoder().encode("test-hs256-key-32bytes-long-12345");
const WRONG_KEY = new TextEncoder().encode("WRONG-test-hs256-key-32bytes-1234");
const ISSUER = "proxmox-gw";
const AUDIENCE = "agents-js-mcp";

/**
 * Mint a JWT for tests. Mirrors what the gateway-side AJS-57 minter
 * will eventually produce, but with overrides so each test can stress
 * a single dimension (expired, wrong issuer, etc.) without rebuilding
 * the entire payload.
 */
async function mintTestJwt(
  overrides: {
    sub?: string;
    scopes?: readonly string[];
    cid?: string;
    iss?: string;
    aud?: string;
    expSecondsFromNow?: number;
    key?: Uint8Array;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    scopes: overrides.scopes ?? ["matrix.send_message", "matrix.read"],
    cid: overrides.cid ?? "cid-test-001",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(overrides.sub ?? "codex-hostname-null")
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expSecondsFromNow ?? 900))
    .sign(overrides.key ?? SIGNING_KEY);
}

describe("packages/host/tests/jwt-verifier.test.ts — AJS-57 runtime session contract", () => {
  let goodJwt: string;
  beforeAll(async () => {
    goodJwt = await mintTestJwt();
  });

  /**
   * WHAT: A JWT signed with the gateway's HS256 key, with matching
   *       `iss`/`aud`, unexpired, and carrying `sub`/`scopes`/`cid`
   *       resolves to an `AuthenticatedIdentity` with those fields.
   * WHY: This is the success path — every other test in this file
   *      asserts that some specific failure mode rejects, so the
   *      positive case must be pinned separately. Without this, a
   *      regression could make the verifier reject everything and the
   *      negative tests would still pass.
   */
  test("valid JWT resolves to AuthenticatedIdentity with sub/scopes/cid", async () => {
    const result = await verifyJwt(goodJwt, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.identity.agentName).toBe("codex-hostname-null");
    expect(result.identity.scopes).toEqual(["matrix.send_message", "matrix.read"]);
    expect(result.identity.correlationId).toBe("cid-test-001");
    expect(result.identity.issuer).toBe(ISSUER);
    expect(typeof result.identity.expiresAt).toBe("number");
  });

  /**
   * WHAT: A JWT signed with HS512 against the SAME shared key is
   *       rejected with `reason: "signature-invalid"` — the verifier
   *       MUST pin to HS256 explicitly, not accept whichever algorithm
   *       the JWT header advertises.
   * WHY: Pinned by @cognee-codex source-review on PR #48. Without an
   *      explicit `algorithms: ["HS256"]` option, jose accepts any
   *      JWS algorithm declared in the JWT header. An attacker who
   *      obtains (or guesses) the shared secret + flips the header
   *      `alg` to a stronger or weaker variant would have their token
   *      accepted because the key and algorithm aren't bound. AJS-56
   *      design Q4 names HS256 as the v1 choice; pinning the
   *      algorithm matches the deployment promise and prevents
   *      cross-algorithm substitution attacks.
   */
  test("JWT signed with HS512 (same key, wrong algorithm) → rejected as signature-invalid", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const hs512 = await new SignJWT({
      scopes: ["matrix.send_message"],
      cid: "cid-test-hs512",
    })
      .setProtectedHeader({ alg: "HS512" })
      .setSubject("codex-hostname-null")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 900)
      .sign(SIGNING_KEY);
    const result = await verifyJwt(hs512, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("signature-invalid");
  });

  /**
   * WHAT: A JWT signed with the WRONG key is rejected with
   *       `reason: "signature-invalid"`.
   * WHY: This is the core security property. If the verifier accepts
   *      tokens signed by anyone, every other check is decorative —
   *      an attacker could forge any `sub`/`scopes` they like. Per
   *      AJS-56 design "no client-controlled identity strings": the
   *      `sub` claim must be server-asserted (signed by the gateway's
   *      key), so signature verification is the keystone.
   */
  test("JWT signed with wrong key → rejected with signature-invalid", async () => {
    const forged = await mintTestJwt({ key: WRONG_KEY });
    const result = await verifyJwt(forged, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("signature-invalid");
  });

  /**
   * WHAT: An expired JWT is rejected with `reason: "expired"`.
   * WHY: 15-minute TTL is the design's first-line revocation mechanism
   *      (design doc Q5 resolution: "pull-based-with-short-TTL").
   *      Accepting expired tokens defeats lease semantics — a
   *      compromised harness's stolen JWT would remain valid forever.
   *      Pinned with a static `now` to remove clock-flake.
   */
  test("expired JWT → rejected with expired", async () => {
    const expired = await mintTestJwt({ expSecondsFromNow: -10 });
    const result = await verifyJwt(expired, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("expired");
  });

  /**
   * WHAT: A JWT with the wrong `iss` claim is rejected with
   *       `reason: "issuer-mismatch"`.
   * WHY: Cross-gateway token replay protection. Each gateway mints
   *      JWTs with its own `iss`; if a token from gateway A is replayed
   *      against gateway B, B must reject it. Without this check,
   *      gateway B would accept A's tokens, and A's scope decisions
   *      would silently apply to B's resources.
   */
  test("JWT with wrong issuer → rejected with issuer-mismatch", async () => {
    const wrongIss = await mintTestJwt({ iss: "other-gateway" });
    const result = await verifyJwt(wrongIss, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("issuer-mismatch");
  });

  /**
   * WHAT: A JWT with the wrong `aud` claim is rejected with
   *       `reason: "audience-mismatch"`.
   * WHY: Audience binding prevents replay across services on the same
   *      gateway — a JWT minted for `agents-js-mcp` should not be
   *      accepted by, say, a future `agents-js-admin-api` audience.
   *      Mirrors RFC 7519 §4.1.3 intent.
   */
  test("JWT with wrong audience → rejected with audience-mismatch", async () => {
    const wrongAud = await mintTestJwt({ aud: "different-service" });
    const result = await verifyJwt(wrongAud, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("audience-mismatch");
  });

  /**
   * WHAT: A JWT whose `sub|cid` pair is in the denylist is rejected
   *       with `reason: "revoked"`, even if the JWT itself is otherwise
   *       valid (signature, exp, iss, aud all good).
   * WHY: Design Q5 resolution: "denylist handles 'burn this session
   *      NOW' immediate revoke" — the 15-min TTL covers slow churn,
   *      but credentials compromised mid-session need an immediate kill
   *      switch. The denylist key is `sub|cid` because revoking a
   *      whole `sub` (e.g. "burn all sessions for codex-hostname-null")
   *      and revoking a specific correlation (e.g. one leaked JWT)
   *      are different operations; the key shape supports both.
   */
  test("JWT whose sub|cid is in denylist → rejected with revoked", async () => {
    const denylist = new Set(["codex-hostname-null|cid-test-001"]);
    const result = await verifyJwt(goodJwt, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
      denylist,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("revoked");
  });

  /**
   * WHAT: A JWT without a `sub` claim is rejected with
   *       `reason: "subject-missing"`.
   * WHY: AJS-56 design "the `sub` claim is server-asserted" — a JWT
   *      with no subject identifies no caller. Provider dispatch
   *      would have nothing to resolve gopass paths against. Failing
   *      fast at verify is clearer than failing deep inside a Provider
   *      with a confusing "identity.agentName is undefined" error.
   */
  test("JWT without sub claim → rejected with subject-missing", async () => {
    const noSub = await new SignJWT({ scopes: ["matrix.send_message"], cid: "cid-x" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(SIGNING_KEY);
    const result = await verifyJwt(noSub, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("subject-missing");
  });

  /**
   * WHAT: A JWT without a `cid` (correlationId) claim is rejected
   *       with `reason: "correlation-id-missing"`.
   * WHY: AJS-56 design lists `correlationId` as one of the
   *      "audit chain" propagation fields. A missing `cid` breaks
   *      cross-system audit (MCP tool call → bus → Matrix). It also
   *      breaks the denylist key shape. Make it required at verify
   *      time so downstream consumers can rely on it.
   */
  test("JWT without cid claim → rejected with correlation-id-missing", async () => {
    const noCid = await new SignJWT({ scopes: ["matrix.send_message"] })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("codex-hostname-null")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(SIGNING_KEY);
    const result = await verifyJwt(noCid, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("correlation-id-missing");
  });

  /**
   * WHAT: A JWT without `scopes` resolves successfully but with
   *       `scopes: []`. Verifier does NOT inject default scopes.
   * WHY: Scope enforcement is the ACL layer's responsibility, not the
   *      verifier's. The verifier only asserts identity; the dispatcher
   *      enforces "this identity has the required scope." A missing
   *      scope claim → empty scopes → the ACL rejects with a clear
   *      "scope X not granted" message at dispatch time. Defaulting
   *      to a non-empty scope set here would silently grant
   *      capabilities and conflate concerns.
   */
  test("JWT without scopes → identity.scopes is empty array (not defaulted)", async () => {
    const noScopes = await new SignJWT({ cid: "cid-test-noscope" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("codex-hostname-null")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
      .sign(SIGNING_KEY);
    const result = await verifyJwt(noScopes, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.identity.scopes).toEqual([]);
  });

  /**
   * WHAT: `extractBearerToken(null)` and `extractBearerToken(undefined)`
   *       and `extractBearerToken("")` all return `null`.
   * WHY: Pins the "no token" code path — middleware receives a missing
   *      header from anonymous callers; the verifier surface must
   *      distinguish "no token" (returns null, dispatch should 401)
   *      from "bad token" (returns string that verifyJwt then rejects).
   *      Pinning this separately keeps the middleware logic simple.
   */
  test("extractBearerToken returns null for missing/empty headers", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });

  /**
   * WHAT: `extractBearerToken("Bearer <token>")` returns `<token>`.
   *       Case-insensitive on the scheme name.
   * WHY: RFC 6750 §2.1 says the `Bearer` scheme is case-insensitive
   *      ("Bearer" / "bearer" / "BEARER" all valid). Real-world
   *      clients vary; rejecting "bearer" because we typed `Bearer`
   *      would be a fragile contract that surprises operators.
   */
  test("extractBearerToken parses 'Bearer <token>' case-insensitively", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("BEARER abc.def.ghi")).toBe("abc.def.ghi");
  });

  /**
   * WHAT: `extractBearerToken("Token abc")` (non-Bearer scheme) returns
   *       `null`. Garbage strings also return `null`.
   * WHY: Confusing a non-Bearer auth shape with a malformed JWT would
   *      yield misleading errors ("signature invalid" when really the
   *      caller used the wrong scheme). Distinguish "no Bearer token"
   *      from "bad Bearer token" at parse time.
   */
  test("extractBearerToken rejects non-Bearer schemes and garbage", () => {
    expect(extractBearerToken("Token abc")).toBeNull();
    expect(extractBearerToken("Basic Zm9vOmJhcg==")).toBeNull();
    expect(extractBearerToken("not-a-real-header")).toBeNull();
  });
});
