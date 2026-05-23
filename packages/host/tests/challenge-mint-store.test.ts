/**
 * AJS-55 challenge-mint store + per-IP rate limiter — behavior tests.
 *
 * Tests pin the contract from the folded AJS-55 vault design doc:
 * `agents-js-federation-peer-record-signing-2026-05-22.md` §"Challenge
 * mint flow" §"Pending-challenges Map" + §"Risk model" challenge-flood row.
 *
 * Defaults under test (per cognee-codex contract review §"Still open" Q4-Q5):
 * - Size cap: 10_000 entries (503 challenge-store-full on overflow)
 * - Sweep period: 1 second (expired entries dropped from in-memory map)
 * - Nonce length: 32 bytes (collision-resistant over 60s TTL)
 * - Per-IP rate limit: 30/min token bucket with burst 10 (default;
 *   override via AGENTS_MCP_CHALLENGE_RATE_LIMIT env in the gateway layer)
 */

import { describe, expect, test } from "bun:test";
import { createChallengeMintStore, createIpRateLimiter } from "../src/challenge-mint-store.ts";

describe("packages/host/tests/challenge-mint-store.test.ts — AJS-55 challenge store + rate limiter", () => {
  // ============================================================
  // CHALLENGE STORE — issuance + redeem (vault doc §"Challenge mint flow")
  // ============================================================

  /**
   * WHAT: `issueChallenge()` returns a 32-byte challenge + expiresAt
   *       (now + ttlMs). The challenge is registered as pending in the
   *       in-memory map.
   * WHY: Pin the basic happy path before testing rejection cases.
   *      32-byte nonce length is what cognee-codex approved as
   *      collision-resistant over the 60s TTL.
   */
  test("issueChallenge → 32-byte base64 challenge + future expiresAt", () => {
    const store = createChallengeMintStore({ ttlMs: 60_000 });
    const issued = store.issueChallenge({ now: Date.UTC(2026, 4, 23, 10, 0, 0) });
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("expected ok=true");
    // Base64-encoded 32 bytes = ~44 chars (with =-padding).
    expect(issued.challenge.length).toBeGreaterThanOrEqual(43);
    expect(issued.challenge.length).toBeLessThanOrEqual(44);
    expect(issued.expiresAt).toBe(Date.UTC(2026, 4, 23, 10, 0, 0) + 60_000);
  });

  /**
   * WHAT: `redeemChallenge(challenge)` succeeds on first call, fails
   *       with `already-redeemed` on second call (single-use semantics).
   * WHY: Vault doc §"Challenge mint flow" step 5h: "Mark challenge as
   *      redeemed (single-use)". Replay protection.
   */
  test("redeemChallenge: single-use — second redeem rejected with already-redeemed", () => {
    const store = createChallengeMintStore({ ttlMs: 60_000 });
    const issued = store.issueChallenge({ now: 1000 });
    if (!issued.ok) throw new Error("expected ok=true on issue");

    const first = store.redeemChallenge(issued.challenge, { now: 2000 });
    expect(first.ok).toBe(true);

    const second = store.redeemChallenge(issued.challenge, { now: 2001 });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected second redeem to fail");
    expect(second.reason).toBe("already-redeemed");
  });

  /**
   * WHAT: `redeemChallenge` on an expired challenge → fails with `expired`.
   * WHY: Vault doc §"Challenge mint flow" step 5d: "Check challenge:
   *      present in pending-challenges Map, not expired, not yet redeemed."
   */
  test("redeemChallenge: expired challenge → rejected with 'expired'", () => {
    const store = createChallengeMintStore({ ttlMs: 60_000 });
    const issued = store.issueChallenge({ now: 1000 });
    if (!issued.ok) throw new Error("expected ok=true on issue");

    // Try to redeem after expiry window (1000 + 60_000 = 61_000; now > that).
    const result = store.redeemChallenge(issued.challenge, { now: 70_000 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected redeem to fail on expired");
    expect(result.reason).toBe("expired");
  });

  /**
   * WHAT: `redeemChallenge` on an unknown challenge string → fails with
   *       `not-found`.
   * WHY: Defense against a caller fabricating challenge strings (e.g.
   *      to probe for valid prefixes via timing). All unknown challenges
   *      get the same `not-found` reason regardless of shape.
   */
  test("redeemChallenge: unknown challenge → rejected with 'not-found'", () => {
    const store = createChallengeMintStore({ ttlMs: 60_000 });
    const result = store.redeemChallenge("aGVsbG8td29ybGQtMTIzNDU2Nzg5MGFiY2RlZg==", {
      now: 1000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected redeem to fail on unknown");
    expect(result.reason).toBe("not-found");
  });

  // ============================================================
  // SIZE CAP (vault doc §"Pending-challenges Map" + §"Risk model" flood)
  // ============================================================

  /**
   * WHAT: When the pending-challenges map hits the configured size cap,
   *       `issueChallenge` returns `{ok: false, reason: 'store-full'}`.
   *       Caller (HTTP handler) maps this to 503.
   * WHY: vault doc cap defense against challenge-flood OOM attack.
   *      Default cap is 10_000; tests use 5 for determinism.
   */
  test("issueChallenge: hit size cap → rejected with 'store-full'", () => {
    const store = createChallengeMintStore({ ttlMs: 60_000, sizeCap: 5 });
    for (let i = 0; i < 5; i++) {
      const issued = store.issueChallenge({ now: 1000 + i });
      expect(issued.ok).toBe(true);
    }
    // 6th issuance over cap → reject.
    const overCap = store.issueChallenge({ now: 1006 });
    expect(overCap.ok).toBe(false);
    if (overCap.ok) throw new Error("expected over-cap issue to fail");
    expect(overCap.reason).toBe("store-full");
  });

  /**
   * WHAT: After `sweepExpired()` runs, expired entries are removed from
   *       the map; size-cap counter decrements accordingly. New issuances
   *       can then succeed.
   * WHY: The 1-second sweep timer reclaims expired slots. Without sweep,
   *      a steady churn of issued-but-never-redeemed challenges would
   *      eventually exhaust the cap even when entries are long-expired.
   */
  test("sweepExpired: removes expired entries; cap-counter reclaims slots", () => {
    const store = createChallengeMintStore({ ttlMs: 60_000, sizeCap: 3 });
    // Issue 3 challenges at t=1000 (expire at 61_000).
    store.issueChallenge({ now: 1000 });
    store.issueChallenge({ now: 1001 });
    store.issueChallenge({ now: 1002 });
    // Cap reached.
    const blocked = store.issueChallenge({ now: 1003 });
    expect(blocked.ok).toBe(false);

    // Sweep at t=70_000 (after all 3 expired).
    const sweptCount = store.sweepExpired({ now: 70_000 });
    expect(sweptCount).toBe(3);

    // Cap slots reclaimed; new issuance succeeds.
    const issued = store.issueChallenge({ now: 70_001 });
    expect(issued.ok).toBe(true);
  });

  // ============================================================
  // PER-IP TOKEN-BUCKET RATE LIMITER (vault doc §"Risk model" flood)
  // ============================================================

  /**
   * WHAT: A fresh per-IP bucket starts with `burst` tokens. Each request
   *       consumes 1 token. After `burst` requests in quick succession,
   *       the next request gets `{ok: false, reason: 'rate-limited'}`.
   * WHY: Burst capacity allows short legitimate spikes (e.g. a peer's
   *      first connection mints + immediately redeems) without rejecting.
   */
  test("rate limiter: burst capacity exhausts on Nth request", () => {
    const rl = createIpRateLimiter({ ratePerMinute: 30, burst: 3 });
    const ip = "192.0.2.1";
    expect(rl.check(ip, { now: 1000 }).ok).toBe(true);
    expect(rl.check(ip, { now: 1001 }).ok).toBe(true);
    expect(rl.check(ip, { now: 1002 }).ok).toBe(true);
    const fourth = rl.check(ip, { now: 1003 });
    expect(fourth.ok).toBe(false);
    if (fourth.ok) throw new Error("expected 4th to be rate-limited");
    expect(fourth.reason).toBe("rate-limited");
  });

  /**
   * WHAT: Tokens refill at `ratePerMinute` over time. After enough time
   *       passes, a previously-exhausted bucket can accept again.
   * WHY: Token-bucket refill semantics. ratePerMinute=30 = 1 token per
   *       2 seconds (1 token per 2000ms). After 2000ms with cap-1
   *       remaining, +1 token = 1 available.
   */
  test("rate limiter: tokens refill over time at ratePerMinute", () => {
    const rl = createIpRateLimiter({ ratePerMinute: 30, burst: 1 });
    const ip = "192.0.2.2";
    expect(rl.check(ip, { now: 0 }).ok).toBe(true);
    // Bucket exhausted immediately after 1 request.
    expect(rl.check(ip, { now: 100 }).ok).toBe(false);

    // After 2 seconds (one refill at 30/min = 1 per 2000ms), allowed again.
    expect(rl.check(ip, { now: 2100 }).ok).toBe(true);
  });

  /**
   * WHAT: Different source IPs have independent buckets. Exhausting
   *       IP A doesn't affect IP B.
   * WHY: Per-source isolation defense. Without independent buckets,
   *      one noisy client would DoS legitimate traffic from other IPs.
   */
  test("rate limiter: per-IP isolation — exhausting IP A doesn't affect IP B", () => {
    const rl = createIpRateLimiter({ ratePerMinute: 30, burst: 2 });
    const ipA = "192.0.2.10";
    const ipB = "192.0.2.20";
    rl.check(ipA, { now: 0 });
    rl.check(ipA, { now: 1 });
    expect(rl.check(ipA, { now: 2 }).ok).toBe(false); // ipA exhausted

    // ipB is independent; still has full burst.
    expect(rl.check(ipB, { now: 3 }).ok).toBe(true);
    expect(rl.check(ipB, { now: 4 }).ok).toBe(true);
    expect(rl.check(ipB, { now: 5 }).ok).toBe(false); // ipB now exhausted, but ipA is still
  });
});
