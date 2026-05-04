import { describe, expect, test } from "bun:test";
import type { ACPSessionEvent } from "@agents-js/acp-host";
import { EventType } from "@agents-js/agui-types";
import { validateAguiEvent } from "@agents-js/validation";
import {
  createTranslatorState,
  type TranslatorState,
  translateAcpEvent,
} from "../src/acp-to-agui-translator.ts";

/**
 * Table-driven coverage for every row of the ACP→AG-UI translation
 * table documented in the Wave 4 Track B brief. Each row either
 * produces specific AG-UI events, forwards via a namespaced `CUSTOM`
 * event, or is intentionally dropped.
 */

function makeAgentChunkEvent(text: string, messageId?: string): ACPSessionEvent {
  return {
    type: "session_update",
    notification: {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        ...(messageId ? { messageId } : {}),
      },
    },
  } as ACPSessionEvent;
}

function expectValid(event: unknown): void {
  const result = validateAguiEvent(event);
  if (!result.valid) {
    throw new Error(
      `Expected valid AG-UI event, got issues: ${JSON.stringify(result.error.issues)}`,
    );
  }
}

describe("translateAcpEvent — text message lifecycle", () => {
  test("first agent_message_chunk emits TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT", () => {
    const state = createTranslatorState();
    const out = translateAcpEvent(makeAgentChunkEvent("hello", "msg-1"), state);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    });
    expect(out[1]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "hello",
    });
    for (const event of out) expectValid(event);
  });

  test("subsequent chunk reuses messageId and skips START", () => {
    const state = createTranslatorState();
    translateAcpEvent(makeAgentChunkEvent("hello", "msg-1"), state);
    const out = translateAcpEvent(makeAgentChunkEvent(" world"), state);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: " world",
    });
  });

  test("missing messageId on first chunk synthesizes a UUID", () => {
    const state = createTranslatorState();
    const out = translateAcpEvent(makeAgentChunkEvent("hi"), state);

    expect(out).toHaveLength(2);
    const startId = (out[0] as unknown as { messageId: string }).messageId;
    const contentId = (out[1] as unknown as { messageId: string }).messageId;
    expect(typeof startId).toBe("string");
    expect(startId.length).toBeGreaterThan(0);
    // START + CONTENT share the same auto-generated id.
    expect(contentId).toBe(startId);
  });

  test("turn_completed closes the open text message and emits CUSTOM stop_reason", () => {
    const state = createTranslatorState();
    translateAcpEvent(makeAgentChunkEvent("hi", "msg-1"), state);
    const out = translateAcpEvent(
      { type: "turn_completed", stopReason: "end_turn" } as ACPSessionEvent,
      state,
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: EventType.TEXT_MESSAGE_END,
      messageId: "msg-1",
    } as unknown as object);
    expect(out[1]).toMatchObject({
      type: EventType.CUSTOM,
      name: "agents-js.stop_reason",
      value: "end_turn",
    } as unknown as object);
    // After turn_completed, the open message is closed — the next chunk
    // must open a fresh START.
    const next = translateAcpEvent(makeAgentChunkEvent("more", "msg-2"), state);
    expect(next[0]).toMatchObject({ type: EventType.TEXT_MESSAGE_START, messageId: "msg-2" });
    for (const event of out) expectValid(event);
  });

  test("turn_completed without an open message just emits CUSTOM stop_reason", () => {
    const state = createTranslatorState();
    const out = translateAcpEvent(
      { type: "turn_completed", stopReason: "cancelled" } as ACPSessionEvent,
      state,
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "agents-js.stop_reason",
      value: "cancelled",
    });
  });
});

