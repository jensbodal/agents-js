import { describe, expect, test } from "bun:test";
import {
  type AgentCard,
  type CancelTaskRequest,
  type DeleteTaskPushNotificationConfigRequest,
  type GetTaskPushNotificationConfigRequest,
  type GetTaskRequest,
  type ListTaskPushNotificationConfigsRequest,
  type Message,
  Role,
  type SendMessageRequest,
  type Task,
  type TaskPushNotificationConfig,
  TaskState,
} from "@a2a-js/sdk";
import { A2AClientProvider } from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/session.ts";
import type {
  A2AEvent,
  A2ARunErrorEvent,
  A2ARunFinishedEvent,
  A2ARunStartedEvent,
  A2AStreamElement,
  A2ATransport,
  AgentTargetInput,
  DebugRecord,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";
import {
  createMockTarget,
  makeMessage,
  makeTask,
  makeTextPart,
  taskEvent,
} from "./mock-a2a-transport.ts";

class MockTransport implements A2ATransport {
  inspectResult: TargetInspection = { status: "ready" };

  constructor(
    private readonly sendResult: Message | Task,
    private readonly taskResults: Task[] = [],
    private readonly streamResults: A2AStreamElement[] = [],
  ) {}

  subscribeDebug(listener: (record: DebugRecord) => void): () => void {
    return () => listener;
  }

  async resolveTarget(_input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    return createMockTarget("http://127.0.0.1:55363");
  }

  async inspectTarget(_input: AgentTargetInput): Promise<TargetInspection> {
    return this.inspectResult;
  }

  async sendMessage(
    _target: ResolvedAgentTarget,
    _params: SendMessageRequest,
  ): Promise<Message | Task> {
    return this.sendResult;
  }

  async *sendMessageStream(): AsyncGenerator<A2AStreamElement> {
    for (const event of this.streamResults) {
      yield event;
    }
  }

  async getTask(_target: ResolvedAgentTarget, _params: GetTaskRequest): Promise<Task> {
    const next = this.taskResults.shift();
    if (!next) {
      throw new Error("no task available");
    }
    return next;
  }

  async cancelTask(_target: ResolvedAgentTarget, _params: CancelTaskRequest): Promise<Task> {
    throw new Error("not implemented");
  }

  async *resubscribeTask(): AsyncGenerator<A2AStreamElement> {
    // noop
  }

  async setTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not implemented");
  }

  async getTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: GetTaskPushNotificationConfigRequest,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not implemented");
  }

  async listTaskPushNotificationConfigs(
    _target: ResolvedAgentTarget,
    _params: ListTaskPushNotificationConfigsRequest,
  ): Promise<TaskPushNotificationConfig[]> {
    throw new Error("not implemented");
  }

  async deleteTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: DeleteTaskPushNotificationConfigRequest,
  ): Promise<void> {}

  async getExtendedAgentCard(_target: ResolvedAgentTarget): Promise<AgentCard> {
    throw new Error("not implemented");
  }

  async probe(_input: AgentTargetInput) {
    return [];
  }
}

class ErrorTransport extends MockTransport {
  constructor(private readonly sendError: Error) {
    super(
      makeMessage({
        messageId: "msg-unused",
        role: Role.ROLE_AGENT,
        parts: [makeTextPart("unused")],
      }),
    );
  }

  override async sendMessage(): Promise<Message | Task> {
    throw this.sendError;
  }
}

describe("run.started event — type definition", () => {
  test("A2ARunStartedEvent has required fields", () => {
    const event: A2ARunStartedEvent = {
      type: "run.started",
      runId: "run-1",
      threadId: "thread-1",
    };
    expect(event.type).toBe("run.started");
    expect(event.runId).toBe("run-1");
    expect(event.threadId).toBe("thread-1");
  });

  test("A2ARunStartedEvent supports optional parentRunId and input", () => {
    const event: A2ARunStartedEvent = {
      type: "run.started",
      runId: "run-1",
      threadId: "thread-1",
      parentRunId: "run-0",
      input: { text: "hello" },
    };
    expect(event.parentRunId).toBe("run-0");
    expect(event.input).toEqual({ text: "hello" });
  });

  test("A2ARunStartedEvent is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "run.started",
      runId: "run-1",
      threadId: "thread-1",
    };
    expect(event.type).toBe("run.started");
  });
});

