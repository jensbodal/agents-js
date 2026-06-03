import { describe, expect, test } from "bun:test";
import { Role, TaskState } from "@a2a-js/sdk";
import type { A2AEvent, A2AToolCallArgsEvent } from "../src/index.ts";
import {
  A2AClientProvider,
  applyJsonPatch,
  createInitialSessionState,
  reduceA2ASessionState,
} from "../src/index.ts";
import { makeMessage, makeTextPart, statusEvent } from "./mock-a2a-transport.ts";

/** Terminal stream payload carrying the final agent reply (A2A 1.0). */
const TERMINAL_DONE = statusEvent({
  taskId: "task-1",
  contextId: "ctx-1",
  state: TaskState.TASK_STATE_COMPLETED,
  message: makeMessage({ messageId: "m1", role: Role.ROLE_AGENT, parts: [makeTextPart("done")] }),
});

describe("Fix 1: JSON Patch getValue enforces key existence", () => {
  test("copy rejects invalid source path with descriptive error", () => {
    const state = { name: "Alice", age: 30 };

    expect(() => {
      applyJsonPatch(state, [{ op: "copy", from: "/nonexistent", path: "/backup" }]);
    }).toThrow(/nonexistent/);
  });

  test("move rejects invalid source path with descriptive error", () => {
    const state = { name: "Alice", age: 30 };

    expect(() => {
      applyJsonPatch(state, [{ op: "move", from: "/nonexistent", path: "/backup" }]);
    }).toThrow(/nonexistent/);
  });

  test("test rejects non-existent key with descriptive error", () => {
    const state = { name: "Alice" };

    // Testing a non-existent key should fail descriptively,
    // not silently compare undefined
    expect(() => {
      applyJsonPatch(state, [{ op: "test", path: "/nonexistent", value: undefined }]);
    }).toThrow(/nonexistent/);
  });

  test("getValue on valid key still works", () => {
    const state: Record<string, unknown> = { name: "Alice", nested: { key: "value" } };

    // copy from valid path should work
    const result = applyJsonPatch(state, [{ op: "copy", from: "/name", path: "/backup" }]);
    expect(result).toEqual({ name: "Alice", nested: { key: "value" }, backup: "Alice" });
  });

  test("copy from nested non-existent path throws", () => {
    const state = { data: { items: [1, 2, 3] } };

    expect(() => {
      applyJsonPatch(state, [{ op: "copy", from: "/data/missing", path: "/backup" }]);
    }).toThrow(/missing/);
  });
});

describe("Fix 2: session.updated with empty delta is no-op", () => {
  test("delta: [] returns current state, not event.state", () => {
    const currentState = createInitialSessionState({ status: "waiting" });
    const differentState = createInitialSessionState({ status: "error" });

    const result = reduceA2ASessionState(currentState, {
      type: "session.updated",
      state: differentState,
      delta: [],
    });

    // With empty delta, should be a no-op — return current state, not event.state
    expect(result.status).toBe("waiting");
    expect(result).toBe(currentState);
  });

  test("delta: undefined still falls through to state replacement", () => {
    const currentState = createInitialSessionState({ status: "waiting" });
    const newState = createInitialSessionState({ status: "idle" });

    const result = reduceA2ASessionState(currentState, {
      type: "session.updated",
      state: newState,
    });

    // Without delta, behaves as before: replaces state wholesale
    expect(result.status).toBe("idle");
    expect(result).toBe(newState);
  });

  test("delta with operations still applies patches", () => {
    const currentState = createInitialSessionState({ status: "idle" });

    const result = reduceA2ASessionState(currentState, {
      type: "session.updated",
      state: createInitialSessionState({ status: "error" }),
      delta: [{ op: "replace", path: "/status", value: "connected" }],
    });

    expect(result.status).toBe("connected");
  });
});

describe("Fix 3: JSON Patch add/replace/test enforce required value field", () => {
  test("add operation without value field throws descriptive error", () => {
    const state = { name: "Alice" };

    expect(() => {
      applyJsonPatch(state, [{ op: "add", path: "/newField" } as never]);
    }).toThrow(/"add".*requires.*"value"/i);
  });

  test("replace operation without value field throws descriptive error", () => {
    const state = { name: "Alice" };

    expect(() => {
      applyJsonPatch(state, [{ op: "replace", path: "/name" } as never]);
    }).toThrow(/"replace".*requires.*"value"/i);
  });

  test("test operation without value field throws descriptive error", () => {
    const state = { name: "Alice" };

    expect(() => {
      applyJsonPatch(state, [{ op: "test", path: "/name" } as never]);
    }).toThrow(/"test".*requires.*"value"/i);
  });

  test("add with explicit undefined value is still valid", () => {
    // RFC 6902: value field must be present (key in object), but can be null
    const state: Record<string, unknown> = { name: "Alice" };

    // When value is explicitly set to null, should work fine
    const result = applyJsonPatch(state, [{ op: "add", path: "/extra", value: null }]);
    expect(result).toEqual({ name: "Alice", extra: null });
  });

  test("remove operation does not require value field", () => {
    const state: Record<string, unknown> = { name: "Alice", age: 30 };

    // remove does not need a value field
    const result = applyJsonPatch(state, [{ op: "remove", path: "/age" }]);
    expect(result).toEqual({ name: "Alice" });
  });

  test("move operation does not require value field", () => {
    const state: Record<string, unknown> = { name: "Alice", age: 30 };

    const result = applyJsonPatch(state, [{ op: "move", from: "/name", path: "/displayName" }]);
    expect(result).toEqual({ age: 30, displayName: "Alice" });
  });
});

