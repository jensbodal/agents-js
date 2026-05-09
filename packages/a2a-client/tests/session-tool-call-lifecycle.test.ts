import { describe, expect, test } from "bun:test";
import type {
  A2AEvent,
  A2AToolCallArgsEvent,
  A2AToolCallEndEvent,
  A2AToolCallStartEvent,
} from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/index.ts";

describe("tool_call.start event — type definition", () => {
  test("A2AToolCallStartEvent has required fields", () => {
    const event: A2AToolCallStartEvent = {
      type: "tool_call.start",
      toolCallId: "tc-1",
      toolCallName: "web_search",
    };
    expect(event.type).toBe("tool_call.start");
    expect(event.toolCallId).toBe("tc-1");
    expect(event.toolCallName).toBe("web_search");
  });

  test("A2AToolCallStartEvent supports optional parentMessageId", () => {
    const event: A2AToolCallStartEvent = {
      type: "tool_call.start",
      toolCallId: "tc-1",
      toolCallName: "web_search",
      parentMessageId: "msg-42",
    };
    expect(event.parentMessageId).toBe("msg-42");
  });

  test("A2AToolCallStartEvent is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "tool_call.start",
      toolCallId: "tc-1",
      toolCallName: "web_search",
    };
    expect(event.type).toBe("tool_call.start");
  });
});

describe("tool_call.end event — type definition", () => {
  test("A2AToolCallEndEvent has required fields", () => {
    const event: A2AToolCallEndEvent = {
      type: "tool_call.end",
      toolCallId: "tc-1",
    };
    expect(event.type).toBe("tool_call.end");
    expect(event.toolCallId).toBe("tc-1");
  });

  test("A2AToolCallEndEvent is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "tool_call.end",
      toolCallId: "tc-1",
    };
    expect(event.type).toBe("tool_call.end");
  });
});

describe("tool_call lifecycle events — reducer pass-through", () => {
  test("reducer passes tool_call.start through without state mutation", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      contextId: "ctx-1",
      taskId: "task-1",
      pendingAgentText: "working...",
    });

    const next = reduceA2ASessionState(initial, {
      type: "tool_call.start",
      toolCallId: "tc-1",
      toolCallName: "web_search",
    });

    // Pass-through: state identity preserved
    expect(next).toBe(initial);
    expect(next.status).toBe("waiting");
    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBe("task-1");
    expect(next.pendingAgentText).toBe("working...");
  });

  test("reducer passes tool_call.end through without state mutation", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      contextId: "ctx-1",
      taskId: "task-1",
      pendingAgentText: "working...",
    });

    const next = reduceA2ASessionState(initial, {
      type: "tool_call.end",
      toolCallId: "tc-1",
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("waiting");
    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBe("task-1");
    expect(next.pendingAgentText).toBe("working...");
  });
});

describe("tool_call lifecycle events — subscriber callbacks", () => {
  test("subscribed listener receives tool_call.start with full payload", () => {
    const received: A2AEvent[] = [];
    const listener: (event: A2AEvent) => void = (event) => received.push(event);

    listener({
      type: "tool_call.start",
      toolCallId: "tc-1",
      toolCallName: "web_search",
      parentMessageId: "msg-42",
    });

    expect(received).toHaveLength(1);
    const event = received[0];
    if (event?.type === "tool_call.start") {
      expect(event.toolCallId).toBe("tc-1");
      expect(event.toolCallName).toBe("web_search");
      expect(event.parentMessageId).toBe("msg-42");
    }
  });

  test("subscribed listener receives tool_call.end with full payload", () => {
    const received: A2AEvent[] = [];
    const listener: (event: A2AEvent) => void = (event) => received.push(event);

    listener({
      type: "tool_call.end",
      toolCallId: "tc-1",
    });

    expect(received).toHaveLength(1);
    const event = received[0];
    if (event?.type === "tool_call.end") {
      expect(event.toolCallId).toBe("tc-1");
    }
  });
});

describe("tool_call lifecycle — full start → args → end sequence", () => {
  test("reducer handles full lifecycle in order without state corruption", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      contextId: "ctx-1",
      taskId: "task-1",
    });

    const events: A2AEvent[] = [
      { type: "tool_call.start", toolCallId: "tc-1", toolCallName: "web_search" },
      { type: "tool_call.args", toolCallId: "tc-1", argsChunk: '{"query":' },
      { type: "tool_call.args", toolCallId: "tc-1", argsChunk: ' "weather"}' },
      { type: "tool_call.end", toolCallId: "tc-1" },
    ];

    let state = initial;
    for (const event of events) {
      state = reduceA2ASessionState(state, event);
    }

    // All lifecycle events are pass-through
    expect(state).toBe(initial);
    expect(state.status).toBe("waiting");
    expect(state.contextId).toBe("ctx-1");
    expect(state.taskId).toBe("task-1");
  });

  test("subscriber receives full lifecycle in order", () => {
    const received: A2AEvent[] = [];
    const listener: (event: A2AEvent) => void = (event) => received.push(event);

    const lifecycle: [A2AToolCallStartEvent, A2AToolCallArgsEvent, A2AToolCallEndEvent] = [
      { type: "tool_call.start", toolCallId: "tc-1", toolCallName: "web_search" },
      { type: "tool_call.args", toolCallId: "tc-1", argsChunk: '{"query": "weather"}' },
      { type: "tool_call.end", toolCallId: "tc-1" },
    ];

    for (const event of lifecycle) {
      listener(event);
    }

    expect(received).toHaveLength(3);
    expect(received[0]?.type).toBe("tool_call.start");
    expect(received[1]?.type).toBe("tool_call.args");
    expect(received[2]?.type).toBe("tool_call.end");
  });
});
