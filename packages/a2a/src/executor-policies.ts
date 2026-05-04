import type { ClientSideConnection } from "@agents-js/acp";

type ClientHandlersFactory = ConstructorParameters<typeof ClientSideConnection>[0];
type ClientHandlers = ReturnType<ClientHandlersFactory>;
type RequestPermissionParams = Parameters<NonNullable<ClientHandlers["requestPermission"]>>[0];
type RequestPermissionResponse = Awaited<
  ReturnType<NonNullable<ClientHandlers["requestPermission"]>>
>;
type SessionUpdateParams = Parameters<NonNullable<ClientHandlers["sessionUpdate"]>>[0];
type AgentMessageChunk = Extract<
  SessionUpdateParams["update"],
  { sessionUpdate: "agent_message_chunk" }
>;

export function extractValidAgentMessageId(
  messageId: AgentMessageChunk["messageId"] | unknown,
): string | undefined {
  return typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
}

export function selectPermissionOutcome(
  options: RequestPermissionParams["options"],
): RequestPermissionResponse {
  const selectedOption = options[0];
  return selectedOption
    ? { outcome: { outcome: "selected", optionId: selectedOption.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

export function resolveAgentMessageId(chunkMessageId: AgentMessageChunk["messageId"]): string {
  return extractValidAgentMessageId(chunkMessageId) ?? crypto.randomUUID();
}
