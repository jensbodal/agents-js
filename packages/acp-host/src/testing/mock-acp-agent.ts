/**
 * Deterministic in-process ACP mock agent for testing.
 *
 * Uses the same TransformStream + ndJsonStream + AgentSideConnection pattern
 * as the ACP controller tests. The agent runs in-process, so hosts can test
 * real controller flows without spawning an external subprocess.
 */
import {
  type Agent,
  AgentSideConnection,
  CLIENT_METHODS,
  type CloseSessionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeResponse,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type LogoutResponse,
  type NewSessionResponse,
  ndJsonStream,
  type PermissionOptionKind,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionInfo,
  type SetSessionConfigOptionResponse,
  type StopReason,
  type Stream,
  type ToolCallContent,
  type ToolKind,
} from "@agentclientprotocol/sdk";
import type { ACPProcess, ACPProcessOptions } from "@agents-js/acp";

const A2UI_META_KEY = "a2ui_message";

export type ElicitationScenario = {
  sessionId?: string;
  mode: "form";
  message: string;
  requestedSchema: Record<string, unknown>;
};

export type PromptScenario = {
  messageChunks?: string[];
  messageChunkIds?: Array<string | null | undefined>;
  planEntries?: Array<{
    content: string;
    status: "pending" | "in_progress" | "completed";
    priority: "high" | "medium" | "low";
  }>;
  toolCalls?: Array<{
    id: string;
    title: string;
    status: "in_progress" | "completed" | "failed";
    kind?: ToolKind;
    content?: ToolCallContent[];
    /**
     * Optional ordered list of A2UI messages to ship alongside this
     * tool_call. Each entry becomes a `ToolCallContent` with
     * `_meta.a2ui_message` set on the wire — matching the extension
     * shape the host adapter recognizes. Passed as `unknown` so tests
     * can exercise invalid payloads too.
     */
    a2uiMessages?: unknown[];
  }>;
  sessionInfoUpdate?: { title?: string; updatedAt?: string };
  permissionRequest?: {
    toolCallId: string;
    title: string;
    options: Array<{ kind: PermissionOptionKind; name: string; optionId: string }>;
  };
  elicitationRequest?: ElicitationScenario;
  writeFile?: { path: string; content: string };
  readFile?: { path: string };
  userMessageId?: string | null;
  stopReason: StopReason;
};

export type AgentScenario = {
  initialize?: Partial<InitializeResponse>;
  newSession?: Partial<NewSessionResponse>;
  listSessions?: { sessions: SessionInfo[]; nextCursor?: string };
  loadSession?: Partial<LoadSessionResponse> | Error;
  closeSession?: Partial<CloseSessionResponse> | Error;
  forkSession?: Partial<ForkSessionResponse> | Error;
  resumeSession?: Partial<ResumeSessionResponse> | Error;
  setConfigOption?: Partial<SetSessionConfigOptionResponse> | Error;
  logout?: Partial<LogoutResponse> | Error;
  prompts: PromptScenario[];
};

type StreamFactory = () => { clientStream: Stream; agentStream: Stream };

