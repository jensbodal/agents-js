import { afterEach, describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@agents-js/agui-types";
import { EventType } from "@agents-js/agui-types";
import { AGUITransport } from "../src/transports/agui.ts";
import { AGUIStreamError } from "../src/transports/agui-errors.ts";

type SseScript =
  | { kind: "events"; frames: string[] }
  | { kind: "status"; status: number; body: string };

interface ServerHandle {
  stop: () => void;
  url: string;
  requests: Array<{ body: RunAgentInput; headers: Record<string, string> }>;
}

function startFakeAguiServer(script: SseScript): ServerHandle {
  const requests: ServerHandle["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      if (req.method === "POST" && url.pathname === "/agent") {
        const body = (await req.json()) as RunAgentInput;
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          headers[k] = v;
        });
        requests.push({ body, headers });

        if (script.kind === "status") {
          return new Response(script.body, { status: script.status });
        }

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const frame of script.frames) {
              controller.enqueue(encoder.encode(frame));
              // Yield so parser can process incrementally.
              await new Promise((r) => setTimeout(r, 0));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    stop: () => server.stop(true),
    url: `http://127.0.0.1:${server.port}`,
    requests,
  };
}

const handles: ServerHandle[] = [];
afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.stop();
  }
});

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function mkInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [{ id: "m1", role: "user", content: "hello" }],
    tools: [],
    context: [],
    state: undefined,
    forwardedProps: undefined,
    ...overrides,
  };
}

describe("AGUITransport.runAgent", () => {
  test("streams RUN_STARTED + TEXT chunks + RUN_FINISHED", async () => {
    const server = startFakeAguiServer({
      kind: "events",
      frames: [
        frame({ type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" }),
        frame({ type: EventType.TEXT_MESSAGE_START, messageId: "mm", role: "assistant" }),
        frame({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "mm", delta: "hello" }),
        frame({ type: EventType.TEXT_MESSAGE_END, messageId: "mm" }),
        frame({ type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" }),
      ],
    });
    handles.push(server);

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: server.url });
    const result = transport.runAgent(target, mkInput());

    const events: unknown[] = [];
    for await (const event of result.events) {
      events.push(event);
    }

    expect(result.threadId).toBe("thread-1");
    expect(result.runId).toBe("run-1");
    expect(events).toHaveLength(5);
    expect((events[0] as { type: string }).type).toBe(EventType.RUN_STARTED);
    expect((events[4] as { type: string }).type).toBe(EventType.RUN_FINISHED);

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.headers.accept).toBe("text/event-stream");
    expect(server.requests[0]?.body.threadId).toBe("thread-1");
  });

  test("streams RUN_ERROR as terminal event", async () => {
    const server = startFakeAguiServer({
      kind: "events",
      frames: [
        frame({ type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" }),
        frame({ type: EventType.RUN_ERROR, message: "boom", code: "E_TEST" }),
      ],
    });
    handles.push(server);

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: server.url });
    const result = transport.runAgent(target, mkInput());
    const events: unknown[] = [];
    for await (const event of result.events) {
      events.push(event);
    }
    expect(events).toHaveLength(2);
    expect((events[1] as { type: string }).type).toBe(EventType.RUN_ERROR);
  });

  test("throws AGUIStreamError on HTTP 4xx", async () => {
    const server = startFakeAguiServer({
      kind: "status",
      status: 400,
      body: JSON.stringify({ error: "bad request" }),
    });
    handles.push(server);

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: server.url });
    const gen = transport.runAgent(target, mkInput()).events;
    let err: unknown;
    try {
      for await (const _ of gen) {
        // drain
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AGUIStreamError);
    expect((err as Error).message).toContain("400");
  });

  test("rejects events after terminal RUN_FINISHED", async () => {
    const server = startFakeAguiServer({
      kind: "events",
      frames: [
        frame({ type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" }),
        frame({ type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" }),
        frame({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m", delta: "late" }),
      ],
    });
    handles.push(server);

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: server.url });
    const gen = transport.runAgent(target, mkInput()).events;
    let err: unknown;
    try {
      for await (const _ of gen) {
        // drain
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AGUIStreamError);
  });

  test("rejects non-RUN_STARTED first event", async () => {
    const server = startFakeAguiServer({
      kind: "events",
      frames: [frame({ type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m", delta: "oops" })],
    });
    handles.push(server);

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: server.url });
    const gen = transport.runAgent(target, mkInput()).events;
    let err: unknown;
    try {
      for await (const _ of gen) {
        // drain
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AGUIStreamError);
  });

  test("rejects streams closed without terminal event", async () => {
    const server = startFakeAguiServer({
      kind: "events",
      frames: [frame({ type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" })],
    });
    handles.push(server);

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: server.url });
    const gen = transport.runAgent(target, mkInput()).events;
    let err: unknown;
    try {
      for await (const _ of gen) {
        // drain
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AGUIStreamError);
  });

  test("applies static headers from constructor", async () => {
    const server = startFakeAguiServer({
      kind: "events",
      frames: [
        frame({ type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" }),
        frame({ type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" }),
      ],
    });
    handles.push(server);

    const transport = new AGUITransport({ headers: { "x-test": "yes" } });
    const target = await transport.resolveTarget({ url: server.url });
    const gen = transport.runAgent(target, mkInput()).events;
    for await (const _ of gen) {
      // drain
    }
    expect(server.requests[0]?.headers["x-test"]).toBe("yes");
  });

  test("emits outbound + inbound debug records for the request", async () => {
    const server = startFakeAguiServer({
      kind: "events",
      frames: [
        frame({ type: EventType.RUN_STARTED, threadId: "thread-1", runId: "run-1" }),
        frame({ type: EventType.RUN_FINISHED, threadId: "thread-1", runId: "run-1" }),
      ],
    });
    handles.push(server);

    const transport = new AGUITransport();
    const records: Array<{ direction: string; method: string }> = [];
    transport.subscribeDebug((r) => records.push({ direction: r.direction, method: r.method }));

    const target = await transport.resolveTarget({ url: server.url });
    const gen = transport.runAgent(target, mkInput()).events;
    for await (const _ of gen) {
      // drain
    }

    const http = records.filter((r) => r.method === "POST");
    expect(http.some((r) => r.direction === "outbound")).toBe(true);
    expect(http.some((r) => r.direction === "inbound")).toBe(true);
  });

  test("inspectTarget reports ready when probe succeeds", async () => {
    const server = startFakeAguiServer({
      kind: "events",
      frames: [],
    });
    handles.push(server);

    const transport = new AGUITransport();
    const inspection = await transport.inspectTarget({ url: server.url });
    expect(inspection.status).toBe("ready");
    expect(inspection.results?.some((r) => r.ok)).toBe(true);
  });
});
