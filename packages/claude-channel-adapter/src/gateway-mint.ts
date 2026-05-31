/**
 * AJS-55 challenge/redeem JWT minting for the agents-js gateway.
 *
 * The gateway has NO admin mint (disabled). A client proves its identity by
 * signing a server-issued challenge with the per-agent ed25519 key, then
 * redeems the signature for a short-lived scoped JWT.
 *
 * **Contract** (confirmed against the live gateway):
 * - `POST {base}/api/agents/mint/challenge` (no auth, body `{}`)
 *     -> `{ challenge: <base64 32-byte nonce>, expires_at: <epoch ms> }` (~60s TTL)
 * - signed bytes = `UTF8("agents-js:challenge-mint:v1")` ‖ `0x0A`
 *     ‖ `UTF8(JCS({ challenge, entity, requested_scopes }))`  (NOT raw challenge bytes)
 * - `POST {base}/api/agents/mint/redeem`
 *     `{ challenge, entity, requested_scopes, sig: <base64 ed25519>, cid? }`
 *     -> `{ jwt, expires_in: 900, sub, scopes, cid }`
 *
 * The private key is PEM PKCS#8 ed25519; signing is `crypto.sign(null, bytes, key)`
 * (ed25519 hashes internally — no prehash). This module never reads gopass or any
 * secret store itself; the caller supplies the PEM, so key sourcing stays at the
 * launcher boundary and this stays unit-testable with a generated keypair.
 */

import { createPrivateKey, sign as cryptoSign } from "node:crypto";

/** Domain separator the gateway prepends before the canonical JSON. */
export const CHALLENGE_MINT_DOMAIN = "agents-js:challenge-mint:v1";

export interface MintResult {
  readonly jwt: string;
  readonly expires_in: number;
  readonly sub: string;
  readonly scopes: string[];
  readonly cid?: string;
}

export interface MintOptions {
  /** Gateway base URL, e.g. `https://ajs-gateway.q4m.dev`. */
  readonly baseUrl: string;
  /** Identity to mint for (the JWT `sub`), e.g. `hostname-null-claude-0`. */
  readonly entity: string;
  readonly scopes: string[];
  /** PEM PKCS#8 ed25519 private key for {@link MintOptions.entity}. */
  readonly privateKeyPem: string;
  /** Optional correlation id (UUID); gateway generates one if absent. */
  readonly cid?: string;
  /** Fetch override for tests. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Canonical JSON (RFC 8785 JCS) for the flat signed object. JCS sorts keys by
 * UTF-16 code unit; `challenge` < `entity` < `requested_scopes` are already in
 * that order and all values are JSON strings / a string array, so a compact
 * stringify in this exact key order is the canonical form, which matches the
 * gateway's verifier for this object.
 */
export function canonicalSignedObject(
  challenge: string,
  entity: string,
  requested_scopes: string[],
): string {
  return JSON.stringify({ challenge, entity, requested_scopes });
}

/** Build the exact bytes the gateway expects to be ed25519-signed. */
export function buildSignedBytes(challenge: string, entity: string, scopes: string[]): Buffer {
  return Buffer.concat([
    Buffer.from(CHALLENGE_MINT_DOMAIN, "utf8"),
    Buffer.from([0x0a]),
    Buffer.from(canonicalSignedObject(challenge, entity, scopes), "utf8"),
  ]);
}

interface ChallengeResponse {
  challenge?: unknown;
  expires_at?: unknown;
}

/**
 * Run the full challenge -> sign -> redeem flow and return the minted JWT
 * (plus its TTL/scopes). Throws on any non-200 or malformed response.
 */
export async function mintGatewayJwt(opts: MintOptions): Promise<MintResult> {
  const f = opts.fetchImpl ?? fetch;

  const challengeRes = await f(`${opts.baseUrl}/api/agents/mint/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!challengeRes.ok) {
    throw new Error(`mint/challenge HTTP ${challengeRes.status}: ${await safeText(challengeRes)}`);
  }
  const { challenge } = (await challengeRes.json()) as ChallengeResponse;
  if (typeof challenge !== "string" || challenge.length === 0) {
    throw new Error("mint/challenge: missing challenge");
  }

  const sig = cryptoSign(
    null,
    buildSignedBytes(challenge, opts.entity, opts.scopes),
    createPrivateKey(opts.privateKeyPem),
  ).toString("base64");

  const redeemRes = await f(`${opts.baseUrl}/api/agents/mint/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge,
      entity: opts.entity,
      requested_scopes: opts.scopes,
      sig,
      ...(opts.cid ? { cid: opts.cid } : {}),
    }),
  });
  if (!redeemRes.ok) {
    throw new Error(`mint/redeem HTTP ${redeemRes.status}: ${await safeText(redeemRes)}`);
  }
  const out = (await redeemRes.json()) as MintResult;
  if (typeof out.jwt !== "string" || out.jwt.length === 0) {
    throw new Error("mint/redeem: missing jwt");
  }
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "(no body)";
  }
}