describe("run.finished event — type definition", () => {
  test("A2ARunFinishedEvent has required fields", () => {
    const event: A2ARunFinishedEvent = {
      type: "run.finished",
      runId: "run-1",
      threadId: "thread-1",
    };
    expect(event.type).toBe("run.finished");
    expect(event.runId).toBe("run-1");
    expect(event.threadId).toBe("thread-1");
  });

  test("A2ARunFinishedEvent supports optional result", () => {
    const event: A2ARunFinishedEvent = {
      type: "run.finished",
      runId: "run-1",
      threadId: "thread-1",
      result: { text: "done" },
    };
    expect(event.result).toEqual({ text: "done" });
  });

  test("A2ARunFinishedEvent is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "run.finished",
      runId: "run-1",
      threadId: "thread-1",
    };
    expect(event.type).toBe("run.finished");
  });
});

describe("run.error event — type definition", () => {
  test("A2ARunErrorEvent has required message field", () => {
    const event: A2ARunErrorEvent = {
      type: "run.error",
      message: "boom",
    };
    expect(event.type).toBe("run.error");
    expect(event.message).toBe("boom");
  });

  test("A2ARunErrorEvent supports optional runId, threadId, code", () => {
    const event: A2ARunErrorEvent = {
      type: "run.error",
      runId: "run-1",
      threadId: "thread-1",
      message: "boom",
      code: "E_TEST",
    };
    expect(event.runId).toBe("run-1");
    expect(event.threadId).toBe("thread-1");
    expect(event.code).toBe("E_TEST");
  });

  test("A2ARunErrorEvent is assignable to A2AEvent", () => {
    const event: A2AEvent = {
      type: "run.error",
      message: "boom",
    };
    expect(event.type).toBe("run.error");
  });
});

describe("run lifecycle events — reducer pass-through", () => {
  test("reducer passes run.started through without state mutation", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      contextId: "ctx-1",
      taskId: "task-1",
      pendingAgentText: "working...",
    });

    const next = reduceA2ASessionState(initial, {
      type: "run.started",
      runId: "run-1",
      threadId: "thread-1",
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("waiting");
    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBe("task-1");
    expect(next.pendingAgentText).toBe("working...");
  });

  test("reducer passes run.finished through without state mutation", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      contextId: "ctx-1",
      taskId: "task-1",
      pendingAgentText: "working...",
    });

    const next = reduceA2ASessionState(initial, {
      type: "run.finished",
      runId: "run-1",
      threadId: "thread-1",
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("waiting");
    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBe("task-1");
    expect(next.pendingAgentText).toBe("working...");
  });

  test("reducer passes run.error through without state mutation", () => {
    const initial = createInitialSessionState({
      status: "waiting",
      contextId: "ctx-1",
      taskId: "task-1",
      pendingAgentText: "working...",
    });

    const next = reduceA2ASessionState(initial, {
      type: "run.error",
      message: "boom",
    });

    expect(next).toBe(initial);
    expect(next.status).toBe("waiting");
    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBe("task-1");
    expect(next.pendingAgentText).toBe("working...");
  });
});

