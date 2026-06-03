import {
  type AgentCard,
  type Artifact,
  type Message,
  type Part,
  Role,
  type Task,
  type TaskArtifactUpdateEvent,
  TaskState,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
import type {
  A2AStreamElement,
  A2AStreamPayload,
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";

// --- Proto-canonical (A2A 1.0) builders -------------------------------------
//
// Centralize the proto scaffolding (Role enum, `content.$case` parts, required
// `tenant`/`extensions`/`metadata`/`artifacts` fields, TaskState enum) so tests
// build wire-shaped objects without repeating boilerplate. Wrapped event
// builders compose the raw ones so the two can't drift.

/** Build a proto text {@link Part}. */
export function makeTextPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

/** Build a proto-canonical {@link Message}. */
export function makeMessage(opts: {
  text?: string;
  parts?: Part[];
  role?: Role;
  messageId?: string;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}): Message {
  return {
    messageId: opts.messageId ?? crypto.randomUUID(),
    role: opts.role ?? Role.ROLE_AGENT,
    parts: opts.parts ?? (opts.text !== undefined ? [makeTextPart(opts.text)] : []),
    contextId: opts.contextId ?? "",
    taskId: opts.taskId ?? "",
    metadata: opts.metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** Build a proto-canonical {@link Task}. */
export function makeTask(opts: {
  id?: string;
  contextId?: string;
  state?: TaskState;
  message?: Message;
  text?: string;
  timestamp?: string;
  history?: Message[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}): Task {
  const message =
    opts.message ?? (opts.text !== undefined ? makeMessage({ text: opts.text }) : undefined);
  return {
    id: opts.id ?? crypto.randomUUID(),
    contextId: opts.contextId ?? "",
    status: {
      state: opts.state ?? TaskState.TASK_STATE_WORKING,
      message,
      timestamp: opts.timestamp,
    },
    artifacts: opts.artifacts ?? [],
    history: opts.history ?? [],
    metadata: opts.metadata,
  };
}

/** Build a proto-canonical {@link TaskStatusUpdateEvent}. */
export function makeStatusUpdate(opts: {
  taskId?: string;
  contextId?: string;
  state?: TaskState;
  message?: Message;
  text?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}): TaskStatusUpdateEvent {
  const message =
    opts.message ?? (opts.text !== undefined ? makeMessage({ text: opts.text }) : undefined);
  return {
    taskId: opts.taskId ?? "",
    contextId: opts.contextId ?? "",
    status: {
      state: opts.state ?? TaskState.TASK_STATE_WORKING,
      message,
      timestamp: opts.timestamp,
    },
    metadata: opts.metadata,
  };
}

// --- Wrapped stream-payload builders ----------------------------------------

/** Wrap a Task in the A2A 1.0 stream payload envelope. */
export function taskEvent(opts: Parameters<typeof makeTask>[0]): A2AStreamPayload {
  return { $case: "task", value: makeTask(opts) };
}

/** Wrap a Message in the A2A 1.0 stream payload envelope. */
export function messageEvent(opts: Parameters<typeof makeMessage>[0]): A2AStreamPayload {
  return { $case: "message", value: makeMessage(opts) };
}

/** Wrap a TaskStatusUpdateEvent in the A2A 1.0 stream payload envelope. */
export function statusEvent(opts: Parameters<typeof makeStatusUpdate>[0]): A2AStreamPayload {
  return { $case: "statusUpdate", value: makeStatusUpdate(opts) };
}

/** Wrap a TaskArtifactUpdateEvent in the A2A 1.0 stream payload envelope. */
export function artifactEvent(value: TaskArtifactUpdateEvent): A2AStreamPayload {
  return { $case: "artifactUpdate", value };
}

/**
 * Build a proto-canonical (A2A 1.0) {@link AgentCard}. `url`/`protocolVersion`
 * moved off the top level onto `supportedInterfaces[]`; `capabilities` requires
 * an `extensions` array; `securitySchemes`/`securityRequirements`/`signatures`
 * are required.
 */
export function makeAgentCard(
  opts: {
    name?: string;
    description?: string;
    url?: string;
    protocolVersion?: string;
    version?: string;
    capabilities?: Record<string, unknown>;
    defaultInputModes?: string[];
    defaultOutputModes?: string[];
    skills?: unknown[];
  } = {},
): AgentCard {
  const url = opts.url ?? "http://127.0.0.1:55363";
  const protocolVersion = opts.protocolVersion ?? "1.0.0-alpha.0";
  return {
    name: opts.name ?? "mock-agent",
    description: opts.description ?? "Mock agent for testing",
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", tenant: "", protocolVersion }],
    provider: undefined,
    version: opts.version ?? "1.0.0",
    capabilities: { extensions: [], ...(opts.capabilities ?? {}) } as AgentCard["capabilities"],
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: opts.defaultInputModes ?? ["text"],
    defaultOutputModes: opts.defaultOutputModes ?? ["text"],
    skills: (opts.skills ?? []) as AgentCard["skills"],
    signatures: [],
  } as AgentCard;
}

export function createMockTarget(url: string): ResolvedAgentTarget {
  const protocolVersion = "1.0.0-alpha.0";
  return {
    baseUrl: url,
    cardUrl: `${url}/.well-known/agent.json`,
    card: makeAgentCard({ url, protocolVersion }),
    protocolVersion,
    capabilities: {
      inputModes: ["text"],
      outputModes: ["text"],
      supportsTextInput: true,
      supportsTextOutput: true,
      supportsStreaming: false,
      supportsPushNotifications: false,
      raw: { extensions: [] },
    },
  };
}

export function createMockTransport(responses: Record<string, string>): A2ATransport {
  return {
    async resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
      return createMockTarget(input.url);
    },
    async inspectTarget(_input: AgentTargetInput): Promise<TargetInspection> {
      return { status: "ready" };
    },
    async sendMessage(target: ResolvedAgentTarget): Promise<Message> {
      const responseText = responses[target.baseUrl] ?? "no response configured";
      return makeMessage({ text: responseText });
    },
    sendMessageStream() {
      throw new Error("Streaming not supported in mock transport");
    },
    async getTask() {
      throw new Error("Not implemented");
    },
    async cancelTask() {
      throw new Error("Not implemented");
    },
    resubscribeTask() {
      throw new Error("Not implemented");
    },
    async setTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async getTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async listTaskPushNotificationConfigs() {
      throw new Error("Not implemented");
    },
    async deleteTaskPushNotificationConfig() {},
    async getExtendedAgentCard() {
      throw new Error("Not implemented");
    },
    async probe() {
      return [];
    },
    subscribeDebug() {
      return () => {};
    },
  } as A2ATransport;
}

/** Event items a streaming mock transport may yield from `sendMessageStream`. */
export type StreamItem = A2AStreamElement;

/**
 * Streaming-capable mock transport. Yields the provided `streamResults` from
 * `sendMessageStream` in order; all other methods throw. The resolved target
 * reports `supportsStreaming: true`.
 */
export function createStreamingMockTransport(streamResults: StreamItem[]): A2ATransport {
  return {
    async resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
      const target = createMockTarget(input.url);
      target.capabilities.supportsStreaming = true;
      target.capabilities.raw = { streaming: true, extensions: [] };
      target.card.capabilities = { streaming: true, extensions: [] };
      return target;
    },
    async inspectTarget(_input: AgentTargetInput): Promise<TargetInspection> {
      return { status: "ready" };
    },
    async sendMessage() {
      throw new Error("non-streaming sendMessage not supported in streaming mock");
    },
    async *sendMessageStream(): AsyncGenerator<StreamItem> {
      for (const event of streamResults) {
        yield event;
      }
    },
    async getTask() {
      throw new Error("Not implemented");
    },
    async cancelTask() {
      throw new Error("Not implemented");
    },
    resubscribeTask() {
      throw new Error("Not implemented");
    },
    async setTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async getTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async listTaskPushNotificationConfigs() {
      throw new Error("Not implemented");
    },
    async deleteTaskPushNotificationConfig() {},
    async getExtendedAgentCard() {
      throw new Error("Not implemented");
    },
    async probe() {
      return [];
    },
    subscribeDebug() {
      return () => {};
    },
  } as A2ATransport;
}
