/**
 * Tests for `@agents-js/wake-channel-bridge`.
 *
 * Coverage:
 *  - Empty pending → empty attempts list
 *  - Single-emit round-trip → emitted-and-marked, store reflects delivered
 *  - Repeat drain → emitted-but-dedup (store already marked)
 *  - Sender-gate rejection → not marked, signal stays pending for retry
 *  - Sanitizer rejection → same (not marked)
 *  - Multi-signal ordering preserved (createdAtMs ascending)
 *  - dispatchOne on absent signal → transport-error
 *  - dispatchOne on already-delivered → emitted-but-dedup
 */

import { describe, expect, test } from "bun:test";

import type { ClaudeChannelServer } from "@agents-js/claude-channel-adapter";
import {
  createWakeSignalStore,
  InMemoryWakeSignalStoreBackend,
  type WakeSignalRecord,
  type WakeSignalStore,
} from "@agents-js/wake-signal-store";
import type {
  InSessionPushWakeAdapter,
  WakeIdempotencyKey,
  WakeSignalId,
  WakeTarget,
} from "@agents-js/wake-types";

import { createWakeChannelBridge } from "../src/index.ts";

// ----------------------------------------------------------------------------
// Test fixtures
// ----------------------------------------------------------------------------

const TARGET_X: WakeTarget = { kind: "session", sessionId: "session-x" };
const TARGET_Y: WakeTarget = { kind: "session", sessionId: "session-y" };

function makeSignal(
  signalId: string,
  options: { createdAtMs?: number; sender?: string } = {},
): WakeSignalRecord {
  const sid = signalId as WakeSignalId;
  const adapter: InSessionPushWakeAdapter = {
    shape: "in-session-push",
    signalId: sid,
    target: TARGET_X,
    expiresAtMs: Date.now() + 60_000,
    idempotencyKey: `idem-${signalId}` as WakeIdempotencyKey,
    payload: { sender: options.sender ?? "matrix-bot", text: "hello" },
  };
  return {
    signalId: sid,
    idempotencyKey: `idem-${signalId}` as WakeIdempotencyKey,
    target: TARGET_X,
    adapter,
    createdAtMs: options.createdAtMs ?? Date.now(),
    expiresAtMs: Date.now() + 60_000,
  };
}

/**
 * Build a fake ClaudeChannelServer with the supplied sender allowlist.
 * The bridge tests focus on composition + delivery-marking semantics, not
 * the real adapter's MCP transport. This fake replays sender-gate logic
 * inline so we can drive the bridge through all emit-result branches
 * without spawning a real MCP server.
 */
function buildServerWithAllowlist(allowed: readonly string[]): {
  server: ClaudeChannelServer;
  emits: Array<{ content: string; sender: string; meta?: unknown }>;
} {
  const emits: Array<{ content: string; sender: string; meta?: unknown }> = [];
  const allowedSet = new Set(allowed);
  const server: ClaudeChannelServer = {
    async connect() {
      // no-op for fake
    },
    async emitChannelMessage(input) {
      emits.push(input);
      if (!allowedSet.has(input.sender)) {
        return { status: "rejected-by-sender-gate", sender: input.sender };
      }
      return { status: "emitted" };
    },
    async close() {
      // no-op for fake
    },
  };
  return { server, emits };
}

function makeStore(): WakeSignalStore {
  return createWakeSignalStore({
    backend: new InMemoryWakeSignalStoreBackend(),
  });
}

/**
 * Read the `payload` map off an `in-session-push` adapter. The bridge's
 * test fixtures only ever build that shape; for any other shape we return
 * an empty record so the resolvers degrade to their default values.
 */
function adapterPayload(record: WakeSignalRecord): Record<string, unknown> {
  const { adapter } = record;
  return adapter.shape === "in-session-push" ? adapter.payload : {};
}

const RESOLVERS_BASIC = {
  sender: (record: WakeSignalRecord): string => {
    const payload = adapterPayload(record) as { sender?: string };
    return payload.sender ?? "unknown";
  },
  content: (record: WakeSignalRecord): string => JSON.stringify(adapterPayload(record)),
};

// ----------------------------------------------------------------------------
// Empty + single-signal cases
// ----------------------------------------------------------------------------

