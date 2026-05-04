import { describe, expect, test } from "bun:test";
import type { Message, Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { A2AClientController, A2AClientProvider } from "../src/index.ts";
import type { A2AEvent, A2ATransport, ResolvedAgentTarget } from "../src/types.ts";
import { createMockTarget, createStreamingMockTransport } from "./mock-a2a-transport.ts";

function makeStreamingTarget(url: string): ResolvedAgentTarget {
  const target = createMockTarget(url);
  target.capabilities.supportsStreaming = true;
  return target;
}

class StreamingTaskMockTransport {
  readonly cancelCalls: Array<{ id: string }> = [];
  // Streaming events to deliver. Test populates this to control timing.
  streamEvents: Array<{ delayMs: number; event: Task | TaskStatusUpdateEvent | Message }> = [];

  async resolveTarget(input: { url: string }): Promise<ResolvedAgentTarget> {
    return makeStreamingTarget(input.url);
  }
  async inspectTarget() {
    return { status: "ready" as const };
  }
  async sendMessage(): Promise<Message> {
    throw new Error("non-streaming sendMessage not used in this test");
  }
  async *sendMessageStream(): AsyncGenerator<Task | TaskStatusUpdateEvent | Message> {
    for (const item of this.streamEvents) {
      if (item.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, item.delayMs));
      }
      yield item.event;
    }
  }
  async getTask(): Promise<Task> {
    throw new Error("not implemented");
  }
  async cancelTask(_target: ResolvedAgentTarget, params: { id: string }): Promise<Task> {
    this.cancelCalls.push(params);
    return {
      kind: "task",
      id: params.id,
      contextId: "ctx-1",
      status: { state: "canceled" },
    };
  }
  async *resubscribeTask(): AsyncGenerator<Task | TaskStatusUpdateEvent | Message> {}
  async setTaskPushNotificationConfig() {
    throw new Error("not implemented");
  }
  async getTaskPushNotificationConfig() {
    throw new Error("not implemented");
  }
  async listTaskPushNotificationConfigs() {
    throw new Error("not implemented");
  }
  async deleteTaskPushNotificationConfig() {}
  async getExtendedAgentCard(): Promise<never> {
    throw new Error("not implemented");
  }
  async probe() {
    return [];
  }
  subscribeDebug() {
    return () => {};
  }
}

describe("AbortSignal propagation (WP2)", () => {
  test("already-aborted signal short-circuits sendTurn before transport call", async () => {
    const transport = createStreamingMockTransport([]);
    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });

    const events: A2AEvent[] = [];
    provider.subscribe((event) => events.push(event));

    const controller = new AbortController();
    controller.abort("user cancel");

    await expect(provider.sendTurn(target, "hi", { signal: controller.signal })).rejects.toThrow();

    const types = events.map((event) => event.type);
    expect(types).toContain("abort.send");
    // Critically: no run.started / turn.started before the abort short-circuit.
    expect(types).not.toContain("turn.started");
    expect(types).not.toContain("run.started");
    expect(types).not.toContain("message.completed");

    const abortEvent = events.find((event) => event.type === "abort.send");
    expect(abortEvent?.type).toBe("abort.send");
    if (abortEvent?.type === "abort.send") {
      expect(abortEvent.reason).toBe("user cancel");
    }
  });

  test("mid-stream abort breaks out of stream loop and emits abort.stream", async () => {
    const transport = new StreamingTaskMockTransport();
    transport.streamEvents = [
      {
        delayMs: 0,
        event: {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "working" },
        } satisfies Task,
      },
      {
        delayMs: 50,
        event: {
          kind: "status-update",
          taskId: "task-1",
          contextId: "ctx-1",
          status: { state: "working", message: undefined },
          final: false,
        } satisfies TaskStatusUpdateEvent,
      },
      {
        delayMs: 50,
        event: {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "completed" },
          history: [
            {
              kind: "message",
              messageId: "msg-1",
              role: "agent",
              parts: [{ kind: "text", text: "done" }],
            },
          ],
        } satisfies Task,
      },
    ];

    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });

    const events: A2AEvent[] = [];
    provider.subscribe((event) => events.push(event));

    const controller = new AbortController();
    // Abort after the first event has been processed but before completion.
    setTimeout(() => controller.abort("mid-stream cancel"), 25);

    await expect(provider.sendTurn(target, "hi", { signal: controller.signal })).rejects.toThrow();

    const types = events.map((event) => event.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("abort.stream");
    expect(types).not.toContain("message.completed");
  });

  test("controller forwards signal to provider and reflects abort state", async () => {
    const transport = createStreamingMockTransport([]);
    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const controller = new A2AClientController({ provider });
    await controller.connect({ url: "http://127.0.0.1:55363" });

    const ac = new AbortController();
    ac.abort("pre-abort");

    await expect(controller.sendTurn("hi", { signal: ac.signal })).rejects.toThrow();
    // Session reducer flips status back to "connected" on abort.send so the
    // turn-in-flight state is cleared.
    expect(controller.getState().status).toBe("connected");
    expect(controller.getState().lastError).toBeUndefined();
  });

  test("non-aborted signal does not interfere with normal send", async () => {
    const transport = createStreamingMockTransport([
      {
        kind: "task",
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
        history: [
          {
            kind: "message",
            messageId: "msg-1",
            role: "agent",
            parts: [{ kind: "text", text: "ok" }],
          },
        ],
      } satisfies Task,
    ]);
    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });

    const events: A2AEvent[] = [];
    provider.subscribe((event) => events.push(event));

    const ac = new AbortController(); // never aborted
    const result = await provider.sendTurn(target, "hi", { signal: ac.signal });

    const types = events.map((event) => event.type);
    expect(types).toContain("message.completed");
    expect(types).not.toContain("abort.send");
    expect(types).not.toContain("abort.stream");
    expect(result).toBeDefined();
  });
});

describe("Structured cancellation events (WP3)", () => {
  test("controller.cancelTask emits cancellation.requested + cancellation.succeeded on success", async () => {
    const transport = new StreamingTaskMockTransport();
    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const controller = new A2AClientController({ provider });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-1");

    const events: A2AEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const result = await controller.cancelTask();
    expect(result.outcome).toBe("canceled");

    const types = events.map((event) => event.type);
    expect(types).toContain("cancellation.requested");
    expect(types).toContain("cancellation.succeeded");
    expect(types).toContain("task.updated");
    expect(types).not.toContain("cancellation.failed");
  });

  test("controller.cancelTask emits cancellation.failed when transport rejects", async () => {
    const transport = new StreamingTaskMockTransport();
    transport.cancelTask = async () => {
      throw new Error("server refused");
    };
    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const controller = new A2AClientController({ provider });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-1");

    const events: A2AEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const result = await controller.cancelTask();
    expect(result.outcome).toBe("failed");

    const types = events.map((event) => event.type);
    expect(types).toContain("cancellation.requested");
    expect(types).toContain("cancellation.failed");
    expect(types).not.toContain("cancellation.succeeded");

    const failed = events.find((event) => event.type === "cancellation.failed");
    expect(failed?.type).toBe("cancellation.failed");
    if (failed?.type === "cancellation.failed") {
      expect(failed.error).toContain("server refused");
      expect(failed.taskId).toBe("task-1");
    }
  });

  test("cancellation.failed populates session.lastError so UI can show diagnostics", async () => {
    const transport = new StreamingTaskMockTransport();
    transport.cancelTask = async () => {
      throw new Error("network unreachable");
    };
    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const controller = new A2AClientController({ provider });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-1");

    await controller.cancelTask();
    expect(controller.getState().lastError).toContain("network unreachable");
  });
});
