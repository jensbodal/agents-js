/**
 * Hardening smoke for @agents-js/host — the HS256 JWT mint → verify →
 * reject security loop, exercised against the PUBLIC package surface.
 *
 * What this proves end-to-end, as a downstream consumer would see it:
 *   1. A gateway mints a scoped HS256 JWT (jose SignJWT, mirroring the
 *      AJS-57 minter shape: `sub` / `scopes` / `cid` / `iss` / `aud` /
 *      `exp`).
 *   2. A client verifies it with the CORRECT signing key + issuer +
 *      audience → `verifyJwt` resolves a typed AuthenticatedIdentity.
 *   3. Verification REJECTS the failure modes that matter at the
 *      deployment boundary: wrong signing key, a byte-flipped/forged
 *      token, an HS512-same-key algorithm substitution, and an expired
 *      token.
 *
 * Why this is a learning test (not a tautology): every reject vector
 * below is a real "trust-the-network" gap if the verifier regressed.
 * The success path is pinned separately so a verifier that rejected
 * everything would still fail test #1, not silently pass the negatives.
 *
 * Surface under test is imported from the `@agents-js/host` barrel —
 * the exact import a real consumer writes — not a relative `src/` path.
 */

import { describe, expect, test } from "bun:test";
import { extractBearerToken, verifyJwt } from "@agents-js/host";
import { SignJWT } from "jose";

const SIGNING_KEY = new TextEncoder().encode("hardening-smoke-hs256-key-32bytes-01");
const WRONG_KEY = new TextEncoder().encode("hardening-smoke-WRONG-key-32bytes-02");
const ISSUER = "hardening-smoke-gateway";
const AUDIENCE = "agents-js-mcp";

/**
 * Mint a JWT the way the gateway-side minter does. Overrides let each
 * test stress one dimension (wrong key, past exp, ...) without
 * rebuilding the whole payload.
 */
async function mintScopedJwt(
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
    cid: overrides.cid ?? "cid-hardening-001",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(overrides.sub ?? "smoke-agent")
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expSecondsFromNow ?? 900))
    .sign(overrides.key ?? SIGNING_KEY);
}

describe("hardening-smoke — HS256 mint → verify → reject loop via @agents-js/host", () => {
  // Intent: the success path. A correctly-minted, correctly-keyed,
  // unexpired token with matching iss/aud resolves to a typed identity
  // carrying the scopes the gateway asserted. Pinned separately so the
  // reject tests below cannot all pass against a verifier that rejects
  // everything.
  test("mint → verify with correct key resolves an AuthenticatedIdentity", async () => {
    const jwt = await mintScopedJwt();
    const result = await verifyJwt(jwt, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.identity.agentName).toBe("smoke-agent");
    expect(result.identity.scopes).toEqual(["matrix.send_message", "matrix.read"]);
    expect(result.identity.correlationId).toBe("cid-hardening-001");
    expect(result.identity.issuer).toBe(ISSUER);
    expect(typeof result.identity.expiresAt).toBe("number");
  });

  // Intent: the keystone security property. A token signed by a key the
  // verifier does not hold MUST NOT verify — otherwise any party could
  // forge `sub`/`scopes` and identity is meaningless.
  test("verify rejects a token signed with the wrong key (signature-invalid)", async () => {
    const forged = await mintScopedJwt({ key: WRONG_KEY });
    const result = await verifyJwt(forged, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("signature-invalid");
  });

  // Intent: tamper-evidence. Flipping a single byte of an otherwise-valid
  // token breaks the HMAC; verification routes the tamper through the
  // jose-error fallback and rejects as signature-invalid. Proves the
  // signature actually covers the payload, not just that a wrong KEY is
  // caught.
  test("verify rejects a byte-flipped/forged token (signature-invalid)", async () => {
    const jwt = await mintScopedJwt();
    // Flip the last character of the base64url signature segment. A
    // valid JWS is `header.payload.signature`; mutating the signature
    // invalidates the HMAC without changing the asserted claims.
    const lastChar = jwt.at(-1);
    const flipped = `${jwt.slice(0, -1)}${lastChar === "A" ? "B" : "A"}`;
    expect(flipped).not.toBe(jwt);

    const result = await verifyJwt(flipped, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("signature-invalid");
  });

  // Intent: algorithm pinning. A token signed with HS512 against the
  // SAME shared key MUST be rejected — the verifier pins HS256 and does
  // not accept whichever algorithm the JWT header advertises. Without
  // this, an attacker holding the secret could swap the header `alg` to
  // sidestep the contract (cross-algorithm substitution).
  test("verify rejects an HS512-same-key algorithm substitution (signature-invalid)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const hs512 = await new SignJWT({
      scopes: ["matrix.send_message"],
      cid: "cid-hardening-hs512",
    })
      .setProtectedHeader({ alg: "HS512" })
      .setSubject("smoke-agent")
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
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

  // Intent: lease semantics. A token whose `exp` is already in the past
  // MUST be rejected as expired. The short TTL is the first-line
  // revocation mechanism; accepting expired tokens would let a stolen
  // token live forever.
  test("verify rejects a token with exp in the past (expired)", async () => {
    const expired = await mintScopedJwt({ expSecondsFromNow: -10 });
    const result = await verifyJwt(expired, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("expired");
  });

  // Intent: the bearer-header parse seam that sits in front of verifyJwt.
  // A real client presents `Authorization: Bearer <token>`; the loop is
  // only end-to-end if the token extracted from the header is the same
  // token that verifies. Also pins the "no token" path returning null so
  // middleware can distinguish absent from malformed.
  test("extractBearerToken feeds verifyJwt: header round-trip verifies; missing header → null", async () => {
    const jwt = await mintScopedJwt();
    const token = extractBearerToken(`Bearer ${jwt}`);
    expect(token).toBe(jwt);
    if (token === null) throw new Error("unreachable");

    const result = await verifyJwt(token, {
      signingKey: SIGNING_KEY,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    expect(result.ok).toBe(true);

    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Basic Zm9vOmJhcg==")).toBeNull();
  });
});
