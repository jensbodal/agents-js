import { describe, expect, test } from "bun:test";
import type { Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { A2AClientProvider } from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/session.ts";
import type { A2AEvent, A2AMessageDeltaEvent } from "../src/types.ts";
import { createStreamingMockTransport, type StreamItem } from "./mock-a2a-transport.ts";

/**
 * Wave 3.4 — `message.delta` carries an incremental chunk via the new `delta`
 * field, while `text` continues to carry the accumulated value (backward compat).
 *
 * AG-UI spec semantics: `TextMessageContent.delta` is the *incremental* chunk
 * ("hel", "lo", " w"); accumulating the chunks reproduces the full text.
 */

function buildStatusUpdate(
  taskId: string,
  contextId: string,
  messageId: string,
  text: string,
  final = false,
): TaskStatusUpdateEvent {
  return {
    kind: "status-update",
    taskId,
    contextId,
    final,
    status: {
      state: final ? "completed" : "working",
      message: {
        kind: "message",
        role: "agent",
        messageId,
        parts: [{ kind: "text", text }],
      },
    },
  };
}

function buildTerminalTask(taskId: string, contextId: string, finalText: string): Task {
  return {
    kind: "task",
    id: taskId,
    contextId,
    status: { state: "completed" },
    history: [
      {
        kind: "message",
        messageId: `msg-${taskId}-final`,
        role: "agent",
        parts: [{ kind: "text", text: finalText }],
      },
    ],
  };
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

function deltas(events: A2AEvent[]): A2AMessageDeltaEvent[] {
  return events.filter((e): e is A2AMessageDeltaEvent => e.type === "message.delta");
}

describe("message.delta — incremental delta semantics (Wave 3.4)", () => {
  test("first delta: delta === text === full chunk (no prior text)", async () => {
    const events = await runStream([
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "hel"),
      buildTerminalTask("task-1", "ctx-1", "hello world"),
    ]);

    const d = deltas(events);
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d[0]?.text).toBe("hel");
    expect(d[0]?.delta).toBe("hel");
    expect(d[0]?.messageId).toBe("msg-1");
  });

  test("subsequent delta: text accumulates, delta is just the new chunk", async () => {
    const events = await runStream([
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "hel"),
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "hello"),
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "hello world"),
      buildTerminalTask("task-1", "ctx-1", "hello world"),
    ]);

    const d = deltas(events);
    expect(d).toHaveLength(3);

    expect(d[0]?.text).toBe("hel");
    expect(d[0]?.delta).toBe("hel");

    expect(d[1]?.text).toBe("hello");
    expect(d[1]?.delta).toBe("lo");

    expect(d[2]?.text).toBe("hello world");
    expect(d[2]?.delta).toBe(" world");
  });

  test("concatenating delta chunks reproduces the accumulated text", async () => {
    const events = await runStream([
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "one"),
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "one two"),
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "one two three"),
      buildTerminalTask("task-1", "ctx-1", "one two three"),
    ]);

    const d = deltas(events);
    const stitched = d.map((e) => e.delta ?? "").join("");
    expect(stitched).toBe("one two three");
    expect(d.at(-1)?.text).toBe("one two three");
  });

  test("full replacement: when currentText does not start with previousText, delta === currentText", async () => {
    // Agent first emits "hello", then resets / replaces with a completely
    // different payload "GOODBYE" under the same messageId. This is rare but
    // documented behavior.
    const events = await runStream([
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "hello"),
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "GOODBYE"),
      buildTerminalTask("task-1", "ctx-1", "GOODBYE"),
    ]);

    const d = deltas(events);
    expect(d).toHaveLength(2);
    expect(d[0]?.delta).toBe("hello");
    // "GOODBYE" does not start with "hello" → full-replacement semantics.
    expect(d[1]?.text).toBe("GOODBYE");
    expect(d[1]?.delta).toBe("GOODBYE");
  });

  test("multiple concurrent messageIds track per-id previous text independently", async () => {
    // Interleaved chunks for two distinct messageIds should not pollute each
    // other's delta computation.
    const events = await runStream([
      buildStatusUpdate("task-1", "ctx-1", "msg-A", "Alpha"),
      buildStatusUpdate("task-1", "ctx-1", "msg-B", "Beta"),
      buildStatusUpdate("task-1", "ctx-1", "msg-A", "Alpha one"),
      buildStatusUpdate("task-1", "ctx-1", "msg-B", "Beta two"),
      buildTerminalTask("task-1", "ctx-1", "Beta two"),
    ]);

    const d = deltas(events);
    expect(d).toHaveLength(4);

    // msg-A stream
    const aDeltas = d.filter((e) => e.messageId === "msg-A");
    expect(aDeltas).toHaveLength(2);
    expect(aDeltas[0]?.text).toBe("Alpha");
    expect(aDeltas[0]?.delta).toBe("Alpha");
    expect(aDeltas[1]?.text).toBe("Alpha one");
    expect(aDeltas[1]?.delta).toBe(" one");

    // msg-B stream
    const bDeltas = d.filter((e) => e.messageId === "msg-B");
    expect(bDeltas).toHaveLength(2);
    expect(bDeltas[0]?.text).toBe("Beta");
    expect(bDeltas[0]?.delta).toBe("Beta");
    expect(bDeltas[1]?.text).toBe("Beta two");
    expect(bDeltas[1]?.delta).toBe(" two");
  });

  test("session reducer still reads text (accumulated) and ignores delta", () => {
    // Delta computation is emission-only. The reducer must continue to
    // interpret `text` as the accumulated value so existing consumers that
    // never read `delta` keep working.
    const initial = createInitialSessionState({ status: "waiting" });

    const after1 = reduceA2ASessionState(initial, {
      type: "message.delta",
      text: "hel",
      delta: "hel",
      messageId: "msg-1",
    });
    expect(after1.pendingAgentText).toBe("hel");

    const after2 = reduceA2ASessionState(after1, {
      type: "message.delta",
      text: "hello",
      delta: "lo",
      messageId: "msg-1",
    });
    // Reducer sets pendingAgentText to event.text (accumulated), NOT event.delta.
    expect(after2.pendingAgentText).toBe("hello");

    const after3 = reduceA2ASessionState(after2, {
      type: "message.delta",
      text: "hello world",
      delta: " world",
      messageId: "msg-1",
    });
    expect(after3.pendingAgentText).toBe("hello world");
  });

  test("terminal message result emits delta equal to its incremental tail", async () => {
    // When the stream ends with a bare Message (no wrapping Task), the
    // provider treats it as a delta for that messageId.
    const events = await runStream([
      buildStatusUpdate("task-1", "ctx-1", "msg-1", "partial"),
      {
        kind: "message",
        messageId: "msg-1",
        role: "agent",
        contextId: "ctx-1",
        taskId: "task-1",
        parts: [{ kind: "text", text: "partial and done" }],
      },
      buildTerminalTask("task-1", "ctx-1", "partial and done"),
    ]);

    const d = deltas(events);
    expect(d).toHaveLength(2);
    expect(d[0]?.text).toBe("partial");
    expect(d[0]?.delta).toBe("partial");
    expect(d[1]?.text).toBe("partial and done");
    expect(d[1]?.delta).toBe(" and done");
  });
});