describe("drainPending — basic round-trip", () => {
  test("empty pending → empty attempts", async () => {
    const store = makeStore();
    const { server } = buildServerWithAllowlist(["matrix-bot"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });
    const result = await bridge.drainPending(TARGET_X);
    expect(result.attempts.length).toBe(0);
    expect(result.target).toEqual(TARGET_X);
  });

  test("single allowed signal → emitted-and-marked + store reflects delivered", async () => {
    const store = makeStore();
    const { server, emits } = buildServerWithAllowlist(["matrix-bot"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });
    const signal = makeSignal("sig-a");
    await store.put(signal);

    const result = await bridge.drainPending(TARGET_X);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]?.outcome).toBe("emitted-and-marked");
    expect(emits.length).toBe(1);
    expect(emits[0]?.sender).toBe("matrix-bot");

    // Store should now reflect the delivery.
    const fetched = await store.get(signal.signalId);
    expect(fetched?.deliveredAtMs).toBeDefined();
  });
});

// ----------------------------------------------------------------------------
// Dedup on repeat drain
// ----------------------------------------------------------------------------

describe("drainPending — at-least-once dedup", () => {
  test("repeat drain after successful emit → empty (delivered signals not pulled)", async () => {
    const store = makeStore();
    const { server } = buildServerWithAllowlist(["matrix-bot"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });
    await store.put(makeSignal("sig-a"));

    const first = await bridge.drainPending(TARGET_X);
    expect(first.attempts[0]?.outcome).toBe("emitted-and-marked");

    const second = await bridge.drainPending(TARGET_X);
    expect(second.attempts.length).toBe(0); // store.pullPending excludes delivered
  });
});

// ----------------------------------------------------------------------------
// Gate rejection
// ----------------------------------------------------------------------------

describe("drainPending — sender-gate rejection", () => {
  test("disallowed sender → rejected-by-sender-gate, NOT marked delivered", async () => {
    const store = makeStore();
    const { server, emits } = buildServerWithAllowlist(["other-agent"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });
    const signal = makeSignal("sig-a", { sender: "untrusted-agent" });
    await store.put(signal);

    const result = await bridge.drainPending(TARGET_X);
    expect(result.attempts.length).toBe(1);
    const attempt = result.attempts[0];
    if (attempt === undefined) throw new Error("expected one attempt");
    expect(attempt.outcome).toBe("rejected-by-sender-gate");
    if (attempt.outcome === "rejected-by-sender-gate") {
      expect(attempt.sender).toBe("untrusted-agent");
    }

    // Signal NOT marked delivered — stays available for retry under
    // future policy revision.
    const fetched = await store.get(signal.signalId);
    expect(fetched?.deliveredAtMs).toBeUndefined();

    // emit was attempted (to surface the rejection) but no successful frame
    expect(emits.length).toBe(1);
  });

  test("repeat drain on gate-rejected signal → still pending, still rejected", async () => {
    const store = makeStore();
    const { server } = buildServerWithAllowlist(["other-agent"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });
    await store.put(makeSignal("sig-a", { sender: "untrusted-agent" }));

    const first = await bridge.drainPending(TARGET_X);
    expect(first.attempts[0]?.outcome).toBe("rejected-by-sender-gate");

    const second = await bridge.drainPending(TARGET_X);
    // Still pending — still attempted, still rejected
    expect(second.attempts.length).toBe(1);
    expect(second.attempts[0]?.outcome).toBe("rejected-by-sender-gate");
  });
});

// ----------------------------------------------------------------------------
// Multi-signal ordering
// ----------------------------------------------------------------------------

describe("drainPending — multi-signal store ordering", () => {
  test("attempts preserve createdAtMs ascending order", async () => {
    const store = makeStore();
    const { server } = buildServerWithAllowlist(["matrix-bot"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });

    // Insert out-of-order; store sorts by createdAtMs
    await store.put(makeSignal("sig-c", { createdAtMs: 3_000 }));
    await store.put(makeSignal("sig-a", { createdAtMs: 1_000 }));
    await store.put(makeSignal("sig-b", { createdAtMs: 2_000 }));

    const result = await bridge.drainPending(TARGET_X);
    const ids = result.attempts.map((a) => a.signalId);
    expect(ids).toEqual([
      "sig-a" as WakeSignalId,
      "sig-b" as WakeSignalId,
      "sig-c" as WakeSignalId,
    ]);
  });
});

// ----------------------------------------------------------------------------
// dispatchOne
// ----------------------------------------------------------------------------

