/**
 * AJS-57 runtime session JWT verifier.
 *
 * Verifies a short-lived HS256-signed session JWT and resolves it to
 * a typed {@link AuthenticatedIdentity}. The MCP dispatch layer
 * (AJS-56) calls this once per inbound tool call, before scope ACL
 * enforcement and provider dispatch.
 *
 * Threat model + design rationale: see
 * `docs/research/agents-js-hosted-mcp-tool-provider-design-2026-05-20.md`
 * section 3 (Identity-aware tool calls). Key invariants pinned here:
 *
 *  - Signature MUST verify against the gateway's HS256 key (server-
 *    asserted identity — clients cannot forge `sub`).
 *  - `iss` + `aud` MUST match the gateway's configured values
 *    (cross-gateway and cross-service replay protection).
 *  - `exp` MUST be in the future (lease semantics; design Q5).
 *  - `sub` + `cid` MUST be present (downstream audit + denylist).
 *  - Optional denylist enables "burn this session NOW" revoke without
 *    waiting for the TTL.
 *
 * Surface deliberately rejection-typed (`{ ok: false, reason, message }`)
 * rather than throwing, so the dispatcher can map structured reasons
 * to HTTP status / log fields without exception machinery.
 */

import { errors as joseErrors, jwtVerify } from "jose";

/**
 * Resolved caller identity. Every Provider method receives one of these
 * as its first argument; `agentName` is the `sub` claim, set by the
 * gateway mint endpoint.
 */
export interface AuthenticatedIdentity {
  /** JWT `sub` claim. The canonical agent name (e.g. "codex-hostname-null"). */
  agentName: string;
  /**
   * JWT `scopes` claim. 1:1 with MCP tool names (e.g.
   * `"matrix.send_message"`, `"matrix.read"`, `"memory.query"`).
   * `[]` when the claim is absent — verifier never defaults to a
   * non-empty set; scope enforcement is the ACL layer's job.
   */
  scopes: readonly string[];
  /** JWT `cid` claim — opaque correlation id for audit chain propagation. */
  correlationId: string;
  /** JWT `iss` claim — name of the minting gateway. */
  issuer: string;
  /** Epoch seconds; the `exp` claim, for downstream short-cache TTL. */
  expiresAt: number;
}

/**
 * Why a verification attempt failed. Stable string union so callers
 * can match on it for telemetry + HTTP-status mapping without parsing
 * free-text error messages.
 */
export type VerifyRejectionReason =
  | "missing-bearer"
  | "signature-invalid"
  | "expired"
  | "issuer-mismatch"
  | "audience-mismatch"
  | "subject-missing"
  | "correlation-id-missing"
  | "revoked";

/** Discriminated result; ok-or-reason. Never throws on validation failure. */
export type VerifyResult =
  | { ok: true; identity: AuthenticatedIdentity }
  | { ok: false; reason: VerifyRejectionReason; message: string };

/** Options for {@link verifyJwt}. */
export interface VerifyJwtOptions {
  /**
   * HS256 signing key bytes. Per-gateway, loaded server-side from
   * gopass at `services/agents-js/gateway/<hostname>/jwt-signing-key`.
   * Never client-provided.
   */
  signingKey: Uint8Array;
  /** Expected `iss` claim — the gateway's canonical name. */
  issuer: string;
  /** Expected `aud` claim — `"agents-js-mcp"` for the MCP tool surface. */
  audience: string;
  /**
   * Optional revocation denylist. Keys are `"<sub>|<cid>"` strings —
   * shape supports both whole-agent revoke and specific-correlation
   * revoke. GC is the caller's responsibility.
   */
  denylist?: ReadonlySet<string>;
  /** Clock injection for testability. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/**
 * Verify a session JWT and resolve it to a caller identity.
 *
 * Returns `{ ok: true, identity }` on success or
 * `{ ok: false, reason, message }` on any verification failure.
 * Never throws on validation errors — only on programmer errors
 * (e.g. a non-string `jwt` argument).
 */
export async function verifyJwt(jwt: string, opts: VerifyJwtOptions): Promise<VerifyResult> {
  if (!jwt || typeof jwt !== "string") {
    return { ok: false, reason: "missing-bearer", message: "no JWT provided" };
  }

  try {
    const { payload } = await jwtVerify(jwt, opts.signingKey, {
      // **Algorithm pinning — security-critical.** Without this, jose
      // accepts any algorithm the JWT header advertises, so a JWT
      // signed with HS512 using the same secret would verify against
      // our HS256 key. Per @cognee-codex source-review on PR #48:
      // pin explicitly to the algorithm we promise in the verifier
      // contract. AJS-56 design Q4 names HS256 as the v1 choice.
      algorithms: ["HS256"],
      issuer: opts.issuer,
      audience: opts.audience,
      ...(opts.now ? { currentDate: opts.now() } : {}),
    });

    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      return {
        ok: false,
        reason: "subject-missing",
        message: "JWT `sub` claim is required",
      };
    }

    const cid = (payload as { cid?: unknown }).cid;
    if (typeof cid !== "string" || cid.length === 0) {
      return {
        ok: false,
        reason: "correlation-id-missing",
        message: "JWT `cid` claim is required",
      };
    }

    if (opts.denylist?.has(`${sub}|${cid}`)) {
      return {
        ok: false,
        reason: "revoked",
        message: `session ${sub}|${cid} is on the denylist`,
      };
    }

    const rawScopes = (payload as { scopes?: unknown }).scopes;
    const scopes: readonly string[] =
      Array.isArray(rawScopes) && rawScopes.every((s): s is string => typeof s === "string")
        ? Object.freeze([...rawScopes])
        : Object.freeze([]);

    if (typeof payload.iss !== "string" || typeof payload.exp !== "number") {
      return {
        ok: false,
        reason: "signature-invalid",
        message: "JWT payload missing iss/exp",
      };
    }

    return {
      ok: true,
      identity: {
        agentName: sub,
        scopes,
        correlationId: cid,
        issuer: payload.iss,
        expiresAt: payload.exp,
      },
    };
  } catch (err) {
    return { ok: false, ...mapJoseError(err) };
  }
}

/**
 * Map a jose verification error to a structured rejection reason.
 *
 * jose throws typed error classes; we narrow on the class so each
 * failure mode maps to a stable {@link VerifyRejectionReason}. Falls
 * back to `signature-invalid` for any unmapped case — every unmapped
 * failure MUST be treated as a security failure (don't accept tokens
 * we can't confidently verify).
 */
function mapJoseError(err: unknown): { reason: VerifyRejectionReason; message: string } {
  if (err instanceof joseErrors.JWTExpired) {
    return { reason: "expired", message: "JWT expired" };
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.claim === "iss") {
      return { reason: "issuer-mismatch", message: err.message };
    }
    if (err.claim === "aud") {
      return { reason: "audience-mismatch", message: err.message };
    }
    return { reason: "signature-invalid", message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { reason: "signature-invalid", message };
}

/**
 * Extract a bearer token from an `Authorization` header value.
 *
 * Returns the token string for `"Bearer <token>"` (scheme name is
 * case-insensitive per RFC 6750 section 2.1). Returns `null` for
 * missing, empty, or non-Bearer headers.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader || typeof authHeader !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}
