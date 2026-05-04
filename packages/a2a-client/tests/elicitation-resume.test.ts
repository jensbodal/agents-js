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
import { ACP_A2A_ELICITATION_METADATA_KEY } from "../src/acp-state.ts";
import { A2AClientController, A2AClientProvider } from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/session.ts";
import type {
  A2AStreamEvent,
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";

function makeResolvedTarget(overrides: { supportsStreaming?: boolean } = {}): ResolvedAgentTarget {
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
      supportsStreaming: overrides.supportsStreaming ?? false,
      supportsPushNotifications: false,
      raw: {},
    },
  };
}

function makeReadyInspection(): TargetInspection {
  return {
    status: "ready",
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
  };
}

/**
 * Test seam: a transport whose elicitation/resume behavior can be staged per
 * scenario. Records every `sendMessage`/`sendMessageStream` call so tests can
 * assert that taskId + contextId reach the wire, and lets each test stage the
 * agent's reply.
 */
class ElicitationResumeTransport implements A2ATransport {
  readonly sendCalls: MessageSendParams[] = [];
  readonly streamCalls: MessageSendParams[] = [];
  supportsStreaming = false;

  sendImpl: (params: MessageSendParams) => Promise<Message | Task> = async (params) => ({
    kind: "task",
    id: params.message.taskId ?? "task-1",
    contextId: params.message.contextId ?? "ctx-1",
    status: { state: "completed" },
    history: [
      {
        kind: "message",
        messageId: "agent-final",
        role: "agent",
        parts: [{ kind: "text", text: "completed reply" }],
      },
    ],
  });

  // Default streaming behavior emits a working status, then a terminal
  // completed task with an agent message in history.
  streamImpl: (
    params: MessageSendParams,
  ) => AsyncGenerator<Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent> =
    async function* (params: MessageSendParams) {
      yield {
        kind: "status-update",
        taskId: params.message.taskId ?? "task-1",
        contextId: params.message.contextId ?? "ctx-1",
        final: false,
        status: { state: "working" },
      } satisfies TaskStatusUpdateEvent;
      yield {
        kind: "task",
        id: params.message.taskId ?? "task-1",
        contextId: params.message.contextId ?? "ctx-1",
        status: { state: "completed" },
        history: [
          {
            kind: "message",
            messageId: "agent-final-stream",
            role: "agent",
            parts: [{ kind: "text", text: "streamed reply" }],
          },
        ],
      } satisfies Task;
    };

  async resolveTarget(_input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    return makeResolvedTarget({ supportsStreaming: this.supportsStreaming });
  }

  async inspectTarget(): Promise<TargetInspection> {
    return makeReadyInspection();
  }

  async sendMessage(
    _target: ResolvedAgentTarget,
    params: MessageSendParams,
  ): Promise<Message | Task> {
    this.sendCalls.push(params);
    return this.sendImpl(params);
  }

  async *sendMessageStream(
    _target: ResolvedAgentTarget,
    params: MessageSendParams,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {
    this.streamCalls.push(params);
    for await (const event of this.streamImpl(params)) {
      yield event;
    }
  }

  // Default getTask stub used by the streaming-input-required path: the
  // provider calls this when a stream ends without a terminal task, to
  // recover the latest task state. Tests can override per scenario.
  getTaskImpl: (params: TaskQueryParams) => Promise<Task> = async (params) => ({
    kind: "task",
    id: params.id,
    contextId: "ctx-1",
    status: { state: "input-required" },
  });

  async getTask(_target: ResolvedAgentTarget, params: TaskQueryParams): Promise<Task> {
    return this.getTaskImpl(params);
  }

  async cancelTask(_target: ResolvedAgentTarget, params: TaskIdParams): Promise<Task> {
    return {
      kind: "task",
      id: params.id,
      contextId: "ctx-1",
      status: { state: "canceled" },
    };
  }

  async *resubscribeTask(): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {}

  async setTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not used");
  }

  async getTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: GetTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not used");
  }

  async listTaskPushNotificationConfigs(
    _target: ResolvedAgentTarget,
    _params: ListTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig[]> {
    throw new Error("not used");
  }

  async deleteTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: DeleteTaskPushNotificationConfigParams,
  ): Promise<void> {
    throw new Error("not used");
  }

  async getExtendedAgentCard(_target: ResolvedAgentTarget): Promise<AgentCard> {
    throw new Error("not used");
  }

  async probe() {
    return [];
  }

  subscribeDebug() {
    return () => {};
  }
}