describe("provider emits run lifecycle alongside legacy events", () => {
  test("sendTurn emits run.started alongside turn.started with matching ids", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "message-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("hello")],
          contextId: "ctx-1",
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.sendTurn(target, "hi");

    const turnStarted = events.find((e) => e.type === "turn.started");
    const runStarted = events.find((e) => e.type === "run.started");

    expect(turnStarted).toBeDefined();
    expect(runStarted).toBeDefined();

    if (runStarted?.type === "run.started") {
      expect(typeof runStarted.runId).toBe("string");
      expect(runStarted.runId.length).toBeGreaterThan(0);
      expect(typeof runStarted.threadId).toBe("string");
      expect(runStarted.threadId.length).toBeGreaterThan(0);
    }
  });

  test("run.started is emitted after turn.started in the same turn", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "message-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("hello")],
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const eventTypes: string[] = [];
    provider.subscribe((event) => {
      eventTypes.push(event.type);
    });

    await provider.sendTurn(target, "hi");

    const turnIndex = eventTypes.indexOf("turn.started");
    const runIndex = eventTypes.indexOf("run.started");
    expect(turnIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBe(turnIndex + 1);
  });

  test("sendTurn emits run.finished alongside message.completed", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "message-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("hello")],
          contextId: "ctx-1",
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.sendTurn(target, "hi");

    const completed = events.find((e) => e.type === "message.completed");
    const runFinished = events.find((e) => e.type === "run.finished");

    expect(completed).toBeDefined();
    expect(runFinished).toBeDefined();

    if (runFinished?.type === "run.finished") {
      expect(typeof runFinished.runId).toBe("string");
      expect(typeof runFinished.threadId).toBe("string");
    }
  });

  test("run.started and run.finished share the same runId/threadId in a single turn", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "message-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("hello")],
          contextId: "ctx-shared",
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.sendTurn(target, "hi");

    const runStarted = events.find((e) => e.type === "run.started");
    const runFinished = events.find((e) => e.type === "run.finished");

    expect(runStarted?.type).toBe("run.started");
    expect(runFinished?.type).toBe("run.finished");

    if (runStarted?.type === "run.started" && runFinished?.type === "run.finished") {
      expect(runStarted.runId).toBe(runFinished.runId);
      expect(runStarted.threadId).toBe(runFinished.threadId);
    }
  });

  test("threadId derives from options.contextId when provided", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "message-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("hello")],
          contextId: "ctx-provided",
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.sendTurn(target, "hi", { contextId: "ctx-provided" });

    const runStarted = events.find((e) => e.type === "run.started");
    expect(runStarted?.type).toBe("run.started");
    if (runStarted?.type === "run.started") {
      expect(runStarted.threadId).toBe("ctx-provided");
    }
  });

  test("input on run.started carries the user text", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "message-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("hello")],
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.sendTurn(target, "hello agent");

    const runStarted = events.find((e) => e.type === "run.started");
    if (runStarted?.type === "run.started") {
      expect(runStarted.input).toEqual({ text: "hello agent" });
    }
  });

  test("sendTurn emits run.error alongside error when transport throws", async () => {
    const provider = new A2AClientProvider(new ErrorTransport(new Error("boom")));
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await expect(provider.sendTurn(target, "hi")).rejects.toThrow("boom");

    const errorEvent = events.find((e) => e.type === "error");
    const runError = events.find((e) => e.type === "run.error");

    expect(errorEvent).toBeDefined();
    expect(runError).toBeDefined();

    if (runError?.type === "run.error") {
      expect(runError.message).toBe("boom");
      expect(typeof runError.runId).toBe("string");
      expect(typeof runError.threadId).toBe("string");
    }
  });

  test("run.error correlates with the in-flight run.started ids", async () => {
    const provider = new A2AClientProvider(new ErrorTransport(new Error("boom")));
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await expect(provider.sendTurn(target, "hi", { contextId: "ctx-error" })).rejects.toThrow(
      "boom",
    );

    const runStarted = events.find((e) => e.type === "run.started");
    const runError = events.find((e) => e.type === "run.error");

    if (runStarted?.type === "run.started" && runError?.type === "run.error") {
      expect(runError.runId).toBe(runStarted.runId);
      expect(runError.threadId).toBe(runStarted.threadId);
      expect(runError.threadId).toBe("ctx-error");
    }
  });

  test("streaming path emits run.started and run.finished", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({
          id: "task-terminal",
          contextId: "ctx-1",
          state: TaskState.TASK_STATE_COMPLETED,
          history: [
            makeMessage({
              messageId: "msg-stream-1",
              role: Role.ROLE_AGENT,
              parts: [makeTextPart("done")],
            }),
          ],
        }),
        [],
        [
          taskEvent({
            id: "task-terminal",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_COMPLETED,
            history: [
              makeMessage({
                messageId: "msg-stream-2",
                role: Role.ROLE_AGENT,
                parts: [makeTextPart("done")],
              }),
            ],
          }),
        ],
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    target.capabilities.supportsStreaming = true;

    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.sendTurn(target, "hi");

    const runStarted = events.find((e) => e.type === "run.started");
    const runFinished = events.find((e) => e.type === "run.finished");

    expect(runStarted).toBeDefined();
    expect(runFinished).toBeDefined();

    if (runStarted?.type === "run.started" && runFinished?.type === "run.finished") {
      expect(runStarted.runId).toBe(runFinished.runId);
      expect(runStarted.threadId).toBe(runFinished.threadId);
    }
  });
});