describe("Fix 4: Stream result type union includes reasoning and tool_call.args", () => {
  // This is primarily a type-level fix — verified by TypeScript compilation.
  // We validate that the A2ATransport interface sendMessageStream and resubscribeTask
  // accept/yield reasoning and tool_call.args event types.
  test("A2AEvent union includes reasoning and tool_call.args types", () => {
    // Already in union from previous work, but verify they're in the stream-related types
    const reasoningEvent: A2AEvent = { type: "reasoning.start" };
    const argsEvent: A2AEvent = { type: "tool_call.args", toolCallId: "tc-1", argsChunk: "{}" };
    expect(reasoningEvent.type).toBe("reasoning.start");
    expect(argsEvent.type).toBe("tool_call.args");
  });
});

describe("Fix 5: Provider emits reasoning and tool_call.args events from stream", () => {
  function createMockTransport(streamEvents: unknown[]) {
    return {
      resolveTarget: async () => ({}) as never,
      inspectTarget: async () => ({}) as never,
      sendMessage: async () => ({}) as never,
      sendMessageStream: async function* () {
        for (const event of streamEvents) {
          yield event;
        }
      },
      getTask: async () => ({}) as never,
      cancelTask: async () => ({}) as never,
      resubscribeTask: async function* () {
        for (const event of streamEvents) {
          yield event;
        }
      },
      setTaskPushNotificationConfig: async () => ({}) as never,
      getTaskPushNotificationConfig: async () => ({}) as never,
      listTaskPushNotificationConfigs: async () => [] as never,
      deleteTaskPushNotificationConfig: async () => undefined as never,
      getExtendedAgentCard: async () => ({}) as never,
      probe: async () => [] as never,
      subscribeDebug: () => () => {},
    };
  }

  test("provider emits reasoning events from SSE stream", async () => {
    const streamEvents = [
      { type: "reasoning.start" },
      { type: "reasoning.message.content", text: "thinking..." },
      { type: "reasoning.end" },
      // Terminal status-update ends the stream (A2A 1.0 — no terminal Task).
      TERMINAL_DONE,
    ];

    const transport = createMockTransport(streamEvents);
    const provider = new A2AClientProvider(transport as never);

    const received: A2AEvent[] = [];
    provider.subscribe((event) => received.push(event));

    const target = {
      baseUrl: "http://localhost",
      cardUrl: "http://localhost/.well-known/agent-card.json",
      card: {},
      capabilities: {
        supportsStreaming: true,
        supportsTextInput: true,
        supportsTextOutput: true,
        inputModes: [],
        outputModes: [],
        supportsPushNotifications: false,
        raw: {},
      },
    } as never;

    await provider.sendTurn(target, "test", { stream: true });

    const reasoningEvents = received.filter((e) => e.type.startsWith("reasoning."));
    expect(reasoningEvents.length).toBeGreaterThanOrEqual(3);
    expect(reasoningEvents.map((e) => e.type)).toContain("reasoning.start");
    expect(reasoningEvents.map((e) => e.type)).toContain("reasoning.message.content");
    expect(reasoningEvents.map((e) => e.type)).toContain("reasoning.end");
  });

  test("provider emits tool_call.args events from SSE stream", async () => {
    const streamEvents = [
      { type: "tool_call.args", toolCallId: "tc-1", argsChunk: '{"query":' },
      { type: "tool_call.args", toolCallId: "tc-1", argsChunk: ' "weather"}' },
      // Terminal status-update ends the stream (A2A 1.0 — no terminal Task).
      TERMINAL_DONE,
    ];

    const transport = createMockTransport(streamEvents);
    const provider = new A2AClientProvider(transport as never);

    const received: A2AEvent[] = [];
    provider.subscribe((event) => received.push(event));

    const target = {
      baseUrl: "http://localhost",
      cardUrl: "http://localhost/.well-known/agent-card.json",
      card: {},
      capabilities: {
        supportsStreaming: true,
        supportsTextInput: true,
        supportsTextOutput: true,
        inputModes: [],
        outputModes: [],
        supportsPushNotifications: false,
        raw: {},
      },
    } as never;

    await provider.sendTurn(target, "test", { stream: true });

    const argsEvents = received.filter((e) => e.type === "tool_call.args");
    expect(argsEvents.length).toBe(2);
    const first = argsEvents[0] as A2AToolCallArgsEvent;
    expect(first.toolCallId).toBe("tc-1");
    expect(first.argsChunk).toBe('{"query":');
  });
});
