import { describe, expect, test } from "bun:test";
import { buildBridgeBusEvent, publishBridgeEventToBus } from "../src/bridge-publisher.ts";
import { createGatewayBus, type GatewayBusEvent } from "../src/gateway-bus.ts";

// `buildBridgeBusEvent` is the generic external-bridge envelope
// builder. Tests use a synthetic non-Matrix payload to prove the
// API is source-agnostic — agents-js core knows nothing about any
// specific external system (Matrix, Slack, GitHub, etc.). Each
// bridge supplies its own topic + payload + sourcePrincipal.

interface SyntheticBridgePayload {
  source: string;
  body: string;
  extras?: Record<string, unknown>;
}

const SAMPLE_TOPIC = "gateway.synthetic.event-received";

const SAMPLE_PAYLOAD: SyntheticBridgePayload = {
  source: "synthetic-test-source",
  body: "hello bus",
  extras: { tag: "fixture" },
};

describe("buildBridgeBusEvent", () => {
  test("emits the caller-supplied topic", () => {
    const envelope = buildBridgeBusEvent({ topic: SAMPLE_TOPIC, payload: SAMPLE_PAYLOAD });
    expect(envelope.type).toBe(SAMPLE_TOPIC);
  });

  test("preserves the caller-supplied payload verbatim", () => {
    const envelope = buildBridgeBusEvent({ topic: SAMPLE_TOPIC, payload: SAMPLE_PAYLOAD });
    expect(envelope.payload).toEqual(SAMPLE_PAYLOAD);
    expect(envelope.payload.source).toBe("synthetic-test-source");
    expect(envelope.payload.body).toBe("hello bus");
    expect(envelope.payload.extras?.tag).toBe("fixture");
  });

  test("does NOT inject a default sourcePrincipal", () => {
    const envelope = buildBridgeBusEvent({ topic: SAMPLE_TOPIC, payload: SAMPLE_PAYLOAD });
    expect(envelope.sourcePrincipal).toBeUndefined();
  });

  test("propagates a caller-supplied sourcePrincipal verbatim", () => {
    const envelope = buildBridgeBusEvent({
      topic: SAMPLE_TOPIC,
      payload: SAMPLE_PAYLOAD,
      sourcePrincipal: { kind: "external-bridge", id: "synthetic-bridge-1" },
    });
    expect(envelope.sourcePrincipal?.kind).toBe("external-bridge");
    expect(envelope.sourcePrincipal?.id).toBe("synthetic-bridge-1");
  });

  test("propagates correlationId when supplied", () => {
    const envelope = buildBridgeBusEvent({
      topic: SAMPLE_TOPIC,
      payload: SAMPLE_PAYLOAD,
      correlationId: "bridge-corr-1",
    });
    expect(envelope.correlationId).toBe("bridge-corr-1");
  });

  test("omits correlationId when not supplied", () => {
    const envelope = buildBridgeBusEvent({ topic: SAMPLE_TOPIC, payload: SAMPLE_PAYLOAD });
    expect(envelope.correlationId).toBeUndefined();
  });

  test("each call produces a unique envelope id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const envelope = buildBridgeBusEvent({ topic: SAMPLE_TOPIC, payload: SAMPLE_PAYLOAD });
      ids.add(envelope.id);
    }
    expect(ids.size).toBe(50);
  });

  test("stamps `ts` as an ISO-8601 string", () => {
    const envelope = buildBridgeBusEvent({ topic: SAMPLE_TOPIC, payload: SAMPLE_PAYLOAD });
    expect(envelope.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("respects an arbitrary caller-supplied topic without enumerating sources", () => {
    const topics = [
      "gateway.example.event-received",
      "gateway.example-stream.message",
      "gateway.example-webhook.notification",
      "gateway.unknown-future-bridge.event",
    ];
    for (const topic of topics) {
      const envelope = buildBridgeBusEvent({ topic, payload: SAMPLE_PAYLOAD });
      expect(envelope.type).toBe(topic);
    }
  });

  test("payload type parameter is preserved on the returned envelope", () => {
    const envelope: GatewayBusEvent<SyntheticBridgePayload> = buildBridgeBusEvent({
      topic: SAMPLE_TOPIC,
      payload: SAMPLE_PAYLOAD,
    });
    expect(envelope.payload.source).toBe("synthetic-test-source");
  });
});

describe("publishBridgeEventToBus", () => {
  test("builds and publishes onto the supplied bus, returning the envelope", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const envelope = publishBridgeEventToBus({
      bus,
      topic: SAMPLE_TOPIC,
      payload: SAMPLE_PAYLOAD,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(envelope.id);
    expect(received[0]?.type).toBe(SAMPLE_TOPIC);
    expect(received[0]?.payload).toEqual(SAMPLE_PAYLOAD);
  });

  test("each call produces a distinct envelope id even with identical input", () => {
    const bus = createGatewayBus();
    const a = publishBridgeEventToBus({ bus, topic: SAMPLE_TOPIC, payload: SAMPLE_PAYLOAD });
    const b = publishBridgeEventToBus({ bus, topic: SAMPLE_TOPIC, payload: SAMPLE_PAYLOAD });
    expect(a.id).not.toBe(b.id);
  });
});
