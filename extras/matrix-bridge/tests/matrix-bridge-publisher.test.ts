import { describe, expect, test } from "bun:test";
import { createGatewayBus, type GatewayBusEvent } from "@agents-js/host";
import {
  buildMatrixBusEvent,
  MATRIX_BRIDGE_EVENT_TOPIC,
  MATRIX_SOURCE_PRINCIPAL_KIND,
  type MatrixBridgeEventInput,
  publishMatrixEventToBus,
} from "../src/index.ts";

// `@agents-js/matrix-bridge` is the Matrix-flavored adapter over the
// generic bridge primitive in `@agents-js/host`. agents-js core
// knows nothing about Matrix; this package adds the canonical topic,
// sender→source-principal mapping, and payload shape that the
// out-of-process `matrix_nio_bridge.py` mirrors.

const SAMPLE_MATRIX_EVENT: MatrixBridgeEventInput = {
  roomId: "!demo:server.example",
  sender: "@alice:server.example",
  type: "m.room.message",
  eventId: "$abc123",
  body: "hello bus",
  msgtype: "m.text",
};

describe("buildMatrixBusEvent", () => {
  test("emits the canonical `gateway.matrix.event-received` topic", () => {
    const envelope = buildMatrixBusEvent({ matrixEvent: SAMPLE_MATRIX_EVENT });
    expect(envelope.type).toBe(MATRIX_BRIDGE_EVENT_TOPIC);
    expect(envelope.type).toBe("gateway.matrix.event-received");
  });

  test("preserves the Matrix event verbatim as the payload", () => {
    const envelope = buildMatrixBusEvent({ matrixEvent: SAMPLE_MATRIX_EVENT });
    expect(envelope.payload).toEqual(SAMPLE_MATRIX_EVENT);
    expect(envelope.payload.roomId).toBe("!demo:server.example");
    expect(envelope.payload.sender).toBe("@alice:server.example");
    expect(envelope.payload.body).toBe("hello bus");
    expect(envelope.payload.msgtype).toBe("m.text");
  });

  test("defaults source-principal to `{ kind: 'matrix', id: <sender> }`", () => {
    const envelope = buildMatrixBusEvent({ matrixEvent: SAMPLE_MATRIX_EVENT });
    expect(envelope.sourcePrincipal?.kind).toBe(MATRIX_SOURCE_PRINCIPAL_KIND);
    expect(envelope.sourcePrincipal?.kind).toBe("matrix");
    expect(envelope.sourcePrincipal?.id).toBe("@alice:server.example");
  });

  test("respects a caller-supplied source-principal override", () => {
    const envelope = buildMatrixBusEvent({
      matrixEvent: SAMPLE_MATRIX_EVENT,
      sourcePrincipal: { kind: "bridge", id: "matrix-nio-bridge.py" },
    });
    expect(envelope.sourcePrincipal?.kind).toBe("bridge");
    expect(envelope.sourcePrincipal?.id).toBe("matrix-nio-bridge.py");
  });

  test("propagates correlationId when supplied", () => {
    const envelope = buildMatrixBusEvent({
      matrixEvent: SAMPLE_MATRIX_EVENT,
      correlationId: "matrix-corr-1",
    });
    expect(envelope.correlationId).toBe("matrix-corr-1");
  });

  test("omits correlationId when not supplied", () => {
    const envelope = buildMatrixBusEvent({ matrixEvent: SAMPLE_MATRIX_EVENT });
    expect(envelope.correlationId).toBeUndefined();
  });

  test("each call produces a unique envelope id", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const envelope = buildMatrixBusEvent({ matrixEvent: SAMPLE_MATRIX_EVENT });
      ids.add(envelope.id);
    }
    expect(ids.size).toBe(50);
  });

  test("stamps `ts` as an ISO-8601 string", () => {
    const envelope = buildMatrixBusEvent({ matrixEvent: SAMPLE_MATRIX_EVENT });
    expect(envelope.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("returned envelope is typed against MatrixBridgeEventInput", () => {
    const envelope: GatewayBusEvent<MatrixBridgeEventInput> = buildMatrixBusEvent({
      matrixEvent: SAMPLE_MATRIX_EVENT,
    });
    expect(envelope.payload.roomId).toBe("!demo:server.example");
  });

  test("accepts partial Matrix events (only roomId + sender + type required)", () => {
    const partial: MatrixBridgeEventInput = {
      roomId: "!partial:server.example",
      sender: "@bob:server.example",
      type: "m.reaction",
    };
    const envelope = buildMatrixBusEvent({ matrixEvent: partial });
    expect(envelope.payload).toEqual(partial);
    expect(envelope.payload.body).toBeUndefined();
    expect(envelope.payload.eventId).toBeUndefined();
  });
});

describe("publishMatrixEventToBus", () => {
  test("builds and publishes the envelope on the supplied bus", () => {
    const bus = createGatewayBus();
    const received: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((event) => received.push(event));

    const envelope = publishMatrixEventToBus({
      bus,
      matrixEvent: SAMPLE_MATRIX_EVENT,
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(envelope.id);
    expect(received[0]?.type).toBe(MATRIX_BRIDGE_EVENT_TOPIC);
    expect(received[0]?.sourcePrincipal?.kind).toBe("matrix");
  });

  test("each call produces a distinct envelope id even with identical input", () => {
    const bus = createGatewayBus();
    const a = publishMatrixEventToBus({ bus, matrixEvent: SAMPLE_MATRIX_EVENT });
    const b = publishMatrixEventToBus({ bus, matrixEvent: SAMPLE_MATRIX_EVENT });
    expect(a.id).not.toBe(b.id);
  });

  test("respects a caller-supplied source-principal override", () => {
    const bus = createGatewayBus();
    const envelope = publishMatrixEventToBus({
      bus,
      matrixEvent: SAMPLE_MATRIX_EVENT,
      sourcePrincipal: { kind: "bridge", id: "matrix-nio-bridge.py" },
    });
    expect(envelope.sourcePrincipal?.kind).toBe("bridge");
  });
});
