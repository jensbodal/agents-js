import type { Message, Task, TaskArtifactUpdateEvent, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import type {
  A2AStreamEvent,
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";

export function createMockTarget(url: string): ResolvedAgentTarget {
  return {
    baseUrl: url,
    cardUrl: `${url}/.well-known/agent.json`,
    card: {
      name: "mock-agent",
      description: "Mock agent for testing",
      url,
      version: "1.0.0",
      protocolVersion: "0.3.0",
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      capabilities: {},
    },
    protocolVersion: "0.3.0",
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
      return {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: responseText }],
      } as Message;
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
export type StreamItem =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent
  | A2AStreamEvent;

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
      target.capabilities.raw = { streaming: true };
      target.card.capabilities = { streaming: true };
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
