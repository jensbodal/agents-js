import { describe, expect, test } from "bun:test";
import {
  DroidToAcpTranslator,
  promptRequestToDroidPrompt,
  stripInlineThinking,
} from "../src/translator.ts";
import type { DroidStreamEvent } from "../src/types.ts";

describe("DroidToAcpTranslator", () => {
  test("system/init captures droid session_id without emitting notifications", () => {
    const t = new DroidToAcpTranslator("acp-1");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "system",
      subtype: "init",
      cwd: "/tmp",
      session_id: "droid-xyz",
      tools: ["Execute"],
      model: "m",
      reasoning_effort: "high",
    });
    expect(step.notifications).toEqual([]);
    expect(step.droidSessionId).toBe("droid-xyz");
    expect(step.turnComplete).toBeUndefined();
  });

  test("user-role message events are dropped (echo of our own prompt)", () => {
    const t = new DroidToAcpTranslator("acp-2");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "message",
      role: "user",
      id: "u-1",
      text: "hi",
      timestamp: 1,
      session_id: "s",
    });
    expect(step.notifications).toEqual([]);
  });

  test("assistant-role message → agent_message_chunk (with inline thinking stripped)", () => {
    const t = new DroidToAcpTranslator("acp-3");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "message",
      role: "assistant",
      id: "a-1",
      text: "<thinking>\nplanning\n</thinking>\n\nHello!",
      timestamp: 1,
      session_id: "s",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "acp-3",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello!" },
        },
      },
    ]);
  });

  test("assistant message that is entirely a thinking block is dropped (no empty chunk)", () => {
    const t = new DroidToAcpTranslator("acp-4");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "message",
      role: "assistant",
      id: "a-2",
      text: "<thinking>all thoughts, no output</thinking>",
      timestamp: 1,
      session_id: "s",
    });
    expect(step.notifications).toEqual([]);
  });

  test("reasoning event → agent_thought_chunk on first occurrence", () => {
    const t = new DroidToAcpTranslator("acp-5");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "reasoning",
      id: "r-1",
      text: "Let me think.",
      timestamp: 1,
      session_id: "s",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "acp-5",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Let me think." },
        },
      },
    ]);
  });

  test("duplicate reasoning event with same id is dropped (droid quirk)", () => {
    const t = new DroidToAcpTranslator("acp-6");
    t.markTurnStarted();
    const first = t.handleEvent({
      type: "reasoning",
      id: "r-dup",
      text: "plan",
      timestamp: 1,
      session_id: "s",
    });
    const second = t.handleEvent({
      type: "reasoning",
      id: "r-dup",
      text: "plan",
      timestamp: 1,
      session_id: "s",
    });
    expect(first.notifications).toHaveLength(1);
    expect(second.notifications).toEqual([]);
  });

  test("empty reasoning text is dropped", () => {
    const t = new DroidToAcpTranslator("acp-7");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "reasoning",
      id: "r-empty",
      text: "",
      timestamp: 1,
      session_id: "s",
    });
    expect(step.notifications).toEqual([]);
  });

  test("tool_call → tool_call (in_progress)", () => {
    const t = new DroidToAcpTranslator("acp-8");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "tool_call",
      id: "tc-1",
      messageId: "a-1",
      toolId: "Execute",
      toolName: "Execute",
      parameters: { command: "ls" },
      timestamp: 1,
      session_id: "s",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "acp-8",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-1",
          title: "Execute",
          status: "in_progress",
        },
      },
    ]);
  });

  test("tool_result with isError=false → tool_call_update (completed)", () => {
    const t = new DroidToAcpTranslator("acp-9");
    t.markTurnStarted();
    t.handleEvent({
      type: "tool_call",
      id: "tc-2",
      messageId: "a-1",
      toolId: "Read",
      toolName: "Read",
      parameters: {},
      timestamp: 1,
      session_id: "s",
    });
    const step = t.handleEvent({
      type: "tool_result",
      id: "tc-2",
      messageId: "a-2",
      toolId: "Read",
      isError: false,
      value: "file contents",
      timestamp: 2,
      session_id: "s",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "acp-9",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-2",
          status: "completed",
        },
      },
    ]);
  });

  test("tool_result with isError=true → tool_call_update (failed)", () => {
    const t = new DroidToAcpTranslator("acp-10");
    t.markTurnStarted();
    t.handleEvent({
      type: "tool_call",
      id: "tc-3",
      messageId: "a-1",
      toolId: "Execute",
      toolName: "Execute",
      parameters: { command: "false" },
      timestamp: 1,
      session_id: "s",
    });
    const step = t.handleEvent({
      type: "tool_result",
      id: "tc-3",
      messageId: "a-2",
      toolId: "Execute",
      isError: true,
      value: "exit 1",
      timestamp: 2,
      session_id: "s",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "acp-10",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-3",
          status: "failed",
        },
      },
    ]);
  });

  test("tool_result arriving before tool_call synthesizes an in_progress start first", () => {
    const t = new DroidToAcpTranslator("acp-11");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "tool_result",
      id: "tc-orphan",
      messageId: "a-1",
      toolId: "Edit",
      isError: false,
      value: "ok",
      timestamp: 1,
      session_id: "s",
    });
    expect(step.notifications).toEqual([
      {
        sessionId: "acp-11",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-orphan",
          title: "tc-orphan",
          status: "in_progress",
        },
      },
      {
        sessionId: "acp-11",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-orphan",
          status: "completed",
        },
      },
    ]);
  });

  test("completion resolves the turn with end_turn", () => {
    const t = new DroidToAcpTranslator("acp-12");
    t.markTurnStarted();
    expect(t.isTurnActive).toBe(true);
    const step = t.handleEvent({
      type: "completion",
      finalText: "done",
      numTurns: 1,
      durationMs: 10,
      session_id: "s",
      timestamp: 1,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    expect(step.notifications).toEqual([]);
    expect(step.turnComplete).toEqual({ stopReason: "end_turn" });
    expect(t.isTurnActive).toBe(false);
  });

  test("markTurnCancelled returns cancelled stop reason", () => {
    const t = new DroidToAcpTranslator("acp-13");
    t.markTurnStarted();
    const step = t.markTurnCancelled();
    expect(step.notifications).toEqual([]);
    expect(step.turnComplete).toEqual({ stopReason: "cancelled" });
    expect(t.isTurnActive).toBe(false);
  });

  test("unknown events drop silently (forward-compat)", () => {
    const t = new DroidToAcpTranslator("acp-14");
    t.markTurnStarted();
    const step = t.handleEvent({
      type: "some_future_event_type",
    } as DroidStreamEvent);
    expect(step.notifications).toEqual([]);
    expect(step.turnComplete).toBeUndefined();
  });

  test("golden sequence: system/init → reasoning (dup) → tool_call → tool_result → message → completion", () => {
    const t = new DroidToAcpTranslator("golden");
    t.markTurnStarted();
    const sequence: DroidStreamEvent[] = [
      {
        type: "system",
        subtype: "init",
        cwd: "/tmp",
        session_id: "droid-golden",
        tools: ["Execute"],
        model: "m",
        reasoning_effort: "high",
      },
      {
        type: "message",
        role: "user",
        id: "u-1",
        text: "run ls",
        timestamp: 1,
        session_id: "droid-golden",
      },
      {
        type: "reasoning",
        id: "r-1",
        text: "Plan: list files.",
        timestamp: 2,
        session_id: "droid-golden",
      },
      {
        type: "reasoning",
        id: "r-1",
        text: "Plan: list files.",
        timestamp: 2,
        session_id: "droid-golden",
      },
      {
        type: "tool_call",
        id: "tc-ls",
        messageId: "a-1",
        toolId: "Execute",
        toolName: "Execute",
        parameters: { command: "ls" },
        timestamp: 3,
        session_id: "droid-golden",
      },
      {
        type: "tool_result",
        id: "tc-ls",
        messageId: "a-2",
        toolId: "Execute",
        isError: false,
        value: "a\nb\n",
        timestamp: 4,
        session_id: "droid-golden",
      },
      {
        type: "message",
        role: "assistant",
        id: "a-3",
        text: "<thinking>done</thinking>\n\nListed two files.",
        timestamp: 5,
        session_id: "droid-golden",
      },
      {
        type: "completion",
        finalText: "Listed two files.",
        numTurns: 1,
        durationMs: 10,
        session_id: "droid-golden",
        timestamp: 6,
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    ];
    let latchedSessionId: string | undefined;
    const collected: unknown[] = [];
    let terminalStop: string | undefined;
    for (const event of sequence) {
      const step = t.handleEvent(event);
      if (step.droidSessionId) latchedSessionId = step.droidSessionId;
      for (const n of step.notifications) collected.push(n.update);
      if (step.turnComplete) terminalStop = step.turnComplete.stopReason;
    }
    expect(latchedSessionId).toBe("droid-golden");
    expect(terminalStop).toBe("end_turn");
    expect(collected).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Plan: list files." },
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tc-ls",
        title: "Execute",
        status: "in_progress",
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-ls",
        status: "completed",
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Listed two files." },
      },
    ]);
  });
});

