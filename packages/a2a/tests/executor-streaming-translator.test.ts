/**
 * Layer 2 — A2A executor adapter test.
 *
 * Wires `ACPtoA2AExecutor` against a fake ACP harness that emits a
 * deterministic 5-chunk text stream (single-character deltas "H", "e",
 * "l", "l", "o"), then asserts:
 *
 *   - Exactly 5 `Message` events are published (one per chunk) — not 1
 *     collapsed event, not 5 `TaskStatusUpdateEvent`s with cumulative
 *     text. This is the load-bearing assertion: the v0.2.x bug was the
 *     executor publishing per-chunk `TaskStatusUpdateEvent`s with
 *     cumulative text and *zero* `Message` events; the SSE encoder
 *     batched them and the TUI burst-rendered.
 *
 *   - Each `Message` event carries the cumulative text up to that point
 *     ("H", "He", "Hel", "Hell", "Hello"). The provider's
 *     `createDeltaAccumulator` (`packages/a2a-client/src/provider.ts:194-207`)
 *     subtracts successive cumulative texts to compute per-chunk
 *     `message.delta` events.
 *
 * No LLM, no real ACP harness — pure deterministic data-in / event-out.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "@a2a-js/sdk";
import { ndJsonStream } from "@agents-js/acp";
import { ACPtoA2AExecutor } from "../src/executor.ts";

type AcpRequest = {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ExecutorWithSessionIdStore = {
  sessionIdStore: {
    load: () => Promise<Map<string, string>>;
    save: (map: Map<string, string>) => Promise<void>;
  };
};

type RecordedEvent = {
  kind: string;
  messageId?: string;
  parts?: Array<{ kind: string; text?: string }>;
  taskId?: string;
  contextId?: string;
  status?: { state: string; message?: { messageId?: string } };
};

function asAcpRequest(value: unknown): AcpRequest {
  return value as AcpRequest;
}

function createAcpHarness() {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    executorStream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
    agentStream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
  };
}

async function runFakeAcpAgentStreamingChunks(
  agentStream: ReturnType<typeof createAcpHarness>["agentStream"],
  options: { messageId: string; deltas: string[] },
): Promise<void> {
  const reader = agentStream.readable.getReader();
  const writer = agentStream.writable.getWriter();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (!value || typeof value !== "object" || !("method" in value)) continue;
      const req = asAcpRequest(value);
      if (req.method === "initialize") {
        await writer.write({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "fake-agent", version: "1.0.0" },
            agentCapabilities: {
              loadSession: true,
              mcpCapabilities: { http: false, sse: false },
              promptCapabilities: { image: false },
              sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
            },
          },
        });
        continue;
      }
      if (req.method === "session/new") {
        await writer.write({
          jsonrpc: "2.0",
          id: req.id,
          result: { sessionId: "sess-stream" },
        });
        continue;
      }
      if (req.method === "session/prompt") {
        // Emit one session/update per delta. All chunks share messageId.
        for (const delta of options.deltas) {
          await writer.write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: req.params?.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                messageId: options.messageId,
                content: { type: "text", text: delta },
              },
            },
          });
        }
        await writer.write({
          jsonrpc: "2.0",
          id: req.id,
          result: { stopReason: "end_turn", userMessageId: "user-1" },
        });
        await writer.close();
        return;
      }
    }
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

function createEventBus() {
  const events: RecordedEvent[] = [];
  return {
    events,
    eventBus: {
      publish(event: RecordedEvent) {
        events.push(event);
      },
      finished() {
        events.push({ kind: "finished" });
      },
    },
  };
}

function stubSessionIdStore(executor: ACPtoA2AExecutor): void {
  (executor as unknown as ExecutorWithSessionIdStore).sessionIdStore = {
    load: async () => new Map(),
    save: async () => {},
  };
}

describe("ACPtoA2AExecutor — streaming translator integration", () => {
  test("publishes one Message event per chunk, each carrying cumulative text", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();

    const messageId = "agent-msg-1";
    const deltas = ["H", "e", "l", "l", "o"];

    const agentTask = runFakeAcpAgentStreamingChunks(harness.agentStream, {
      messageId,
      deltas,
    });

    await executor.execute(
      {
        taskId: "task-stream",
        contextId: "ctx-stream",
        userMessage: {
          kind: "message",
          messageId: "user-1",
          role: "user",
          parts: [{ kind: "text", text: "stream me" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    // Filter for streaming Message events (kind === "message"). The
    // terminal-task path also publishes a Task with an agent message in
    // its history, but that's `kind === "task"` — won't match here.
    const messageEvents = events.filter((e): e is Message & RecordedEvent => e.kind === "message");

    // Load-bearing: exactly N=5 streaming events for N=5 chunks. Not 1
    // collapsed event (the v0.2.x bug shape: 0 Message events, all
    // text shoved into status updates with cumulative text). Not 5
    // status updates either — the new shape is one Message per chunk.
    expect(messageEvents).toHaveLength(deltas.length);

    const cumulativeTexts = ["H", "He", "Hel", "Hell", "Hello"];
    for (let i = 0; i < deltas.length; i += 1) {
      const event = messageEvents[i];
      expect(event).toBeDefined();
      expect(event?.parts?.[0]?.kind).toBe("text");
      expect(event?.parts?.[0]?.text).toBe(cumulativeTexts[i]);
      expect(event?.messageId).toBe(messageId);
      expect(event?.taskId).toBe("task-stream");
      expect(event?.contextId).toBe("ctx-stream");
    }
  });

  test("does not collapse chunks into status-update events with cumulative text (v0.2.x regression guard)", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();

    const agentTask = runFakeAcpAgentStreamingChunks(harness.agentStream, {
      messageId: "m1",
      deltas: ["a", "b", "c"],
    });

    await executor.execute(
      {
        taskId: "t-regress",
        contextId: "c-regress",
        userMessage: {
          kind: "message",
          messageId: "user-r",
          role: "user",
          parts: [{ kind: "text", text: "go" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    // The v0.2.x bug shape: per-chunk status-updates carrying cumulative
    // text. After the fix, status-updates are reserved for lifecycle
    // (working / input-required / etc.), not per-chunk text emission.
    const perChunkStatusUpdates = events.filter(
      (e) =>
        e.kind === "status-update" &&
        e.status?.state === "working" &&
        e.status?.message !== undefined,
    );
    // The single "working" status update at task start carries no
    // message text, so the count here should be 0.
    expect(perChunkStatusUpdates).toHaveLength(0);
  });
});