describe("dispatchOne", () => {
  test("absent signal → transport-error", async () => {
    const store = makeStore();
    const { server } = buildServerWithAllowlist(["matrix-bot"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });
    const result = await bridge.dispatchOne("does-not-exist" as WakeSignalId);
    expect(result.outcome).toBe("transport-error");
  });

  test("already-delivered → emitted-but-dedup (without re-emitting)", async () => {
    const store = makeStore();
    const { server, emits } = buildServerWithAllowlist(["matrix-bot"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });
    const signal = makeSignal("sig-a");
    await store.put(signal);

    await bridge.dispatchOne(signal.signalId); // first call → emits + marks
    const emitsAfterFirst = emits.length;

    const second = await bridge.dispatchOne(signal.signalId); // dedup path
    expect(second.outcome).toBe("emitted-but-dedup");
    expect(emits.length).toBe(emitsAfterFirst); // no additional emit
  });

  test("eligible signal → emitted-and-marked", async () => {
    const store = makeStore();
    const { server } = buildServerWithAllowlist(["matrix-bot"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });
    const signal = makeSignal("sig-a");
    await store.put(signal);

    const result = await bridge.dispatchOne(signal.signalId);
    expect(result.outcome).toBe("emitted-and-marked");
  });
});

// ----------------------------------------------------------------------------
// Target isolation
// ----------------------------------------------------------------------------

describe("drainPending — target isolation", () => {
  test("signals for target X don't drain when target Y is drained", async () => {
    const store = makeStore();
    const { server } = buildServerWithAllowlist(["matrix-bot"]);
    const bridge = createWakeChannelBridge({
      store,
      server,
      resolvers: RESOLVERS_BASIC,
    });

    await store.put(makeSignal("sig-a")); // TARGET_X
    const result = await bridge.drainPending(TARGET_Y);
    expect(result.attempts.length).toBe(0);

    // sig-a still pending for TARGET_X
    const xResult = await bridge.drainPending(TARGET_X);
    expect(xResult.attempts.length).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// Resolver + markDelivered exception containment (per cognee-codex PR #96 review)
// ----------------------------------------------------------------------------

describe("drainPending — resolver exception containment", () => {
  test("resolver throw on signal A → resolver-error; signal B still drains", async () => {
    const store = makeStore();
    const { server } = buildServerWithAllowlist(["matrix-bot"]);
    const throwResolvers = {
      sender: (record: WakeSignalRecord): string => {
        if (record.signalId === ("sig-a" as WakeSignalId)) {
          throw new Error("resolver synthetic failure");
        }
        const payload = adapterPayload(record) as { sender?: string };
        return payload.sender ?? "unknown";
      },
      content: (record: WakeSignalRecord): string => JSON.stringify(adapterPayload(record)),
    };
    const bridge = createWakeChannelBridge({ store, server, resolvers: throwResolvers });

    await store.put(makeSignal("sig-a", { createdAtMs: 1_000 }));
    await store.put(makeSignal("sig-b", { createdAtMs: 2_000 }));

    const result = await bridge.drainPending(TARGET_X);
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0]?.outcome).toBe("resolver-error");
    expect(result.attempts[1]?.outcome).toBe("emitted-and-marked");

    // resolver-error signal NOT marked delivered
    const a = await store.get("sig-a" as WakeSignalId);
    expect(a?.deliveredAtMs).toBeUndefined();
  });
});

describe("drainPending — markDelivered exception containment", () => {
  test("markDelivered throw after emit → emitted-but-mark-failed; next signal still drains", async () => {
    const { server } = buildServerWithAllowlist(["matrix-bot"]);

    // Build a store wrapper that throws on markDelivered for sig-a but
    // delegates everything else to the real in-memory backend.
    const realBackend = new InMemoryWakeSignalStoreBackend();
    const realStore = createWakeSignalStore({ backend: realBackend });
    const throwingStore: WakeSignalStore = {
      put: (r) => realStore.put(r),
      get: (id) => realStore.get(id),
      pullPending: (t) => realStore.pullPending(t),
      gcExpired: () => realStore.gcExpired(),
      async markDelivered(signalId, idempotencyKey) {
        if (signalId === ("sig-a" as WakeSignalId)) {
          throw new Error("markDelivered synthetic failure");
        }
        return realStore.markDelivered(signalId, idempotencyKey);
      },
    };

    const bridge = createWakeChannelBridge({
      store: throwingStore,
      server,
      resolvers: RESOLVERS_BASIC,
    });

    await throwingStore.put(makeSignal("sig-a", { createdAtMs: 1_000 }));
    await throwingStore.put(makeSignal("sig-b", { createdAtMs: 2_000 }));

    const result = await bridge.drainPending(TARGET_X);
    expect(result.attempts.length).toBe(2);
    expect(result.attempts[0]?.outcome).toBe("emitted-but-mark-failed");
    expect(result.attempts[1]?.outcome).toBe("emitted-and-marked");

    // sig-a NOT marked delivered in the underlying store (the mark threw)
    const a = await realBackend.get("sig-a" as WakeSignalId);
    expect(a?.deliveredAtMs).toBeUndefined();
  });
});
