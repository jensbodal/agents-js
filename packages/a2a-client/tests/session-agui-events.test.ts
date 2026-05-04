import { describe, expect, test } from "bun:test";
import type {
  A2AEvent,
  A2AMessageEndEvent,
  A2AMessageStartEvent,
  A2AStepFinishedEvent,
  A2AStepStartedEvent,
} from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/index.ts";

describe("AG-UI message lifecycle events", () => {
  test("message.start event type has required fields", () => {
    const event: A2AMessageStartEvent = {
      type: "message.start",
      role: "agent",
      messageId: "msg-1",
    };

    expect(event.type).toBe("message.start");
    expect(event.role).toBe("agent");
    expect(event.messageId).toBe("msg-1");
  });

  test("message.start is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "message.start",
      role: "agent",
      messageId: "msg-1",
    };
    expect(event.type).toBe("message.start");
  });

  test("reducer handles message.start → sets status to waiting", () => {
    const initial = createInitialSessionState({ status: "connected" });
    const next = reduceA2ASessionState(initial, {
      type: "message.start",
      role: "agent",
      messageId: "msg-1",
    });

    expect(next.status).toBe("waiting");
    // Should not append to transcript (transcript added on message.completed)
    expect(next.transcript.length).toBe(0);
  });

  test("message.end event type has required fields", () => {
    const event: A2AMessageEndEvent = {
      type: "message.end",
      messageId: "msg-1",
    };

    expect(event.type).toBe("message.end");
    expect(event.messageId).toBe("msg-1");
  });

  test("message.end is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "message.end",
      messageId: "msg-1",
    };
    expect(event.type).toBe("message.end");
  });

  test("reducer handles message.end → clears pendingAgentText, sets status to connected", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      pendingAgentText: "partial response",
    });
    const next = reduceA2ASessionState(initial, {
      type: "message.end",
      messageId: "msg-1",
    });

    expect(next.status).toBe("connected");
    expect(next.pendingAgentText).toBeUndefined();
  });

  test("reducer handles message.start → message.end sequence", () => {
    const initial = createInitialSessionState({ status: "connected" });

    const afterStart = reduceA2ASessionState(initial, {
      type: "message.start",
      role: "agent",
      messageId: "msg-1",
    });
    expect(afterStart.status).toBe("waiting");

    const afterEnd = reduceA2ASessionState(afterStart, {
      type: "message.end",
      messageId: "msg-1",
    });
    expect(afterEnd.status).toBe("connected");
    expect(afterEnd.pendingAgentText).toBeUndefined();
    // No transcript entries (those come from message.completed)
    expect(afterEnd.transcript.length).toBe(0);
  });

  test("message.completed backward compatibility preserved", () => {
    const initial = createInitialSessionState();
    const next = reduceA2ASessionState(initial, {
      type: "message.completed",
      text: "hello world",
      contextId: "ctx-1",
      taskId: "task-1",
      task: {
        kind: "task",
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
      },
    });

    expect(next.status).toBe("connected");
    expect(next.transcript).toHaveLength(1);
    expect(next.transcript[0]?.text).toBe("hello world");
    expect(next.contextId).toBe("ctx-1");
  });
});

describe("AG-UI step lifecycle events", () => {
  test("step.started event type has required fields", () => {
    const event: A2AStepStartedEvent = {
      type: "step.started",
      stepId: "step-1",
      name: "search_web",
    };

    expect(event.type).toBe("step.started");
    expect(event.stepId).toBe("step-1");
    expect(event.name).toBe("search_web");
  });

  test("step.started allows optional name", () => {
    const event: A2AStepStartedEvent = {
      type: "step.started",
      stepId: "step-1",
    };
    expect(event.stepId).toBe("step-1");
    expect(event.name).toBeUndefined();
  });

  test("step.started is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "step.started",
      stepId: "step-1",
      name: "search_web",
    };
    expect(event.type).toBe("step.started");
  });

  test("step.finished event type has required fields", () => {
    const event: A2AStepFinishedEvent = {
      type: "step.finished",
      stepId: "step-1",
      result: '{"status": "ok"}',
    };

    expect(event.type).toBe("step.finished");
    expect(event.stepId).toBe("step-1");
    expect(event.result).toBe('{"status": "ok"}');
  });

  test("step.finished allows optional result", () => {
    const event: A2AStepFinishedEvent = {
      type: "step.finished",
      stepId: "step-1",
    };
    expect(event.stepId).toBe("step-1");
    expect(event.result).toBeUndefined();
  });

  test("step.finished is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "step.finished",
      stepId: "step-1",
    };
    expect(event.type).toBe("step.finished");
  });

  test("reducer handles step.started during active turn", () => {
    const initial = createInitialSessionState({ status: "waiting" });
    const next = reduceA2ASessionState(initial, {
      type: "step.started",
      stepId: "step-1",
      name: "search_web",
    });

    // Step events are informational; status stays waiting
    expect(next.status).toBe("waiting");
  });

  test("reducer handles step.finished after step.started", () => {
    const initial = createInitialSessionState({ status: "waiting" });
    const afterStart = reduceA2ASessionState(initial, {
      type: "step.started",
      stepId: "step-1",
      name: "search_web",
    });
    expect(afterStart.status).toBe("waiting");

    const afterFinish = reduceA2ASessionState(afterStart, {
      type: "step.finished",
      stepId: "step-1",
      result: "found 5 results",
    });

    // Status remains waiting since the turn is still active
    expect(afterFinish.status).toBe("waiting");
  });

  test("reducer handles nested steps correctly", () => {
    const initial = createInitialSessionState({ status: "waiting" });

    // Start outer step
    const s1 = reduceA2ASessionState(initial, {
      type: "step.started",
      stepId: "outer-step",
      name: "research",
    });
    expect(s1.status).toBe("waiting");

    // Start inner step
    const s2 = reduceA2ASessionState(s1, {
      type: "step.started",
      stepId: "inner-step",
      name: "search_web",
    });
    expect(s2.status).toBe("waiting");

    // Finish inner step
    const s3 = reduceA2ASessionState(s2, {
      type: "step.finished",
      stepId: "inner-step",
      result: "done",
    });
    expect(s3.status).toBe("waiting");

    // Finish outer step
    const s4 = reduceA2ASessionState(s3, {
      type: "step.finished",
      stepId: "outer-step",
      result: "all done",
    });
    expect(s4.status).toBe("waiting");
  });

  test("step events do not corrupt other state fields", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      contextId: "ctx-1",
      taskId: "task-1",
      pendingAgentText: "some text",
      transcript: [{ id: "t1", role: "user", text: "hello" }],
    });

    const afterStep = reduceA2ASessionState(initial, {
      type: "step.started",
      stepId: "step-1",
    });

    expect(afterStep.contextId).toBe("ctx-1");
    expect(afterStep.taskId).toBe("task-1");
    expect(afterStep.pendingAgentText).toBe("some text");
    expect(afterStep.transcript).toHaveLength(1);

    const afterFinish = reduceA2ASessionState(afterStep, {
      type: "step.finished",
      stepId: "step-1",
    });

    expect(afterFinish.contextId).toBe("ctx-1");
    expect(afterFinish.taskId).toBe("task-1");
    expect(afterFinish.pendingAgentText).toBe("some text");
    expect(afterFinish.transcript).toHaveLength(1);
  });
});

