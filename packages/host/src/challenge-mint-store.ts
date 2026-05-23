/**
 * AJS-55 challenge-mint store + per-IP token-bucket rate limiter.
 *
 * Pure-logic primitives consumed by the gateway HTTP layer
 * (`apps/internal-gateway/agents-mcp-mount.ts`) to back the
 * `POST /api/agents/mint/challenge` + `POST /api/agents/mint/redeem`
 * endpoints. No I/O; no fetch; no timers (callers wire the sweep timer).
 *
 * Design doc: `agents-js-federation-peer-record-signing-2026-05-22.md`
 * §"Challenge mint flow" + §"Pending-challenges Map: TTL GC + size cap
 * + rate guard".
 *
 * **Ratified defaults** (cognee-codex contract review §"Still open"):
 * - Size cap: 10_000 entries (503 `challenge-store-full` on overflow)
 * - Sweep period: 1 second (callers wire `setInterval` around `sweepExpired`)
 * - Nonce length: 32 bytes (collision-resistant over 60s TTL)
 * - Per-IP rate limit: 30/min token bucket with burst 10 (configurable
 *   via `AGENTS_MCP_CHALLENGE_RATE_LIMIT` in the gateway layer)
 *
 * **Why pure logic (no timers)**: tests deterministic without fake-clock
 * libs; gateway wires the sweep timer at startup; future Redis-backed
 * implementation can replace the in-memory Map without touching this
 * surface.
 */

import { randomBytes } from "node:crypto";
import { bytesToBase64 } from "./ed25519.ts";

// ============================================================================
// CHALLENGE STORE
// ============================================================================

/**
 * Options for {@link createChallengeMintStore}.
 *
 * @internal AJS-55 implementation surface.
 */
export interface ChallengeMintStoreOptions {
  /** TTL for issued challenges in milliseconds. Vault doc spec: 60_000 (60s). */
  ttlMs: number;
  /**
   * Maximum number of pending challenges the store will hold. Once
   * reached, `issueChallenge` returns `{ok:false, reason:'store-full'}`.
   * Default: 10_000.
   */
  sizeCap?: number;
}

/** Result of {@link ChallengeMintStore.issueChallenge}. */
export type IssueChallengeResult =
  | { ok: true; challenge: string; expiresAt: number }
  | { ok: false; reason: "store-full" };

/** Result of {@link ChallengeMintStore.redeemChallenge}. */
export type RedeemChallengeResult =
  | { ok: true }
  | { ok: false; reason: "not-found" | "expired" | "already-redeemed" };

/**
 * Pure-logic challenge-mint store. Tracks issued challenges in an
 * in-memory `Map<string, ChallengeEntry>`; consumed (redeemed)
 * challenges are removed from the map. Callers wire a sweep timer
 * (`setInterval` around `sweepExpired`) at startup.
 *
 * @internal AJS-55 implementation surface; gateway HTTP handler wraps
 *           this with auth + sig-verify + IP-based rate limiting.
 */
export interface ChallengeMintStore {
  /** Issue a fresh 32-byte challenge. Returns null on size-cap overflow. */
  issueChallenge(opts: { now: number }): IssueChallengeResult;
  /**
   * Mark a challenge as redeemed. Returns ok=true on success; ok=false
   * with reason on any failure (not-found / expired / already-redeemed).
   * Removes the entry from the map on success (single-use semantics).
   */
  redeemChallenge(challenge: string, opts: { now: number }): RedeemChallengeResult;
  /**
   * Sweep expired entries from the map. Returns the count of entries
   * removed. Callers wire this around `setInterval` at the configured
   * sweep period (default 1000ms).
   */
  sweepExpired(opts: { now: number }): number;
  /** Current size of the pending-challenges map (for telemetry). */
  size(): number;
}

interface ChallengeEntry {
  expiresAt: number;
  issuedAt: number;
}

