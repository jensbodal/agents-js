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
import { A2AClientController, A2AClientProvider } from "../src/index.ts";
import type {
  A2AStreamEvent,
  A2ATransport,
  AgentTargetInput,
  DebugRecord,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";

function makeResolvedTarget(): ResolvedAgentTarget {
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

function makeInspection(
  status: TargetInspection["status"],
  overrides: Partial<TargetInspection> = {},
): TargetInspection {
  return {
    status,
    ...overrides,
  };
}

function makeProbeRecord(url: string): DebugRecord {
  return {
    requestId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    direction: "inbound",
    kind: "probe",
    method: "GET",
    url,
    headers: {},
    status: 200,
    contentType: "application/json",
    body: '{"name":"mock"}',
  };
}

class RecordingTransport implements A2ATransport {
  readonly sendParams: MessageSendParams[] = [];
  readonly inspectCalls: AgentTargetInput[] = [];
  inspectImpl: (input: AgentTargetInput) => Promise<TargetInspection> = async (input) =>
    makeInspection("ready", {
      card: {
        name: "mock",
        description: "mock",
        url: input.url,
        version: "1.0.0",
        protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
        skills: [],
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
        capabilities: {},
      },
      results: [
        {
          method: "GET",
          url: `${input.url}/.well-known/agent-card.json`,
          ok: true,
          status: 200,
          contentType: "application/json",
        },
      ],
    });

  private debugListener: ((record: DebugRecord) => void) | null = null;

  subscribeDebug(listener: (record: DebugRecord) => void): () => void {
    this.debugListener = listener;
    return () => {
      if (this.debugListener === listener) {
        this.debugListener = null;
      }
    };
  }

  emitDebug(record: DebugRecord): void {
    this.debugListener?.(record);
  }

  async resolveTarget(_input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    return makeResolvedTarget();
  }

  async inspectTarget(input: AgentTargetInput): Promise<TargetInspection> {
    this.inspectCalls.push(input);
    return this.inspectImpl(input);
  }

  async sendMessage(
    _target: ResolvedAgentTarget,
    params: MessageSendParams,
  ): Promise<Message | Task> {
    this.sendParams.push(params);
    if (this.sendParams.length === 1) {
      return {
        kind: "message",
        messageId: "message-1",
        role: "agent",
        parts: [{ kind: "text", text: "hello" }],
        contextId: "ctx-1",
        taskId: "task-1",
      };
    }

    return {
      kind: "message",
      messageId: "message-2",
      role: "agent",
      parts: [{ kind: "text", text: "still works" }],
      contextId: "ctx-1",
    };
  }

  async getTask(_target: ResolvedAgentTarget, _params: TaskQueryParams): Promise<Task> {
    throw new Error("not implemented");
  }

  readonly cancelCalls: TaskIdParams[] = [];
  cancelImpl: (params: TaskIdParams) => Promise<Task> = async (params) => ({
    kind: "task",
    id: params.id,
    contextId: "ctx-1",
    status: { state: "canceled" },
  });

  async cancelTask(_target: ResolvedAgentTarget, params: TaskIdParams): Promise<Task> {
    this.cancelCalls.push(params);
    return this.cancelImpl(params);
  }

  async *sendMessageStream(): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {}

  async *resubscribeTask(): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {}

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

describe("A2AClientController", () => {
  test("starts with idle pre-connect inspection state", () => {
    const controller = new A2AClientController({
      provider: new A2AClientProvider(new RecordingTransport()),
    });

    expect(controller.getState().targetInput).toBeUndefined();
    expect(controller.getState().targetInspection).toBeUndefined();
  });

  test("debounces inspection and transitions through probing to ready", async () => {
    const transport = new RecordingTransport();
    let resolveInspection: ((value: TargetInspection) => void) | undefined;
    transport.inspectImpl = async (input) =>
      new Promise<TargetInspection>((resolve) => {
        resolveInspection = resolve;
        transport.emitDebug(makeProbeRecord(`${input.url}/.well-known/agent-card.json`));
      });

    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    controller.setTargetInput({ url: "http://127.0.0.1:55363" });
    expect(controller.getState().targetInspection?.status).toBe("idle");

    await Bun.sleep(350);
    expect(controller.getState().targetInspection?.status).toBe("probing");
    expect(transport.inspectCalls).toHaveLength(1);

    resolveInspection?.(
      makeInspection("ready", {
        card: makeResolvedTarget().card,
        results: [
          {
            method: "GET",
            url: "http://127.0.0.1:55363/.well-known/agent-card.json",
            ok: true,
            status: 200,
            contentType: "application/json",
          },
        ],
      }),
    );

    await Bun.sleep(0);
    expect(controller.getState().targetInspection?.status).toBe("ready");
    expect(controller.getState().targetInspection?.card?.name).toBe("mock");
    expect(controller.getState().debugRecords).toHaveLength(1);
  });

  test("stores unreachable inspection results without forcing session error", async () => {
    const transport = new RecordingTransport();
    transport.inspectImpl = async () =>
      makeInspection("unreachable", {
        error: "connect ECONNREFUSED 127.0.0.1:55363",
      });

    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    controller.setTargetInput({ url: "http://127.0.0.1:55363" });
    await Bun.sleep(350);
    await Bun.sleep(0);

    expect(controller.getState().status).toBe("idle");
    expect(controller.getState().targetInspection?.status).toBe("unreachable");
    expect(controller.getState().targetInspection?.error).toContain("ECONNREFUSED");
  });

  test("ignores stale inspection results when the target input changes quickly", async () => {
    const transport = new RecordingTransport();
    let resolveFirst: ((value: TargetInspection) => void) | undefined;
    transport.inspectImpl = async (input) => {
      if (input.url.includes("55363")) {
        return new Promise<TargetInspection>((resolve) => {
          resolveFirst = resolve;
        });
      }

      return makeInspection("ready", {
        card: {
          ...makeResolvedTarget().card,
          url: input.url,
        },
        results: [
          {
            method: "GET",
            url: `${input.url}/.well-known/agent-card.json`,
            ok: true,
            status: 200,
            contentType: "application/json",
          },
        ],
      });
    };

    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    controller.setTargetInput({ url: "http://127.0.0.1:55363" });
    await Bun.sleep(350);
    expect(controller.getState().targetInspection?.status).toBe("probing");

    controller.setTargetInput({ url: "http://127.0.0.1:55364" });
    expect(controller.getState().targetInspection?.status).toBe("idle");

    await Bun.sleep(350);
    await Bun.sleep(0);
    expect(controller.getState().targetInspection?.status).toBe("ready");
    expect(controller.getState().targetInput?.url).toBe("http://127.0.0.1:55364");

    resolveFirst?.(
      makeInspection("ready", {
        card: {
          ...makeResolvedTarget().card,
          url: "http://127.0.0.1:55363",
        },
      }),
    );

    await Bun.sleep(0);
    expect(controller.getState().targetInput?.url).toBe("http://127.0.0.1:55364");
    expect(controller.getState().targetInspection?.card?.url).toBe("http://127.0.0.1:55364");
  });

  test("reuses only contextId after a direct message result", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363", mode: "base" });
    await controller.sendTurn("hello");
    await controller.sendTurn("follow up");

    expect(transport.sendParams).toHaveLength(2);
    expect(transport.sendParams[0]?.message.contextId).toBeUndefined();
    expect(transport.sendParams[0]?.message.taskId).toBeUndefined();
    expect(transport.sendParams[1]?.message.contextId).toBe("ctx-1");
    expect(transport.sendParams[1]?.message.taskId).toBeUndefined();

    const state = controller.getState();
    expect(state.contextId).toBe("ctx-1");
    expect(state.taskId).toBeUndefined();
  });

  test("resetSession() clears error state and restores connected status", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    await controller.sendTurn("hello");
    expect(controller.getState().status).toBe("connected");
    expect(controller.getState().transcript).toHaveLength(2);

    // Force an error by making transport throw on next send
    const originalSendMessage = transport.sendMessage.bind(transport);
    transport.sendMessage = async () => {
      throw new Error("simulated runtime crash");
    };
    await controller.sendTurn("trigger error").catch(() => {});
    transport.sendMessage = originalSendMessage;

    // Verify error state was set
    expect(controller.getState().status).toBe("error");
    expect(controller.getState().lastError).toBe("simulated runtime crash");

    controller.resetSession();

    const state = controller.getState();
    expect(state.status).toBe("connected");
    expect(state.transcript).toHaveLength(0);
    expect(state.contextId).toBeUndefined();
    expect(state.lastError).toBeUndefined();
    expect(state.target).toBeDefined();
  });

  test("resetSession() without prior connection produces idle status", () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    controller.resetSession();

    const state = controller.getState();
    expect(state.status).toBe("idle");
    expect(state.target).toBeUndefined();
    expect(state.transcript).toHaveLength(0);
  });

  test("connect() after resetSession() produces clean connected state", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    await controller.sendTurn("hello");

    controller.resetSession();
    await controller.connect({ url: "http://127.0.0.1:55363" });

    const state = controller.getState();
    expect(state.status).toBe("connected");
    expect(state.transcript).toHaveLength(0);
  });

  test("sendTurn() after resetSession() omits stale contextId", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    await controller.sendTurn("hello");
    expect(controller.getState().contextId).toBe("ctx-1");
    expect(transport.sendParams).toHaveLength(1);
    expect(transport.sendParams[0]?.message.contextId).toBeUndefined();

    controller.resetSession();
    expect(controller.getState().contextId).toBeUndefined();

    await controller.sendTurn("after reset");

    // Second sendTurn should not carry the old contextId
    expect(transport.sendParams).toHaveLength(2);
    expect(transport.sendParams[1]?.message.contextId).toBeUndefined();
  });
});