describe("resumeTurn emits run lifecycle", () => {
  const resumableTask: Task = makeTask({
    id: "task-to-resume",
    contextId: "ctx-resume",
    state: TaskState.TASK_STATE_COMPLETED,
    history: [
      makeMessage({
        messageId: "msg-resume-1",
        role: Role.ROLE_AGENT,
        parts: [makeTextPart("resumed")],
      }),
    ],
  });

  test("resumeTurn (polling path) emits run.started and run.finished with matching ids", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(makeMessage({ messageId: "unused", role: Role.ROLE_AGENT, parts: [] }), [
        resumableTask,
      ]),
    );
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.resumeTurn(target, "task-to-resume");

    const runStarted = events.find((e) => e.type === "run.started");
    const runFinished = events.find((e) => e.type === "run.finished");

    expect(runStarted).toBeDefined();
    expect(runFinished).toBeDefined();

    if (runStarted?.type === "run.started" && runFinished?.type === "run.finished") {
      expect(runStarted.runId).toBe(runFinished.runId);
      expect(runStarted.threadId).toBe(runFinished.threadId);
      expect(runStarted.input).toEqual({ taskId: "task-to-resume" });
    }
  });

  test("resumeTurn threadId derives from options.contextId when provided", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(makeMessage({ messageId: "unused", role: Role.ROLE_AGENT, parts: [] }), [
        resumableTask,
      ]),
    );
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.resumeTurn(target, "task-to-resume", { contextId: "ctx-resume" });

    const runStarted = events.find((e) => e.type === "run.started");
    if (runStarted?.type === "run.started") {
      expect(runStarted.threadId).toBe("ctx-resume");
    }
  });

  test("resumeTurn emits run.error when transport throws", async () => {
    class ThrowingTransport extends MockTransport {
      constructor() {
        super(makeMessage({ messageId: "unused", role: Role.ROLE_AGENT, parts: [] }));
      }
      override async getTask(): Promise<Task> {
        throw new Error("resume boom");
      }
    }

    const provider = new A2AClientProvider(new ThrowingTransport());
    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await expect(
      provider.resumeTurn(target, "task-to-resume", { contextId: "ctx-err" }),
    ).rejects.toThrow("resume boom");

    const runStarted = events.find((e) => e.type === "run.started");
    const runError = events.find((e) => e.type === "run.error");

    expect(runStarted).toBeDefined();
    expect(runError).toBeDefined();

    if (runStarted?.type === "run.started" && runError?.type === "run.error") {
      expect(runError.runId).toBe(runStarted.runId);
      expect(runError.threadId).toBe(runStarted.threadId);
      expect(runError.threadId).toBe("ctx-err");
      expect(runError.message).toBe("resume boom");
    }
  });
});
