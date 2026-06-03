import { describe, expect, test } from "bun:test";
import { Role, TaskState } from "@a2a-js/sdk";
import { A2AClientProvider } from "../src/index.ts";
import type { A2AEvent, A2AMessageDeltaEvent } from "../src/types.ts";
import {
  createStreamingMockTransport,
  makeMessage,
  makeTextPart,
  type StreamItem,
  statusEvent,
  taskEvent,
} from "./mock-a2a-transport.ts";

/**
 * Reasoning and message tracking regressions:
 *
 * reasoning.start / reasoning.end events that arrive without an explicit
 * `messageId` should be enriched with the currently-active agent messageId so
 * consumers can correlate them to the right assistant message.
 *
 * Multiple anonymous (messageId-less) message updates within a single
 * stream must not share a delta accumulator bucket. Two successive anonymous
 * messages previously cross-contaminated each other's delta computation.
 */

function terminalTask(taskId: string, contextId: string, finalText: string): StreamItem {
  return taskEvent({
    id: taskId,
    contextId,
    state: TaskState.TASK_STATE_COMPLETED,
    history: [
      makeMessage({
        messageId: `msg-${taskId}-final`,
        role: Role.ROLE_AGENT,
        parts: [makeTextPart(finalText)],
      }),
    ],
  });
}

function statusUpdate(
  taskId: string,
  contextId: string,
  messageId: string | undefined,
  text: string,
  final = false,
): StreamItem {
  return statusEvent({
    taskId,
    contextId,
    state: final ? TaskState.TASK_STATE_COMPLETED : TaskState.TASK_STATE_WORKING,
    message: makeMessage({
      role: Role.ROLE_AGENT,
      ...(messageId !== undefined ? { messageId } : {}),
      parts: [makeTextPart(text)],
    }),
  });
}

async function runStream(streamResults: StreamItem[]): Promise<A2AEvent[]> {
  const provider = new A2AClientProvider(createStreamingMockTransport(streamResults));
  const target = await provider.connect({ url: "http://127.0.0.1:55363" });
  const events: A2AEvent[] = [];
  provider.subscribe((event) => {
    events.push(event);
  });
  await provider.sendTurn(target, "hi");
  return events;
}

describe("A3 — reasoning.start/end get enriched with current agent messageId", () => {
  test("reasoning.start without messageId picks up the active agent messageId", async () => {
    const events = await runStream([
      statusUpdate("task-1", "ctx-1", "msg-A", "partial"),
      { type: "reasoning.start" },
      terminalTask("task-1", "ctx-1", "partial answer"),
    ]);

    const reasoningStart = events.find((e) => e.type === "reasoning.start");
    expect(reasoningStart).toBeDefined();
    if (reasoningStart?.type === "reasoning.start") {
      expect(reasoningStart.messageId).toBe("msg-A");
    }
  });

  test("reasoning.end without messageId picks up the active agent messageId", async () => {
    const events = await runStream([
      statusUpdate("task-1", "ctx-1", "msg-B", "thinking"),
      { type: "reasoning.end" },
      terminalTask("task-1", "ctx-1", "final"),
    ]);

    const reasoningEnd = events.find((e) => e.type === "reasoning.end");
    if (reasoningEnd?.type === "reasoning.end") {
      expect(reasoningEnd.messageId).toBe("msg-B");
    }
  });

  test("reasoning.start with an explicit messageId is passed through unchanged", async () => {
    const events = await runStream([
      statusUpdate("task-1", "ctx-1", "msg-active", "p"),
      { type: "reasoning.start", messageId: "reasoning-self" },
      terminalTask("task-1", "ctx-1", "done"),
    ]);

    const reasoningStart = events.find((e) => e.type === "reasoning.start");
    if (reasoningStart?.type === "reasoning.start") {
      expect(reasoningStart.messageId).toBe("reasoning-self");
    }
  });

  test("reasoning.start before any message sees undefined messageId (no active message yet)", async () => {
    const events = await runStream([
      { type: "reasoning.start" },
      terminalTask("task-1", "ctx-1", "hello"),
    ]);

    const reasoningStart = events.find((e) => e.type === "reasoning.start");
    if (reasoningStart?.type === "reasoning.start") {
      expect(reasoningStart.messageId).toBeUndefined();
    }
  });
});

describe("B3 — distinct messages do not cross-contaminate delta computation", () => {
  test("two messages with distinct ids each emit their full text as the delta", async () => {
    // A2A 1.0 messages always carry a messageId (the proto field is a required
    // string), so the prior "anonymous message" path no longer exists. The
    // invariant that survives: two messages with DISTINCT ids each get their own
    // delta bucket — the second is not prefix-subtracted against the first.
    const events = await runStream([
      statusUpdate("task-1", "ctx-1", "msg-A", "Hello"),
      statusUpdate("task-1", "ctx-1", "msg-B", "World"),
      terminalTask("task-1", "ctx-1", "World"),
    ]);

    const deltas = events.filter((e): e is A2AMessageDeltaEvent => e.type === "message.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);

    const first = deltas[0];
    const second = deltas[1];

    expect(first?.messageId).toBe("msg-A");
    expect(first?.text).toBe("Hello");
    expect(first?.delta).toBe("Hello");

    expect(second?.messageId).toBe("msg-B");
    expect(second?.text).toBe("World");
    expect(second?.delta).toBe("World");
  });

  test("named messages still get incremental delta; anonymous messages in between do not poison state", async () => {
    const events = await runStream([
      statusUpdate("task-1", "ctx-1", "msg-named", "hel"),
      statusUpdate("task-1", "ctx-1", undefined, "anon"),
      statusUpdate("task-1", "ctx-1", "msg-named", "hello"),
      terminalTask("task-1", "ctx-1", "hello"),
    ]);

    const deltas = events.filter((e): e is A2AMessageDeltaEvent => e.type === "message.delta");
    const namedDeltas = deltas.filter((d) => d.messageId === "msg-named");

    // First named update: full text as delta
    expect(namedDeltas[0]?.text).toBe("hel");
    expect(namedDeltas[0]?.delta).toBe("hel");
    // Second named update: incremental chunk ("lo")
    expect(namedDeltas[1]?.text).toBe("hello");
    expect(namedDeltas[1]?.delta).toBe("lo");
  });
});