/** Factory for the challenge-mint store. */
export function createChallengeMintStore(options: ChallengeMintStoreOptions): ChallengeMintStore {
  // Pending challenges: issued + not yet redeemed + not yet expired.
  const map = new Map<string, ChallengeEntry>();
  // Recently-redeemed challenges: kept for ttlMs so the wire reason
  // distinguishes `already-redeemed` from `not-found` on replay
  // attempts. Without this, replay attacks would surface as the same
  // wire reason as fabricated-challenge attempts — operationally
  // equivalent reject but loses telemetry signal.
  const redeemed = new Map<string, { redeemedAt: number; expiresAt: number }>();
  const sizeCap = options.sizeCap ?? 10_000;
  const ttlMs = options.ttlMs;

  return {
    issueChallenge({ now }) {
      // Size cap counts pending + recently-redeemed: both consume slots
      // in the bounded memory budget.
      if (map.size + redeemed.size >= sizeCap) {
        return { ok: false, reason: "store-full" };
      }
      const challenge = bytesToBase64(new Uint8Array(randomBytes(32)));
      map.set(challenge, { expiresAt: now + ttlMs, issuedAt: now });
      return { ok: true, challenge, expiresAt: now + ttlMs };
    },

    redeemChallenge(challenge, { now }) {
      // Check recently-redeemed first — replay attempt should get the
      // distinctive `already-redeemed` reason for telemetry.
      const redeemedEntry = redeemed.get(challenge);
      if (redeemedEntry !== undefined) {
        if (now >= redeemedEntry.expiresAt) {
          // Recently-redeemed entry aged out; treat as not-found.
          redeemed.delete(challenge);
          return { ok: false, reason: "not-found" };
        }
        return { ok: false, reason: "already-redeemed" };
      }
      const entry = map.get(challenge);
      if (entry === undefined) {
        return { ok: false, reason: "not-found" };
      }
      if (now >= entry.expiresAt) {
        // Expired entries are still in the map until sweep runs; treat
        // as expired (not already-redeemed) since the latter implies
        // a successful prior redeem (security-relevant distinction).
        map.delete(challenge);
        return { ok: false, reason: "expired" };
      }
      // Single-use: remove from pending; track in recently-redeemed
      // until ttlMs has elapsed since redeem, so replay attempts get
      // the `already-redeemed` wire reason.
      map.delete(challenge);
      redeemed.set(challenge, { redeemedAt: now, expiresAt: now + ttlMs });
      return { ok: true };
    },

    sweepExpired({ now }) {
      let removed = 0;
      for (const [challenge, entry] of map.entries()) {
        if (now >= entry.expiresAt) {
          map.delete(challenge);
          removed++;
        }
      }
      for (const [challenge, entry] of redeemed.entries()) {
        if (now >= entry.expiresAt) {
          redeemed.delete(challenge);
          removed++;
        }
      }
      return removed;
    },

    size() {
      // Telemetry size = pending only (recently-redeemed is internal
      // bookkeeping). Operators monitoring "how many pending challenges
      // are in flight" want the pending count, not the replay-detection
      // window.
      return map.size;
    },
  };
}

// ============================================================================
// PER-IP TOKEN-BUCKET RATE LIMITER
// ============================================================================

/**
 * Options for {@link createIpRateLimiter}.
 *
 * @internal AJS-55 implementation surface.
 */
export interface IpRateLimiterOptions {
  /** Refill rate in tokens per minute. Default: 30. */
  ratePerMinute: number;
  /** Maximum burst (initial bucket size). Default: 10. */
  burst: number;
}

/** Result of {@link IpRateLimiter.check}. */
export type RateLimitCheckResult =
  | { ok: true; remainingTokens: number }
  | { ok: false; reason: "rate-limited"; retryAfterMs: number };

/**
 * Per-IP token-bucket rate limiter. Pure logic; callers wire wall-clock
 * `now` at check time.
 *
 * @internal AJS-55 implementation surface; gateway HTTP handler wraps
 *           this around the unauthenticated `/api/agents/mint/challenge`
 *           endpoint to bound the unauth-flood attack surface.
 */
export interface IpRateLimiter {
  /**
   * Consume 1 token for the given IP. Returns ok=true with remaining
   * tokens, or ok=false with `retryAfterMs` (the time until the next
   * token refills).
   */
  check(ip: string, opts: { now: number }): RateLimitCheckResult;
  /** Current bucket count for an IP (for telemetry). Returns burst if unknown. */
  remaining(ip: string, opts: { now: number }): number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/** Factory for the per-IP token-bucket rate limiter. */
export function createIpRateLimiter(options: IpRateLimiterOptions): IpRateLimiter {
  const buckets = new Map<string, Bucket>();
  const ratePerMinute = options.ratePerMinute;
  const burst = options.burst;
  const refillIntervalMs = 60_000 / ratePerMinute; // ms per token

  function refill(bucket: Bucket, now: number): void {
    const elapsedMs = now - bucket.lastRefillMs;
    if (elapsedMs <= 0) return;
    const tokensToAdd = Math.floor(elapsedMs / refillIntervalMs);
    if (tokensToAdd > 0) {
      bucket.tokens = Math.min(burst, bucket.tokens + tokensToAdd);
      bucket.lastRefillMs += tokensToAdd * refillIntervalMs;
    }
  }

  return {
    check(ip, { now }) {
      let bucket = buckets.get(ip);
      if (bucket === undefined) {
        bucket = { tokens: burst, lastRefillMs: now };
        buckets.set(ip, bucket);
      } else {
        refill(bucket, now);
      }
      if (bucket.tokens <= 0) {
        const retryAfterMs = bucket.lastRefillMs + refillIntervalMs - now;
        return {
          ok: false,
          reason: "rate-limited",
          retryAfterMs: Math.max(0, retryAfterMs),
        };
      }
      bucket.tokens -= 1;
      return { ok: true, remainingTokens: bucket.tokens };
    },

    remaining(ip, { now }) {
      const bucket = buckets.get(ip);
      if (bucket === undefined) return burst;
      refill(bucket, now);
      return bucket.tokens;
    },
  };
}
