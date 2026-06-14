import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildGatewayBusEvent, type GatewayBusEvent } from "@agents-js/host";
import { runBusSubscriber } from "../src/bus-subscriber.ts";

/**
 * Build a Response whose body is an SSE stream emitting the given
 * envelopes. The stream stays open until the controller closes — we
 * close it after the last event so the subscriber sees `done` and
 * loops back to fetch (which the test controls via its mock fetch).
 */
function buildSseResponse(envelopes: GatewayBusEvent<unknown>[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const env of envelopes) {
        controller.enqueue(encoder.encode(`id: ${env.id}\ndata: ${JSON.stringify(env)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Quiet logger so unit-test output stays clean. */
const silentLogger = {
  log() {},
  warn() {},
  error() {},
};

describe("runBusSubscriber", () => {
  let controller: AbortController;
  beforeEach(() => {
    controller = new AbortController();
  });
  afterEach(() => {
    controller.abort();
  });

  test("decodes each SSE frame into a single bus event and forwards in order", async () => {
    const sent = [
      buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 1 } }),
      buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 2 } }),
      buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 3 } }),
    ];

    const received: GatewayBusEvent<unknown>[] = [];

    let fetchCalls = 0;
    const mockFetch = (async (
      _input: Parameters<typeof fetch>[0],
      _init?: Parameters<typeof fetch>[1],
    ) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return buildSseResponse(sent);
      }
      // After the SSE stream ends, abort so the subscriber returns.
      controller.abort();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await runBusSubscriber({
      url: "http://localhost:8080/events",
      onEvent: (event) => {
        received.push(event);
      },
      signal: controller.signal,
      reconnectMinMs: 1,
      reconnectMaxMs: 5,
      logger: silentLogger,
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    });

    expect(received.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2, 3]);
  });

  test("ignores SSE comment lines and frames with no `data:` payload", async () => {
    const env = buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 1 } });
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(`: heartbeat\n\n`));
        c.enqueue(encoder.encode(`id: ${env.id}\ndata: ${JSON.stringify(env)}\n\n`));
        c.enqueue(encoder.encode(`: another heartbeat\n\n`));
        c.close();
      },
    });
    const response = new Response(stream, { status: 200 });

    const received: GatewayBusEvent<unknown>[] = [];
    let calls = 0;
    const mockFetch = (async () => {
      calls += 1;
      if (calls === 1) return response;
      controller.abort();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await runBusSubscriber({
      url: "http://localhost:8080/events",
      onEvent: (event) => {
        received.push(event);
      },
      signal: controller.signal,
      reconnectMinMs: 1,
      reconnectMaxMs: 5,
      logger: silentLogger,
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(env.id);
  });

  test("reconnects with exponential backoff when fetch fails", async () => {
    const sleepCalls: number[] = [];
    let fetchCalls = 0;
    const mockFetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls <= 3) {
        throw new Error(`simulated network failure ${fetchCalls}`);
      }
      controller.abort();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await runBusSubscriber({
      url: "http://localhost:8080/events",
      onEvent: () => {},
      signal: controller.signal,
      reconnectMinMs: 10,
      reconnectMaxMs: 80,
      logger: silentLogger,
      fetchImpl: mockFetch,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    // Three failures → sleeps of 10, 20, 40 ms (exponential, capped at 80).
    // The final iteration aborts before sleeping again, so only the 3
    // post-failure sleeps land in the log.
    expect(sleepCalls.slice(0, 3)).toEqual([10, 20, 40]);
  });

  test("resets backoff after a successful connection", async () => {
    const sleepCalls: number[] = [];
    let fetchCalls = 0;
    const okResponse = buildSseResponse([
      buildGatewayBusEvent({ type: "gateway.example.event", payload: null }),
    ]);

    const mockFetch = (async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) throw new Error("first attempt fails");
      if (fetchCalls === 2) return okResponse;
      if (fetchCalls === 3) throw new Error("third attempt fails");
      controller.abort();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await runBusSubscriber({
      url: "http://localhost:8080/events",
      onEvent: () => {},
      signal: controller.signal,
      reconnectMinMs: 10,
      reconnectMaxMs: 200,
      logger: silentLogger,
      fetchImpl: mockFetch,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    // Sleeps: 10 (after first failure), 10 (after stream completes —
    // reset because the connection succeeded), 10 (after third failure
    // — reset again because the prior fetch returned OK).
    expect(sleepCalls.slice(0, 3)).toEqual([10, 10, 10]);
  });

  test("exits cleanly when signal aborts mid-stream", async () => {
    const slowStream = new ReadableStream<Uint8Array>({
      start() {
        // Stream never produces data; subscriber blocks on reader.read().
      },
    });
    const mockFetch = (async () =>
      new Response(slowStream, { status: 200 })) as unknown as typeof fetch;

    const subscribePromise = runBusSubscriber({
      url: "http://localhost:8080/events",
      onEvent: () => {},
      signal: controller.signal,
      reconnectMinMs: 1,
      reconnectMaxMs: 5,
      logger: silentLogger,
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    });

    setTimeout(() => controller.abort(), 5);
    await subscribePromise;
    // Test passes simply by returning — if the abort doesn't unblock
    // the subscriber, the test framework will timeout.
  });

  test("warns and skips a frame that does not parse as JSON", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode(`data: this-is-not-json\n\n`));
        const ok = buildGatewayBusEvent({ type: "gateway.example.event", payload: { n: 1 } });
        c.enqueue(encoder.encode(`data: ${JSON.stringify(ok)}\n\n`));
        c.close();
      },
    });
    const response = new Response(stream, { status: 200 });

    const received: GatewayBusEvent<unknown>[] = [];
    let calls = 0;
    const warnings: unknown[] = [];
    const mockFetch = (async () => {
      calls += 1;
      if (calls === 1) return response;
      controller.abort();
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await runBusSubscriber({
      url: "http://localhost:8080/events",
      onEvent: (event) => {
        received.push(event);
      },
      signal: controller.signal,
      reconnectMinMs: 1,
      reconnectMaxMs: 5,
      logger: {
        log() {},
        warn(...args) {
          warnings.push(args);
        },
        error() {},
      },
      fetchImpl: mockFetch,
      sleepImpl: async () => {},
    });

    expect(received).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });
});
