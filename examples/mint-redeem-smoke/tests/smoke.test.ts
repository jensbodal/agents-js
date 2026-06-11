/**
 * AJS-55 challenge-mint smoke — LT-6 learning test.
 *
 * Proves the cryptographic challenge-mint loop end-to-end through the
 * REAL gateway mount handler (`setupAgentsMcpMount` from
 * `@agents-js/gateway`), exactly as an external peer would drive it
 * over HTTP:
 *
 *   1. POST /api/agents/mint/challenge        -> 32-byte challenge
 *   2. ed25519-sign the canonical signed bytes
 *      (domain-sep || 0x0A || JCS({challenge, entity, requested_scopes}))
 *   3. POST /api/agents/mint/redeem           -> JWT
 *
 * Assertions (the three contracts LT-6 pins):
 *   - The minted JWT carries EXACTLY the requested scopes (no silent
 *     downgrade) — verified by DECODING the JWT claim, not by trusting
 *     the response body echo.
 *   - Replaying the same (challenge, sig) is rejected single-use. The
 *     substrate returns HTTP 401 `invalid-challenge` (message contains
 *     `already-redeemed`). NB: the LT-6 brief loosely says "400"; the
 *     real handler maps `invalid-challenge` -> 401 (400 is reserved for
 *     `invalid-args` / `invalid-scope`). This test pins the substrate's
 *     actual contract.
 *   - The per-IP token-bucket rate limiter returns HTTP 429 with a
 *     `Retry-After` header once the burst is exhausted.
 *
 * Substrate reused (NOT rebuilt): `setupAgentsMcpMount` (gateway mount +
 * JWT minting + status mapping), `redeemMintChallenge` /
 * `createIpRateLimiter` / `buildChallengeMintSignedBytes` from
 * `@agents-js/host`. The peer key directory + tight rate limiter are the
 * only test seams wired via `overrides`.
 */

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { type AgentsMcpEnvConfig, setupAgentsMcpMount } from "@agents-js/gateway/agents-mcp-mount";
import { createTestAgentsMcpConfig } from "@agents-js/gateway/testing";
import {
  buildChallengeMintSignedBytes,
  createIpRateLimiter,
  type PeerKeyDirectory,
} from "@agents-js/host";
import { makeRecordingMatrixTool } from "@agents-js/host/testing";
import { jwtVerify } from "jose";

// HS256 signing key for the gateway's minted JWTs. ≥32 bytes (RFC 7518
// §3.2 / readAgentsMcpEnv enforces this minimum).
const SIGNING_KEY_TEXT = "mint-redeem-smoke-signing-key-32bytes-min";
const ISSUER = "mint-redeem-smoke-gateway";
const AUDIENCE = "agents-js-mcp";
const SIGNING_KEY = new TextEncoder().encode(SIGNING_KEY_TEXT);

/** Minimal gateway config for the mount, pinned to this smoke's crypto wiring. */
function baseConfig(overrides: Partial<AgentsMcpEnvConfig> = {}): AgentsMcpEnvConfig {
  return createTestAgentsMcpConfig({
    signingKey: SIGNING_KEY,
    issuer: ISSUER,
    audience: AUDIENCE,
    sendScript: "/unused-in-smoke",
    ...overrides,
  });
}

/**
 * Generate an ed25519 keypair, register it in a mock {@link PeerKeyDirectory},
 * and return a signer that produces a valid challenge signature exactly as a
 * real peer would: sign the canonical bytes from {@link buildChallengeMintSignedBytes}.
 *
 * The directory stores the base64-encoded RAW 32-byte ed25519 public key
 * (the AJS-55 B1 wire format), extracted from the tail of the SPKI DER.
 */
function makeMintFixture(opts: { entity: string; scopes: string[] }): {
  peerKeyDirectory: PeerKeyDirectory;
  signChallenge: (challenge: string, requestedScopes: string[]) => string;
} {
  // generateKeyPairSync returns KeyObjects ready to sign/export directly.
  const { privateKey: priv, publicKey } = generateKeyPairSync("ed25519");
  // SPKI DER for ed25519 is a fixed 12-byte header + the raw 32-byte key.
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const rawPubKey = new Uint8Array(spkiDer.subarray(spkiDer.length - 32));
  const pubKeyBase64 = Buffer.from(rawPubKey).toString("base64");
  const { entity } = opts;

  return {
    peerKeyDirectory: {
      getPubkey: (e) => (e === entity ? pubKeyBase64 : null),
      getCapabilities: (e) => (e === entity ? { scopes: opts.scopes } : null),
    },
    signChallenge: (challenge, requestedScopes) => {
      const signedBytes = buildChallengeMintSignedBytes({
        challenge,
        entity,
        requested_scopes: requestedScopes,
      });
      return Buffer.from(nodeSign(null, signedBytes, priv)).toString("base64");
    },
  };
}

async function fetchChallenge(
  handler: (req: Request) => Promise<Response | null>,
  headers?: Record<string, string>,
): Promise<Response | null> {
  return handler(
    new Request("http://gw.local/api/agents/mint/challenge", { method: "POST", headers }),
  );
}

