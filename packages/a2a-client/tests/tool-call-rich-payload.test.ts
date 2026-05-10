/**
 * Layer 2 — `tool_call.start` / `tool_call.progress` / `tool_call.end`
 * reducer tests for ACP rich-payload pass-through.
 *
 * Asserts that `ActiveToolCall` state captures (and merges) the full
 * ACP `ToolCall` payload across the call lifecycle:
 *   - start populates initial fields
 *   - progress merges over (undefined preserves, value replaces, null
 *     stores as explicit clear for content/locations)
 *   - end carries the call into `completedToolCalls` with the latest
 *     merged payload
 *
 * Wire round-trip (provider translation from
 * `TaskStatusUpdateEvent.metadata` to typed client events) is covered
 * by the executor + provider integration tests; these tests focus on
 * reducer semantics in isolation.
 */
import { describe, expect, test } from "bun:test";
import { createInitialSessionState, reduceA2ASessionState } from "../src/session.ts";

describe("tool_call lifecycle — rich payload pass-through", () => {
  test("tool_call.start populates ACP fields on ActiveToolCall", () => {
    const initial = createInitialSessionState({ sessionId: "s1" });
    const next = reduceA2ASessionState(initial, {
      type: "tool_call.start",
      toolCallId: "tc1",
      toolCallName: "read_file",
      toolKind: "read",
      content: [{ type: "content", content: { type: "text", text: "hi" } }],
      locations: [{ path: "/repo/src/foo.ts", line: 12 }],
      rawInput: { path: "/repo/src/foo.ts" },
    });
    expect(next.activeToolCalls).toHaveLength(1);
    const tc = next.activeToolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.toolCallId).toBe("tc1");
    expect(tc.toolKind).toBe("read");
    expect(tc.content).toEqual([{ type: "content", content: { type: "text", text: "hi" } }]);
    expect(tc.locations).toEqual([{ path: "/repo/src/foo.ts", line: 12 }]);
    expect(tc.rawInput).toEqual({ path: "/repo/src/foo.ts" });
  });

  test("tool_call.start uses harness-reported status (not hard-coded in_progress)", () => {
    // Some harnesses emit `pending` to mark a queued-but-not-executing
    // call before transitioning to `in_progress`. Reducer must reflect
    // the reported value rather than defaulting.
    const initial = createInitialSessionState({ sessionId: "s1" });
    const next = reduceA2ASessionState(initial, {
      type: "tool_call.start",
      toolCallId: "tc-pending",
      toolCallName: "execute",
      status: "pending",
    });
    const tc = next.activeToolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.status).toBe("pending");
  });

  test("tool_call.start falls back to in_progress when status is omitted", () => {
    const initial = createInitialSessionState({ sessionId: "s1" });
    const next = reduceA2ASessionState(initial, {
      type: "tool_call.start",
      toolCallId: "tc-default",
      toolCallName: "read",
    });
    const tc = next.activeToolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.status).toBe("in_progress");
  });

  test("tool_call.progress merges over prior ActiveToolCall (undefined preserves)", () => {
    let state = createInitialSessionState({ sessionId: "s1" });
    state = reduceA2ASessionState(state, {
      type: "tool_call.start",
      toolCallId: "tc1",
      toolCallName: "read_file",
      toolKind: "read",
      rawInput: { path: "/a.ts" },
    });
    state = reduceA2ASessionState(state, {
      type: "tool_call.progress",
      toolCallId: "tc1",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "partial" } }],
    });
    const tc = state.activeToolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    // Status replaced, content replaced, but toolKind + rawInput preserved
    // because progress event omitted them.
    expect(tc.status).toBe("in_progress");
    expect(tc.toolKind).toBe("read");
    expect(tc.content).toEqual([{ type: "content", content: { type: "text", text: "partial" } }]);
    expect(tc.rawInput).toEqual({ path: "/a.ts" });
  });

  test("tool_call.progress with null content stores explicit clear", () => {
    let state = createInitialSessionState({ sessionId: "s1" });
    state = reduceA2ASessionState(state, {
      type: "tool_call.start",
      toolCallId: "tc1",
      toolCallName: "read_file",
      content: [{ type: "content", content: { type: "text", text: "old" } }],
    });
    state = reduceA2ASessionState(state, {
      type: "tool_call.progress",
      toolCallId: "tc1",
      content: null,
    });
    const tc = state.activeToolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    // null is distinct from absent — receivers must be able to tell
    // "agent withdrew the content" from "no change".
    expect(tc.content).toBeNull();
  });

  test("tool_call.progress synthesizes ActiveToolCall when start was missed", () => {
    const initial = createInitialSessionState({ sessionId: "s1" });
    const next = reduceA2ASessionState(initial, {
      type: "tool_call.progress",
      toolCallId: "tc1",
      status: "in_progress",
      toolKind: "execute",
    });
    expect(next.activeToolCalls).toHaveLength(1);
    const tc = next.activeToolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.toolCallId).toBe("tc1");
    expect(tc.status).toBe("in_progress");
    expect(tc.toolKind).toBe("execute");
    // Synthesized — toolName empty so the TUI knows the start was missed.
    expect(tc.toolName).toBe("");
  });

  test("tool_call.end merges terminal payload onto completed entry", () => {
    let state = createInitialSessionState({ sessionId: "s1" });
    state = reduceA2ASessionState(state, {
      type: "tool_call.start",
      toolCallId: "tc1",
      toolCallName: "read_file",
      toolKind: "read",
      rawInput: { path: "/a.ts" },
    });
    state = reduceA2ASessionState(state, {
      type: "tool_call.end",
      toolCallId: "tc1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "final" } }],
      rawOutput: "file body",
    });
    expect(state.activeToolCalls).toHaveLength(0);
    expect(state.completedToolCalls).toHaveLength(1);
    const tc = state.completedToolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    // Final entry carries fields from BOTH start and end events.
    expect(tc.status).toBe("completed");
    expect(tc.toolKind).toBe("read");
    expect(tc.rawInput).toEqual({ path: "/a.ts" });
    expect(tc.content).toEqual([{ type: "content", content: { type: "text", text: "final" } }]);
    expect(tc.rawOutput).toBe("file body");
  });

  test("end without prior start synthesizes a completed entry", () => {
    const initial = createInitialSessionState({ sessionId: "s1" });
    const next = reduceA2ASessionState(initial, {
      type: "tool_call.end",
      toolCallId: "tc1",
      status: "failed",
      toolKind: "execute",
      rawOutput: { error: "denied" },
    });
    expect(next.completedToolCalls).toHaveLength(1);
    const tc = next.completedToolCalls[0];
    expect(tc).toBeDefined();
    if (!tc) return;
    expect(tc.status).toBe("failed");
    expect(tc.toolKind).toBe("execute");
    expect(tc.rawOutput).toEqual({ error: "denied" });
    expect(tc.toolName).toBe("");
  });
});
