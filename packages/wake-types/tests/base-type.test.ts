import { describe, expect, it } from "bun:test";
import {
  type InSessionPushWakeAdapter,
  isKnownWakeAdapterShape,
  isWakeSignalExpired,
  KNOWN_WAKE_ADAPTER_SHAPES,
  makeWakeIdempotencyKey,
  makeWakeSignalId,
  type SpawnWithSignalWakeAdapter,
  type TranslatorInjectWakeAdapter,
  type WakeAdapter,
  type WakeAdapterShape,
} from "../src/index.ts";

describe("KNOWN_WAKE_ADAPTER_SHAPES", () => {
  it("contains exactly the three SHAPES axis members", () => {
    expect([...KNOWN_WAKE_ADAPTER_SHAPES].sort()).toEqual([
      "in-session-push",
      "spawn-with-signal",
      "translator-inject",
    ]);
  });

  it("is a readonly set (mutation rejected at type level)", () => {
    // Type-only check: ReadonlySet has no add/delete methods on its type.
    // We can still test that the surface is what we expect by counting members.
    expect(KNOWN_WAKE_ADAPTER_SHAPES.size).toBe(3);
  });
});

describe("isKnownWakeAdapterShape", () => {
  it("narrows known shape strings", () => {
    expect(isKnownWakeAdapterShape("in-session-push")).toBe(true);
    expect(isKnownWakeAdapterShape("translator-inject")).toBe(true);
    expect(isKnownWakeAdapterShape("spawn-with-signal")).toBe(true);
  });

  it("rejects unknown strings", () => {
    expect(isKnownWakeAdapterShape("polling")).toBe(false);
    expect(isKnownWakeAdapterShape("app-server-mediated")).toBe(false);
    expect(isKnownWakeAdapterShape("")).toBe(false);
    expect(isKnownWakeAdapterShape("IN-SESSION-PUSH")).toBe(false);
  });

  it("acts as a type guard", () => {
    const raw: string = "in-session-push";
    if (isKnownWakeAdapterShape(raw)) {
      const narrowed: WakeAdapterShape = raw;
      expect(narrowed).toBe("in-session-push");
    } else {
      throw new Error("expected narrowing to succeed");
    }
  });
});

describe("WakeAdapter discriminated union", () => {
  it("forces exhaustive switch via assertNever", () => {
    function handle(adapter: WakeAdapter): string {
      switch (adapter.shape) {
        case "in-session-push":
          return `mcp:${JSON.stringify(adapter.payload)}`;
        case "translator-inject":
          return `inject:${adapter.injectedText}`;
        case "spawn-with-signal":
          return `spawn:${adapter.initialPrompt}`;
        default: {
          const _exhaustive: never = adapter;
          throw new Error(`unreachable wake-adapter shape: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }

    const inSessionPush: InSessionPushWakeAdapter = {
      shape: "in-session-push",
      signalId: makeWakeSignalId("sig-1"),
      target: { kind: "session", sessionId: "sess-1" },
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: makeWakeIdempotencyKey("idem-1"),
      payload: { foo: "bar" },
    };
    const translatorInject: TranslatorInjectWakeAdapter = {
      shape: "translator-inject",
      signalId: makeWakeSignalId("sig-2"),
      target: { kind: "agent", agentName: "pi" },
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: makeWakeIdempotencyKey("idem-2"),
      injectedText: "wake up",
      sourceTag: "test",
    };
    const spawnWithSignal: SpawnWithSignalWakeAdapter = {
      shape: "spawn-with-signal",
      signalId: makeWakeSignalId("sig-3"),
      target: { kind: "agent", agentName: "droid" },
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: makeWakeIdempotencyKey("idem-3"),
      initialPrompt: "begin",
    };

    expect(handle(inSessionPush)).toContain("mcp:");
    expect(handle(translatorInject)).toBe("inject:wake up");
    expect(handle(spawnWithSignal)).toBe("spawn:begin");
  });

  it("forces common metadata on every shape", () => {
    const t1: WakeAdapter = {
      shape: "translator-inject",
      signalId: makeWakeSignalId("sig-2"),
      target: { kind: "agent", agentName: "pi" },
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: makeWakeIdempotencyKey("idem-2"),
      injectedText: "wake",
    };
    expect(t1.signalId).toBeDefined();
    expect(t1.target).toBeDefined();
    expect(t1.expiresAtMs).toBeGreaterThan(0);
    expect(t1.idempotencyKey).toBeDefined();
  });
});

describe("WakeTarget union", () => {
  it("supports session-scoped targets", () => {
    const adapter: WakeAdapter = {
      shape: "in-session-push",
      signalId: makeWakeSignalId("sig-1"),
      target: { kind: "session", sessionId: "abc" },
      expiresAtMs: Date.now() + 1000,
      idempotencyKey: makeWakeIdempotencyKey("idem-1"),
      payload: {},
    };
    if (adapter.target.kind === "session") {
      expect(adapter.target.sessionId).toBe("abc");
    } else {
      throw new Error("expected session-scoped target");
    }
  });

  it("supports agent-scoped targets", () => {
    const adapter: WakeAdapter = {
      shape: "in-session-push",
      signalId: makeWakeSignalId("sig-1"),
      target: { kind: "agent", agentName: "claude" },
      expiresAtMs: Date.now() + 1000,
      idempotencyKey: makeWakeIdempotencyKey("idem-1"),
      payload: {},
    };
    if (adapter.target.kind === "agent") {
      expect(adapter.target.agentName).toBe("claude");
    } else {
      throw new Error("expected agent-scoped target");
    }
  });
});

describe("isWakeSignalExpired", () => {
  it("returns true when current time is past expiresAtMs", () => {
    const past = { expiresAtMs: 100 };
    expect(isWakeSignalExpired(past, () => 200)).toBe(true);
  });

  it("returns false when current time is before expiresAtMs", () => {
    const future = { expiresAtMs: 200 };
    expect(isWakeSignalExpired(future, () => 100)).toBe(false);
  });

  it("returns true at exact expiry boundary (>=)", () => {
    const exact = { expiresAtMs: 100 };
    expect(isWakeSignalExpired(exact, () => 100)).toBe(true);
  });

  it("defaults to Date.now() when no clock injected", () => {
    const future = { expiresAtMs: Date.now() + 60_000 };
    expect(isWakeSignalExpired(future)).toBe(false);
    const past = { expiresAtMs: Date.now() - 1 };
    expect(isWakeSignalExpired(past)).toBe(true);
  });
});

describe("branded constructors", () => {
  it("makeWakeSignalId erases brand at runtime", () => {
    const id = makeWakeSignalId("01ABCDEF");
    expect(typeof id).toBe("string");
    expect(id).toBe("01ABCDEF" as ReturnType<typeof makeWakeSignalId>);
  });

  it("makeWakeIdempotencyKey erases brand at runtime", () => {
    const key = makeWakeIdempotencyKey("idem-001");
    expect(typeof key).toBe("string");
    expect(key).toBe("idem-001" as ReturnType<typeof makeWakeIdempotencyKey>);
  });
});