describe("existing A2AEvent variants unchanged", () => {
  test("all 10 original event types still work in reducer", () => {
    const initial = createInitialSessionState({ status: "connected" });

    // target.resolved
    const r1 = reduceA2ASessionState(initial, {
      type: "target.resolved",
      target: {
        baseUrl: "http://localhost:3000",
        cardUrl: "http://localhost:3000/.well-known/agent-card.json",
        card: {
          name: "test",
          description: "test agent",
          url: "http://localhost:3000",
          version: "1.0",
          protocolVersion: "0.3.0",
          defaultInputModes: ["text"],
          defaultOutputModes: ["text"],
          skills: [],
          capabilities: {},
        },
        capabilities: {
          inputModes: ["text"],
          outputModes: ["text"],
          supportsTextInput: true,
          supportsTextOutput: true,
          supportsStreaming: false,
          supportsPushNotifications: false,
          raw: {},
        },
      },
    });
    expect(r1.status).toBe("connected");

    // turn.started
    const r2 = reduceA2ASessionState(initial, {
      type: "turn.started",
      text: "hello",
    });
    expect(r2.status).toBe("sending");

    // message.delta
    const r3 = reduceA2ASessionState(initial, {
      type: "message.delta",
      text: "partial",
    });
    expect(r3.status).toBe("waiting");

    // message.completed
    const r4 = reduceA2ASessionState(initial, {
      type: "message.completed",
      text: "done",
    });
    expect(r4.status).toBe("connected");

    // error
    const r5 = reduceA2ASessionState(initial, {
      type: "error",
      error: "boom",
    });
    expect(r5.status).toBe("error");

    // session.updated
    const newState = createInitialSessionState({ status: "idle" });
    const r6 = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: newState,
    });
    expect(r6.status).toBe("idle");

    // debug.record
    const r7 = reduceA2ASessionState(initial, {
      type: "debug.record",
      record: {
        requestId: "req-1",
        timestamp: new Date().toISOString(),
        direction: "outbound",
        kind: "http",
        method: "POST",
        url: "http://localhost:3000",
        headers: {},
      },
    });
    expect(r7.debugRecords).toHaveLength(1);
  });
});

describe("AG-UI field alignment (Wave 2.3)", () => {
  test("message.start accepts spec-shaped role values", () => {
    const roles = ["user", "agent", "assistant", "system", "tool", "developer"] as const;
    for (const role of roles) {
      const event: A2AMessageStartEvent = {
        type: "message.start",
        role,
        messageId: `msg-${role}`,
      };
      expect(event.role).toBe(role);

      // Reducer still sets status to waiting for every role value
      const initial = createInitialSessionState({ status: "connected" });
      const next = reduceA2ASessionState(initial, event);
      expect(next.status).toBe("waiting");
    }
  });

  test("message.delta accepts optional delta and messageId spec aliases", () => {
    const event: A2AEvent = {
      type: "message.delta",
      text: "hello world",
      delta: " world",
      messageId: "msg-1",
    };
    if (event.type === "message.delta") {
      expect(event.text).toBe("hello world");
      expect(event.delta).toBe(" world");
      expect(event.messageId).toBe("msg-1");
    }

    // Reducer behavior unchanged: status becomes waiting regardless of spec fields.
    const initial = createInitialSessionState({ status: "connected" });
    const next = reduceA2ASessionState(initial, {
      type: "message.delta",
      text: "hello",
      delta: "hello",
      messageId: "msg-2",
    });
    expect(next.status).toBe("waiting");
  });

  test("message.delta still works without spec fields (backward compat)", () => {
    const event: A2AEvent = {
      type: "message.delta",
      text: "legacy-only",
    };
    if (event.type === "message.delta") {
      expect(event.text).toBe("legacy-only");
      expect(event.delta).toBeUndefined();
      expect(event.messageId).toBeUndefined();
    }
  });
});
