/**
 * Gateway-side dispatcher tests for the in-session-push shape (AJS-96).
 *
 * Covers:
 *   - happy path: unexpired signal → sink called + audit fires `dispatched`
 *   - expiry guard: expired signal → no sink call + audit fires `expired_on_dispatch`
 *   - sink error: propagates to caller (gateway), no audit shadow
 *   - audit hook error: swallowed, dispatch outcome unaffected
 *   - method override: custom method appears in the notification frame
 *   - serialization round-trip: dispatched notification parses back to equal adapter
 *   - correlationId: present iff input had it (optional-field preservation)
 */

import { describe, expect, test } from "bun:test";
import {
  type InSessionPushWakeAdapter,
  makeWakeIdempotencyKey,
  makeWakeSignalId,
} from "@agents-js/wake-types";
import {
  createInSessionPushDispatcher,
  DEFAULT_WAKE_NOTIFICATION_METHOD,
  type InSessionPushDispatcherAuditEvent,
  type McpNotification,
  parseInSessionPushNotification,
  serializeInSessionPushAdapter,
} from "../src/index.ts";

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

describe("createInSessionPushDispatcher", () => {
  test("happy path: unexpired signal calls sink + audits dispatched", async () => {
    const calls: McpNotification[] = [];
    const audited: InSessionPushDispatcherAuditEvent[] = [];
    const dispatcher = createInSessionPushDispatcher({
      notificationSink: async (n) => {
        calls.push(n);
      },
      now: () => 5_000, // before expiresAtMs=10_000
      audit: (e) => audited.push(e),
    });

    const outcome = await dispatcher.dispatch(makeAdapter());

    expect(outcome).toEqual({ status: "dispatched" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(DEFAULT_WAKE_NOTIFICATION_METHOD);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.kind).toBe("dispatched");
  });

  test("expiry guard: expired signal skips sink + audits expired_on_dispatch", async () => {
    const calls: McpNotification[] = [];
    const audited: InSessionPushDispatcherAuditEvent[] = [];
    const dispatcher = createInSessionPushDispatcher({
      notificationSink: async (n) => {
        calls.push(n);
      },
      now: () => 20_000, // past expiresAtMs=10_000
      audit: (e) => audited.push(e),
    });

    const outcome = await dispatcher.dispatch(makeAdapter());

    expect(outcome.status).toBe("expired_on_dispatch");
    expect(calls).toHaveLength(0);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.kind).toBe("expired_on_dispatch");
  });

  test("boundary: nowMs === expiresAtMs counts as expired (>= semantics)", async () => {
    const dispatcher = createInSessionPushDispatcher({
      notificationSink: async () => {},
      now: () => 10_000, // exactly at expiresAtMs
    });
    const outcome = await dispatcher.dispatch(makeAdapter());
    expect(outcome.status).toBe("expired_on_dispatch");
  });

  test("sink error propagates; no audit shadows the real failure", async () => {
    const audited: InSessionPushDispatcherAuditEvent[] = [];
    const dispatcher = createInSessionPushDispatcher({
      notificationSink: async () => {
        throw new Error("sink boom");
      },
      now: () => 5_000,
      audit: (e) => audited.push(e),
    });

    await expect(dispatcher.dispatch(makeAdapter())).rejects.toThrow("sink boom");
    // Audit MUST NOT fire `dispatched` for a failed wire emission.
    expect(audited).toHaveLength(0);
  });

  test("audit hook error is swallowed; outcome still dispatched", async () => {
    let sinkCalled = false;
    const dispatcher = createInSessionPushDispatcher({
      notificationSink: async () => {
        sinkCalled = true;
      },
      now: () => 5_000,
      audit: () => {
        throw new Error("audit boom");
      },
    });

    const outcome = await dispatcher.dispatch(makeAdapter());
    expect(outcome).toEqual({ status: "dispatched" });
    expect(sinkCalled).toBe(true);
  });

  test("method override appears in the wire frame", async () => {
    let captured: McpNotification | undefined;
    const dispatcher = createInSessionPushDispatcher({
      notificationSink: async (n) => {
        captured = n;
      },
      now: () => 5_000,
      method: "notifications/custom",
    });

    await dispatcher.dispatch(makeAdapter());
    expect(captured?.method).toBe("notifications/custom");
  });
});

describe("serialize/parse round-trip", () => {
  test("required fields round-trip equal", () => {
    const adapter = makeAdapter();
    const notification = serializeInSessionPushAdapter(adapter);
    const parsed = parseInSessionPushNotification(notification);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.adapter.shape).toBe("in-session-push");
      expect(parsed.adapter.signalId).toBe(adapter.signalId);
      expect(parsed.adapter.target).toEqual(adapter.target);
      expect(parsed.adapter.expiresAtMs).toBe(adapter.expiresAtMs);
      expect(parsed.adapter.idempotencyKey).toBe(adapter.idempotencyKey);
      expect(parsed.adapter.payload).toEqual(adapter.payload);
    }
  });

  test("correlationId preserved when present", () => {
    const adapter = makeAdapter({ correlationId: "corr-xyz" });
    const parsed = parseInSessionPushNotification(serializeInSessionPushAdapter(adapter));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.adapter.correlationId).toBe("corr-xyz");
    }
  });

  test("correlationId omitted when absent (not undefined-stamped)", () => {
    const adapter = makeAdapter();
    const parsed = parseInSessionPushNotification(serializeInSessionPushAdapter(adapter));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect("correlationId" in parsed.adapter).toBe(false);
    }
  });

  test("wrong method rejected", () => {
    const adapter = makeAdapter();
    const notification = serializeInSessionPushAdapter(adapter, "notifications/other");
    const parsed = parseInSessionPushNotification(notification); // default method
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("wrong_method");
  });

  test("missing shape rejected", () => {
    const parsed = parseInSessionPushNotification({
      method: DEFAULT_WAKE_NOTIFICATION_METHOD,
      params: { signalId: "x", target: {}, expiresAtMs: 1, idempotencyKey: "k", payload: {} },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("missing_shape");
  });

  test("wrong shape rejected", () => {
    const parsed = parseInSessionPushNotification({
      method: DEFAULT_WAKE_NOTIFICATION_METHOD,
      params: {
        shape: "spawn-with-signal",
        signalId: "x",
        target: {},
        expiresAtMs: 1,
        idempotencyKey: "k",
        payload: {},
      },
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("wrong_shape");
  });
});