function createStreamPair(): { clientStream: Stream; agentStream: Stream } {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    clientStream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
    agentStream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createMockAgent(
  scenario: AgentScenario,
  streamFactory: StreamFactory = createStreamPair,
): {
  createProcess: (options: ACPProcessOptions) => ACPProcess;
  agentReady: Promise<void>;
  promptRequests: PromptRequest[];
  newSessionRequests: Array<Parameters<Agent["newSession"]>[0]>;
  listSessionRequests: ListSessionsRequest[];
  loadSessionRequests: LoadSessionRequest[];
  forkSessionRequests: ForkSessionRequest[];
  resumeSessionRequests: ResumeSessionRequest[];
} {
  let promptIndex = 0;
  const agentReadyDeferred = createDeferred<void>();
  const promptRequests: PromptRequest[] = [];
  const newSessionRequests: Array<Parameters<Agent["newSession"]>[0]> = [];
  const listSessionRequests: ListSessionsRequest[] = [];
  const loadSessionRequests: LoadSessionRequest[] = [];
  const forkSessionRequests: ForkSessionRequest[] = [];
  const resumeSessionRequests: ResumeSessionRequest[] = [];

  const createProcess = (_options: ACPProcessOptions): ACPProcess => {
    const { clientStream, agentStream } = streamFactory();

    const _agentConnection = new AgentSideConnection((connection): Agent => {
      agentReadyDeferred.resolve();

      return {
        async authenticate() {
          return {};
        },

        async initialize(_params) {
          return {
            agentInfo: { name: "mock-agent", version: "1.0.0" },
            agentCapabilities: {},
            protocolVersion: PROTOCOL_VERSION,
            ...scenario.initialize,
          };
        },

        async newSession(params) {
          newSessionRequests.push(params);
          return {
            sessionId: "mock-session-1",
            ...scenario.newSession,
          };
        },

        async listSessions(params) {
          listSessionRequests.push(params);
          return {
            sessions: scenario.listSessions?.sessions ?? [],
            nextCursor: scenario.listSessions?.nextCursor,
          };
        },

        async loadSession(params) {
          loadSessionRequests.push(params);
          if (scenario.loadSession instanceof Error) {
            throw scenario.loadSession;
          }
          return {
            ...scenario.loadSession,
          };
        },

        async closeSession(_params) {
          if (scenario.closeSession instanceof Error) {
            throw scenario.closeSession;
          }
          return {
            ...scenario.closeSession,
          };
        },

        async unstable_forkSession(params) {
          forkSessionRequests.push(params);
          if (scenario.forkSession instanceof Error) {
            throw scenario.forkSession;
          }
          return {
            sessionId: "forked-session-1",
            ...scenario.forkSession,
          };
        },

        async resumeSession(params) {
          resumeSessionRequests.push(params);
          if (scenario.resumeSession instanceof Error) {
            throw scenario.resumeSession;
          }
          return {
            ...scenario.resumeSession,
          };
        },

        async setSessionConfigOption(_params) {
          if (scenario.setConfigOption instanceof Error) {
            throw scenario.setConfigOption;
          }
          return {
            configOptions: [],
            ...scenario.setConfigOption,
          };
        },

        async unstable_logout(_params) {
          if (scenario.logout instanceof Error) {
            throw scenario.logout;
          }
          return {
            ...scenario.logout,
          };
        },

        async prompt(params: PromptRequest): Promise<PromptResponse> {
          promptRequests.push(params);
          const promptScenario = scenario.prompts[promptIndex];
          if (!promptScenario) {
            throw new Error(
              `Mock agent: no scenario for prompt index ${promptIndex}. ` +
                `Only ${scenario.prompts.length} scenarios configured.`,
            );
          }
          promptIndex++;

          if (promptScenario.messageChunks) {
            for (const [index, text] of promptScenario.messageChunks.entries()) {
              const messageId = promptScenario.messageChunkIds?.[index];
              await connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text },
                  ...(messageId != null ? { messageId } : {}),
                },
              });
            }
          }

          if (promptScenario.toolCalls) {
            for (const tc of promptScenario.toolCalls) {
              const a2uiContentEntries = (tc.a2uiMessages ?? []).map((msg) => ({
                type: "content" as const,
                content: { type: "text" as const, text: "[a2ui]" },
                _meta: { [A2UI_META_KEY]: msg },
              }));
              const content = [...(tc.content ?? []), ...a2uiContentEntries];
              await connection.sessionUpdate({
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: tc.id,
                  title: tc.title,
                  status: tc.status,
                  kind: tc.kind,
                  ...(content.length > 0 ? { content } : {}),
                },
              });
            }
          }

          if (promptScenario.planEntries) {
            await connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "plan",
                entries: promptScenario.planEntries,
              },
            });
          }

          if (promptScenario.sessionInfoUpdate) {
            await connection.sessionUpdate({
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "session_info_update",
                ...promptScenario.sessionInfoUpdate,
              },
            });
          }

          if (promptScenario.readFile) {
            await connection.readTextFile({
              sessionId: params.sessionId,
              path: promptScenario.readFile.path,
            });
          }

          if (promptScenario.writeFile) {
            await connection.writeTextFile({
              sessionId: params.sessionId,
              path: promptScenario.writeFile.path,
              content: promptScenario.writeFile.content,
            });
          }

          if (promptScenario.permissionRequest) {
            const pr = promptScenario.permissionRequest;
            await connection.requestPermission({
              sessionId: params.sessionId,
              toolCall: {
                toolCallId: pr.toolCallId,
                title: pr.title,
              },
              options: pr.options,
            });
          }

          if (promptScenario.elicitationRequest) {
            const er = promptScenario.elicitationRequest;
            await connection.extMethod(CLIENT_METHODS.elicitation_create, {
              sessionId: er.sessionId ?? params.sessionId,
              mode: er.mode,
              message: er.message,
              requestedSchema: er.requestedSchema,
            });
          }

          return {
            stopReason: promptScenario.stopReason,
            ...(promptScenario.userMessageId != null
              ? { userMessageId: promptScenario.userMessageId }
              : {}),
          };
        },

        async cancel() {},
      };
    }, agentStream);

    return {
      stream: clientStream,
      process: null as unknown as import("node:child_process").ChildProcess,
      kill: () => {},
    };
  };

  return {
    createProcess,
    agentReady: agentReadyDeferred.promise,
    promptRequests,
    newSessionRequests,
    listSessionRequests,
    loadSessionRequests,
    forkSessionRequests,
    resumeSessionRequests,
  };
}

