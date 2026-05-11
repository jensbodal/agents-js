import { describe, expect, test } from "bun:test";
import { createBusPublishHandler, createBusSubscribeHandler } from "../src/bus-endpoint.ts";
import { buildGatewayBusEvent, createGatewayBus } from "../src/gateway-bus.ts";

// Narrow `Response | null` -> non-null body reader. Throws instead of
// using `!.` non-null assertion so biome's noNonNullAssertion rule
// stays happy AND the failure mode is loud (test gets a real error
// message rather than a cryptic null-deref). Return type is inferred
// because Bun's ReadableStreamDefaultReader carries extra `readMany`
// that the standard Web type does not, and we don't want to spell out
// the runtime-specific type.
function readerOf(response: Response | null | undefined) {
  if (!response?.body) {
    throw new Error("expected response with a body stream");
  }
  return response.body.getReader();
}

describe("createBusPublishHandler", () => {
  test("returns null for non-matching path so caller can fall through", async () => {
    const bus = createGatewayBus();
    const handler = createBusPublishHandler({ bus });
    const result = await handler(new Request("http://localhost/other", { method: "POST" }));
    expect(result).toBeNull();
  });

  test("rejects non-POST methods with 405", async () => {
    const bus = createGatewayBus();
    const handler = createBusPublishHandler({ bus });
    const result = await handler(new Request("http://localhost/admin/publish", { method: "GET" }));
    expect(result).not.toBeNull();
    expect(result?.status).toBe(405);
    expect(result?.headers.get("Allow")).toBe("POST");
  });

  test("rejects malformed JSON with 400", async () => {
    const bus = createGatewayBus();
    const handler = createBusPublishHandler({
      bus,
      logger: { warn() {}, error() {}, log() {} },
    });
    const result = await handler(
      new Request("http://localhost/admin/publish", {
        method: "POST",
        body: "not-json{",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(result?.status).toBe(400);
    const body = (await result?.json()) as { error?: string };
    expect(body.error).toContain("invalid JSON");
  });

  test("rejects body without `type` field with 400", async () => {
    const bus = createGatewayBus();
    const handler = createBusPublishHandler({ bus });
    const result = await handler(
      new Request("http://localhost/admin/publish", {
        method: "POST",
        body: JSON.stringify({ payload: {} }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(result?.status).toBe(400);
    const body = (await result?.json()) as { error?: string };
    expect(body.error).toContain("type");
  });

  test("rejects body with empty-string `type` field with 400", async () => {
    const bus = createGatewayBus();
    const handler = createBusPublishHandler({ bus });
    const result = await handler(
      new Request("http://localhost/admin/publish", {
        method: "POST",
        body: JSON.stringify({ type: "", payload: {} }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(result?.status).toBe(400);
  });

  test("publishes a valid event to the bus and returns 200 with the event id", async () => {
    const bus = createGatewayBus();
    const received: Array<{ id: string; type: string; payload: unknown }> = [];
    bus.subscribe((event) =>
      received.push({ id: event.id, type: event.type, payload: event.payload }),
    );

    const handler = createBusPublishHandler({ bus });
    const result = await handler(
      new Request("http://localhost/admin/publish", {
        method: "POST",
        body: JSON.stringify({
          type: "gateway.matrix.event-received",
          payload: { sender: "@user:server", text: "hello" },
          sourcePrincipal: { kind: "matrix", id: "@user:server" },
          correlationId: "abc-123",
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(result?.status).toBe(200);
    const body = (await result?.json()) as { id?: string; accepted?: boolean };
    expect(body.accepted).toBe(true);
    expect(typeof body.id).toBe("string");

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe("gateway.matrix.event-received");
    expect(received[0]?.id).toBe(body.id);
    expect(received[0]?.payload).toEqual({ sender: "@user:server", text: "hello" });
  });

  test("respects custom path option", async () => {
    const bus = createGatewayBus();
    const handler = createBusPublishHandler({ bus, path: "/custom/publish" });
    const noop = await handler(new Request("http://localhost/admin/publish", { method: "POST" }));
    expect(noop).toBeNull();
    const matched = await handler(
      new Request("http://localhost/custom/publish", {
        method: "POST",
        body: JSON.stringify({ type: "test", payload: null }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(matched?.status).toBe(200);
  });
});

describe("createBusSubscribeHandler", () => {
  test("returns null for non-matching path", async () => {
    const bus = createGatewayBus();
    const handler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const result = await handler(new Request("http://localhost/other"));
    expect(result).toBeNull();
  });

  test("rejects non-GET methods with 405", async () => {
    const bus = createGatewayBus();
    const handler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const result = await handler(new Request("http://localhost/events", { method: "POST" }));
    expect(result?.status).toBe(405);
    expect(result?.headers.get("Allow")).toBe("GET");
  });

  test("opens an SSE stream with correct headers", async () => {
    const bus = createGatewayBus();
    const handler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const result = await handler(new Request("http://localhost/events"));

    expect(result?.status).toBe(200);
    expect(result?.headers.get("Content-Type")).toBe("text/event-stream");
    expect(result?.headers.get("Cache-Control")).toContain("no-cache");

    await result?.body?.cancel();
  });

  test("attaches the subscriber when the stream opens", async () => {
    const bus = createGatewayBus();
    expect(bus.subscriberCount()).toBe(0);

    const handler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const response = await handler(new Request("http://localhost/events"));
    const reader = readerOf(response);

    expect(bus.subscriberCount()).toBe(1);

    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });

  test("publishes flow through to the SSE stream as data frames", async () => {
    const bus = createGatewayBus();
    const handler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const response = await handler(new Request("http://localhost/events"));
    const reader = readerOf(response);

    const event = buildGatewayBusEvent({
      type: "test.subscribe-flow",
      payload: { value: 42 },
    });
    bus.publish(event);

    const decoder = new TextDecoder();
    const { value } = await reader.read();
    const frame = decoder.decode(value);

    expect(frame).toContain(`id: ${event.id}`);
    expect(frame).toContain(`data: `);
    expect(frame).toContain('"type":"test.subscribe-flow"');
    expect(frame).toContain('"value":42');
    expect(frame).toMatch(/\n\n$/);

    await reader.cancel();
  });

  test("multiple concurrent subscribers each receive every published event", async () => {
    const bus = createGatewayBus();
    const handler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });

    const reader1 = readerOf(await handler(new Request("http://localhost/events")));
    const reader2 = readerOf(await handler(new Request("http://localhost/events")));

    expect(bus.subscriberCount()).toBe(2);

    bus.publish(buildGatewayBusEvent({ type: "test.broadcast", payload: null }));

    const decoder = new TextDecoder();
    const f1 = decoder.decode((await reader1.read()).value);
    const f2 = decoder.decode((await reader2.read()).value);

    expect(f1).toContain('"type":"test.broadcast"');
    expect(f2).toContain('"type":"test.broadcast"');

    await reader1.cancel();
    await reader2.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });

  test("cancelling the stream detaches the subscriber from the bus", async () => {
    const bus = createGatewayBus();
    const handler = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const response = await handler(new Request("http://localhost/events"));
    const reader = readerOf(response);

    expect(bus.subscriberCount()).toBe(1);
    await reader.cancel();
    expect(bus.subscriberCount()).toBe(0);
  });

  test("respects custom path option", async () => {
    const bus = createGatewayBus();
    const handler = createBusSubscribeHandler({
      bus,
      path: "/custom/events",
      heartbeatMs: 0,
    });

    const noop = await handler(new Request("http://localhost/events"));
    expect(noop).toBeNull();

    const matched = await handler(new Request("http://localhost/custom/events"));
    expect(matched?.status).toBe(200);
    await matched?.body?.cancel();
  });
});

describe("createBusSubscribeHandler — integration with publish handler", () => {
  test("admin-published events arrive on SSE subscribers", async () => {
    const bus = createGatewayBus();
    const subscribe = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const publish = createBusPublishHandler({ bus });

    const subResponse = await subscribe(new Request("http://localhost/events"));
    const reader = readerOf(subResponse);

    const pubResponse = await publish(
      new Request("http://localhost/admin/publish", {
        method: "POST",
        body: JSON.stringify({
          type: "gateway.matrix.message",
          payload: { text: "round-trip" },
        }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(pubResponse?.status).toBe(200);

    const decoder = new TextDecoder();
    const frame = decoder.decode((await reader.read()).value);
    expect(frame).toContain('"type":"gateway.matrix.message"');
    expect(frame).toContain('"text":"round-trip"');

    await reader.cancel();
  });
});
