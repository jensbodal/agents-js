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
import { A2AClientProvider, ACP_A2A_ELICITATION_METADATA_KEY } from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/session.ts";
import type {
  A2AEvent,
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
  messageEvent,
  statusEvent,
  taskEvent,
} from "./mock-a2a-transport.ts";

class MockTransport implements A2ATransport {
  inspectResult: TargetInspection = { status: "ready" };

  constructor(
    private readonly sendResult: Message | Task,
    private readonly taskResults: Task[] = [],
    private readonly streamResults: A2AStreamElement[] = [],
    private readonly resubscribeResults: A2AStreamElement[] = taskResults.map((value) => ({
      $case: "task",
      value,
    })),
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

  async *sendMessageStream(
    _target: ResolvedAgentTarget,
    _params: SendMessageRequest,
  ): AsyncGenerator<A2AStreamElement> {
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
    for (const event of this.resubscribeResults) {
      yield event;
    }
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
  ): Promise<void> {
    throw new Error("not implemented");
  }

  async getExtendedAgentCard(_target: ResolvedAgentTarget): Promise<AgentCard> {
    throw new Error("not implemented");
  }

  async probe(_input: AgentTargetInput) {
    return [];
  }
}

describe("A2AClientProvider", () => {
  test("emits a completed message for immediate message/send results", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "message-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("hello")],
          contextId: "ctx-1",
          taskId: "task-ignored",
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: string[] = [];
    let ignoredTaskIdNotice = false;
    provider.subscribe((event) => {
      events.push(event.type);
      if (
        event.type === "debug.record" &&
        event.record.kind === "client" &&
        event.record.body?.includes('Ignoring taskId "task-ignored"')
      ) {
        ignoredTaskIdNotice = true;
      }
    });

    await provider.sendTurn(target, "hi");

    expect(events).toContain("turn.started");
    expect(events).toContain("message.completed");
    expect(ignoredTaskIdNotice).toBe(true);
  });

  test("returns inspection results without emitting a session error", async () => {
    const transport = new MockTransport(
      makeMessage({
        messageId: "message-1",
        role: Role.ROLE_AGENT,
        parts: [makeTextPart("hello")],
      }),
    );
    transport.inspectResult = {
      status: "unreachable",
      error: "connect ECONNREFUSED 127.0.0.1:55363",
    };

    const provider = new A2AClientProvider(transport);
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    const inspection = await provider.inspectTarget({ url: "http://127.0.0.1:55363" });

    expect(inspection.status).toBe("unreachable");
    expect(events.find((event) => event.type === "error")).toBeUndefined();
  });

  test("ignores taskId from direct message results and emits a debug warning", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "message-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("hello")],
          contextId: "ctx-1",
          taskId: "task-1",
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await provider.sendTurn(target, "hi");

    const completed = events.find((event) => event.type === "message.completed");
    const warning = events.find((event) => event.type === "debug.record");

    expect(completed?.type).toBe("message.completed");
    if (completed?.type === "message.completed") {
      expect(completed.contextId).toBe("ctx-1");
      expect(completed.taskId).toBeUndefined();
    }

    expect(warning?.type).toBe("debug.record");
    if (warning?.type === "debug.record") {
      expect(warning.record.kind).toBe("client");
      expect(warning.record.body).toContain('Ignoring taskId "task-1"');
    }
  });