function redeemRequest(body: unknown): Request {
  return new Request("http://gw.local/api/agents/mint/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("mint-redeem-smoke — AJS-55 challenge mint/redeem end-to-end", () => {
  // Intent: the full production path. A peer fetches a challenge, signs
  // the canonical payload with its ed25519 key, redeems, and receives a
  // JWT whose `scopes` claim is EXACTLY what it requested — proving the
  // no-silent-downgrade contract by decoding the JWT, not the body echo.
  test("challenge -> sign -> redeem -> JWT carries exactly the requested scopes", async () => {
    const requestedScopes = ["matrix.send_message", "inbox.deliver"];
    const fixture = makeMintFixture({ entity: "smoke-peer", scopes: requestedScopes });
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
      },
    });
    if (wireup === null) throw new Error("mount unexpectedly disabled");
    try {
      const challengeRes = await fetchChallenge(wireup.fetchHandler);
      expect(challengeRes?.status).toBe(200);
      const { challenge } = (await challengeRes?.json()) as { challenge: string };
      // Base64 of 32 raw bytes is 43-44 chars.
      expect(challenge.length).toBeGreaterThanOrEqual(43);

      const sig = fixture.signChallenge(challenge, requestedScopes);
      const redeemRes = await wireup.fetchHandler(
        redeemRequest({
          challenge,
          entity: "smoke-peer",
          requested_scopes: requestedScopes,
          sig,
        }),
      );
      expect(redeemRes?.status).toBe(200);
      const body = (await redeemRes?.json()) as { jwt: string; sub: string; scopes: string[] };
      expect(body.sub).toBe("smoke-peer");
      expect(body.scopes).toEqual(requestedScopes);

      // Decode + verify the JWT against the gateway signing key. The
      // `scopes` CLAIM (not just the body echo) must equal the request.
      const { payload } = await jwtVerify(body.jwt, SIGNING_KEY, {
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      expect(payload.sub).toBe("smoke-peer");
      expect(payload.scopes).toEqual(requestedScopes);
    } finally {
      wireup.stop();
    }
  });

  // Intent: single-use. Replaying a successfully-redeemed (challenge, sig)
  // pair is rejected. The handler maps the store's `already-redeemed`
  // reason to HTTP 401 `invalid-challenge` — capture-replay protection.
  test("replay of a redeemed challenge -> 401 invalid-challenge (single-use)", async () => {
    const scopes = ["matrix.send_message"];
    const fixture = makeMintFixture({ entity: "smoke-peer", scopes });
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
      },
    });
    if (wireup === null) throw new Error("mount unexpectedly disabled");
    try {
      const challengeRes = await fetchChallenge(wireup.fetchHandler);
      const { challenge } = (await challengeRes?.json()) as { challenge: string };
      const sig = fixture.signChallenge(challenge, scopes);
      const send = () =>
        wireup.fetchHandler(
          redeemRequest({ challenge, entity: "smoke-peer", requested_scopes: scopes, sig }),
        );

      // First redeem succeeds and mints a JWT.
      expect((await send())?.status).toBe(200);

      // Replay of the same challenge is rejected single-use.
      const replayRes = await send();
      expect(replayRes?.status).toBe(401);
      const replayBody = (await replayRes?.json()) as { reason: string; message: string };
      expect(replayBody.reason).toBe("invalid-challenge");
      expect(replayBody.message).toContain("already-redeemed");
    } finally {
      wireup.stop();
    }
  });

  // Intent: the per-IP token-bucket rate limiter on the unauthenticated
  // /mint/challenge endpoint returns 429 + Retry-After once the burst is
  // exhausted — bounding the challenge-flood attack surface. A tight
  // limiter (burst 2) keeps the assertion deterministic; a fixed source
  // IP via X-Forwarded-For pins all three requests to one bucket.
  test("per-IP rate limiter -> 429 with Retry-After once burst exhausted", async () => {
    const fixture = makeMintFixture({ entity: "smoke-peer", scopes: ["matrix.send_message"] });
    const wireup = await setupAgentsMcpMount({
      overrides: {
        config: baseConfig(),
        matrixTool: makeRecordingMatrixTool(),
        peerKeyDirectory: fixture.peerKeyDirectory,
        ipRateLimiter: createIpRateLimiter({ ratePerMinute: 30, burst: 2 }),
      },
    });
    if (wireup === null) throw new Error("mount unexpectedly disabled");
    try {
      const ipHeaders = { "X-Forwarded-For": "192.0.2.99" };
      // Burst of 2 succeeds.
      expect((await fetchChallenge(wireup.fetchHandler, ipHeaders))?.status).toBe(200);
      expect((await fetchChallenge(wireup.fetchHandler, ipHeaders))?.status).toBe(200);
      // 3rd request from the same IP hits the limit.
      const limited = await fetchChallenge(wireup.fetchHandler, ipHeaders);
      expect(limited?.status).toBe(429);
      expect(limited?.headers.get("Retry-After")).not.toBeNull();
    } finally {
      wireup.stop();
    }
  });
});
