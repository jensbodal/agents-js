import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { configureLogging, Logger, resetLogging } from "../src/logger.ts";
import { createInitialState, createTurnState } from "../src/session-state.ts";
import { handleSessionUpdate } from "../src/session-updates.ts";
import type { ACPSessionEvent, ACPSessionState } from "../src/types/session.ts";

// Scoped to this file's lifetime to avoid leaking "silent" minLevel into
// other test files' global logger state. See logger.ts's globalLogConfig.
beforeAll(() => {
  configureLogging({ minLevel: "silent" });
});
afterAll(() => {
  resetLogging();
});

const noopLog = new Logger("debug");

function makeToolCallNotification(opts: {
  toolCallId: string;
  title: string;
  status: string;
  kind?: string;
}): SessionNotification {
  return {
    sessionId: "s-1",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: opts.toolCallId,
      title: opts.title,
      status: opts.status,
      kind: opts.kind ?? "tool",
    },
  } as SessionNotification;
}

function makeTextChunkNotification(text: string): SessionNotification {
  return {
    sessionId: "s-1",
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  } as SessionNotification;
}

describe("handleSessionUpdate — tool call and text processing", () => {
  function setup() {
    const state: ACPSessionState = {
      ...createInitialState(),
      sessionId: "s-1",
      status: "prompting",
      currentTurn: createTurnState(),
    };
    const events: ACPSessionEvent[] = [];
    const emit = (event: ACPSessionEvent) => events.push(event);
    return { state, events, emit };
  }

  test("records tool call in turnItems and toolCalls map", () => {
    const { state, emit } = setup();

    const notification = makeToolCallNotification({
      toolCallId: "tc-1",
      title: "Write file",
      status: "in_progress",
    });

    handleSessionUpdate(notification, state, null, emit, noopLog);

    expect(state.currentTurn?.toolCalls.has("tc-1")).toBe(true);
    expect(state.currentTurn?.turnItems).toHaveLength(1);
    expect(state.currentTurn?.turnItems[0]).toEqual({ type: "tool_call", id: "tc-1" });
  });

  test("processes text chunks", () => {
    const { state, emit } = setup();

    const textNotification = makeTextChunkNotification("Hello world");
    handleSessionUpdate(textNotification, state, null, emit, noopLog);

    expect(state.currentTurn?.textChunks).toEqual(["Hello world"]);
  });

  test("tool calls are not blocked regardless of permission mode", () => {
    const { state, emit } = setup();

    const notification = makeToolCallNotification({
      toolCallId: "tc-1",
      title: "Write file",
      status: "in_progress",
    });

    handleSessionUpdate(notification, state, null, emit, noopLog);

    // Tool call should be recorded, not blocked
    expect(state.currentTurn).toBeDefined();
    expect(state.currentTurn?.toolCalls.has("tc-1")).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: existence asserted above
    const tc = state.currentTurn!.toolCalls.get("tc-1")!;
    expect(tc.name).toBe("Write file");
    expect(tc.status).toBe("running");
  });

  test("emits session_update for each notification", () => {
    const { state, events, emit } = setup();

    const notification = makeTextChunkNotification("test");
    handleSessionUpdate(notification, state, null, emit, noopLog);

    const sessionUpdates = events.filter((e) => e.type === "session_update");
    expect(sessionUpdates).toHaveLength(1);
  });

  test("available_commands_update stores commands in state and emits event", () => {
    const { state, events, emit } = setup();

    const notification: SessionNotification = {
      sessionId: "s-1",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "create_plan", description: "Create a plan" },
          { name: "research", description: "Research codebase" },
        ],
      },
    } as SessionNotification;

    handleSessionUpdate(notification, state, null, emit, noopLog);

    expect(state.availableCommands).toHaveLength(2);
    expect(state.availableCommands?.[0]?.name).toBe("create_plan");
    expect(state.availableCommands?.[1]?.name).toBe("research");

    const cmdEvent = events.find((e) => e.type === "available_commands_updated");
    expect(cmdEvent).toBeDefined();
    if (cmdEvent?.type === "available_commands_updated") {
      expect(cmdEvent.commands).toHaveLength(2);
      expect(cmdEvent.commands[0]?.name).toBe("create_plan");
    }
  });

  test("available_commands_update replaces previous commands", () => {
    const { state, emit } = setup();

    // First update
    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "old_command" }],
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );
    expect(state.availableCommands).toHaveLength(1);

    // Second update replaces
    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "new_a" }, { name: "new_b" }],
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );
    expect(state.availableCommands).toHaveLength(2);
    expect(state.availableCommands?.[0]?.name).toBe("new_a");
  });

  test("usage_update stores usage in state and emits event", () => {
    const { state, events, emit } = setup();

    const notification: SessionNotification = {
      sessionId: "s-1",
      update: {
        sessionUpdate: "usage_update",
        size: 100000,
        used: 5000,
      },
    } as SessionNotification;

    handleSessionUpdate(notification, state, null, emit, noopLog);

    expect(state.usage).toEqual({ size: 100000, used: 5000, cost: null });

    const usageEvent = events.find((e) => e.type === "usage_updated");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === "usage_updated") {
      expect(usageEvent.size).toBe(100000);
      expect(usageEvent.used).toBe(5000);
      expect(usageEvent.cost).toBeNull();
    }
  });

  test("usage_update includes cost when present", () => {
    const { state, events, emit } = setup();

    const notification: SessionNotification = {
      sessionId: "s-1",
      update: {
        sessionUpdate: "usage_update",
        size: 200000,
        used: 50000,
        cost: { amount: 1.5, currency: "USD" },
      },
    } as SessionNotification;

    handleSessionUpdate(notification, state, null, emit, noopLog);

    expect(state.usage).toEqual({
      size: 200000,
      used: 50000,
      cost: { amount: 1.5, currency: "USD" },
    });

    const usageEvent = events.find((e) => e.type === "usage_updated");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === "usage_updated") {
      expect(usageEvent.cost).toEqual({ amount: 1.5, currency: "USD" });
    }
  });

  test("usage_update replaces previous usage data", () => {
    const { state, emit } = setup();

    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: { sessionUpdate: "usage_update", size: 100000, used: 5000 },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );
    expect(state.usage?.used).toBe(5000);

    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: { sessionUpdate: "usage_update", size: 100000, used: 15000 },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );
    expect(state.usage?.used).toBe(15000);
  });
});

