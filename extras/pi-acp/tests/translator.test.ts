import { describe, expect, test } from "bun:test";
import { PiToAcpTranslator, promptRequestToPiMessage } from "../src/translator.ts";
import type { PiRpcMessage } from "../src/types.ts";

describe("PiToAcpTranslator", () => {
  test("ignores framing events (agent_start, turn_start, message_start, message_end, turn_end)", () => {
    const t = new PiToAcpTranslator("s-1");
    t.markTurnStarted();
    const framing: PiRpcMessage[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start" },
      { type: "message_end" },
      { type: "turn_end" },
    ];
    for (const m of framing) {
      const step = t.handleMessage(m);
      expect(step.notifications).toEqual([]);
      expect(step.turnComplete).toBeUndefined();
    }
  });

  test("text_delta → agent_message_chunk", () => {
    const t = new PiToAcpTranslator("s-1");
    t.markTurnStarted();
    const step = t.handleMessage({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hello ", contentIndex: 0 },
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello " },
        },
      },
    ]);
    expect(step.turnComplete).toBeUndefined();
  });

  test("thinking_delta → agent_thought_chunk", () => {
    const t = new PiToAcpTranslator("s-2");
    t.markTurnStarted();
    const step = t.handleMessage({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "Let me think." },
    });
    expect(step.notifications).toHaveLength(1);
    expect(step.notifications[0]).toEqual({
      sessionId: "s-2",
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Let me think." },
      },
    });
  });

  test("text_start / text_end / thinking_start / thinking_end drop (ACP reconstructs from deltas)", () => {
    const t = new PiToAcpTranslator("s-3");
    t.markTurnStarted();
    for (const evtType of ["text_start", "text_end", "thinking_start", "thinking_end"]) {
      const step = t.handleMessage({
        type: "message_update",
        assistantMessageEvent: { type: evtType },
      });
      expect(step.notifications).toEqual([]);
    }
  });

  test("empty text_delta is dropped (no empty chunk emitted)", () => {
    const t = new PiToAcpTranslator("s-4");
    t.markTurnStarted();
    const step = t.handleMessage({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "" },
    });
    expect(step.notifications).toEqual([]);
  });

  test("tool_execution_start → tool_call (in_progress)", () => {
    const t = new PiToAcpTranslator("s-5");
    t.markTurnStarted();
    const step = t.handleMessage({
      type: "tool_execution_start",
      toolCallId: "call-1",
      title: "bash",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "s-5",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "bash",
          status: "in_progress",
        },
      },
    ]);
  });

  test("tool_execution_update emits tool_call_update (in_progress)", () => {
    const t = new PiToAcpTranslator("s-6");
    t.markTurnStarted();
    t.handleMessage({ type: "tool_execution_start", toolCallId: "c-1", title: "read" });
    const step = t.handleMessage({
      type: "tool_execution_update",
      toolCallId: "c-1",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "s-6",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-1",
          status: "in_progress",
        },
      },
    ]);
  });

  test("tool_execution_end with success=true emits tool_call_update (completed)", () => {
    const t = new PiToAcpTranslator("s-7");
    t.markTurnStarted();
    t.handleMessage({ type: "tool_execution_start", toolCallId: "c-2", title: "edit" });
    const step = t.handleMessage({
      type: "tool_execution_end",
      toolCallId: "c-2",
      success: true,
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "s-7",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-2",
          status: "completed",
        },
      },
    ]);
  });

  test("tool_execution_end with error field emits failed status", () => {
    const t = new PiToAcpTranslator("s-8");
    t.markTurnStarted();
    t.handleMessage({ type: "tool_execution_start", toolCallId: "c-3", title: "write" });
    const step = t.handleMessage({
      type: "tool_execution_end",
      toolCallId: "c-3",
      error: "permission denied",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "s-8",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "c-3",
          status: "failed",
        },
      },
    ]);
  });

  test("tool_execution_update before start synthesizes a tool_call", () => {
    const t = new PiToAcpTranslator("s-9");
    t.markTurnStarted();
    const step = t.handleMessage({
      type: "tool_execution_update",
      toolCallId: "c-4",
      title: "bash",
    });
    expect(step.notifications).toHaveLength(1);
    expect(step.notifications[0]).toEqual({
      sessionId: "s-9",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "c-4",
        title: "bash",
        status: "in_progress",
      },
    });
  });

  test("agent_end resolves the turn with end_turn", () => {
    const t = new PiToAcpTranslator("s-10");
    t.markTurnStarted();
    expect(t.isTurnActive).toBe(true);
    const step = t.handleMessage({ type: "agent_end", messages: [] });
    expect(step.notifications).toEqual([]);
    expect(step.turnComplete).toEqual({ stopReason: "end_turn" });
    expect(t.isTurnActive).toBe(false);
  });

  test("markTurnCancelled returns cancelled stop reason and clears turn state", () => {
    const t = new PiToAcpTranslator("s-11");
    t.markTurnStarted();
    const step = t.markTurnCancelled();
    expect(step.notifications).toEqual([]);
    expect(step.turnComplete).toEqual({ stopReason: "cancelled" });
    expect(t.isTurnActive).toBe(false);
  });

  test("response messages are consumed silently (handled by RPC client, not translator)", () => {
    const t = new PiToAcpTranslator("s-12");
    t.markTurnStarted();
    const step = t.handleMessage({
      type: "response",
      command: "prompt",
      success: true,
      id: "req-1",
    });
    expect(step.notifications).toEqual([]);
    expect(step.turnComplete).toBeUndefined();
  });

  test("unknown events drop silently (forward-compat)", () => {
    const t = new PiToAcpTranslator("s-13");
    t.markTurnStarted();
    const step = t.handleMessage({ type: "compaction_start" });
    expect(step.notifications).toEqual([]);
    expect(step.turnComplete).toBeUndefined();
  });

  test("golden sequence: prompt turn with text + thinking + tool call + agent_end", () => {
    const t = new PiToAcpTranslator("s-golden");
    t.markTurnStarted();
    const sequence: PiRpcMessage[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "message_start" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start" },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Planning..." },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_end" },
      },
      { type: "tool_execution_start", toolCallId: "bash-1", title: "bash" },
      { type: "tool_execution_end", toolCallId: "bash-1", success: true },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hi " },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "there" },
      },
      { type: "message_end" },
      { type: "turn_end" },
      { type: "agent_end" },
    ];
    const collected: unknown[] = [];
    let terminalStop: string | undefined;
    for (const msg of sequence) {
      const step = t.handleMessage(msg);
      for (const n of step.notifications) collected.push(n.update);
      if (step.turnComplete) terminalStop = step.turnComplete.stopReason;
    }
    expect(terminalStop).toBe("end_turn");
    expect(collected).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Planning..." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "bash-1",
        title: "bash",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "bash-1",
        status: "completed",
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hi " },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "there" },
      },
    ]);
  });
});

describe("promptRequestToPiMessage", () => {
  test("concatenates text content blocks", () => {
    expect(
      promptRequestToPiMessage({
        sessionId: "s",
        prompt: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      }),
    ).toBe("Hello world");
  });

  test("serializes resource_link blocks as <uri> placeholders", () => {
    expect(
      promptRequestToPiMessage({
        sessionId: "s",
        prompt: [
          { type: "text", text: "See " },
          { type: "resource_link", uri: "file:///tmp/a.txt", name: "a.txt" },
        ],
      }),
    ).toBe("See <file:///tmp/a.txt>");
  });

  test("silently drops unsupported block types (e.g. image) in first cut", () => {
    expect(
      promptRequestToPiMessage({
        sessionId: "s",
        prompt: [
          { type: "text", text: "look:" },
          { type: "image", data: "base64==", mimeType: "image/png" },
        ],
      }),
    ).toBe("look:");
  });

  test("empty prompt array returns empty string", () => {
    expect(promptRequestToPiMessage({ sessionId: "s", prompt: [] })).toBe("");
  });
});
