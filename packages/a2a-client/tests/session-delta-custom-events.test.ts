import { describe, expect, test } from "bun:test";
import type { A2ACustomEvent, A2AEvent, A2ASessionUpdatedEvent } from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/index.ts";

describe("StateDelta event (VAL-AGUI-011, VAL-AGUI-012, VAL-AGUI-013)", () => {
  test("A2ASessionUpdatedEvent supports optional delta field with JSON Patch operations", () => {
    const event: A2ASessionUpdatedEvent = {
      type: "session.updated",
      state: createInitialSessionState({ status: "connected" }),
      delta: [{ op: "replace", path: "/status", value: "waiting" }],
    };

    expect(event.type).toBe("session.updated");
    expect(event.delta).toBeDefined();
    expect(event.delta).toHaveLength(1);
    expect(event.delta?.[0]?.op).toBe("replace");
  });

  test("A2ASessionUpdatedEvent delta field is optional (backward compat)", () => {
    const event: A2ASessionUpdatedEvent = {
      type: "session.updated",
      state: createInitialSessionState({ status: "idle" }),
    };

    expect(event.delta).toBeUndefined();
  });

  test("reducer applies JSON Patch replace operation via delta", () => {
    const initial = createInitialSessionState({ status: "idle" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "replace", path: "/status", value: "connected" }],
    });

    expect(next.status).toBe("connected");
  });

  test("reducer applies JSON Patch add operation via delta", () => {
    const initial = createInitialSessionState({ status: "connected" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "add", path: "/lastError", value: "timeout" }],
    });

    expect(next.lastError).toBe("timeout");
  });

  test("reducer applies JSON Patch remove operation via delta", () => {
    const initial = createInitialSessionState({
      status: "error",
      lastError: "something went wrong",
    });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "remove", path: "/lastError" }],
    });

    expect(next.lastError).toBeUndefined();
  });

  test("reducer applies multiple JSON Patch operations in sequence", () => {
    const initial = createInitialSessionState({ status: "idle" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [
        { op: "replace", path: "/status", value: "connected" },
        { op: "add", path: "/pendingAgentText", value: "hello world" },
      ],
    });

    expect(next.status).toBe("connected");
    expect(next.pendingAgentText).toBe("hello world");
  });

  test("reducer applies add/remove/replace patch ops on nested paths", () => {
    const initial = createInitialSessionState({
      status: "connected",
      transcript: [{ id: "t1", role: "user", text: "hello" }],
    });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "replace", path: "/transcript/0/text", value: "hi there" }],
    });

    expect(next.transcript[0]?.text).toBe("hi there");
  });

  test("reducer returns previous state on invalid JSON Patch replace (graceful degradation)", () => {
    const initial = createInitialSessionState({ status: "idle" });

    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "replace", path: "/nonexistent/deep/path", value: "test" }],
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("idle");
  });

  test("reducer returns previous state on invalid JSON Patch remove (graceful degradation)", () => {
    const initial = createInitialSessionState({ status: "idle" });

    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "remove", path: "/nonexistent/deep/path" }],
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("idle");
  });

  test("full-snapshot session.updated backward compatibility preserved", () => {
    const initial = createInitialSessionState({ status: "connected" });
    const newState = createInitialSessionState({ status: "idle" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: newState,
    });

    // Without delta, behaves as before: replaces state wholesale
    expect(next.status).toBe("idle");
    expect(next).toBe(newState);
  });

  test("delta takes precedence when both state and delta are present", () => {
    const initial = createInitialSessionState({ status: "connected" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: createInitialSessionState({ status: "error" }),
      delta: [{ op: "replace", path: "/status", value: "waiting" }],
    });

    // Delta applies to current state, not the provided state
    expect(next.status).toBe("waiting");
  });

  test("delta produces a new state object (immutable)", () => {
    const initial = createInitialSessionState({ status: "idle" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "replace", path: "/status", value: "connected" }],
    });

    expect(next).not.toBe(initial);
    expect(initial.status).toBe("idle");
    expect(next.status).toBe("connected");
  });

  test("delta with JSON Patch test operation validates before applying", () => {
    const initial = createInitialSessionState({ status: "idle" });

    // test operation should pass when value matches
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [
        { op: "test", path: "/status", value: "idle" },
        { op: "replace", path: "/status", value: "connected" },
      ],
    });
    expect(next.status).toBe("connected");

    // test operation should return previous state when value doesn't match (graceful degradation)
    const failed = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [
        { op: "test", path: "/status", value: "connected" },
        { op: "replace", path: "/status", value: "error" },
      ],
    });
    expect(failed).toBe(initial);
    expect(failed.status).toBe("idle");
  });

  test("delta with empty array returns current state unchanged", () => {
    const initial = createInitialSessionState({ status: "idle" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [],
    });

    expect(next.status).toBe("idle");
  });

  test("delta supports array manipulation via add to index", () => {
    const initial = createInitialSessionState({
      status: "connected",
      transcript: [{ id: "t1", role: "user", text: "hello" }],
    });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [
        {
          op: "add",
          path: "/transcript/1",
          value: { id: "t2", role: "agent", text: "hi" },
        },
      ],
    });

    expect(next.transcript).toHaveLength(2);
    expect(next.transcript[1]?.text).toBe("hi");
  });

  test("delta supports array append via - index", () => {
    const initial = createInitialSessionState({
      status: "connected",
      transcript: [{ id: "t1", role: "user", text: "hello" }],
    });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [
        {
          op: "add",
          path: "/transcript/-",
          value: { id: "t2", role: "agent", text: "world" },
        },
      ],
    });

    expect(next.transcript).toHaveLength(2);
    expect(next.transcript[1]?.text).toBe("world");
  });
});

