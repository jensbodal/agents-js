import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildGatewayBusEvent } from "@agents-js/host";
import { runMcpBusBridge } from "../src/bridge.ts";
import type { BridgeConfig } from "../src/env.ts";
import type { McpNotification } from "../src/event-mapper.ts";
import type { McpBusBridgeServer } from "../src/mcp-server.ts";

/**
 * Recording fake server: captures every call to `dispatchNotification`
 * so the test can assert what the bridge fanned out.
 */
function createRecordingServer(): McpBusBridgeServer & {
  notifications: McpNotification[];
  closed: boolean;
} {
  const notifications: McpNotification[] = [];
  let connected = false;
  let closed = false;
  return {
    notifications,
    get closed() {
      return closed;
    },
    async connect() {
      connected = true;
    },
    async dispatchNotification(n) {
      if (!connected) throw new Error("not connected");
      notifications.push(n);
    },
    async close() {
      closed = true;
    },
  };
}

const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

const baseConfig: BridgeConfig = {
  gatewayUrl: "http://localhost:8080",
  subscribePath: "/events",
  filterPrefixes: ["*"],
  reconnectMinMs: 1,
  reconnectMaxMs: 5,
};

function buildSseFetch(eventsToEmit: ReturnType<typeof buildGatewayBusEvent>[]) {
  let calls = 0;
  return (controller: AbortController): typeof fetch =>
    (async () => {
      calls += 1;
      if (calls === 1) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            for (const env of eventsToEmit) {
              c.enqueue(encoder.encode(`id: ${env.id}\ndata: ${JSON.stringify(env)}\n\n`));
            }
            c.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      controller.abort();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
}

describe("runMcpBusBridge", () => {
  let controller: AbortController;
  beforeEach(() => {
    controller = new AbortController();
  });
  afterEach(() => {
    controller.abort();
  });

  test("dispatches one MCP notification per forwarded bus event", async () => {
    const events = [
      buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 1 } }),
      buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 2 } }),
    ];
    const server = createRecordingServer();
    const fetchImpl = buildSseFetch(events)(controller);

    await runMcpBusBridge({
      config: baseConfig,
      serverInfo: { name: "test-bridge", version: "0.0.0" },
      signal: controller.signal,
      logger: silentLogger,
      server,
      fetchImpl,
      sleepImpl: async () => {},
    });

    expect(server.notifications).toHaveLength(2);
    expect(server.notifications[0]?.method).toBe("notifications/gateway-bus/event");
    expect((server.notifications[0]?.params.payload as { n: number }).n).toBe(1);
    expect((server.notifications[1]?.params.payload as { n: number }).n).toBe(2);
  });

  test("drops bus events that do not match the filter", async () => {
    const events = [
      buildGatewayBusEvent({ type: "gateway.audit.event", payload: { id: "a" } }),
      buildGatewayBusEvent({ type: "gateway.example.event", payload: { id: "b" } }),
      buildGatewayBusEvent({ type: "gateway.registry.event", payload: { id: "c" } }),
    ];
    const server = createRecordingServer();
    const fetchImpl = buildSseFetch(events)(controller);

    await runMcpBusBridge({
      config: { ...baseConfig, filterPrefixes: ["gateway.example."] },
      serverInfo: { name: "test-bridge", version: "0.0.0" },
      signal: controller.signal,
      logger: silentLogger,
      server,
      fetchImpl,
      sleepImpl: async () => {},
    });

    expect(server.notifications).toHaveLength(1);
    expect(server.notifications[0]?.params.type).toBe("gateway.example.event");
  });

  test("closes the MCP server when the signal aborts", async () => {
    const server = createRecordingServer();
    const fetchImpl = buildSseFetch([])(controller);

    await runMcpBusBridge({
      config: baseConfig,
      serverInfo: { name: "test-bridge", version: "0.0.0" },
      signal: controller.signal,
      logger: silentLogger,
      server,
      fetchImpl,
      sleepImpl: async () => {},
    });

    expect(server.closed).toBe(true);
  });

  test("keeps the bridge alive when a single dispatch throws", async () => {
    const events = [
      buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 1 } }),
      buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 2 } }),
    ];
    const fetchImpl = buildSseFetch(events)(controller);

    let dispatched = 0;
    const flakyServer: McpBusBridgeServer = {
      async connect() {},
      async dispatchNotification() {
        dispatched += 1;
        if (dispatched === 1) throw new Error("transient transport failure");
      },
      async close() {},
    };

    await runMcpBusBridge({
      config: baseConfig,
      serverInfo: { name: "test-bridge", version: "0.0.0" },
      signal: controller.signal,
      logger: silentLogger,
      server: flakyServer,
      fetchImpl,
      sleepImpl: async () => {},
    });

    // Both events were processed even though the first dispatch threw.
    expect(dispatched).toBe(2);
  });

  test("builds the subscribe URL by joining gatewayUrl + subscribePath", async () => {
    const events = [buildGatewayBusEvent({ type: "gateway.example.event", payload: null })];
    const server = createRecordingServer();

    let observedUrl: string | undefined;
    let calls = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      observedUrl = typeof input === "string" ? input : (input as Request).url;
      calls += 1;
      if (calls === 1) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            for (const env of events) {
              c.enqueue(encoder.encode(`data: ${JSON.stringify(env)}\n\n`));
            }
            c.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      controller.abort();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await runMcpBusBridge({
      config: {
        ...baseConfig,
        gatewayUrl: "http://gw.local:9000/",
        subscribePath: "/v1/events",
      },
      serverInfo: { name: "test-bridge", version: "0.0.0" },
      signal: controller.signal,
      logger: silentLogger,
      server,
      fetchImpl,
      sleepImpl: async () => {},
    });

    // Trailing slash on gatewayUrl is normalized so the URL has a
    // single boundary slash between host and path.
    expect(observedUrl).toBe("http://gw.local:9000/v1/events");
  });

  test("adds a leading slash when subscribePath omits one", async () => {
    const events = [buildGatewayBusEvent({ type: "gateway.example.event", payload: null })];
    const server = createRecordingServer();

    let observedUrl: string | undefined;
    let calls = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      observedUrl = typeof input === "string" ? input : (input as Request).url;
      calls += 1;
      if (calls === 1) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            for (const env of events) {
              c.enqueue(encoder.encode(`data: ${JSON.stringify(env)}\n\n`));
            }
            c.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      controller.abort();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await runMcpBusBridge({
      config: {
        ...baseConfig,
        gatewayUrl: "http://gw.local:9000",
        subscribePath: "events",
      },
      serverInfo: { name: "test-bridge", version: "0.0.0" },
      signal: controller.signal,
      logger: silentLogger,
      server,
      fetchImpl,
      sleepImpl: async () => {},
    });

    // Path missing the leading slash is normalized into a single slash
    // between host and path; without this the host and path would
    // concatenate into `http://gw.local:9000events`.
    expect(observedUrl).toBe("http://gw.local:9000/events");
  });
});