describe("handleSessionUpdate — AG-UI tool_call lifecycle emission", () => {
  function setup() {
    const state: ACPSessionState = {
      ...createInitialState(),
      sessionId: "s-1",
      status: "prompting",
      currentTurn: createTurnState(),
    };
    const events: ACPSessionEvent[] = [];
    const emit = (event: ACPSessionEvent) => events.push(event);
    return { state, events, emit };
  }

  test("emits tool_call_start on first tool_call notification", () => {
    const { state, events, emit } = setup();

    const notification = makeToolCallNotification({
      toolCallId: "tc-1",
      title: "Search",
      status: "in_progress",
    });
    handleSessionUpdate(notification, state, null, emit, noopLog);

    const startEvents = events.filter((e) => e.type === "tool_call_start");
    expect(startEvents).toHaveLength(1);
    const startEvent = startEvents[0];
    if (startEvent?.type === "tool_call_start") {
      expect(startEvent.toolCallId).toBe("tc-1");
      expect(startEvent.toolCallName).toBe("Search");
    }
  });

  test("emits tool_call_start for pending status too", () => {
    const { state, events, emit } = setup();

    const notification = makeToolCallNotification({
      toolCallId: "tc-1",
      title: "Search",
      status: "pending",
    });
    handleSessionUpdate(notification, state, null, emit, noopLog);

    const startEvents = events.filter((e) => e.type === "tool_call_start");
    expect(startEvents).toHaveLength(1);
  });

  test("does not double-emit tool_call_start for the same toolCallId", () => {
    const { state, events, emit } = setup();

    // First tool_call notification
    handleSessionUpdate(
      makeToolCallNotification({ toolCallId: "tc-1", title: "Search", status: "in_progress" }),
      state,
      null,
      emit,
      noopLog,
    );

    // Subsequent tool_call_update
    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "in_progress",
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );

    const startEvents = events.filter((e) => e.type === "tool_call_start");
    expect(startEvents).toHaveLength(1);
  });

  test("emits tool_call_end when status transitions to completed", () => {
    const { state, events, emit } = setup();

    handleSessionUpdate(
      makeToolCallNotification({ toolCallId: "tc-1", title: "Search", status: "in_progress" }),
      state,
      null,
      emit,
      noopLog,
    );

    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );

    const endEvents = events.filter((e) => e.type === "tool_call_end");
    expect(endEvents).toHaveLength(1);
    const endEvent = endEvents[0];
    if (endEvent?.type === "tool_call_end") {
      expect(endEvent.toolCallId).toBe("tc-1");
    }
  });

  test("emits tool_call_end when status transitions to failed", () => {
    const { state, events, emit } = setup();

    handleSessionUpdate(
      makeToolCallNotification({ toolCallId: "tc-1", title: "Search", status: "in_progress" }),
      state,
      null,
      emit,
      noopLog,
    );

    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "failed",
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );

    const endEvents = events.filter((e) => e.type === "tool_call_end");
    expect(endEvents).toHaveLength(1);
  });

  test("does not emit tool_call_end for non-terminal statuses", () => {
    const { state, events, emit } = setup();

    handleSessionUpdate(
      makeToolCallNotification({ toolCallId: "tc-1", title: "Search", status: "in_progress" }),
      state,
      null,
      emit,
      noopLog,
    );

    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "in_progress",
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );

    const endEvents = events.filter((e) => e.type === "tool_call_end");
    expect(endEvents).toHaveLength(0);
  });

  test("does not double-emit tool_call_end for the same toolCallId", () => {
    const { state, events, emit } = setup();

    handleSessionUpdate(
      makeToolCallNotification({ toolCallId: "tc-1", title: "Search", status: "in_progress" }),
      state,
      null,
      emit,
      noopLog,
    );

    // First terminal update
    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );

    // Duplicate terminal update
    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          status: "completed",
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );

    const endEvents = events.filter((e) => e.type === "tool_call_end");
    expect(endEvents).toHaveLength(1);
  });

  test("emits tool_call_end on first notification if status is already terminal", () => {
    const { state, events, emit } = setup();

    handleSessionUpdate(
      makeToolCallNotification({ toolCallId: "tc-1", title: "Search", status: "completed" }),
      state,
      null,
      emit,
      noopLog,
    );

    const startEvents = events.filter((e) => e.type === "tool_call_start");
    const endEvents = events.filter((e) => e.type === "tool_call_end");
    expect(startEvents).toHaveLength(1);
    expect(endEvents).toHaveLength(1);
  });

  test("synthesizes tool_call_start when initial notification was missed", () => {
    const { state, events, emit } = setup();

    // Simulate a missed tool_call notification: only a tool_call_update arrives.
    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-1",
          title: "Search",
          status: "in_progress",
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );

    const startEvents = events.filter((e) => e.type === "tool_call_start");
    expect(startEvents).toHaveLength(1);
    const startEvent = startEvents[0];
    if (startEvent?.type === "tool_call_start") {
      expect(startEvent.toolCallId).toBe("tc-1");
      expect(startEvent.toolCallName).toBe("Search");
    }
  });

  test("emits tool_call_start with parentMessageId when agentMessageId is known", () => {
    const { state, events, emit } = setup();

    // First send an agent message chunk so the agentMessageId gets captured.
    handleSessionUpdate(
      {
        sessionId: "s-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "agent-msg-1",
          content: { type: "text", text: "Let me search..." },
        },
      } as SessionNotification,
      state,
      null,
      emit,
      noopLog,
    );

    handleSessionUpdate(
      makeToolCallNotification({ toolCallId: "tc-1", title: "Search", status: "in_progress" }),
      state,
      null,
      emit,
      noopLog,
    );

    const startEvent = events.find((e) => e.type === "tool_call_start");
    if (startEvent?.type === "tool_call_start") {
      expect(startEvent.parentMessageId).toBe("agent-msg-1");
    }
  });
});