describe("stripInlineThinking", () => {
  test("removes a single thinking block and trims trailing whitespace", () => {
    expect(stripInlineThinking("<thinking>plan</thinking>\n\nHello")).toBe("Hello");
  });

  test("removes multiple thinking blocks", () => {
    expect(stripInlineThinking("<thinking>a</thinking>foo<thinking>b</thinking>bar")).toBe(
      "foobar",
    );
  });

  test("handles multi-line thinking content non-greedily", () => {
    expect(stripInlineThinking("<thinking>\nline1\nline2\n</thinking>\n\nResult")).toBe("Result");
  });

  test("leaves plain text untouched", () => {
    expect(stripInlineThinking("no tags here")).toBe("no tags here");
  });

  test("returns empty string when entire text is a thinking block", () => {
    expect(stripInlineThinking("<thinking>only</thinking>")).toBe("");
  });
});

describe("promptRequestToDroidPrompt", () => {
  test("concatenates text content blocks", () => {
    expect(
      promptRequestToDroidPrompt({
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
      promptRequestToDroidPrompt({
        sessionId: "s",
        prompt: [
          { type: "text", text: "See " },
          { type: "resource_link", uri: "file:///tmp/a.txt", name: "a.txt" },
        ],
      }),
    ).toBe("See <file:///tmp/a.txt>");
  });

  test("silently drops unsupported block types in first cut", () => {
    expect(
      promptRequestToDroidPrompt({
        sessionId: "s",
        prompt: [
          { type: "text", text: "look:" },
          { type: "image", data: "base64==", mimeType: "image/png" },
        ],
      }),
    ).toBe("look:");
  });

  test("empty prompt array returns empty string", () => {
    expect(promptRequestToDroidPrompt({ sessionId: "s", prompt: [] })).toBe("");
  });
});
