/**
 * Shared mock A2A transport for internal-gateway tests.
 *
 * Used by the host-executor test suite.
 */
import { type Message, Role } from "@a2a-js/sdk";
import type {
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
  TargetInspection,
} from "@agents-js/a2a-client";

export function createMockTarget(url: string): ResolvedAgentTarget {
  return {
    baseUrl: url,
    cardUrl: `${url}/.well-known/agent.json`,
    card: {
      name: "mock-agent",
      description: "Mock agent for testing",
      supportedInterfaces: [{ url, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1" }],
      version: "1.0.0",
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      capabilities: { extensions: [] },
      provider: undefined,
      securitySchemes: {},
      securityRequirements: [],
      signatures: [],
    },
    protocolVersion: "0.3.0",
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
      return {
        messageId: crypto.randomUUID(),
        role: Role.ROLE_AGENT,
        parts: [
          {
            content: { $case: "text", value: responseText },
            metadata: undefined,
            filename: "",
            mediaType: "text/plain",
          },
        ],
        taskId: "",
        contextId: "",
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      } satisfies Message;
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
