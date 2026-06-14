import { describe, expect, test } from "bun:test";
import { buildGatewayBusEvent } from "@agents-js/host";
import {
  mapBusEventToNotification,
  methodForBusEvent,
  shouldForwardBusEvent,
} from "../src/event-mapper.ts";

describe("methodForBusEvent", () => {
  test("defaults to `notifications/gateway-bus/event`", () => {
    expect(methodForBusEvent()).toBe("notifications/gateway-bus/event");
  });

  test("respects a custom namespace", () => {
    expect(methodForBusEvent({ methodNamespace: "notifications/agents-js" })).toBe(
      "notifications/agents-js/event",
    );
  });
});

describe("mapBusEventToNotification", () => {
  test("places envelope metadata in params.{id,type,ts,payload}", () => {
    const event = buildGatewayBusEvent({
      type: "gateway.example.event-received",
      payload: { body: "hello" },
    });
    const frame = mapBusEventToNotification(event);
    expect(frame.method).toBe("notifications/gateway-bus/event");
    expect(frame.params.id).toBe(event.id);
    expect(frame.params.type).toBe("gateway.example.event-received");
    expect(frame.params.ts).toBe(event.ts);
    expect(frame.params.payload).toEqual({ body: "hello" });
  });

  test("omits sourcePrincipal when not present on the envelope", () => {
    const event = buildGatewayBusEvent({
      type: "gateway.example.event-received",
      payload: null,
    });
    const frame = mapBusEventToNotification(event);
    expect("sourcePrincipal" in frame.params).toBe(false);
  });

  test("includes sourcePrincipal when present", () => {
    const event = buildGatewayBusEvent({
      type: "gateway.example.event-received",
      payload: null,
      sourcePrincipal: { kind: "example-bridge", id: "example-author-1" },
    });
    const frame = mapBusEventToNotification(event);
    expect(frame.params.sourcePrincipal).toEqual({
      kind: "example-bridge",
      id: "example-author-1",
    });
  });

  test("omits correlationId when not present", () => {
    const event = buildGatewayBusEvent({
      type: "gateway.example.event-received",
      payload: null,
    });
    const frame = mapBusEventToNotification(event);
    expect("correlationId" in frame.params).toBe(false);
  });

  test("includes correlationId when present", () => {
    const event = buildGatewayBusEvent({
      type: "gateway.example.event-received",
      payload: null,
      correlationId: "abc-123",
    });
    const frame = mapBusEventToNotification(event);
    expect(frame.params.correlationId).toBe("abc-123");
  });

  test("respects custom method namespace", () => {
    const event = buildGatewayBusEvent({
      type: "gateway.example.event",
      payload: null,
    });
    const frame = mapBusEventToNotification(event, {
      methodNamespace: "notifications/custom",
    });
    expect(frame.method).toBe("notifications/custom/event");
  });

  test("preserves arbitrary payload shapes", () => {
    interface SamplePayload {
      a: number;
      nested: { b: string };
    }
    const event = buildGatewayBusEvent<SamplePayload>({
      type: "gateway.example.shape",
      payload: { a: 42, nested: { b: "value" } },
    });
    const frame = mapBusEventToNotification(event);
    expect(frame.params.payload).toEqual({ a: 42, nested: { b: "value" } });
  });
});

describe("shouldForwardBusEvent", () => {
  const event = buildGatewayBusEvent({
    type: "gateway.example.event-received",
    payload: null,
  });

  test("forwards when filter list is empty", () => {
    expect(shouldForwardBusEvent(event, [])).toBe(true);
  });

  test("forwards when filter includes wildcard", () => {
    expect(shouldForwardBusEvent(event, ["*"])).toBe(true);
  });

  test("forwards when a prefix matches", () => {
    expect(shouldForwardBusEvent(event, ["gateway.example."])).toBe(true);
    expect(shouldForwardBusEvent(event, ["gateway."])).toBe(true);
  });

  test("does NOT forward when no prefix matches", () => {
    expect(shouldForwardBusEvent(event, ["gateway.audit."])).toBe(false);
    expect(shouldForwardBusEvent(event, ["gateway.matrix.", "gateway.slack."])).toBe(false);
  });

  test("forwards when at least one prefix in the list matches", () => {
    expect(shouldForwardBusEvent(event, ["gateway.audit.", "gateway.example."])).toBe(true);
  });

  test("prefix match is exact-prefix, not substring", () => {
    const otherEvent = buildGatewayBusEvent({
      type: "gateway.matrix.event-received",
      payload: null,
    });
    // "matrix" alone is not a valid prefix (the type starts with "gateway.")
    expect(shouldForwardBusEvent(otherEvent, ["matrix."])).toBe(false);
    expect(shouldForwardBusEvent(otherEvent, ["gateway.matrix."])).toBe(true);
  });
});
