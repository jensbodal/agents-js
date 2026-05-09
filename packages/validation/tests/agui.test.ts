import { describe, expect, test } from "bun:test";
import { EventType } from "@agents-js/agui-types";
import { isAguiEvent, validateAguiEvent, validateRunAgentInput } from "../src/agui.ts";
import { ValidationError } from "../src/errors.ts";

// Every event type in `EventType` is covered by a valid fixture below.
// This list is kept in sync with the enum to fail loudly on drift.
const eventFixtures: Record<EventType, Record<string, unknown>> = {
  [EventType.TEXT_MESSAGE_START]: {
    type: EventType.TEXT_MESSAGE_START,
    messageId: "m1",
    role: "user",
  },
  [EventType.TEXT_MESSAGE_CONTENT]: {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: "m1",
    delta: "hello",
  },
  [EventType.TEXT_MESSAGE_END]: {
    type: EventType.TEXT_MESSAGE_END,
    messageId: "m1",
  },
  [EventType.TEXT_MESSAGE_CHUNK]: {
    type: EventType.TEXT_MESSAGE_CHUNK,
    messageId: "m1",
    role: "assistant",
    delta: "hi",
  },
  [EventType.TOOL_CALL_START]: {
    type: EventType.TOOL_CALL_START,
    toolCallId: "call_1",
    toolCallName: "fs_read",
  },
  [EventType.TOOL_CALL_ARGS]: {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: "call_1",
    delta: '{"path":"/foo"}',
  },
  [EventType.TOOL_CALL_END]: {
    type: EventType.TOOL_CALL_END,
    toolCallId: "call_1",
  },
  [EventType.TOOL_CALL_CHUNK]: {
    type: EventType.TOOL_CALL_CHUNK,
    toolCallId: "call_1",
    delta: "partial",
  },
  [EventType.TOOL_CALL_RESULT]: {
    type: EventType.TOOL_CALL_RESULT,
    messageId: "m1",
    toolCallId: "call_1",
    content: "ok",
  },
  [EventType.THINKING_START]: {
    type: EventType.THINKING_START,
  },
  [EventType.THINKING_END]: {
    type: EventType.THINKING_END,
  },
  [EventType.THINKING_TEXT_MESSAGE_START]: {
    type: EventType.THINKING_TEXT_MESSAGE_START,
  },
  [EventType.THINKING_TEXT_MESSAGE_CONTENT]: {
    type: EventType.THINKING_TEXT_MESSAGE_CONTENT,
    delta: "partial thought",
  },
  [EventType.THINKING_TEXT_MESSAGE_END]: {
    type: EventType.THINKING_TEXT_MESSAGE_END,
  },
  [EventType.STATE_SNAPSHOT]: {
    type: EventType.STATE_SNAPSHOT,
    snapshot: { counter: 0 },
  },
  [EventType.STATE_DELTA]: {
    type: EventType.STATE_DELTA,
    delta: [{ op: "replace", path: "/counter", value: 1 }],
  },
  [EventType.MESSAGES_SNAPSHOT]: {
    type: EventType.MESSAGES_SNAPSHOT,
    messages: [{ id: "msg_1", role: "user", content: "hi" }],
  },
  [EventType.ACTIVITY_SNAPSHOT]: {
    type: EventType.ACTIVITY_SNAPSHOT,
    messageId: "m1",
    activityType: "typing",
    content: { progress: 0 },
  },
  [EventType.ACTIVITY_DELTA]: {
    type: EventType.ACTIVITY_DELTA,
    messageId: "m1",
    activityType: "typing",
    patch: [{ op: "replace", path: "/progress", value: 1 }],
  },
  [EventType.RAW]: {
    type: EventType.RAW,
    event: { provider: "anthropic", payload: {} },
  },
  [EventType.CUSTOM]: {
    type: EventType.CUSTOM,
    name: "custom_signal",
    value: { foo: "bar" },
  },
  [EventType.RUN_STARTED]: {
    type: EventType.RUN_STARTED,
    threadId: "thread_1",
    runId: "run_1",
  },
  [EventType.RUN_FINISHED]: {
    type: EventType.RUN_FINISHED,
    threadId: "thread_1",
    runId: "run_1",
  },
  [EventType.RUN_ERROR]: {
    type: EventType.RUN_ERROR,
    message: "boom",
  },
  [EventType.STEP_STARTED]: {
    type: EventType.STEP_STARTED,
    stepName: "plan",
  },
  [EventType.STEP_FINISHED]: {
    type: EventType.STEP_FINISHED,
    stepName: "plan",
  },
  [EventType.REASONING_START]: {
    type: EventType.REASONING_START,
    messageId: "reasoning_1",
  },
  [EventType.REASONING_MESSAGE_START]: {
    type: EventType.REASONING_MESSAGE_START,
    messageId: "reasoning_1",
    role: "reasoning",
  },
  [EventType.REASONING_MESSAGE_CONTENT]: {
    type: EventType.REASONING_MESSAGE_CONTENT,
    messageId: "reasoning_1",
    delta: "thinking...",
  },
  [EventType.REASONING_MESSAGE_END]: {
    type: EventType.REASONING_MESSAGE_END,
    messageId: "reasoning_1",
  },
  [EventType.REASONING_MESSAGE_CHUNK]: {
    type: EventType.REASONING_MESSAGE_CHUNK,
    messageId: "reasoning_1",
    delta: "chunk",
  },
  [EventType.REASONING_END]: {
    type: EventType.REASONING_END,
    messageId: "reasoning_1",
  },
  [EventType.REASONING_ENCRYPTED_VALUE]: {
    type: EventType.REASONING_ENCRYPTED_VALUE,
    subtype: "message",
    entityId: "reasoning_1",
    encryptedValue: "opaque-blob",
  },
};