describe("translateAcpEvent — tool calls", () => {
  test("tool_call_start emits TOOL_CALL_START once", () => {
    const state = createTranslatorState();
    const event: ACPSessionEvent = {
      type: "tool_call_start",
      toolCallId: "tc-1",
      toolCallName: "grep",
      parentMessageId: "msg-1",
    };

    const first = translateAcpEvent(event, state);
    const second = translateAcpEvent(event, state);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-1",
      toolCallName: "grep",
      parentMessageId: "msg-1",
    });
    expect(second).toHaveLength(0);
    for (const event of first) expectValid(event);
  });

  test("tool_call_start without parentMessageId omits the field", () => {
    const state = createTranslatorState();
    const out = translateAcpEvent(
      { type: "tool_call_start", toolCallId: "tc-2", toolCallName: "ls" } as ACPSessionEvent,
      state,
    );

    expect(out[0]).toMatchObject({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tc-2",
      toolCallName: "ls",
    });
    expect((out[0] as Record<string, unknown>).parentMessageId).toBeUndefined();
  });

  test("tool_call_end emits TOOL_CALL_END once", () => {
    const state = createTranslatorState();
    const event: ACPSessionEvent = { type: "tool_call_end", toolCallId: "tc-1" };

    const first = translateAcpEvent(event, state);
    const second = translateAcpEvent(event, state);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ type: EventType.TOOL_CALL_END, toolCallId: "tc-1" });
    expect(second).toHaveLength(0);
    for (const event of first) expectValid(event);
  });
});

describe("translateAcpEvent — error handling", () => {
  test("error event returns empty array (endpoint wraps as RUN_ERROR)", () => {
    const state = createTranslatorState();
    const out = translateAcpEvent({ type: "error", message: "boom" } as ACPSessionEvent, state);
    expect(out).toEqual([]);
  });
});

describe("translateAcpEvent — CUSTOM forwarded events", () => {
  const rows: Array<{ label: string; event: ACPSessionEvent; expectedName: string }> = [
    {
      label: "plan_updated",
      event: {
        type: "plan_updated",
        entries: [{ content: "step", status: "pending", priority: "high" }],
      } as ACPSessionEvent,
      expectedName: "agents-js.plan_updated",
    },
    {
      label: "mode_changed",
      event: { type: "mode_changed", modeId: "fast", modes: { currentModeId: "fast" } } as never,
      expectedName: "agents-js.mode_changed",
    },
    {
      label: "model_changed",
      event: { type: "model_changed", modelId: "m1", models: {} } as never,
      expectedName: "agents-js.model_changed",
    },
    {
      label: "usage_updated",
      event: { type: "usage_updated", size: 100, used: 10 } as ACPSessionEvent,
      expectedName: "agents-js.usage_updated",
    },
    {
      label: "permission_requested",
      event: { type: "permission_requested", request: { toolCall: { title: "x" } } } as never,
      expectedName: "agents-js.permission_requested",
    },
    {
      label: "permission_resolved",
      event: { type: "permission_resolved", cancelled: false } as ACPSessionEvent,
      expectedName: "agents-js.permission_resolved",
    },
    {
      label: "elicitation_requested",
      event: { type: "elicitation_requested", request: { message: "pick one" } } as never,
      expectedName: "agents-js.elicitation_requested",
    },
    {
      label: "elicitation_resolved",
      event: { type: "elicitation_resolved", action: "accept" } as never,
      expectedName: "agents-js.elicitation_resolved",
    },
    {
      label: "write_gate_requested",
      event: {
        type: "write_gate_requested",
        path: "/tmp/x",
        diff: "",
        closestParentFolder: "/tmp",
      } as ACPSessionEvent,
      expectedName: "agents-js.write_gate_requested",
    },
    {
      label: "write_gate_resolved",
      event: { type: "write_gate_resolved", approved: true } as ACPSessionEvent,
      expectedName: "agents-js.write_gate_resolved",
    },
    {
      label: "writable_folder_added",
      event: { type: "writable_folder_added", folder: "/tmp" } as ACPSessionEvent,
      expectedName: "agents-js.writable_folder_added",
    },
    {
      label: "ungated_write_detected",
      event: {
        type: "ungated_write_detected",
        toolCallId: "tc",
        title: "x",
        kind: "edit",
      } as ACPSessionEvent,
      expectedName: "agents-js.ungated_write_detected",
    },
    {
      label: "permission_gating_status",
      event: { type: "permission_gating_status", active: true, reason: "" } as ACPSessionEvent,
      expectedName: "agents-js.permission_gating_status",
    },
    {
      label: "config_option_changed",
      event: { type: "config_option_changed", configId: "x", value: true } as ACPSessionEvent,
      expectedName: "agents-js.config_option_changed",
    },
    {
      label: "logged_out",
      event: { type: "logged_out" } as ACPSessionEvent,
      expectedName: "agents-js.logged_out",
    },
    {
      label: "available_commands_updated",
      event: { type: "available_commands_updated", commands: [] } as ACPSessionEvent,
      expectedName: "agents-js.available_commands_updated",
    },
  ];

  for (const row of rows) {
    test(`${row.label} → CUSTOM ${row.expectedName}`, () => {
      const state = createTranslatorState();
      const out = translateAcpEvent(row.event, state);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        type: EventType.CUSTOM,
        name: row.expectedName,
      });
      expect((out[0] as unknown as { value: { type?: string } }).value.type).toBeUndefined();
      for (const event of out) expectValid(event);
    });
  }
});

