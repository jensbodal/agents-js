import { afterEach, describe, expect, test } from "bun:test";
import { EventType } from "@agents-js/agui-types";
import {
  createGatewayTestServer,
  type GatewayTestServerHandle,
  getMockAgentPath,
} from "@agents-js/host/testing";
import { buildRunAgentInput } from "../src/run-input.ts";
import { readAguiSseFrames } from "../src/sse-frames.ts";

/**
 * Learning test (LT-3): the native AG-UI streaming transport, end-to-end.
 *
 * Proves two core guarantees of `POST /agent` over the real gateway
 * stack (ACPSessionController + HostA2AExecutor + mock ACP agent), with
 * the AG-UI endpoint mounted on the server's `additionalFetch` hook:
 *
 *   1. An SSE run streams `RUN_STARTED` first, interior events, then a
 *      terminal `RUN_FINISHED` — and nothing after it.
 *   2. A second concurrent `POST /agent` while a run is active is
 *      rejected by the single-active-run gate with HTTP 409 + a `Busy`
 *      JSON body, BEFORE a second SSE stream opens.
 *
 * The run is backed by `tests/mock-acp-agent.cjs` driven through the
 * real executor — not a fake controller — so the wire path exercised
 * here is the same one a browser AG-UI client hits in production.
 */

// Repo-root mock ACP agent fixture.
const mockAgentPath = getMockAgentPath();

interface SsePost {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  json: () => Promise<unknown>;
}

/** POST /agent with the SSE Accept header and a valid RunAgentInput body. */
async function postAgent(url: string, prompt: string): Promise<SsePost> {
  const res = await fetch(`${url}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The 406 check runs before the run-slot acquire, so the second
      // POST must also opt into SSE — otherwise it would 406, not 409.
      Accept: "text/event-stream",
    },
    body: JSON.stringify(buildRunAgentInput(prompt)),
  });
  return { status: res.status, body: res.body, json: () => res.json() };
}

describe("agui-transport-smoke", () => {
  // The gateway is created per-test (not in a shared beforeEach) so each test
  // spawns exactly the mock variant it needs — test 1 the undelayed mock,
  // test 2 the prompt-delayed mock — with no discarded spawn in between.
  let gateway: GatewayTestServerHandle;

  /** Spawn a gateway with the AG-UI endpoint mounted against the mock agent. */
  async function startGateway(acpEnv?: Record<string, string>): Promise<GatewayTestServerHandle> {
    return createGatewayTestServer({
      acpCommand: "node",
      acpArgs: [mockAgentPath],
      ...(acpEnv ? { acpEnv } : {}),
      // Mount the native AG-UI endpoint against the factory-owned
      // controller so POST /agent streams a real run.
      mountAguiEndpoint: true,
    });
  }

  afterEach(async () => {
    await gateway.stop();
  });

  // Intent: a single SSE run round-trips through the real executor and
  // mock agent, opening with RUN_STARTED and closing with RUN_FINISHED.
  test("POST /agent (SSE) streams RUN_STARTED -> interior -> RUN_FINISHED", async () => {
    gateway = await startGateway();
    const res = await postAgent(gateway.url, "say hello");
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const events: Array<{ type: string }> = [];
    for await (const event of readAguiSseFrames(res.body as ReadableStream<Uint8Array>)) {
      events.push(event as { type: string });
    }

    expect(events.length).toBeGreaterThan(0);
    // RUN_STARTED must be the very first frame on the wire.
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    // RUN_FINISHED must be the terminal frame; nothing follows it.
    expect(events[events.length - 1]?.type).toBe(EventType.RUN_FINISHED);
    expect(events.some((e) => e.type === EventType.RUN_ERROR)).toBe(false);

    // Interior text bracketing proves real agent output flowed through:
    // START precedes END, and any CONTENT sits strictly between them.
    const start = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_START);
    const end = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_END);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
  }, 30_000);

  // Intent: the single-active-run gate rejects an overlapping run. The
  // mock holds the first turn open (MOCK_ACP_PROMPT_DELAY_MS) so the
  // lease is provably still held when the second POST lands.
  test("a second concurrent POST /agent is rejected with 409 Busy", async () => {
    // Stand the gateway with a delayed mock so the first run stays in flight
    // long enough for the second POST to collide with it.
    gateway = await startGateway({ MOCK_ACP_PROMPT_DELAY_MS: "400" });

    // POST #1: start a run and read frames until RUN_STARTED. Once we
    // see it, the coordinator lease is held by this run.
    const first = await postAgent(gateway.url, "hold the turn open");
    expect(first.status).toBe(200);
    const firstStream = first.body as ReadableStream<Uint8Array>;
    const firstFrames = readAguiSseFrames(firstStream);

    const firstStarted = await firstFrames.next();
    expect((firstStarted.value as { type: string } | undefined)?.type).toBe(EventType.RUN_STARTED);

    // POST #2: lands while the first run is active -> single-active-run
    // gate fires before any SSE stream opens.
    const second = await postAgent(gateway.url, "should be rejected");
    expect(second.status).toBe(409);
    const busy = (await second.json()) as { error?: string; activeRunId?: string };
    expect(busy.error).toBe("Busy");
    expect(typeof busy.activeRunId).toBe("string");

    // Drain the first run to its terminal frame so the lease releases
    // cleanly and no stream is left dangling at teardown.
    let firstTerminal: string | undefined;
    for await (const event of firstFrames) {
      firstTerminal = (event as { type: string }).type;
    }
    expect(firstTerminal).toBe(EventType.RUN_FINISHED);
  }, 30_000);
});
