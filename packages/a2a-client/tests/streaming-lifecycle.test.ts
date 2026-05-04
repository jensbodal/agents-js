import { describe, expect, test } from "bun:test";
import type { Message, Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { A2AClientProvider } from "../src/index.ts";
import type { A2AEvent, A2ATransport, ResolvedAgentTarget } from "../src/types.ts";
import { createMockTarget, createStreamingMockTransport } from "./mock-a2a-transport.ts";

function makeStreamingTarget(url: string): ResolvedAgentTarget {
  const target = createMockTarget(url);
  target.capabilities.supportsStreaming = true;
  return target;
}

class DelayedStreamingTransport {
  streamEvents: Array<{ delayMs: number; event: Task | TaskStatusUpdateEvent | Message }> = [];

  async resolveTarget(input: { url: string }): Promise<ResolvedAgentTarget> {
    return makeStreamingTarget(input.url);
  }
  async inspectTarget() {
    return { status: "ready" as const };
  }
  async sendMessage(): Promise<Message> {
    throw new Error("non-streaming sendMessage not used");
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
  async cancelTask(): Promise<Task> {
    throw new Error("not implemented");
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

describe("Streaming lifecycle events (WP4)", () => {
  test("streaming send emits request.sent → stream.opened → first_event → last_event → closed in order", async () => {
    const transport = createStreamingMockTransport([
      {
        kind: "task",
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
        history: [
          {
            kind: "message",
            messageId: "m1",
            role: "agent",
            parts: [{ kind: "text", text: "ok" }],
          },
        ],
      } satisfies Task,
    ]);

    const provider = new A2AClientProvider(transport);
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });

    const events: A2AEvent[] = [];
    provider.subscribe((event) => events.push(event));

    await provider.sendTurn(target, "hi");

    const types = events.map((e) => e.type);
    const firstIdx = types.indexOf("request.sent");
    const openedIdx = types.indexOf("stream.opened");
    const firstEventIdx = types.indexOf("stream.first_event");
    const lastEventIdx = types.indexOf("stream.last_event");
    const closedIdx = types.indexOf("stream.closed");

    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(openedIdx).toBeGreaterThan(firstIdx);
    expect(firstEventIdx).toBeGreaterThan(openedIdx);
    expect(lastEventIdx).toBeGreaterThanOrEqual(firstEventIdx);
    expect(closedIdx).toBeGreaterThan(lastEventIdx);

    const closed = events.find((e) => e.type === "stream.closed");
    if (closed?.type === "stream.closed") {
      expect(closed.reason).toBe("completed");
    }
  });

  test("non-streaming send emits request.sent (streaming=false) but no stream.* events", async () => {
    // The default mock target has supportsStreaming=false so this exercises
    // the non-streaming path directly.
    const transport: A2ATransport = {
      async resolveTarget(input) {
        return createMockTarget(input.url);
      },
      async inspectTarget() {
        return { status: "ready" };
      },
      async sendMessage() {
        return {
          kind: "message",
          messageId: "m1",
          role: "agent",
          parts: [{ kind: "text", text: "pong" }],
        } as Message;
      },
      async *sendMessageStream() {},
      async getTask() {
        throw new Error("not implemented");
      },
      async cancelTask() {
        throw new Error("not implemented");
      },
      async *resubscribeTask() {},
      async setTaskPushNotificationConfig() {
        throw new Error("not implemented");
      },
      async getTaskPushNotificationConfig() {
        throw new Error("not implemented");
      },
      async listTaskPushNotificationConfigs() {
        throw new Error("not implemented");
      },
      async deleteTaskPushNotificationConfig() {},
      async getExtendedAgentCard() {
        throw new Error("not implemented");
      },
      async probe() {
        return [];
      },
      subscribeDebug() {
        return () => {};
      },
    };

    const provider = new A2AClientProvider(transport);
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });

    const events: A2AEvent[] = [];
    provider.subscribe((event) => events.push(event));

    await provider.sendTurn(target, "hi");

    const types = events.map((e) => e.type);
    expect(types).toContain("request.sent");
    expect(types).not.toContain("stream.opened");
    expect(types).not.toContain("stream.first_event");
    expect(types).not.toContain("stream.closed");

    const requestSent = events.find((e) => e.type === "request.sent");
    if (requestSent?.type === "request.sent") {
      expect(requestSent.streaming).toBe(false);
      expect(typeof requestSent.timestamp).toBe("string");
    }
  });

  test("idle threshold emits stream.idle when stream goes silent past threshold", async () => {
    const transport = new DelayedStreamingTransport();
    transport.streamEvents = [
      // First event arrives quickly so we set firstEventSeen=true and start
      // the idle timer. Then a long gap before the terminal task to allow
      // idle to fire.
      {
        delayMs: 5,
        event: {
          kind: "status-update",
          taskId: "task-1",
          contextId: "ctx-1",
          status: { state: "working", message: undefined },
          final: false,
        } satisfies TaskStatusUpdateEvent,
      },
      {
        delayMs: 80,
        event: {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "completed" },
          history: [
            {
              kind: "message",
              messageId: "m1",
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

    // Use a tight idle threshold so we can observe it firing during the
    // 80ms gap above.
    await provider.sendTurn(target, "hi", { idleThresholdMs: 25 });

    const types = events.map((e) => e.type);
    expect(types).toContain("stream.idle");

    const idle = events.find((e) => e.type === "stream.idle");
    if (idle?.type === "stream.idle") {
      expect(idle.thresholdMs).toBe(25);
    }
  });

  test("stream.idle does NOT fire when events arrive faster than threshold", async () => {
    const transport = new DelayedStreamingTransport();
    transport.streamEvents = [
      {
        delayMs: 0,
        event: {
          kind: "status-update",
          taskId: "task-1",
          contextId: "ctx-1",
          status: { state: "working", message: undefined },
          final: false,
        } satisfies TaskStatusUpdateEvent,
      },
      {
        delayMs: 5,
        event: {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "completed" },
          history: [
            {
              kind: "message",
              messageId: "m1",
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

    await provider.sendTurn(target, "hi", { idleThresholdMs: 100 });
    expect(events.map((e) => e.type)).not.toContain("stream.idle");
  });

  test("idleThresholdMs=0 (default) disables idle detection", async () => {
    const transport = new DelayedStreamingTransport();
    transport.streamEvents = [
      {
        delayMs: 50,
        event: {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "completed" },
        } satisfies Task,
      },
    ];

    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });

    const events: A2AEvent[] = [];
    provider.subscribe((event) => events.push(event));

    await provider.sendTurn(target, "hi"); // no idleThresholdMs
    expect(events.map((e) => e.type)).not.toContain("stream.idle");
  });

  test("aborted stream emits stream.closed with reason='aborted'", async () => {
    const transport = new DelayedStreamingTransport();
    transport.streamEvents = [
      {
        delayMs: 5,
        event: {
          kind: "status-update",
          taskId: "task-1",
          contextId: "ctx-1",
          status: { state: "working", message: undefined },
          final: false,
        } satisfies TaskStatusUpdateEvent,
      },
      {
        delayMs: 200,
        event: {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "completed" },
        } satisfies Task,
      },
    ];

    const provider = new A2AClientProvider(transport as unknown as A2ATransport);
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });

    const events: A2AEvent[] = [];
    provider.subscribe((event) => events.push(event));

    const ac = new AbortController();
    setTimeout(() => ac.abort("test cancel"), 30);

    await expect(provider.sendTurn(target, "hi", { signal: ac.signal })).rejects.toThrow();

    const closed = events.find((e) => e.type === "stream.closed");
    expect(closed).toBeDefined();
    if (closed?.type === "stream.closed") {
      expect(closed.reason).toBe("aborted");
    }
  });
});
