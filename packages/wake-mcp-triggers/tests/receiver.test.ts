/**
 * Harness-side receiver tests for the in-session-push shape (AJS-96).
 *
 * Covers:
 *   - happy path: unexpired + first-seen → accepted + dedup cache written
 *   - duplicate: same idempotency key → suppressed + audit fires duplicate_suppressed
 *   - expired-on-receipt: signal whose expiresAtMs already passed at receive time
 *   - dropExpiredEntries: prunes only entries with expiresAtMs <= now
 *   - audit ordering: every accept produces exactly one audit event
 *   - audit error swallowed
 */

import { describe, expect, test } from "bun:test";
import {
  type InSessionPushWakeAdapter,
  makeWakeIdempotencyKey,
  makeWakeSignalId,
  type WakeIdempotencyKey,
} from "@agents-js/wake-types";
import { createInSessionPushReceiver, type InSessionPushReceiverAuditEvent } from "../src/index.ts";

function makeAdapter(overrides: Partial<InSessionPushWakeAdapter> = {}): InSessionPushWakeAdapter {
  return {
    shape: "in-session-push",
    signalId: makeWakeSignalId("sig-1"),
    target: { kind: "session", sessionId: "sess-1" },
    expiresAtMs: 10_000,
    idempotencyKey: makeWakeIdempotencyKey("idem-1"),
    payload: { hello: "world" },
    ...overrides,
  };
}

describe("createInSessionPushReceiver", () => {
  test("happy path: unexpired + first-seen → accepted + cache written", () => {
    const dedupCache = new Map<WakeIdempotencyKey, number>();
    const audited: InSessionPushReceiverAuditEvent[] = [];
    const receiver = createInSessionPushReceiver({
      now: () => 5_000,
      dedupCache,
      audit: (e) => audited.push(e),
    });

    const outcome = receiver.accept(makeAdapter());
    expect(outcome).toEqual({ status: "accepted" });
    expect(dedupCache.get(makeWakeIdempotencyKey("idem-1"))).toBe(10_000);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.kind).toBe("accepted");
  });

  test("duplicate idempotency key suppresses second accept", () => {
    const dedupCache = new Map<WakeIdempotencyKey, number>();
    const audited: InSessionPushReceiverAuditEvent[] = [];
    const receiver = createInSessionPushReceiver({
      now: () => 5_000,
      dedupCache,
      audit: (e) => audited.push(e),
    });

    receiver.accept(makeAdapter()); // first
    const second = receiver.accept(makeAdapter()); // duplicate

    expect(second.status).toBe("duplicate_suppressed");
    expect(audited.map((e) => e.kind)).toEqual(["accepted", "duplicate_suppressed"]);
  });

  test("expired-on-receipt: signal arrived past its expiresAtMs", () => {
    const dedupCache = new Map<WakeIdempotencyKey, number>();
    const audited: InSessionPushReceiverAuditEvent[] = [];
    const receiver = createInSessionPushReceiver({
      now: () => 20_000, // past expiresAtMs=10_000
      dedupCache,
      audit: (e) => audited.push(e),
    });

    const outcome = receiver.accept(makeAdapter());
    expect(outcome.status).toBe("expired_on_receipt");
    // Expired signal MUST NOT be written to dedup cache — otherwise a
    // legitimate re-emit at a later time (with extended TTL) would be
    // wrongly suppressed.
    expect(dedupCache.size).toBe(0);
    expect(audited[0]?.kind).toBe("expired_on_receipt");
  });

  test("boundary: nowMs === expiresAtMs counts as expired (>= semantics)", () => {
    const receiver = createInSessionPushReceiver({
      now: () => 10_000,
      dedupCache: new Map(),
    });
    expect(receiver.accept(makeAdapter()).status).toBe("expired_on_receipt");
  });

  test("dropExpiredEntries prunes only entries with expiresAtMs <= now", () => {
    const dedupCache = new Map<WakeIdempotencyKey, number>([
      [makeWakeIdempotencyKey("a"), 5_000],
      [makeWakeIdempotencyKey("b"), 15_000],
      [makeWakeIdempotencyKey("c"), 25_000],
    ]);
    const receiver = createInSessionPushReceiver({
      now: () => 15_000,
      dedupCache,
    });

    const removed = receiver.dropExpiredEntries();
    expect(removed).toBe(2); // a (5_000) and b (15_000 — boundary <=)
    expect(dedupCache.has(makeWakeIdempotencyKey("c"))).toBe(true);
    expect(dedupCache.size).toBe(1);
  });

  test("audit hook error is swallowed; outcome unaffected", () => {
    const dedupCache = new Map<WakeIdempotencyKey, number>();
    const receiver = createInSessionPushReceiver({
      now: () => 5_000,
      dedupCache,
      audit: () => {
        throw new Error("audit boom");
      },
    });
    const outcome = receiver.accept(makeAdapter());
    expect(outcome).toEqual({ status: "accepted" });
    expect(dedupCache.size).toBe(1);
  });

  test("different idempotency keys both accepted", () => {
    const dedupCache = new Map<WakeIdempotencyKey, number>();
    const receiver = createInSessionPushReceiver({
      now: () => 5_000,
      dedupCache,
    });

    const first = receiver.accept(
      makeAdapter({ idempotencyKey: makeWakeIdempotencyKey("idem-A") }),
    );
    const second = receiver.accept(
      makeAdapter({ idempotencyKey: makeWakeIdempotencyKey("idem-B") }),
    );

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(dedupCache.size).toBe(2);
  });
});
