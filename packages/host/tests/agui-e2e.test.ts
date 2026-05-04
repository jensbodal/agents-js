import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AGUITransport } from "@agents-js/a2a-client";
import type { ACPSessionEvent } from "@agents-js/acp-host";
import { EventType } from "@agents-js/agui-types";
import { validateAguiEvent } from "@agents-js/validation";
import { createAguiFetchHandler } from "../src/agui-endpoint.ts";
import {
  buildRunAgentInput,
  createFakeHostController,
  type FakeHostController,
} from "./fake-host-controller.ts";

/**
 * End-to-end coverage for the native AG-UI client transport and server
 * endpoint over a real local HTTP server.
 *
 * AGUITransport.runAgent → Bun.serve → createAguiFetchHandler → fake controller
 *
 * Scripted ACPSessionEvents flow out of the fake controller, through
 * the translator, over the SSE wire, back into the client's parser.
 */

interface ServerHandle {
  baseUrl: string;
  stop: () => void;
  fake: FakeHostController;
}

function startGateway(): ServerHandle {
  const fake = createFakeHostController();
  const handler = createAguiFetchHandler({ controller: fake.controller });
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const response = await handler(req);
      return response ?? new Response("not found", { status: 404 });
    },
  });
  return {
    baseUrl: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
    fake,
  };
}

async function collect(events: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("AGUITransport ↔ /agent endpoint E2E", () => {
  let gateway: ServerHandle;

  beforeEach(() => {
    gateway = startGateway();
  });

  afterEach(() => {
    gateway.stop();
  });

  test("happy path: RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED", async () => {
    gateway.fake.setOnSendPrompt(async () => {
      // Drive the turn asynchronously after sendPrompt returns.
      queueMicrotask(() => {
        gateway.fake.emit({
          type: "session_update",
          notification: {
            sessionId: "sess-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello " },
              messageId: "msg-1",
            },
          },
        } as ACPSessionEvent);
        gateway.fake.emit({
          type: "session_update",
          notification: {
            sessionId: "sess-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "world" },
              messageId: "msg-1",
            },
          },
        } as ACPSessionEvent);
        gateway.fake.emit({ type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent);
      });
    });

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: gateway.baseUrl });
    const run = transport.runAgent(target, buildRunAgentInput("say hi"));
    const events = (await collect(run.events)) as Array<{ type: string }>;

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1]?.type).toBe(EventType.RUN_FINISHED);

    // Every frame round-trips through the spec validator (client-side gate).
    for (const event of events) {
      expect(validateAguiEvent(event).valid).toBe(true);
    }

    // Text bracketing: START before any CONTENT, END before RUN_FINISHED.
    const textStart = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_START);
    const textEnd = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_END);
    const firstContent = events.findIndex((e) => e.type === EventType.TEXT_MESSAGE_CONTENT);
    expect(textStart).toBeGreaterThanOrEqual(0);
    expect(textEnd).toBeGreaterThan(textStart);
    if (firstContent >= 0) {
      expect(firstContent).toBeGreaterThan(textStart);
      expect(firstContent).toBeLessThan(textEnd);
    }
  });

  test("tool-call pairing: TOOL_CALL_START is matched by TOOL_CALL_END", async () => {
    gateway.fake.setOnSendPrompt(async () => {
      queueMicrotask(() => {
        gateway.fake.emit({
          type: "tool_call_start",
          toolCallId: "tc-1",
          toolCallName: "web_search",
        } as ACPSessionEvent);
        gateway.fake.emit({
          type: "tool_call_end",
          toolCallId: "tc-1",
        } as ACPSessionEvent);
        gateway.fake.emit({ type: "turn_completed" } as ACPSessionEvent);
      });
    });

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: gateway.baseUrl });
    const run = transport.runAgent(target, buildRunAgentInput("use a tool"));
    const events = (await collect(run.events)) as Array<{ type: string; toolCallId?: string }>;

    const starts = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    const ends = events.filter((e) => e.type === EventType.TOOL_CALL_END);
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(starts[0]?.toolCallId).toBe("tc-1");
    expect(ends[0]?.toolCallId).toBe("tc-1");

    for (const event of events) {
      expect(validateAguiEvent(event).valid).toBe(true);
    }
  });

  test("threadId echoes from the request when provided", async () => {
    gateway.fake.setOnSendPrompt(async () => {
      queueMicrotask(() => {
        gateway.fake.emit({ type: "turn_completed" } as ACPSessionEvent);
      });
    });

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: gateway.baseUrl });
    const run = transport.runAgent(
      target,
      buildRunAgentInput("hi", { threadId: "client-chosen-thread" }),
    );
    const events = (await collect(run.events)) as Array<{ type: string; threadId?: string }>;

    const started = events.find((e) => e.type === EventType.RUN_STARTED);
    const finished = events.find((e) => e.type === EventType.RUN_FINISHED);
    expect(started?.threadId).toBe("client-chosen-thread");
    expect(finished?.threadId).toBe("client-chosen-thread");
    expect(run.threadId).toBe("client-chosen-thread");
  });

  test("RUN_ERROR surfaces when ACP emits error during the turn", async () => {
    gateway.fake.setOnSendPrompt(async () => {
      queueMicrotask(() => {
        gateway.fake.emit({
          type: "error",
          message: "upstream exploded",
        } as ACPSessionEvent);
      });
    });

    const transport = new AGUITransport();
    const target = await transport.resolveTarget({ url: gateway.baseUrl });
    const run = transport.runAgent(target, buildRunAgentInput("break it"));
    const events = (await collect(run.events)) as Array<{ type: string; message?: string }>;

    expect(events[0]?.type).toBe(EventType.RUN_STARTED);
    const terminal = events[events.length - 1];
    expect(terminal?.type).toBe(EventType.RUN_ERROR);
    expect(terminal?.message).toContain("upstream exploded");
  });
});