describe("validateAguiEvent — accepts every AG-UI event type", () => {
  for (const [eventType, fixture] of Object.entries(eventFixtures)) {
    test(`accepts ${eventType}`, () => {
      const result = validateAguiEvent(fixture);
      if (!result.valid) {
        throw new Error(
          `Expected ${eventType} to validate; issues: ${JSON.stringify(result.error.issues)}`,
        );
      }
      expect(result.valid).toBe(true);
      expect(result.value.type).toBe(eventType as EventType);
    });
  }

  test("covers the full EventType enum (drift guard)", () => {
    const enumValues = Object.values(EventType);
    const fixtureKeys = Object.keys(eventFixtures);
    // 27 public types today — plus deprecated thinking variants make 33 total.
    // The count is whatever the enum reports; we only care that the fixture
    // set is exhaustive.
    expect(fixtureKeys.sort()).toEqual([...enumValues].sort());
  });
});

describe("validateAguiEvent — rejects invalid input", () => {
  test("rejects unknown event type", () => {
    const result = validateAguiEvent({ type: "NOT_A_REAL_EVENT" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.issues.length).toBeGreaterThan(0);
      // Zod's discriminated-union error surfaces on `type`.
      expect(result.error.message).toContain("Invalid AG-UI event");
    }
  });

  test("rejects event missing required field", () => {
    // TEXT_MESSAGE_START requires `messageId`.
    const result = validateAguiEvent({ type: EventType.TEXT_MESSAGE_START });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.issues.some((issue) => issue.path.includes("messageId"))).toBe(true);
    }
  });

  test("rejects wrong-typed field", () => {
    const result = validateAguiEvent({
      type: EventType.TOOL_CALL_START,
      toolCallId: 42, // should be string
      toolCallName: "fs_read",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.issues.some((issue) => issue.path.includes("toolCallId"))).toBe(true);
    }
  });

  test("rejects non-object input", () => {
    const result = validateAguiEvent("not an event");
    expect(result.valid).toBe(false);
  });

  test("rejects null", () => {
    const result = validateAguiEvent(null);
    expect(result.valid).toBe(false);
  });
});

describe("isAguiEvent — type guard", () => {
  test("returns true for valid event", () => {
    expect(
      isAguiEvent({
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "user",
      }),
    ).toBe(true);
  });

  test("returns false for invalid event", () => {
    expect(isAguiEvent({ type: "nope" })).toBe(false);
    expect(isAguiEvent(undefined)).toBe(false);
    expect(isAguiEvent({})).toBe(false);
  });
});

describe("validateRunAgentInput", () => {
  test("accepts minimal valid envelope", () => {
    const input = {
      threadId: "thread_1",
      runId: "run_1",
      state: {},
      messages: [{ id: "msg_1", role: "user", content: "hi" }],
      tools: [],
      context: [],
      forwardedProps: {},
    };

    const result = validateRunAgentInput(input);
    if (!result.valid) {
      throw new Error(`Expected valid; issues: ${JSON.stringify(result.error.issues)}`);
    }
    expect(result.value.threadId).toBe("thread_1");
    expect(result.value.runId).toBe("run_1");
  });

  test("rejects envelope missing threadId", () => {
    const result = validateRunAgentInput({
      runId: "run_1",
      state: {},
      messages: [],
      tools: [],
      context: [],
      forwardedProps: {},
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.issues.some((issue) => issue.path.includes("threadId"))).toBe(true);
    }
  });

  test("rejects non-object input", () => {
    const result = validateRunAgentInput(42);
    expect(result.valid).toBe(false);
  });
});
