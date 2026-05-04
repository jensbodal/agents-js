import { describe, expect, it } from "bun:test";
import { EventType } from "@agents-js/agui-types";
import {
  type AguiEventEnvelope,
  createAguiEventBridge,
  type LoopNotification,
} from "./agui-event-bridge.ts";

const SESSION_ID = "test-session";
const RUN_ID = "run-001";

function notif(params: Record<string, unknown>): LoopNotification {
  return { jsonrpc: "2.0", method: "session/update", params };
}

function bridgeAll(notifications: LoopNotification[]): AguiEventEnvelope[] {
  const bridge = createAguiEventBridge({ runId: RUN_ID, threadId: SESSION_ID });
  const out: AguiEventEnvelope[] = [];
  for (const n of notifications) {
    for (const ev of bridge(n)) out.push(ev);
  }
  return out;
}

describe("createAguiEventBridge", () => {
  it("maps tool.invoked to TOOL_CALL_START + TOOL_CALL_ARGS + TOOL_CALL_END (in order)", () => {
    const events = bridgeAll([
      notif({ kind: "tool.invoked", tool: "searchDocs", result: { hits: 3 } }),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);
    const start = events[0] as { toolCallName: string; toolCallId: string };
    expect(start.toolCallName).toBe("searchDocs");
    expect(start.toolCallId.length).toBeGreaterThan(0);
    const args = events[1] as { toolCallId: string; delta: string };
    expect(args.toolCallId).toBe(start.toolCallId);
    expect(args.delta).toContain("searchDocs");
  });

  it("answer.chunk before answer.done emits a TEXT_MESSAGE_START then TEXT_MESSAGE_CONTENT", () => {
    const events = bridgeAll([
      notif({ kind: "answer.chunk", text: "Hello " }),
      notif({ kind: "answer.chunk", text: "world." }),
    ]);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.TEXT_MESSAGE_START);
    expect(types[1]).toBe(EventType.TEXT_MESSAGE_CONTENT);
    expect(types[2]).toBe(EventType.TEXT_MESSAGE_CONTENT);
    const content1 = events[1] as { delta: string; messageId: string };
    const content2 = events[2] as { delta: string; messageId: string };
    expect(content1.delta).toBe("Hello ");
    expect(content2.delta).toBe("world.");
    // Both content events share the same messageId issued by the START.
    expect(content1.messageId).toBe(content2.messageId);
  });

  it("answer.done emits TEXT_MESSAGE_END + RUN_FINISHED with the open message id", () => {
    const events = bridgeAll([
      notif({ kind: "answer.chunk", text: "x" }),
      notif({ kind: "answer.done" }),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).toContain(EventType.RUN_FINISHED);
    const startEvent = events.find((e) => e.type === EventType.TEXT_MESSAGE_START) as {
      messageId: string;
    };
    const endEvent = events.find((e) => e.type === EventType.TEXT_MESSAGE_END) as {
      messageId: string;
    };
    expect(endEvent.messageId).toBe(startEvent.messageId);
  });

  it("answer.done without prior chunks emits no TEXT_MESSAGE_END (no message was open) but still RUN_FINISHED", () => {
    const events = bridgeAll([notif({ kind: "answer.done" })]);
    const types = events.map((e) => e.type);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_END);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("clarify maps to a single-shot text message (start + content + end) with assistant role", () => {
    const events = bridgeAll([notif({ kind: "clarify", prompt: "Did you mean X or Y?" })]);
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    const content = events[1] as { delta: string };
    expect(content.delta).toBe("Did you mean X or Y?");
  });

  it("error maps to RUN_ERROR with the message text", () => {
    const events = bridgeAll([notif({ kind: "error", message: "bad action JSON" })]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.RUN_ERROR);
    expect((events[0] as { message: string }).message).toBe("bad action JSON");
  });

  it("cancelled maps to RUN_ERROR with code='cancelled'", () => {
    const events = bridgeAll([notif({ kind: "cancelled" })]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe(EventType.RUN_ERROR);
    const ev = events[0] as { code?: string; message: string };
    expect(ev.code).toBe("cancelled");
  });

  it("returns an empty array for an unknown notification kind", () => {
    const events = bridgeAll([notif({ kind: "unknown.future" })]);
    expect(events).toHaveLength(0);
  });

  it("each call returns a fresh array (caller may mutate)", () => {
    const bridge = createAguiEventBridge({ runId: RUN_ID, threadId: SESSION_ID });
    const a = bridge(notif({ kind: "answer.chunk", text: "x" }));
    const b = bridge(notif({ kind: "answer.chunk", text: "y" }));
    expect(a).not.toBe(b);
  });

  it("idFactory injection is honoured for both tool-call ids and message ids", () => {
    let n = 0;
    const idFactory = () => `id_${++n}`;
    const bridge = createAguiEventBridge({ runId: RUN_ID, threadId: SESSION_ID, idFactory });
    // First notification: a tool.invoked consumes one id (toolCallId).
    const tool = bridge(notif({ kind: "tool.invoked", tool: "x", result: 1 }));
    const toolStart = tool[0] as { toolCallId: string };
    expect(toolStart.toolCallId).toBe("id_1");

    // Then a chunk consumes another id (messageId for the new START).
    const chunk = bridge(notif({ kind: "answer.chunk", text: "hi" }));
    const start = chunk.find((e) => e.type === EventType.TEXT_MESSAGE_START) as {
      messageId: string;
    };
    expect(start.messageId).toBe("id_2");
  });

  it("subsequent answer.chunk after answer.done opens a fresh message (state resets)", () => {
    // The builder's runFinished resets open-message state, so a follow-up
    // chunk must emit a fresh START. Regression guard — earlier hand-rolled
    // bridge cleared the same field, but the contract is now centralized
    // in createAguiEventStream and worth pinning at the consumer level.
    const bridge = createAguiEventBridge({ runId: RUN_ID, threadId: SESSION_ID });
    bridge(notif({ kind: "answer.chunk", text: "hi" }));
    bridge(notif({ kind: "answer.done" }));
    const next = bridge(notif({ kind: "answer.chunk", text: "again" }));
    expect(next.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
  });

  it("error mid-stream auto-closes any open text message before emitting RUN_ERROR", () => {
    // Behaviour change vs. the prior hand-rolled bridge: the builder's
    // runError flushes the open START with a TEXT_MESSAGE_END so the wire
    // stream stays well-formed. Tests pin this so future refactors don't
    // accidentally drop the flush.
    const bridge = createAguiEventBridge({ runId: RUN_ID, threadId: SESSION_ID });
    bridge(notif({ kind: "answer.chunk", text: "partial" }));
    const out = bridge(notif({ kind: "error", message: "boom" }));
    expect(out.map((e) => e.type)).toEqual([EventType.TEXT_MESSAGE_END, EventType.RUN_ERROR]);
  });
});