  test("polls task results until terminal completion", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING }),
        [
          makeTask({
            id: "task-1",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_COMPLETED,
            history: [
              makeMessage({
                messageId: "msg-history-1",
                role: Role.ROLE_AGENT,
                parts: [makeTextPart("done")],
              }),
            ],
          }),
        ],
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: string[] = [];
    provider.subscribe((event) => {
      events.push(event.type);
    });

    await provider.sendTurn(target, "hi", { pollIntervalMs: 0 });

    expect(events).toContain("task.updated");
    expect(events).toContain("message.completed");
  });

  test("emits a completed message for terminal tasks even when polling is disabled", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({
          id: "task-1",
          contextId: "ctx-1",
          state: TaskState.TASK_STATE_COMPLETED,
          history: [
            makeMessage({
              messageId: "msg-history-2",
              role: Role.ROLE_AGENT,
              parts: [makeTextPart("done without polling")],
            }),
          ],
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: string[] = [];
    provider.subscribe((event) => {
      events.push(event.type);
    });

    await provider.sendTurn(target, "hi", { poll: false });

    expect(events).toContain("task.updated");
    expect(events).toContain("message.completed");
  });

  test("consumes streamed status updates and final task when streaming is supported", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({
          id: "task-terminal",
          contextId: "ctx-1",
          state: TaskState.TASK_STATE_COMPLETED,
          history: [
            makeMessage({
              messageId: "msg-history-3",
              role: Role.ROLE_AGENT,
              parts: [makeTextPart("done")],
            }),
          ],
        }),
        [],
        [
          statusEvent({
            taskId: "task-terminal",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_WORKING,
            message: makeMessage({
              messageId: "msg-1",
              role: Role.ROLE_AGENT,
              parts: [makeTextPart("partial")],
            }),
          }),
          taskEvent({
            id: "task-terminal",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_COMPLETED,
            history: [
              makeMessage({
                messageId: "msg-history-4",
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

    const events: string[] = [];
    provider.subscribe((event) => {
      events.push(event.type);
    });

    await provider.sendTurn(target, "hi");

    expect(events).toContain("task.status.updated");
    expect(events).toContain("message.delta");
    expect(events).toContain("task.updated");
    expect(events).toContain("message.completed");
  });

  test("treats streamed raw messages as deltas until the final task arrives", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({
          id: "task-terminal",
          contextId: "ctx-1",
          state: TaskState.TASK_STATE_COMPLETED,
          history: [
            makeMessage({
              messageId: "msg-history-5",
              role: Role.ROLE_AGENT,
              parts: [makeTextPart("done")],
            }),
          ],
        }),
        [],
        [
          statusEvent({
            taskId: "task-terminal",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_WORKING,
            message: makeMessage({
              messageId: "msg-1",
              role: Role.ROLE_AGENT,
              parts: [makeTextPart("partial")],
            }),
          }),
          messageEvent({
            messageId: "msg-1",
            role: Role.ROLE_AGENT,
            parts: [makeTextPart("partial and still running")],
            contextId: "ctx-1",
            taskId: "task-terminal",
          }),
          taskEvent({
            id: "task-terminal",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_COMPLETED,
            history: [
              makeMessage({
                messageId: "msg-history-6",
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

    const completedEvents = events.filter((event) => event.type === "message.completed");
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toEqual(
      expect.objectContaining({
        type: "message.completed",
        text: "done",
      }),
    );

    const state = events.reduce(reduceA2ASessionState, createInitialSessionState());
    expect(state.status).toBe("connected");
    expect(state.resumableTaskId).toBeUndefined();
    expect(state.transcript[state.transcript.length - 1]?.text).toBe("done");
  });

  test("emits a final completion when streaming falls back to getTask after raw message events", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({
          id: "task-fallback",
          contextId: "ctx-1",
          state: TaskState.TASK_STATE_COMPLETED,
          history: [
            makeMessage({
              messageId: "msg-history-7",
              role: Role.ROLE_AGENT,
              parts: [makeTextPart("done")],
            }),
          ],
        }),
        [
          makeTask({
            id: "task-fallback",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_COMPLETED,
            history: [
              makeMessage({
                messageId: "msg-history-8",
                role: Role.ROLE_AGENT,
                parts: [makeTextPart("done")],
              }),
            ],
          }),
        ],
        [
          messageEvent({
            messageId: "msg-fallback",
            role: Role.ROLE_AGENT,
            parts: [makeTextPart("done")],
            contextId: "ctx-1",
            taskId: "task-fallback",
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

    const completedEvents = events.filter((event) => event.type === "message.completed");
    expect(completedEvents).toHaveLength(1);

    const finalState = events.reduce(reduceA2ASessionState, createInitialSessionState());
    expect(finalState.transcript[finalState.transcript.length - 1]?.text).toBe("done");
    expect(finalState.resumableTaskId).toBeUndefined();
  });

  test("treats a terminal streamed raw message as a completed result", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeMessage({
          messageId: "terminal-msg-1",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("final answer")],
          contextId: "ctx-1",
        }),
        [],
        [
          messageEvent({
            messageId: "terminal-msg-1",
            role: Role.ROLE_AGENT,
            parts: [makeTextPart("final answer")],
            contextId: "ctx-1",
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

    const result = await provider.sendTurn(target, "hi");

    expect("messageId" in result).toBe(true);
    expect(events.filter((event) => event.type === "message.completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "message.completed")).toEqual(
      expect.objectContaining({
        type: "message.completed",
        text: "final answer",
      }),
    );
  });

  test("respondToElicitation sends continuation metadata without transcript text", async () => {
    let observedParams: SendMessageRequest | undefined;
    class ResponseTransport extends MockTransport {
      override async sendMessage(
        target: ResolvedAgentTarget,
        params: SendMessageRequest,
      ): Promise<Message | Task> {
        observedParams = params;
        return await super.sendMessage(target, params);
      }
    }

    const provider = new A2AClientProvider(
      new ResponseTransport(
        makeTask({
          id: "task-1",
          contextId: "ctx-1",
          state: TaskState.TASK_STATE_COMPLETED,
          history: [makeMessage({ messageId: "msg-history-9", text: "done" })],
        }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    await provider.respondToElicitation(target, "task-1", "ctx-1", {
      action: "accept",
      content: { project: "demo" },
    });

    const part = observedParams?.message?.parts[0];
    expect(part?.content?.$case).toBe("text");
    expect(part?.content?.$case === "text" ? part.content.value : null).toBe("");
    expect(observedParams?.message?.taskId).toBe("task-1");
    expect(observedParams?.message?.contextId).toBe("ctx-1");
    expect(observedParams?.message?.metadata?.[ACP_A2A_ELICITATION_METADATA_KEY]).toBeUndefined();
    expect(observedParams?.message?.metadata).toBeDefined();
  });

  test("respondToElicitation resumes through the streaming path when supported", async () => {
    let streamed = false;
    let observedParams: SendMessageRequest | undefined;

    class StreamingResponseTransport extends MockTransport {
      override async *sendMessageStream(
        _target: ResolvedAgentTarget,
        params: SendMessageRequest,
      ): AsyncGenerator<A2AStreamElement> {
        streamed = true;
        observedParams = params;
        yield statusEvent({
          taskId: "task-1",
          contextId: "ctx-1",
          state: TaskState.TASK_STATE_WORKING,
          message: makeMessage({ messageId: "msg-1", text: "resuming" }),
        });
        yield taskEvent({
          id: "task-1",
          contextId: "ctx-1",
          state: TaskState.TASK_STATE_COMPLETED,
          history: [makeMessage({ messageId: "msg-history-10", text: "done" })],
        });
      }
    }

    const provider = new A2AClientProvider(
      new StreamingResponseTransport(
        makeTask({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING }),
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    target.capabilities.supportsStreaming = true;

    const events: string[] = [];
    provider.subscribe((event) => {
      events.push(event.type);
    });

    await provider.respondToElicitation(target, "task-1", "ctx-1", {
      action: "accept",
      content: { project: "demo" },
    });

    expect(streamed).toBe(true);
    expect(observedParams?.message?.taskId).toBe("task-1");
    expect(events).toContain("task.status.updated");
    expect(events).toContain("message.completed");
  });

  test("resubscribe streams task events when streaming is supported", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING }),
        [
          makeTask({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING }),
          makeTask({
            id: "task-1",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_COMPLETED,
            history: [
              makeMessage({
                messageId: "msg-history-11",
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

    const events: string[] = [];
    provider.subscribe((event) => {
      events.push(event.type);
    });

    await provider.resumeTurn(target, "task-1");

    expect(events).toContain("task.updated");
    expect(events).toContain("message.completed");
  });

  test("polling times out and emits error when task stays non-terminal", async () => {
    const nonTerminalTask: Task = makeTask({
      id: "task-stuck",
      contextId: "ctx-stuck",
      state: TaskState.TASK_STATE_WORKING,
    });

    class StuckTransport extends MockTransport {
      override async getTask(): Promise<Task> {
        return nonTerminalTask;
      }
    }

    const provider = new A2AClientProvider(new StuckTransport(nonTerminalTask));

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const events: A2AEvent[] = [];
    provider.subscribe((event) => {
      events.push(event);
    });

    await expect(
      provider.sendTurn(target, "hi", { pollIntervalMs: 5, pollTimeoutMs: 20 }),
    ).rejects.toThrow(/Polling timed out/);

    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === "error") {
      expect(errorEvent.error).toContain("Polling timed out");
      expect(errorEvent.error).toContain("task-stuck");
    }
  });

  test("polling completes normally when task reaches terminal state within timeout", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING }),
        [
          makeTask({
            id: "task-1",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_COMPLETED,
            history: [
              makeMessage({
                messageId: "msg-history-12",
                role: Role.ROLE_AGENT,
                parts: [makeTextPart("done")],
              }),
            ],
          }),
        ],
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const result = await provider.sendTurn(target, "hi", {
      pollIntervalMs: 0,
      pollTimeoutMs: 5000,
    });

    expect("id" in result).toBe(true);
    if ("id" in result) {
      expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    }
  });

  test("resubscribe preserves resumable state until the terminal task arrives", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        makeTask({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING }),
        [],
        [],
        [
          statusEvent({
            taskId: "task-1",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_WORKING,
            message: makeMessage({
              messageId: "msg-status-1",
              role: Role.ROLE_AGENT,
              parts: [makeTextPart("still running")],
            }),
          }),
          taskEvent({
            id: "task-1",
            contextId: "ctx-1",
            state: TaskState.TASK_STATE_COMPLETED,
            history: [
              makeMessage({
                messageId: "msg-history-13",
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

    await provider.resumeTurn(target, "task-1");

    const waitingState = events
      .filter((event) => event.type === "task.status.updated")
      .reduce(reduceA2ASessionState, createInitialSessionState());
    expect(waitingState.resumableTaskId).toBe("task-1");

    const finalState = events.reduce(reduceA2ASessionState, createInitialSessionState());
    expect(finalState.status).toBe("connected");
    expect(finalState.resumableTaskId).toBeUndefined();
  });
});