describe("input_required interaction model (WP5)", () => {
  test("input_required state exposes active prompt/details via session reducer", () => {
    // Locks the contract that an agent emitting a `task.status.updated` with
    // state="input-required" and ACP elicitation metadata produces a session
    // state where activeElicitation is populated and status === "input_required".
    const initial = createInitialSessionState();
    const next = reduceA2ASessionState(initial, {
      type: "task.status.updated",
      update: {
        kind: "status-update",
        taskId: "task-1",
        contextId: "ctx-1",
        final: false,
        status: {
          state: "input-required",
          message: {
            kind: "message",
            messageId: "agent-elicit",
            role: "agent",
            parts: [{ kind: "text", text: "Which project?" }],
          },
        },
        metadata: {
          [ACP_A2A_ELICITATION_METADATA_KEY]: {
            kind: "acp.elicitation",
            mode: "form",
            message: "Pick a project to scaffold",
            sessionId: "sess-1",
            requestedSchema: {
              type: "object",
              title: "Project picker",
              properties: {
                project: { type: "string", description: "project slug" },
              },
              required: ["project"],
            },
          },
        },
      },
    });

    expect(next.status).toBe("input_required");
    expect(next.taskId).toBe("task-1");
    expect(next.contextId).toBe("ctx-1");
    expect(next.resumableTaskId).toBe("task-1");
    expect(next.taskState).toBe("input-required");
    expect(next.activeElicitation).toBeDefined();
    expect(next.activeElicitation?.mode).toBe("form");
    expect(next.activeElicitation?.message).toBe("Pick a project to scaffold");
    expect(next.activeElicitation?.requestedSchema.required).toEqual(["project"]);
    expect(next.activeElicitation?.requestedSchema.properties?.project).toMatchObject({
      type: "string",
    });
  });

  test("malformed elicitation metadata degrades gracefully (no throw, activeElicitation undefined)", () => {
    // Compatibility expectation from WP5 brief: clients should never have to
    // parse low-level metadata keys, and bad metadata must not crash the
    // reducer or pollute activeElicitation.
    const initial = createInitialSessionState();

    expect(() =>
      reduceA2ASessionState(initial, {
        type: "task.status.updated",
        update: {
          kind: "status-update",
          taskId: "task-1",
          contextId: "ctx-1",
          final: false,
          status: { state: "input-required" },
          metadata: {
            [ACP_A2A_ELICITATION_METADATA_KEY]: {
              // Intentionally malformed: missing mode/sessionId/requestedSchema
              kind: "acp.elicitation",
              not_a_real_field: true,
            } as unknown,
          },
        },
      }),
    ).not.toThrow();

    const next = reduceA2ASessionState(initial, {
      type: "task.status.updated",
      update: {
        kind: "status-update",
        taskId: "task-1",
        contextId: "ctx-1",
        final: false,
        status: { state: "input-required" },
        metadata: {
          [ACP_A2A_ELICITATION_METADATA_KEY]: "not even an object" as unknown,
        },
      },
    });

    expect(next.status).toBe("input_required");
    expect(next.activeElicitation).toBeUndefined();
  });

  test("respondToElicitation forwards the active resumableTaskId + contextId to transport", async () => {
    const transport = new ElicitationResumeTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });

    // Drive the controller's session state into input_required by replaying
    // the protocol path the reducer normally consumes. We use the transport's
    // event subscription seam by emitting through the provider.
    controller.setSessionContext("ctx-1", "task-1");
    // Directly populate `resumableTaskId` since we don't have a real
    // elicitation event chain in this isolated test.
    const stateWithResumable = {
      ...controller.getState(),
      resumableTaskId: "task-1",
    };
    Object.assign(controller.getState(), stateWithResumable);

    await controller.respondToElicitation({
      action: "accept",
      content: { project: "demo" },
    });

    // Non-streaming target by default → exactly one sendMessage call.
    expect(transport.sendCalls).toHaveLength(1);
    const params = transport.sendCalls[0];
    expect(params?.message.taskId).toBe("task-1");
    expect(params?.message.contextId).toBe("ctx-1");
    // The elicitation reply must be metadata-bearing, not transcript text.
    expect(params?.message.parts[0]).toMatchObject({ kind: "text", text: "" });
    expect(params?.message.metadata).toBeDefined();
  });

  test("respondToElicitation throws when no resumable task is present (controller-level guard)", async () => {
    const transport = new ElicitationResumeTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });

    await expect(
      controller.respondToElicitation({ action: "accept", content: { project: "x" } }),
    ).rejects.toThrow(/resumable task/i);
    expect(transport.sendCalls).toHaveLength(0);
    expect(transport.streamCalls).toHaveLength(0);
  });

  test("resume path works for streaming targets (uses sendMessageStream)", async () => {
    const transport = new ElicitationResumeTransport();
    transport.supportsStreaming = true;
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-1");
    Object.assign(controller.getState(), {
      ...controller.getState(),
      resumableTaskId: "task-1",
    });

    const seenEvents: string[] = [];
    controller.subscribe((event) => seenEvents.push(event.type));

    await controller.respondToElicitation({
      action: "accept",
      content: { project: "demo" },
    });

    expect(transport.streamCalls).toHaveLength(1);
    expect(transport.sendCalls).toHaveLength(0);
    expect(transport.streamCalls[0]?.message.taskId).toBe("task-1");
    expect(transport.streamCalls[0]?.message.contextId).toBe("ctx-1");
    // Streaming path emits intermediate status updates the reducer consumes.
    expect(seenEvents).toContain("task.status.updated");
    expect(seenEvents).toContain("message.completed");
  });

  test("resume path works for non-streaming targets (uses sendMessage)", async () => {
    const transport = new ElicitationResumeTransport();
    transport.supportsStreaming = false;
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });
    controller.setSessionContext("ctx-1", "task-1");
    Object.assign(controller.getState(), {
      ...controller.getState(),
      resumableTaskId: "task-1",
    });

    await controller.respondToElicitation({
      action: "accept",
      content: { project: "demo" },
    });

    expect(transport.sendCalls).toHaveLength(1);
    expect(transport.streamCalls).toHaveLength(0);
    expect(transport.sendCalls[0]?.message.taskId).toBe("task-1");
    expect(transport.sendCalls[0]?.message.contextId).toBe("ctx-1");
    // After non-streaming respond, the agent's terminal task is processed and
    // produces a message.completed transcript entry for the agent reply.
    expect(controller.getState().status).toBe("connected");
    expect(controller.getState().taskState).toBe("completed");
  });

  test("transcript continuity preserved across original prompt → elicitation → follow-up reply (streaming)", async () => {
    // Streaming is the realistic input_required surface: the agent yields a
    // task.status.updated with state="input-required" + ACP elicitation
    // metadata, and the stream stays open. After the user replies via
    // respondToElicitation the agent yields a terminal task with the final
    // answer in history.
    const transport = new ElicitationResumeTransport();
    transport.supportsStreaming = true;

    // Recovered-task stub for the input-required streaming path: when the
    // first stream ends without a terminal task, the provider calls
    // getTask and we surface the same elicitation metadata so the reducer
    // can populate activeElicitation through the `task.updated` reducer
    // path.
    transport.getTaskImpl = async (params) => ({
      kind: "task",
      id: params.id,
      contextId: "ctx-1",
      status: {
        state: "input-required",
        message: {
          kind: "message",
          messageId: "agent-elicit",
          role: "agent",
          parts: [{ kind: "text", text: "Which project?" }],
        },
      },
      metadata: {
        [ACP_A2A_ELICITATION_METADATA_KEY]: {
          kind: "acp.elicitation",
          mode: "form",
          message: "Pick a project",
          sessionId: "sess-1",
          requestedSchema: {
            type: "object",
            properties: { project: { type: "string" } },
            required: ["project"],
          },
        },
      },
    });

    let callCount = 0;
    transport.streamImpl = async function* (params: MessageSendParams) {
      callCount += 1;
      if (callCount === 1) {
        // Realistic input-required stream: the agent yields a final
        // task.status.updated with state="input-required" and final=true,
        // signaling "I'm waiting for the user". The stream then ends without
        // a terminal Task — the client must call respondToElicitation to
        // resume. The reducer's computeSessionStatusFromTaskState explicitly
        // maps "input-required" → "input_required" status.
        yield {
          kind: "status-update",
          taskId: "task-1",
          contextId: "ctx-1",
          // final:false because the task is not terminated; the agent is
          // suspended waiting for client input. final:true would tell the
          // reducer to drop resumableTaskId, which would break the resume
          // path UI consumers depend on.
          final: false,
          status: {
            state: "input-required",
            message: {
              kind: "message",
              messageId: "agent-elicit",
              role: "agent",
              parts: [{ kind: "text", text: "Which project?" }],
            },
          },
          metadata: {
            [ACP_A2A_ELICITATION_METADATA_KEY]: {
              kind: "acp.elicitation",
              mode: "form",
              message: "Pick a project",
              sessionId: "sess-1",
              requestedSchema: {
                type: "object",
                properties: { project: { type: "string" } },
                required: ["project"],
              },
            },
          },
        } satisfies TaskStatusUpdateEvent;
        return;
      }
      // Stage 2: elicitation reply → final completed task.
      yield {
        kind: "task",
        id: params.message.taskId ?? "task-1",
        contextId: params.message.contextId ?? "ctx-1",
        status: { state: "completed" },
        history: [
          {
            kind: "message",
            messageId: "agent-elicit",
            role: "agent",
            parts: [{ kind: "text", text: "Which project?" }],
          },
          {
            kind: "message",
            messageId: "agent-final",
            role: "agent",
            parts: [{ kind: "text", text: "Scaffolded demo." }],
          },
        ],
      } satisfies Task;
    };

    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });
    await controller.connect({ url: "http://127.0.0.1:55363" });

    // User sends original prompt → enters input_required.
    await controller.sendTurn("scaffold a project");

    const afterPrompt = controller.getState();
    // taskState carries the protocol-level state. The session-level `status`
    // field is intentionally less granular — when the stream emits agent text,
    // `message.completed` fires and flips `status` to "connected". UI clients
    // discriminate input-required from completed via `taskState` +
    // `activeElicitation`, NOT via `status` alone. WP7's view-model helper
    // covers reconciling these axes; WP5 just locks the existing contract.
    expect(afterPrompt.taskState).toBe("input-required");
    expect(afterPrompt.resumableTaskId).toBe("task-1");
    expect(afterPrompt.contextId).toBe("ctx-1");
    expect(afterPrompt.transcript).toHaveLength(1);
    expect(afterPrompt.transcript[0]).toMatchObject({
      role: "user",
      text: "scaffold a project",
    });
    expect(afterPrompt.activeElicitation?.mode).toBe("form");
    expect(afterPrompt.activeElicitation?.message).toBe("Pick a project");

    // User responds to elicitation; suppressTranscriptEntry means NO new user
    // entry is appended. The agent's terminal answer should still flow into
    // the transcript via the message.completed reducer path.
    await controller.respondToElicitation({
      action: "accept",
      content: { project: "demo" },
    });

    const afterResume = controller.getState();
    expect(afterResume.status).toBe("connected");
    expect(afterResume.taskState).toBe("completed");
    expect(afterResume.activeElicitation).toBeUndefined();

    // Original user prompt entry still present.
    expect(afterResume.transcript[0]).toMatchObject({
      role: "user",
      text: "scaffold a project",
    });

    // Agent reply appended; same contextId stitches the conversation.
    const agentEntries = afterResume.transcript.filter((entry) => entry.role === "agent");
    expect(agentEntries.length).toBeGreaterThanOrEqual(1);
    const lastAgent = agentEntries[agentEntries.length - 1];
    expect(lastAgent?.text).toBe("Scaffolded demo.");
    expect(lastAgent?.contextId).toBe("ctx-1");

    // No phantom "user follow-up" entry from suppressTranscriptEntry path.
    const userEntries = afterResume.transcript.filter((entry) => entry.role === "user");
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.text).toBe("scaffold a project");

    // Two transport stream calls in order: original sendTurn + elicitation
    // reply. The reply MUST carry the resumableTaskId + contextId.
    expect(transport.streamCalls).toHaveLength(2);
    expect(transport.streamCalls[0]?.message.taskId).toBeUndefined();
    expect(transport.streamCalls[1]?.message.taskId).toBe("task-1");
    expect(transport.streamCalls[1]?.message.contextId).toBe("ctx-1");
  });
});