/**
 * Creates a mock agent whose transport can be aborted mid-session.
 * Useful for host crash/recovery tests that need a hard stream failure.
 */
export function createCrashableAgent(scenario: AgentScenario): {
  createProcess: (options: ACPProcessOptions) => ACPProcess;
  agentReady: Promise<void>;
  promptRequests: PromptRequest[];
  crash: () => void;
} {
  let clientToAgentWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let agentToClientWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let crashed = false;

  const doCrash = () => {
    if (crashed) return;
    crashed = true;
    const crashError = new Error("Process killed (SIGKILL)");
    try {
      clientToAgentWriter?.abort(crashError).catch(() => {});
    } catch {}
    try {
      agentToClientWriter?.abort(crashError).catch(() => {});
    } catch {}
  };

  const crashableStreamFactory: StreamFactory = () => {
    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

    clientToAgentWriter = clientToAgent.writable.getWriter();
    agentToClientWriter = agentToClient.writable.getWriter();

    return {
      clientStream: ndJsonStream(
        new WritableStream<Uint8Array>({
          async write(chunk) {
            if (crashed) throw new Error("Process killed (SIGKILL)");
            await clientToAgentWriter?.write(chunk);
          },
          async close() {
            await clientToAgentWriter?.close();
          },
          async abort(reason) {
            await clientToAgentWriter?.abort(reason);
          },
        }),
        agentToClient.readable,
      ),
      agentStream: ndJsonStream(
        new WritableStream<Uint8Array>({
          async write(chunk) {
            if (crashed) throw new Error("Process killed (SIGKILL)");
            await agentToClientWriter?.write(chunk);
          },
          async close() {
            await agentToClientWriter?.close();
          },
          async abort(reason) {
            await agentToClientWriter?.abort(reason);
          },
        }),
        clientToAgent.readable,
      ),
    };
  };

  const base = createMockAgent(scenario, crashableStreamFactory);
  return {
    ...base,
    crash: doCrash,
  };
}

export function createEchoAgent(): {
  createProcess: (options: ACPProcessOptions) => ACPProcess;
  agentReady: Promise<void>;
  promptRequests: PromptRequest[];
} {
  return createMockAgent({
    prompts: [
      {
        messageChunks: ["Echo: received your message"],
        stopReason: "end_turn",
      },
    ],
  });
}

export function createHangingAgent(): {
  createProcess: (options: ACPProcessOptions) => ACPProcess;
  agentReady: Promise<void>;
  promptRequests: PromptRequest[];
} {
  const agentReadyDeferred = createDeferred<void>();
  const promptRequests: PromptRequest[] = [];

  const createProcess = (_options: ACPProcessOptions): ACPProcess => {
    const { clientStream, agentStream } = createStreamPair();

    const _agentConnection = new AgentSideConnection((): Agent => {
      agentReadyDeferred.resolve();

      return {
        async authenticate() {
          return {};
        },

        async initialize(_params) {
          return {
            agentInfo: { name: "hanging-agent", version: "1.0.0" },
            agentCapabilities: {},
            protocolVersion: PROTOCOL_VERSION,
          };
        },

        async newSession(_params) {
          return { sessionId: "hanging-session-1" };
        },

        async prompt(params: PromptRequest) {
          promptRequests.push(params);
          return new Promise<PromptResponse>(() => {});
        },

        async cancel() {},
      };
    }, agentStream);

    return {
      stream: clientStream,
      process: null as unknown as import("node:child_process").ChildProcess,
      kill: () => {},
    };
  };

  return { createProcess, agentReady: agentReadyDeferred.promise, promptRequests };
}
