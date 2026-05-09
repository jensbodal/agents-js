import { describe, expect, test } from "bun:test";
import type {
  AgentCard,
  DeleteTaskPushNotificationConfigParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import { A2AClientProvider, ACP_A2A_ELICITATION_METADATA_KEY } from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/session.ts";
import type {
  A2AEvent,
  A2AStreamEvent,
  A2ATransport,
  AgentTargetInput,
  DebugRecord,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";

class MockTransport implements A2ATransport {
  inspectResult: TargetInspection = { status: "ready" };

  constructor(
    private readonly sendResult: Message | Task,
    private readonly taskResults: Task[] = [],
    private readonly streamResults: Array<
      Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
    > = [],
    private readonly resubscribeResults: Array<
      Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
    > = taskResults,
  ) {}

  subscribeDebug(listener: (record: DebugRecord) => void): () => void {
    return () => listener;
  }

  async resolveTarget(_input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    return {
      baseUrl: "http://127.0.0.1:55363",
      cardUrl: "http://127.0.0.1:55363/.well-known/agent-card.json",
      protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
      card: {
        name: "mock",
        description: "mock",
        url: "http://127.0.0.1:55363",
        version: "1.0.0",
        protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
        skills: [],
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
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
    };
  }

  async inspectTarget(_input: AgentTargetInput): Promise<TargetInspection> {
    return this.inspectResult;
  }

  async sendMessage(
    _target: ResolvedAgentTarget,
    _params: MessageSendParams,
  ): Promise<Message | Task> {
    return this.sendResult;
  }

  async *sendMessageStream(
    _target: ResolvedAgentTarget,
    _params: MessageSendParams,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {
    for (const event of this.streamResults) {
      yield event;
    }
  }

  async getTask(_target: ResolvedAgentTarget, _params: TaskQueryParams): Promise<Task> {
    const next = this.taskResults.shift();
    if (!next) {
      throw new Error("no task available");
    }
    return next;
  }

  async cancelTask(_target: ResolvedAgentTarget, _params: TaskIdParams): Promise<Task> {
    throw new Error("not implemented");
  }

  async *resubscribeTask(): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {
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
    _params: GetTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not implemented");
  }

  async listTaskPushNotificationConfigs(
    _target: ResolvedAgentTarget,
    _params: ListTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig[]> {
    throw new Error("not implemented");
  }

  async deleteTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: DeleteTaskPushNotificationConfigParams,
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
      new MockTransport({
        kind: "message",
        messageId: "message-1",
        role: "agent",
        parts: [{ kind: "text", text: "hello" }],
        contextId: "ctx-1",
        taskId: "task-ignored",
      }),
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
    const transport = new MockTransport({
      kind: "message",
      messageId: "message-1",
      role: "agent",
      parts: [{ kind: "text", text: "hello" }],
    });
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
      new MockTransport({
        kind: "message",
        messageId: "message-1",
        role: "agent",
        parts: [{ kind: "text", text: "hello" }],
        contextId: "ctx-1",
        taskId: "task-1",
      }),
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
        {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "working" },
        },
        [
          {
            kind: "task",
            id: "task-1",
            contextId: "ctx-1",
            status: { state: "completed" },
            history: [
              {
                kind: "message",
                messageId: "msg-history-1",
                role: "agent",
                parts: [{ kind: "text", text: "done" }],
              },
            ],
          },
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
      new MockTransport({
        kind: "task",
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
        history: [
          {
            kind: "message",
            messageId: "msg-history-2",
            role: "agent",
            parts: [{ kind: "text", text: "done without polling" }],
          },
        ],
      }),
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
        {
          kind: "task",
          id: "task-terminal",
          contextId: "ctx-1",
          status: { state: "completed" },
          history: [
            {
              kind: "message",
              messageId: "msg-history-3",
              role: "agent",
              parts: [{ kind: "text", text: "done" }],
            },
          ],
        },
        [],
        [
          {
            kind: "status-update",
            taskId: "task-terminal",
            contextId: "ctx-1",
            final: false,
            status: {
              state: "working",
              message: {
                kind: "message",
                role: "agent",
                messageId: "msg-1",
                parts: [{ kind: "text", text: "partial" }],
              },
            },
          },
          {
            kind: "task",
            id: "task-terminal",
            contextId: "ctx-1",
            status: { state: "completed" },
            history: [
              {
                kind: "message",
                messageId: "msg-history-4",
                role: "agent",
                parts: [{ kind: "text", text: "done" }],
              },
            ],
          },
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
        {
          kind: "task",
          id: "task-terminal",
          contextId: "ctx-1",
          status: { state: "completed" },
          history: [
            {
              kind: "message",
              messageId: "msg-history-5",
              role: "agent",
              parts: [{ kind: "text", text: "done" }],
            },
          ],
        },
        [],
        [
          {
            kind: "status-update",
            taskId: "task-terminal",
            contextId: "ctx-1",
            final: false,
            status: {
              state: "working",
              message: {
                kind: "message",
                role: "agent",
                messageId: "msg-1",
                parts: [{ kind: "text", text: "partial" }],
              },
            },
          },
          {
            kind: "message",
            messageId: "msg-1",
            role: "agent",
            contextId: "ctx-1",
            taskId: "task-terminal",
            parts: [{ kind: "text", text: "partial and still running" }],
          },
          {
            kind: "task",
            id: "task-terminal",
            contextId: "ctx-1",
            status: { state: "completed" },
            history: [
              {
                kind: "message",
                messageId: "msg-history-6",
                role: "agent",
                parts: [{ kind: "text", text: "done" }],
              },
            ],
          },
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
        {
          kind: "task",
          id: "task-fallback",
          contextId: "ctx-1",
          status: { state: "completed" },
          history: [
            {
              kind: "message",
              messageId: "msg-history-7",
              role: "agent",
              parts: [{ kind: "text", text: "done" }],
            },
          ],
        },
        [
          {
            kind: "task",
            id: "task-fallback",
            contextId: "ctx-1",
            status: { state: "completed" },
            history: [
              {
                kind: "message",
                messageId: "msg-history-8",
                role: "agent",
                parts: [{ kind: "text", text: "done" }],
              },
            ],
          },
        ],
        [
          {
            kind: "message",
            messageId: "msg-fallback",
            role: "agent",
            contextId: "ctx-1",
            taskId: "task-fallback",
            parts: [{ kind: "text", text: "done" }],
          },
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
        {
          kind: "message",
          messageId: "terminal-msg-1",
          role: "agent",
          contextId: "ctx-1",
          parts: [{ kind: "text", text: "final answer" }],
        },
        [],
        [
          {
            kind: "message",
            messageId: "terminal-msg-1",
            role: "agent",
            contextId: "ctx-1",
            parts: [{ kind: "text", text: "final answer" }],
          },
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

    expect(result.kind).toBe("message");
    expect(events.filter((event) => event.type === "message.completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "message.completed")).toEqual(
      expect.objectContaining({
        type: "message.completed",
        text: "final answer",
      }),
    );
  });

  test("respondToElicitation sends continuation metadata without transcript text", async () => {
    let observedParams: MessageSendParams | undefined;
    class ResponseTransport extends MockTransport {
      override async sendMessage(
        target: ResolvedAgentTarget,
        params: MessageSendParams,
      ): Promise<Message | Task> {
        observedParams = params;
        return await super.sendMessage(target, params);
      }
    }

    const provider = new A2AClientProvider(
      new ResponseTransport({
        kind: "task",
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
        history: [
          {
            kind: "message",
            messageId: "msg-history-9",
            role: "agent",
            parts: [{ kind: "text", text: "done" }],
          },
        ],
      }),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    await provider.respondToElicitation(target, "task-1", "ctx-1", {
      action: "accept",
      content: { project: "demo" },
    });

    expect((observedParams?.message as { text?: unknown } | undefined)?.text).toBeUndefined();
    expect(observedParams?.message.parts[0]?.kind).toBe("text");
    expect((observedParams?.message.parts[0] as { text?: string } | undefined)?.text).toBe("");
    expect(observedParams?.message.taskId).toBe("task-1");
    expect(observedParams?.message.contextId).toBe("ctx-1");
    expect(observedParams?.message.metadata?.[ACP_A2A_ELICITATION_METADATA_KEY]).toBeUndefined();
    expect(observedParams?.message.metadata).toBeDefined();
  });

  test("respondToElicitation resumes through the streaming path when supported", async () => {
    let streamed = false;
    let observedParams: MessageSendParams | undefined;

    class StreamingResponseTransport extends MockTransport {
      override async *sendMessageStream(
        _target: ResolvedAgentTarget,
        params: MessageSendParams,
      ): AsyncGenerator<
        Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
      > {
        streamed = true;
        observedParams = params;
        yield {
          kind: "status-update",
          taskId: "task-1",
          contextId: "ctx-1",
          final: false,
          status: {
            state: "working",
            message: {
              kind: "message",
              role: "agent",
              messageId: "msg-1",
              parts: [{ kind: "text", text: "resuming" }],
            },
          },
        };
        yield {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "completed" },
          history: [
            {
              kind: "message",
              messageId: "msg-history-10",
              role: "agent",
              parts: [{ kind: "text", text: "done" }],
            },
          ],
        };
      }
    }

    const provider = new A2AClientProvider(
      new StreamingResponseTransport({
        kind: "task",
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "working" },
      }),
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
    expect(observedParams?.message.taskId).toBe("task-1");
    expect(events).toContain("task.status.updated");
    expect(events).toContain("message.completed");
  });

  test("resubscribe streams task events when streaming is supported", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "working" },
        },
        [
          {
            kind: "task",
            id: "task-1",
            contextId: "ctx-1",
            status: { state: "working" },
          },
          {
            kind: "task",
            id: "task-1",
            contextId: "ctx-1",
            status: { state: "completed" },
            history: [
              {
                kind: "message",
                messageId: "msg-history-11",
                role: "agent",
                parts: [{ kind: "text", text: "done" }],
              },
            ],
          },
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
    const nonTerminalTask: Task = {
      kind: "task",
      id: "task-stuck",
      contextId: "ctx-stuck",
      status: { state: "working" },
    };

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
        {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "working" },
        },
        [
          {
            kind: "task",
            id: "task-1",
            contextId: "ctx-1",
            status: { state: "completed" },
            history: [
              {
                kind: "message",
                messageId: "msg-history-12",
                role: "agent",
                parts: [{ kind: "text", text: "done" }],
              },
            ],
          },
        ],
      ),
    );

    const target = await provider.connect({ url: "http://127.0.0.1:55363" });
    const result = await provider.sendTurn(target, "hi", {
      pollIntervalMs: 0,
      pollTimeoutMs: 5000,
    });

    expect(result.kind).toBe("task");
    if (result.kind === "task") {
      expect(result.status.state).toBe("completed");
    }
  });

  test("resubscribe preserves resumable state until the terminal task arrives", async () => {
    const provider = new A2AClientProvider(
      new MockTransport(
        {
          kind: "task",
          id: "task-1",
          contextId: "ctx-1",
          status: { state: "working" },
        },
        [],
        [],
        [
          {
            kind: "status-update",
            taskId: "task-1",
            contextId: "ctx-1",
            final: false,
            status: {
              state: "working",
              message: {
                kind: "message",
                messageId: "msg-status-1",
                role: "agent",
                parts: [{ kind: "text", text: "still running" }],
              },
            },
          },
          {
            kind: "task",
            id: "task-1",
            contextId: "ctx-1",
            status: { state: "completed" },
            history: [
              {
                kind: "message",
                messageId: "msg-history-13",
                role: "agent",
                parts: [{ kind: "text", text: "done" }],
              },
            ],
          },
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
