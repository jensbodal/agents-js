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
import {
  ACP_A2A_AUTH_REQUIRED_METADATA_KEY,
  extractAcpAuthRequiredMetadata,
} from "../src/acp-state.ts";
import { A2AClientController, A2AClientProvider } from "../src/index.ts";
import { createInitialSessionState, reduceA2ASessionState } from "../src/session.ts";
import type {
  A2AStreamElement,
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";
import {
  createMockTarget,
  makeMessage,
  makeTask,
  makeTextPart,
  statusEvent,
  taskEvent,
} from "./mock-a2a-transport.ts";

function makeResolvedTarget(overrides: { supportsStreaming?: boolean } = {}): ResolvedAgentTarget {
  const target = createMockTarget("http://127.0.0.1:55363");
  target.capabilities.supportsStreaming = overrides.supportsStreaming ?? false;
  return target;
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

class AuthRequiredTransport implements A2ATransport {
  readonly sendCalls: SendMessageRequest[] = [];
  readonly streamCalls: SendMessageRequest[] = [];
  supportsStreaming = false;

  sendImpl: (params: SendMessageRequest) => Promise<Message | Task> = async (params) =>
    makeTask({
      id: params.message?.taskId || "task-1",
      contextId: params.message?.contextId || "ctx-1",
      state: TaskState.TASK_STATE_COMPLETED,
    });

  streamImpl: (params: SendMessageRequest) => AsyncGenerator<A2AStreamElement> = async function* (
    params: SendMessageRequest,
  ) {
    yield taskEvent({
      id: params.message?.taskId || "task-1",
      contextId: params.message?.contextId || "ctx-1",
      state: TaskState.TASK_STATE_COMPLETED,
    });
  };

  // Default getTask returns an auth-required suspended task — used by the
  // streaming path's stream-end fallback when the agent yields no terminal.
  getTaskImpl: (params: GetTaskRequest) => Promise<Task> = async (params) =>
    makeTask({ id: params.id, contextId: "ctx-1", state: TaskState.TASK_STATE_AUTH_REQUIRED });

  async resolveTarget(_input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    return makeResolvedTarget({ supportsStreaming: this.supportsStreaming });
  }

  async inspectTarget(): Promise<TargetInspection> {
    return makeReadyInspection();
  }

  async sendMessage(
    _target: ResolvedAgentTarget,
    params: SendMessageRequest,
  ): Promise<Message | Task> {
    this.sendCalls.push(params);
    return this.sendImpl(params);
  }

  async *sendMessageStream(
    _target: ResolvedAgentTarget,
    params: SendMessageRequest,
  ): AsyncGenerator<A2AStreamElement> {
    this.streamCalls.push(params);
    for await (const event of this.streamImpl(params)) {
      yield event;
    }
  }

  async getTask(_target: ResolvedAgentTarget, params: GetTaskRequest): Promise<Task> {
    return this.getTaskImpl(params);
  }

  async cancelTask(_target: ResolvedAgentTarget, params: CancelTaskRequest): Promise<Task> {
    return makeTask({ id: params.id, contextId: "ctx-1", state: TaskState.TASK_STATE_CANCELED });
  }

  async *resubscribeTask(): AsyncGenerator<A2AStreamElement> {}

  async setTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not used");
  }

  async getTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: GetTaskPushNotificationConfigRequest,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not used");
  }

  async listTaskPushNotificationConfigs(
    _target: ResolvedAgentTarget,
    _params: ListTaskPushNotificationConfigsRequest,
  ): Promise<TaskPushNotificationConfig[]> {
    throw new Error("not used");
  }

  async deleteTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: DeleteTaskPushNotificationConfigRequest,
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

describe("auth_required metadata + action API", () => {
  test("auth-required task state populates typed activeAuth metadata with link + description", () => {
    // Locks the contract that the SDK plumbs the optional `link` and
    // `description` fields from ACP AuthMethod variants into the typed
    // session state, where Raycast's "Show open auth URL" / "Show copy
    // auth URL" / per-method description rendering depends on them.
    const initial = createInitialSessionState();
    const next = reduceA2ASessionState(initial, {
      type: "task.status.updated",
      update: {
        taskId: "task-1",
        contextId: "ctx-1",
        status: {
          state: TaskState.TASK_STATE_AUTH_REQUIRED,
          message: undefined,
          timestamp: undefined,
        },
        metadata: {
          [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: {
            kind: "acp.auth-required",
            message: "Authenticate to continue",
            authMethods: [
              {
                id: "google-oauth",
                name: "Sign in with Google",
                link: "https://accounts.google.com/oauth/authorize?client_id=...",
                description: "Use your Google account",
                type: "env_var",
                vars: [{ name: "GOOGLE_TOKEN", description: "OAuth token" }],
              },
              {
                id: "agent-handled",
                name: "Use built-in agent auth",
                description: "Agent handles credential capture",
                // No `link` — agent variants don't carry URLs
              },
            ],
          },
        },
      },
    });

    expect(next.taskState).toBe("auth-required");
    expect(next.status).toBe("auth_required");
    expect(next.resumableTaskId).toBe("task-1");
    expect(next.contextId).toBe("ctx-1");
    expect(next.activeAuth).toBeDefined();
    expect(next.activeAuth?.message).toBe("Authenticate to continue");
    expect(next.activeAuth?.authMethods).toHaveLength(2);

    const [google, agentMethod] = next.activeAuth?.authMethods ?? [];
    expect(google).toMatchObject({
      id: "google-oauth",
      name: "Sign in with Google",
      link: "https://accounts.google.com/oauth/authorize?client_id=...",
      description: "Use your Google account",
    });
    // Variant without a link must not surface one — UI uses the missing
    // field to skip the "Open URL" action.
    expect(agentMethod).toMatchObject({
      id: "agent-handled",
      name: "Use built-in agent auth",
      description: "Agent handles credential capture",
    });
    expect(agentMethod?.link).toBeUndefined();
  });

  test("malformed auth-required metadata degrades gracefully (no throw, activeAuth undefined)", () => {
    const initial = createInitialSessionState();

    expect(() =>
      reduceA2ASessionState(initial, {
        type: "task.status.updated",
        update: {
          taskId: "task-1",
          contextId: "ctx-1",
          status: {
            state: TaskState.TASK_STATE_AUTH_REQUIRED,
            message: undefined,
            timestamp: undefined,
          },
          metadata: {
            [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: "not even an object" as unknown,
          },
        },
      }),
    ).not.toThrow();

    const next = reduceA2ASessionState(initial, {
      type: "task.status.updated",
      update: {
        taskId: "task-1",
        contextId: "ctx-1",
        status: {
          state: TaskState.TASK_STATE_AUTH_REQUIRED,
          message: undefined,
          timestamp: undefined,
        },
        metadata: {
          [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: {
            // Missing `kind` discriminator → schema check fails
            authMethods: [{ id: "x" }],
          } as unknown,
        },
      },
    });

    expect(next.taskState).toBe("auth-required");
    expect(next.activeAuth).toBeUndefined();
  });

  test("authMethod entries missing `link` do not produce a broken `link` field on consumers", () => {
    // Direct extractor exercise — pinning the contract that consumers can
    // safely test `method.link !== undefined` to gate open/copy actions.
    const result = extractAcpAuthRequiredMetadata({
      [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: {
        kind: "acp.auth-required",
        message: "Sign in",
        authMethods: [
          { id: "no-url-method", name: "Local terminal" },
          { id: "url-method", name: "Browser flow", link: "https://example.com/oauth" },
          // Garbage entry — no id, must be filtered out
          { name: "broken" } as unknown,
        ],
      },
    });

    expect(result?.authMethods).toHaveLength(2);
    const [terminal, browser] = result?.authMethods ?? [];
    expect(terminal).toEqual({ id: "no-url-method", name: "Local terminal" });
    // Verify the missing-link entry has zero `link` key, not `link: undefined`.
    expect("link" in (terminal ?? {})).toBe(false);
    expect(browser).toEqual({
      id: "url-method",
      name: "Browser flow",
      link: "https://example.com/oauth",
    });
  });

  test("auth-failed state is distinguishable from auth-required waiting state", () => {
    // Compatibility: auth-required must not be collapsed into a
    // generic error unless the task is actually failed. Here we drive the
    // session through auth-required → failed and assert the state shape
    // post-transition makes this distinguishable for UI clients.
    const initial = createInitialSessionState();
    const afterAuthRequired = reduceA2ASessionState(initial, {
      type: "task.status.updated",
      update: {
        taskId: "task-1",
        contextId: "ctx-1",
        status: {
          state: TaskState.TASK_STATE_AUTH_REQUIRED,
          message: undefined,
          timestamp: undefined,
        },
        metadata: {
          [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: {
            kind: "acp.auth-required",
            message: "Authenticate to continue",
            authMethods: [{ id: "oauth", name: "OAuth" }],
          },
        },
      },
    });

    expect(afterAuthRequired.taskState).toBe("auth-required");
    expect(afterAuthRequired.activeAuth).toBeDefined();
    expect(afterAuthRequired.lastError).toBeUndefined();

    // Now the task transitions to failed (e.g. user couldn't auth).
    const afterFailure = reduceA2ASessionState(afterAuthRequired, {
      type: "task.status.updated",
      update: {
        taskId: "task-1",
        contextId: "ctx-1",
        status: { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: undefined },
        metadata: undefined,
      },
    });

    // taskState reflects the protocol-level failure...
    expect(afterFailure.taskState).toBe("failed");
    // ...activeAuth is cleared (no auth metadata on the failed transition,
    // extractor returns undefined, reducer overwrites)...
    expect(afterFailure.activeAuth).toBeUndefined();
    // ...resumableTaskId clears because final:true...
    expect(afterFailure.resumableTaskId).toBeUndefined();
    // ...but lastError stays untouched — failure on the protocol level is
    // a state, not an SDK error event. UI can render "Authentication
    // failed" from `taskState === "failed"` distinctly from
    // `taskState === "auth-required"`.
    expect(afterFailure.lastError).toBeUndefined();
  });

  test("respondToAuthRequired sends method id metadata with original taskId + contextId", async () => {
    const transport = new AuthRequiredTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });

    // Simulate that the controller is in auth_required with a resumable task.
    controller.setSessionContext("ctx-1", "task-1");
    Object.assign(controller.getState(), {
      ...controller.getState(),
      resumableTaskId: "task-1",
    });

    await controller.respondToAuthRequired("oauth-method-id");

    expect(transport.sendCalls).toHaveLength(1);
    const params = transport.sendCalls[0];
    expect(params?.message?.taskId).toBe("task-1");
    expect(params?.message?.contextId).toBe("ctx-1");
    expect(params?.message?.metadata).toBeDefined();
    // Metadata must carry the auth-required response with the chosen method id.
    const authResponse = params?.message?.metadata?.[ACP_A2A_AUTH_REQUIRED_METADATA_KEY] as
      | { kind?: string; methodId?: string }
      | undefined;
    expect(authResponse?.kind).toBe("acp.auth-required");
    expect(authResponse?.methodId).toBe("oauth-method-id");
  });

  test("respondToAuthRequired throws when no resumable task is staged", async () => {
    const transport = new AuthRequiredTransport();
    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });

    await controller.connect({ url: "http://127.0.0.1:55363" });

    await expect(controller.respondToAuthRequired("any-method")).rejects.toThrow(/resumable task/i);
    expect(transport.sendCalls).toHaveLength(0);
    expect(transport.streamCalls).toHaveLength(0);
  });

  test("retry/resume after auth uses original contextId (streaming path preserves resumableTaskId)", async () => {
    // Locks that provider behavior carries over to auth-required: streaming
    // input/auth-required tasks preserve resumableTaskId because
    // `message.completed` is now gated by `isTerminalTaskState`.
    const transport = new AuthRequiredTransport();
    transport.supportsStreaming = true;

    const authMetadata = {
      [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: {
        kind: "acp.auth-required",
        message: "Authenticate to continue",
        authMethods: [{ id: "oauth", name: "OAuth", link: "https://example.com/oauth" }],
      },
    };

    transport.getTaskImpl = async (params) =>
      makeTask({
        id: params.id,
        contextId: "ctx-1",
        state: TaskState.TASK_STATE_AUTH_REQUIRED,
        message: makeMessage({
          messageId: "agent-auth",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("Authenticate to continue")],
        }),
        metadata: authMetadata,
      });

    transport.streamImpl = async function* () {
      yield statusEvent({
        taskId: "task-1",
        contextId: "ctx-1",
        state: TaskState.TASK_STATE_AUTH_REQUIRED,
        message: makeMessage({
          messageId: "agent-auth",
          role: Role.ROLE_AGENT,
          parts: [makeTextPart("Authenticate to continue")],
        }),
        metadata: authMetadata,
      });
    };

    const controller = new A2AClientController({
      provider: new A2AClientProvider(transport),
    });
    await controller.connect({ url: "http://127.0.0.1:55363" });

    await controller.sendTurn("do the thing that needs auth");

    const afterPrompt = controller.getState();
    expect(afterPrompt.taskState).toBe("auth-required");
    expect(afterPrompt.resumableTaskId).toBe("task-1");
    expect(afterPrompt.contextId).toBe("ctx-1");
    expect(afterPrompt.activeAuth?.authMethods?.[0]).toMatchObject({
      id: "oauth",
      name: "OAuth",
      link: "https://example.com/oauth",
    });

    // Resume: respondToAuthRequired must succeed because resumableTaskId
    // survived. The wire call carries the same taskId + contextId.
    await controller.respondToAuthRequired("oauth");

    expect(transport.streamCalls).toHaveLength(2);
    expect(transport.streamCalls[1]?.message?.taskId).toBe("task-1");
    expect(transport.streamCalls[1]?.message?.contextId).toBe("ctx-1");
  });
});