describe("translateAcpEvent — surface events (Wave 5)", () => {
  test("surface_event → CUSTOM agents-js.a2ui.surface_event with opaque payload", () => {
    const state = createTranslatorState();
    const payload = { kind: "beginRendering", components: [{ id: "root" }] };
    const event: ACPSessionEvent = {
      type: "surface_event",
      surfaceId: "surf-1",
      event: payload,
    };
    const out = translateAcpEvent(event, state);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: EventType.CUSTOM,
      name: "agents-js.a2ui.surface_event",
      value: { surfaceId: "surf-1", event: payload },
    });
    // Gateway does not interpret the payload — it is passed through opaquely.
    expect((out[0] as unknown as { value: { event: unknown } }).value.event).toBe(payload);
    for (const e of out) expectValid(e);
  });

  test("surface_event does not affect open-message lifecycle", () => {
    // A surface_event mid-stream must not close the open assistant text
    // message. We assert this behaviorally: a chunk → surface_event →
    // chunk run produces only a single START.
    const state: TranslatorState = createTranslatorState();
    const before = translateAcpEvent(makeAgentChunkEvent("hi", "msg-1"), state);
    const surface = translateAcpEvent(
      { type: "surface_event", surfaceId: "s", event: {} } satisfies ACPSessionEvent,
      state,
    );
    const after = translateAcpEvent(makeAgentChunkEvent(" there"), state);

    expect(before.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
    ]);
    expect(surface.map((e) => e.type)).toEqual([EventType.CUSTOM]);
    expect(after.map((e) => e.type)).toEqual([EventType.TEXT_MESSAGE_CONTENT]);
  });
});

describe("translateAcpEvent — dropped events", () => {
  const dropped: Array<{ label: string; event: ACPSessionEvent }> = [
    { label: "status_changed", event: { type: "status_changed", status: "ready" } },
    { label: "session_created", event: { type: "session_created", sessionId: "s1" } },
    { label: "session_loaded", event: { type: "session_loaded", sessionId: "s1" } },
    { label: "session_closed", event: { type: "session_closed" } },
    {
      label: "session_forked",
      event: { type: "session_forked", sessionId: "s2", parentSessionId: "s1" },
    },
    { label: "session_resumed", event: { type: "session_resumed", sessionId: "s1" } },
    { label: "queue_changed", event: { type: "queue_changed", count: 1 } },
    {
      label: "session_info_updated",
      event: { type: "session_info_updated", title: "t", updatedAt: "now" },
    },
  ];

  for (const row of dropped) {
    test(`${row.label} is dropped`, () => {
      const state = createTranslatorState();
      const out = translateAcpEvent(row.event, state);
      expect(out).toEqual([]);
    });
  }
});

describe("translateAcpEvent — purity", () => {
  test("dropped events leave the open-message state alone", () => {
    // After a chunk is open, dropping a `status_changed` event must not
    // close it: the next chunk should reuse the same messageId rather
    // than emit a fresh START.
    const state: TranslatorState = createTranslatorState();
    translateAcpEvent(makeAgentChunkEvent("hi", "msg-1"), state);
    translateAcpEvent({ type: "status_changed", status: "ready" } as ACPSessionEvent, state);
    const next = translateAcpEvent(makeAgentChunkEvent(" again"), state);

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
    });
  });
});
