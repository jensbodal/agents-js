import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createBusPublishHandler,
  createBusSubscribeHandler,
  createGatewayBus,
  publishBridgeEventToBus,
} from "@agents-js/host";
import { runMcpBusBridge } from "../src/bridge.ts";
import type { McpNotification } from "../src/event-mapper.ts";
import type { McpBusBridgeServer } from "../src/mcp-server.ts";

/**
 * Full-stack integration: real `GatewayBus`, real `/events` SSE
 * subscribe handler from `@agents-js/host`, the bridge subscriber,
 * and a recording fake MCP server. Proves the wire path
 * (bus publish → SSE frame → bridge subscriber → MCP notification)
 * works end-to-end without mocking the SSE stream construction.
 */
describe("mcp-bus-bridge integration with real GatewayBus + SSE subscribe handler", () => {
  let controller: AbortController;
  beforeEach(() => {
    controller = new AbortController();
  });
  afterEach(() => {
    controller.abort();
  });

  test("bus publish → SSE → bridge → MCP notification", async () => {
    const bus = createGatewayBus();
    const subscribe = createBusSubscribeHandler({ bus, heartbeatMs: 0 });

    // Wire the bridge subscriber to the host's actual SSE handler by
    // routing its `fetch` to invoke `subscribe` directly. This lets
    // the test exercise the production frame-serialization path
    // without spinning up `Bun.serve`.
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const response = await subscribe(
        new Request(url, { method: "GET", signal: controller.signal }),
      );
      if (response === null) throw new Error("subscribe handler returned null");
      return response;
    };

    const dispatched: McpNotification[] = [];
    const server: McpBusBridgeServer = {
      async connect() {},
      async dispatchNotification(n) {
        dispatched.push(n);
      },
      async close() {},
    };

    // Start the bridge, then publish 3 envelopes onto the bus. The
    // bridge subscriber will dequeue each as it arrives. Once we've
    // received them all, abort.
    const bridgePromise = runMcpBusBridge({
      config: {
        gatewayUrl: "http://gw.local",
        subscribePath: "/events",
        filterPrefixes: ["*"],
        reconnectMinMs: 1,
        reconnectMaxMs: 5,
      },
      serverInfo: { name: "integration-test", version: "0.0.0" },
      signal: controller.signal,
      server,
      fetchImpl,
      sleepImpl: async () => {},
    });

    // Give the bridge a microtask to attach its subscriber before
    // publishing; otherwise events publish into an empty bus.
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));

    publishBridgeEventToBus({
      bus,
      topic: "gateway.example.event-received",
      payload: { body: "first" },
    });
    publishBridgeEventToBus({
      bus,
      topic: "gateway.example.event-received",
      payload: { body: "second" },
    });
    publishBridgeEventToBus({
      bus,
      topic: "gateway.example.event-received",
      payload: { body: "third" },
    });

    // Poll until the bridge has dispatched all three notifications,
    // with a hard timeout.
    const deadline = Date.now() + 1_000;
    while (dispatched.length < 3 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    controller.abort();
    await bridgePromise;

    expect(dispatched).toHaveLength(3);
    expect(dispatched.map((n) => (n.params.payload as { body: string }).body)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(dispatched.every((n) => n.method === "notifications/gateway-bus/event")).toBe(true);

    // Bus subscription was released on abort.
    expect(bus.subscriberCount()).toBe(0);
  });

  test("admin publish via createBusPublishHandler → SSE → bridge → MCP notification", async () => {
    // Exercises the out-of-process publish path: a publisher hits
    // the gateway's /admin/publish endpoint over HTTP, which fans the
    // event onto the bus, which the bridge forwards as an MCP
    // notification.
    const bus = createGatewayBus();
    const subscribe = createBusSubscribeHandler({ bus, heartbeatMs: 0 });
    const publish = createBusPublishHandler({ bus });

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const response = await subscribe(
        new Request(url, { method: "GET", signal: controller.signal }),
      );
      if (response === null) throw new Error("subscribe handler returned null");
      return response;
    };

    const dispatched: McpNotification[] = [];
    const server: McpBusBridgeServer = {
      async connect() {},
      async dispatchNotification(n) {
        dispatched.push(n);
      },
      async close() {},
    };

    const bridgePromise = runMcpBusBridge({
      config: {
        gatewayUrl: "http://gw.local",
        subscribePath: "/events",
        filterPrefixes: ["*"],
        reconnectMinMs: 1,
        reconnectMaxMs: 5,
      },
      serverInfo: { name: "integration-test", version: "0.0.0" },
      signal: controller.signal,
      server,
      fetchImpl,
      sleepImpl: async () => {},
    });

    await new Promise<void>((r) => setTimeout(r, 5));

    const publishResponse = await publish(
      new Request("http://gw.local/admin/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "gateway.example.event-received",
          payload: { sender: "external-publisher", body: "hello" },
          sourcePrincipal: { kind: "example-bridge", id: "external-publisher" },
          correlationId: "publish-corr-1",
        }),
      }),
    );
    expect(publishResponse?.status).toBe(200);

    const deadline = Date.now() + 1_000;
    while (dispatched.length === 0 && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    controller.abort();
    await bridgePromise;

    expect(dispatched).toHaveLength(1);
    const params = dispatched[0]?.params;
    expect(params?.type).toBe("gateway.example.event-received");
    expect(params?.correlationId).toBe("publish-corr-1");
    expect(params?.sourcePrincipal).toEqual({
      kind: "example-bridge",
      id: "external-publisher",
    });
  });
});
