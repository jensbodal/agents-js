import type {
  AuthMethod,
  CreateElicitationRequest,
  ElicitationContentValue,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";

export const ACP_ELICITATION_METADATA_KEY = "agentclientprotocol.com/elicitation";
export const ACP_ELICITATION_RESPONSE_METADATA_KEY = "agentclientprotocol.com/elicitation-response";
export const ACP_AUTH_REQUIRED_METADATA_KEY = "agentclientprotocol.com/auth-required";

export interface ACPFormElicitationMetadata {
  kind: "acp.elicitation";
  message: string;
  mode: "form";
  requestedSchema: ElicitationSchema;
  sessionId: string;
}

export interface ACPElicitationResponseMetadata {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, ElicitationContentValue> | null;
  kind: "acp.elicitation-response";
}

export interface ACPAuthRequiredMetadata {
  authMethods?: AuthMethod[];
  kind: "acp.auth-required";
  message: string;
}

export function buildACPFormElicitationMetadata(
  request: Extract<CreateElicitationRequest, { mode: "form" }> & { sessionId: string },
): ACPFormElicitationMetadata {
  return {
    kind: "acp.elicitation",
    message: request.message,
    mode: "form",
    requestedSchema: request.requestedSchema,
    sessionId: request.sessionId,
  };
}

export function isACPFormElicitationMetadata(input: unknown): input is ACPFormElicitationMetadata {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as Record<string, unknown>;
  return (
    candidate.kind === "acp.elicitation" &&
    candidate.mode === "form" &&
    typeof candidate.message === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.requestedSchema === "object" &&
    candidate.requestedSchema !== null
  );
}

export function isACPElicitationResponseMetadata(
  input: unknown,
): input is ACPElicitationResponseMetadata {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as Record<string, unknown>;
  return (
    candidate.kind === "acp.elicitation-response" &&
    (candidate.action === "accept" ||
      candidate.action === "decline" ||
      candidate.action === "cancel")
  );
}

export function isACPAuthRequiredMetadata(input: unknown): input is ACPAuthRequiredMetadata {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const candidate = input as Record<string, unknown>;
  return candidate.kind === "acp.auth-required" && typeof candidate.message === "string";
}