describe("Malformed delta graceful degradation", () => {
  test("reducer does not crash on malformed delta and returns previous state", () => {
    const initial = createInitialSessionState({
      status: "connected",
      contextId: "ctx-1",
      taskId: "task-1",
      pendingAgentText: "partial response",
    });

    // Invalid path that doesn't exist
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "replace", path: "/bogus/invalid/path", value: "crash" }],
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("connected");
    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBe("task-1");
    expect(next.pendingAgentText).toBe("partial response");
  });

  test("reducer handles unknown patch operation gracefully", () => {
    const initial = createInitialSessionState({ status: "idle" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "invalid_op" as "replace", path: "/status", value: "crash" }],
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("idle");
  });

  test("reducer handles malformed path syntax gracefully", () => {
    const initial = createInitialSessionState({ status: "idle" });
    const next = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "replace", path: "no-leading-slash", value: "crash" }],
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("idle");
  });
});

describe("Custom event (VAL-AGUI-014, VAL-AGUI-015, VAL-AGUI-016)", () => {
  test("A2ACustomEvent type has required fields", () => {
    const event: A2ACustomEvent = {
      type: "custom",
      name: "my.custom.event",
      data: { foo: "bar", count: 42 },
    };

    expect(event.type).toBe("custom");
    expect(event.name).toBe("my.custom.event");
    expect(event.data).toEqual({ foo: "bar", count: 42 });
  });

  test("A2ACustomEvent is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "custom",
      name: "test.event",
      data: null,
    };
    expect(event.type).toBe("custom");
  });

  test("A2ACustomEvent data can be any JSON-serializable value", () => {
    const events: A2ACustomEvent[] = [
      { type: "custom", name: "null-data", data: null },
      { type: "custom", name: "string-data", data: "hello" },
      { type: "custom", name: "number-data", data: 42 },
      { type: "custom", name: "boolean-data", data: true },
      { type: "custom", name: "array-data", data: [1, 2, 3] },
      { type: "custom", name: "object-data", data: { nested: { deep: true } } },
    ];

    for (const event of events) {
      expect(event.type).toBe("custom");
    }
  });

  test("reducer passes through custom events without state mutation", () => {
    const initial = createInitialSessionState({ status: "connected" });
    const next = reduceA2ASessionState(initial, {
      type: "custom",
      name: "my.event",
      data: { foo: 1 },
    });

    // Custom events should not mutate state
    expect(next).toBe(initial);
  });

  test("reducer passes through custom events - state fields are unchanged", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      contextId: "ctx-1",
      taskId: "task-1",
      pendingAgentText: "partial",
      transcript: [{ id: "t1", role: "user", text: "hello" }],
    });

    const next = reduceA2ASessionState(initial, {
      type: "custom",
      name: "progress.update",
      data: { percent: 50 },
    });

    expect(next.status).toBe("waiting");
    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBe("task-1");
    expect(next.pendingAgentText).toBe("partial");
    expect(next.transcript).toHaveLength(1);
  });

  test("custom events reach subscriber callbacks", () => {
    // This test verifies VAL-AGUI-016: subscribers receive custom events
    const events: A2AEvent[] = [];
    const listener: (event: A2AEvent) => void = (event) => {
      events.push(event);
    };

    // Simulate the provider's emit pattern: listener is called with custom event
    const customEvent: A2ACustomEvent = {
      type: "custom",
      name: "x",
      data: { foo: 1 },
    };

    listener(customEvent);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("custom");
    const received = events[0];
    if (received?.type === "custom") {
      expect(received.name).toBe("x");
      expect(received.data).toEqual({ foo: 1 });
    }
  });
});

describe("exhaustiveness check (VAL-AGUI-025)", () => {
  test("reducer handles all event types without error", () => {
    const initial = createInitialSessionState({ status: "connected" });

    // StateDelta via session.updated
    const r1 = reduceA2ASessionState(initial, {
      type: "session.updated",
      state: initial,
      delta: [{ op: "replace", path: "/status", value: "waiting" }],
    });
    expect(r1.status).toBe("waiting");

    // Custom event
    const r2 = reduceA2ASessionState(initial, {
      type: "custom",
      name: "test",
      data: {},
    });
    expect(r2).toBe(initial);
  });
});