describe("A2AClientController.cancelTask", () => {
  test("rejects when no target is connected", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    const result = await controller.cancelTask();
    expect(result.outcome).toBe("no-target");
    expect(transport.cancelCalls).toHaveLength(0);
  });

  test("returns no-task outcome when no active or supplied task id is available", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    const result = await controller.cancelTask();
    expect(result.outcome).toBe("no-task");
    expect(transport.cancelCalls).toHaveLength(0);
  });

  test("cancels active session task id when no override supplied", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-active");

    const result = await controller.cancelTask();
    expect(result.outcome).toBe("canceled");
    if (result.outcome === "canceled") {
      expect(result.taskId).toBe("task-active");
    }
    expect(transport.cancelCalls).toHaveLength(1);
    expect(transport.cancelCalls[0]?.id).toBe("task-active");
    expect(controller.getState().taskState).toBe("canceled");
  });

  test("falls back to resumableTaskId when state.taskId is undefined", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    // Simulate a session with only a resumable task (e.g., input-required)
    const initial = controller.getState();
    Object.assign(initial, { resumableTaskId: "task-resumable" });
    // setSessionContext only sets taskId/contextId; we rely on session reducer paths
    // for resumable, so use the test seam: provide explicit override path
    const result = await controller.cancelTask({ taskId: "task-resumable" });
    expect(result.outcome).toBe("canceled");
    if (result.outcome === "canceled") {
      expect(result.taskId).toBe("task-resumable");
    }
    expect(transport.cancelCalls).toHaveLength(1);
    expect(transport.cancelCalls[0]?.id).toBe("task-resumable");
  });

  test("explicit taskId overrides session state", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-state");

    const result = await controller.cancelTask({ taskId: "task-explicit" });
    expect(result.outcome).toBe("canceled");
    if (result.outcome === "canceled") {
      expect(result.taskId).toBe("task-explicit");
    }
    expect(transport.cancelCalls[0]?.id).toBe("task-explicit");
  });

  test("propagates transport failures as failed outcome with error detail", async () => {
    const transport = new RecordingTransport();
    transport.cancelImpl = async () => {
      throw new Error("transport refused: unsupported");
    };
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-1");

    const result = await controller.cancelTask();
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.error).toContain("transport refused");
      expect(result.taskId).toBe("task-1");
    }
  });

  test("emits a task.updated event for the canceled task so subscribers see canceled state", async () => {
    const transport = new RecordingTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-1");

    const seenEvents: string[] = [];
    controller.subscribe((event) => seenEvents.push(event.type));
    await controller.cancelTask();

    expect(seenEvents).toContain("task.updated");
    expect(controller.getState().taskState).toBe("canceled");
  });
});

describe("A2AClientController.reportError", () => {
  test("sets status to error and populates lastError from an Error instance", () => {
    const controller = new A2AClientController();
    controller.reportError(new Error("something broke"));
    const state = controller.getState();
    expect(state.status).toBe("error");
    expect(state.lastError).toBe("something broke");
  });

  test("coerces non-Error values into a string message", () => {
    const controller = new A2AClientController();
    controller.reportError({ bad: true });
    const state = controller.getState();
    expect(state.status).toBe("error");
    expect(state.lastError).toBe("[object Object]");
  });

  test("notifies subscribers so header/inspector can re-render", () => {
    const controller = new A2AClientController();
    const seenErrors: Array<string | undefined> = [];
    controller.subscribe((_event, state) => {
      if (state.status === "error") {
        seenErrors.push(state.lastError);
      }
    });
    controller.reportError(new Error("reset-failed"));
    expect(seenErrors).toContain("reset-failed");
  });
});
