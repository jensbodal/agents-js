import { describe, expect, test } from "bun:test";
import {
  buildGatewayBusEvent,
  createGatewayBus,
  type GatewayBusEvent,
} from "../src/gateway-bus.ts";

// `createGatewayBus` is the in-process publish/subscribe primitive
// underlying AJS-8. Contract documented in source: fan-out best-effort
// to every subscriber, subscriber errors isolated, no topic filtering
// at the bus layer (filtering happens in subscribers or transport
// adapters).

describe("createGatewayBus", () => {
  test("delivers a published event to a single subscriber", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const event = buildGatewayBusEvent({ type: "test.hello", payload: { value: 1 } });
    bus.publish(event);

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(event.id);
    expect(received[0]?.type).toBe("test.hello");
    expect(received[0]?.payload).toEqual({ value: 1 });
  });

  test("fans out to every attached subscriber", () => {
    const bus = createGatewayBus();
    const a: GatewayBusEvent<unknown>[] = [];
    const b: GatewayBusEvent<unknown>[] = [];
    const c: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => a.push(event));
    bus.subscribe((event) => b.push(event));
    bus.subscribe((event) => c.push(event));

    bus.publish(buildGatewayBusEvent({ type: "test.fanout", payload: null }));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
  });

  test("unsubscribe removes the subscriber", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    bus.publish(buildGatewayBusEvent({ type: "test.first", payload: null }));
    unsubscribe();
    bus.publish(buildGatewayBusEvent({ type: "test.second", payload: null }));

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("test.first");
  });

  test("unsubscribe is idempotent", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    const unsubscribe = bus.subscribe((event) => received.push(event));

    // Calling unsubscribe twice should be safe and should not affect
    // other subscribers added later.
    unsubscribe();
    unsubscribe();

    const other: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => other.push(event));
    bus.publish(buildGatewayBusEvent({ type: "test.after-double-unsub", payload: null }));

    expect(received).toHaveLength(0);
    expect(other).toHaveLength(1);
  });

  test("subscriber count reflects attaches and detaches", () => {
    const bus = createGatewayBus();
    expect(bus.subscriberCount()).toBe(0);

    const u1 = bus.subscribe(() => {});
    const u2 = bus.subscribe(() => {});
    expect(bus.subscriberCount()).toBe(2);

    u1();
    expect(bus.subscriberCount()).toBe(1);
    u2();
    expect(bus.subscriberCount()).toBe(0);
  });

  test("isolates subscriber errors — surviving subscribers still receive the event", () => {
    const captured: Array<{ error: unknown; event: GatewayBusEvent<unknown> }> = [];
    const bus = createGatewayBus({
      onSubscriberError: (error, event) => captured.push({ error, event }),
    });

    const survivor: GatewayBusEvent<unknown>[] = [];
    bus.subscribe(() => {
      throw new Error("subscriber boom");
    });
    bus.subscribe((event) => survivor.push(event));

    const event = buildGatewayBusEvent({ type: "test.isolation", payload: null });
    bus.publish(event);

    expect(survivor).toHaveLength(1);
    expect(survivor[0]?.id).toBe(event.id);
    expect(captured).toHaveLength(1);
    expect((captured[0]?.error as Error).message).toBe("subscriber boom");
    expect(captured[0]?.event.id).toBe(event.id);
  });

  test("subscriber added during publish does not receive that publish", () => {
    // Snapshot semantics: a subscriber that attaches mid-fan-out should
    // see only events published AFTER its attach. The snapshot taken
    // at publish time protects against the late attachment.
    const bus = createGatewayBus();
    const latecomer: GatewayBusEvent<unknown>[] = [];

    bus.subscribe(() => {
      bus.subscribe((event) => latecomer.push(event));
    });

    bus.publish(buildGatewayBusEvent({ type: "test.during", payload: null }));
    expect(latecomer).toHaveLength(0);

    bus.publish(buildGatewayBusEvent({ type: "test.after", payload: null }));
    expect(latecomer).toHaveLength(1);
    expect(latecomer[0]?.type).toBe("test.after");
  });

  test("subscriber unsubscribing during publish does not break the fan-out pass", () => {
    // Snapshot semantics: an unsubscribe during fan-out should not
    // perturb other subscribers in the current pass — they still
    // receive the event being delivered.
    const bus = createGatewayBus();
    const after: GatewayBusEvent<unknown>[] = [];

    const u1 = bus.subscribe(() => {
      u1();
    });
    bus.subscribe((event) => after.push(event));

    bus.publish(buildGatewayBusEvent({ type: "test.unsub-mid", payload: null }));
    expect(after).toHaveLength(1);

    bus.publish(buildGatewayBusEvent({ type: "test.next", payload: null }));
    expect(after).toHaveLength(2);
    expect(bus.subscriberCount()).toBe(1);
  });
});

describe("buildGatewayBusEvent", () => {
  test("produces an event with id, ts, type, and payload populated", () => {
    const event = buildGatewayBusEvent({
      type: "gateway.session.created",
      payload: { sessionId: "abc" },
    });

    expect(typeof event.id).toBe("string");
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.type).toBe("gateway.session.created");
    expect(event.payload).toEqual({ sessionId: "abc" });
    // ISO-8601 timestamp shape — Date.parse must accept it.
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false);
  });

  test("each call produces a unique id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(buildGatewayBusEvent({ type: "test", payload: null }).id);
    }
    expect(ids.size).toBe(100);
  });

  test("carries optional sourcePrincipal and correlationId when provided", () => {
    const event = buildGatewayBusEvent({
      type: "gateway.permission.decision",
      payload: null,
      sourcePrincipal: {
        kind: "example-bridge",
        id: "example-author-1",
        displayName: "example-author",
      },
      correlationId: "abc-123",
    });

    expect(event.sourcePrincipal?.kind).toBe("example-bridge");
    expect(event.sourcePrincipal?.id).toBe("example-author-1");
    expect(event.correlationId).toBe("abc-123");
  });

  test("omits sourcePrincipal and correlationId when not provided", () => {
    const event = buildGatewayBusEvent({ type: "test", payload: null });
    expect(event.sourcePrincipal).toBeUndefined();
    expect(event.correlationId).toBeUndefined();
  });
});
