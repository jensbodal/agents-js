import type {
  AuthenticateRequest,
  AuthMethod,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agents-js/acp";
import {
  ACP_AUTH_REQUIRED_METADATA_KEY,
  ACP_ELICITATION_METADATA_KEY,
  ACP_ELICITATION_RESPONSE_METADATA_KEY,
  buildACPFormElicitationMetadata,
  isACPElicitationResponseMetadata,
} from "@agents-js/validation/a2a-metadata";

export interface ACPA2ATaskMetadata {
  authRequired?: {
    authMethods: AuthMethod[];
    message?: string;
  };
  elicitation?: {
    request: CreateElicitationRequest;
  };
}

export interface ACPA2AContinuationMetadata {
  authenticate?: AuthenticateRequest;
  elicitationResponse?: CreateElicitationResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildACPA2ATaskMetadata(payload: ACPA2ATaskMetadata): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (payload.elicitation?.request.mode === "form" && "sessionId" in payload.elicitation.request) {
    metadata[ACP_ELICITATION_METADATA_KEY] = buildACPFormElicitationMetadata(
      payload.elicitation.request,
    );
  }

  if (payload.authRequired) {
    metadata[ACP_AUTH_REQUIRED_METADATA_KEY] = {
      kind: "acp.auth-required",
      ...(payload.authRequired.authMethods.length > 0
        ? { authMethods: payload.authRequired.authMethods }
        : {}),
      message:
        payload.authRequired.message ??
        "Authentication is required before the ACP task can continue.",
    };
  }

  return metadata;
}

export function buildACPA2AContinuationMetadata(
  payload: ACPA2AContinuationMetadata,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (payload.authenticate) {
    metadata[ACP_AUTH_REQUIRED_METADATA_KEY] = {
      kind: "acp.auth-required",
      ...(payload.authenticate.methodId ? { methodId: payload.authenticate.methodId } : {}),
    };
  }

  if (payload.elicitationResponse) {
    metadata[ACP_ELICITATION_RESPONSE_METADATA_KEY] = {
      kind: "acp.elicitation-response",
      action: payload.elicitationResponse.action,
      ...(payload.elicitationResponse.action === "accept" &&
      "content" in payload.elicitationResponse &&
      payload.elicitationResponse.content
        ? { content: payload.elicitationResponse.content }
        : {}),
    };
  }

  return metadata;
}

export function extractACPA2AContinuationMetadata(
  metadata: unknown,
): ACPA2AContinuationMetadata | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const continuation: ACPA2AContinuationMetadata = {};
  const auth = metadata[ACP_AUTH_REQUIRED_METADATA_KEY];
  if (isRecord(auth) && typeof auth.methodId === "string") {
    continuation.authenticate = {
      methodId: auth.methodId,
    };
  }

  const elicitation = metadata[ACP_ELICITATION_RESPONSE_METADATA_KEY];
  if (isACPElicitationResponseMetadata(elicitation)) {
    continuation.elicitationResponse =
      elicitation.action === "accept"
        ? {
            action: "accept",
            ...(elicitation.content ? { content: elicitation.content } : {}),
          }
        : { action: elicitation.action };
  }

  return continuation.authenticate || continuation.elicitationResponse ? continuation : undefined;
}
