import { afterEach, describe, expect, test } from "bun:test";
import { type SendMessageRequest, type Task, TaskState } from "@a2a-js/sdk";
import { EventType } from "@agents-js/agui-types";
import { AGUITransport } from "../src/transports/agui.ts";
import { AguiToA2ATransportAdapter } from "../src/transports/agui-a2a-adapter.ts";
import { AGUIUnsupportedOperationError } from "../src/transports/agui-errors.ts";
import type { A2AStreamPayload } from "../src/types.ts";
import { makeMessage, makeTextPart } from "./mock-a2a-transport.ts";

/** Narrow an emitted stream element to a wrapped Task payload. */
function isTaskPayload(e: unknown): e is Extract<A2AStreamPayload, { $case: "task" }> {
  return typeof e === "object" && e !== null && (e as { $case?: string }).$case === "task";
}

interface ServerHandle {
  stop: () => void;
  url: string;
}

function startServer(frames: string[]): ServerHandle {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }
      if (req.method === "POST" && url.pathname === "/agent") {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            for (const f of frames) {
              controller.enqueue(encoder.encode(f));
              await new Promise((r) => setTimeout(r, 0));
            }
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  return { stop: () => server.stop(true), url: `http://127.0.0.1:${server.port}` };
}

function frame(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function mkParams(text: string): SendMessageRequest {
  return {
    tenant: "",
    configuration: undefined,
    metadata: undefined,
    message: makeMessage({
      messageId: "msg-1",
      parts: [makeTextPart(text)],
      contextId: "ctx-from-caller",
    }),
  };
}

const handles: ServerHandle[] = [];
afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.stop();
  }
});

describe("AguiToA2ATransportAdapter", () => {
  test("sendMessageStream synthesizes initial + terminal tasks", async () => {
    const server = startServer([
      frame({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" }),
      frame({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" }),
    ]);
    handles.push(server);

    const inner = new AGUITransport();
    const adapter = new AguiToA2ATransportAdapter(inner);
    const target = await adapter.resolveTarget({ url: server.url });

    const emitted: unknown[] = [];
    for await (const event of adapter.sendMessageStream(target, mkParams("hi"))) {
      emitted.push(event);
    }

    // Expect: run.started, Task(working), run.finished, Task(completed)
    expect(emitted).toHaveLength(4);
    const tasks = emitted.filter(isTaskPayload);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]?.value.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(tasks[1]?.value.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const stream = emitted.filter(
      (e) => typeof e === "object" && e !== null && (e as { type?: string }).type,
    ) as Array<{ type: string }>;
    expect(stream.map((e) => e.type)).toEqual(["run.started", "run.finished"]);
  });

  test("sendMessageStream synthesizes failed task on RUN_ERROR", async () => {
    const server = startServer([
      frame({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" }),
      frame({ type: EventType.RUN_ERROR, message: "kaboom", code: "E_X" }),
    ]);
    handles.push(server);

    const adapter = new AguiToA2ATransportAdapter(new AGUITransport());
    const target = await adapter.resolveTarget({ url: server.url });
    const emitted: unknown[] = [];
    for await (const event of adapter.sendMessageStream(target, mkParams("hi"))) {
      emitted.push(event);
    }

    const tasks = emitted.filter(isTaskPayload);
    expect(tasks).toHaveLength(2);
    expect(tasks[1]?.value.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const statusMessage = tasks[1]?.value.status?.message;
    expect(statusMessage).toBeDefined();
  });

  test("sendMessage collapses stream into terminal Task", async () => {
    const server = startServer([
      frame({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" }),
      frame({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" }),
    ]);
    handles.push(server);

    const adapter = new AguiToA2ATransportAdapter(new AGUITransport());
    const target = await adapter.resolveTarget({ url: server.url });
    const result = await adapter.sendMessage(target, mkParams("hi"));
    expect("id" in result).toBe(true);
    expect((result as Task).status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  test("maps TOOL_CALL_* events to A2A tool_call.* events", async () => {
    const server = startServer([
      frame({ type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" }),
      frame({ type: EventType.TOOL_CALL_START, toolCallId: "tc-1", toolCallName: "search" }),
      frame({ type: EventType.TOOL_CALL_ARGS, toolCallId: "tc-1", delta: '{"q":' }),
      frame({ type: EventType.TOOL_CALL_END, toolCallId: "tc-1" }),
      frame({ type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" }),
    ]);
    handles.push(server);

    const adapter = new AguiToA2ATransportAdapter(new AGUITransport());
    const target = await adapter.resolveTarget({ url: server.url });
    const stream: Array<{ type?: string; toolCallId?: string; argsChunk?: string }> = [];
    for await (const event of adapter.sendMessageStream(target, mkParams("hi"))) {
      const anyEv = event as { type?: string; toolCallId?: string; argsChunk?: string };
      if (anyEv.type?.startsWith("tool_call")) {
        stream.push(anyEv);
      }
    }
    expect(stream.map((e) => e.type)).toEqual([
      "tool_call.start",
      "tool_call.args",
      "tool_call.end",
    ]);
    expect(stream[1]?.argsChunk).toBe('{"q":');
  });

  test("task-only operations throw AGUIUnsupportedOperationError", async () => {
    const server = startServer([]);
    handles.push(server);
    const adapter = new AguiToA2ATransportAdapter(new AGUITransport());
    const target = await adapter.resolveTarget({ url: server.url });

    await expect(adapter.getTask(target, { tenant: "", id: "x" })).rejects.toBeInstanceOf(
      AGUIUnsupportedOperationError,
    );
    await expect(
      adapter.cancelTask(target, { tenant: "", id: "x", metadata: undefined }),
    ).rejects.toBeInstanceOf(AGUIUnsupportedOperationError);
    await expect(
      adapter.resubscribeTask(target, { tenant: "", id: "x" }).next(),
    ).rejects.toBeInstanceOf(AGUIUnsupportedOperationError);
    await expect(
      adapter.setTaskPushNotificationConfig(target, {
        tenant: "",
        id: "p",
        taskId: "x",
        url: "https://example.com",
        token: "",
        authentication: undefined,
      }),
    ).rejects.toBeInstanceOf(AGUIUnsupportedOperationError);
    await expect(
      adapter.getTaskPushNotificationConfig(target, { tenant: "", taskId: "x", id: "p" }),
    ).rejects.toBeInstanceOf(AGUIUnsupportedOperationError);
    await expect(
      adapter.listTaskPushNotificationConfigs(target, {
        tenant: "",
        taskId: "x",
        pageSize: 0,
        pageToken: "",
      }),
    ).rejects.toBeInstanceOf(AGUIUnsupportedOperationError);
    await expect(
      adapter.deleteTaskPushNotificationConfig(target, { tenant: "", taskId: "x", id: "p" }),
    ).rejects.toBeInstanceOf(AGUIUnsupportedOperationError);
  });

  test("getExtendedAgentCard returns the synthesized base card", async () => {
    const server = startServer([]);
    handles.push(server);
    const adapter = new AguiToA2ATransportAdapter(new AGUITransport());
    const target = await adapter.resolveTarget({ url: server.url });
    const card = await adapter.getExtendedAgentCard(target);
    expect(card).toBe(target.card);
  });
});
