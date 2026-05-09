import type {
  ACPAuthRequiredMetadata,
  ACPFormElicitationMetadata,
} from "@agents-js/validation/a2a-metadata";
import {
  ACP_AUTH_REQUIRED_METADATA_KEY,
  ACP_ELICITATION_METADATA_KEY,
  ACP_ELICITATION_RESPONSE_METADATA_KEY,
  isACPAuthRequiredMetadata,
  isACPFormElicitationMetadata,
} from "@agents-js/validation/a2a-metadata";
import type {
  A2AAuthRequiredState,
  ACPA2AElicitation,
  ACPA2AElicitationResponse,
} from "./types.ts";

export const ACP_A2A_AUTH_REQUIRED_METADATA_KEY = ACP_AUTH_REQUIRED_METADATA_KEY;
export const ACP_A2A_ELICITATION_METADATA_KEY = ACP_ELICITATION_METADATA_KEY;
export const ACP_A2A_ELICITATION_RESPONSE_METADATA_KEY = ACP_ELICITATION_RESPONSE_METADATA_KEY;

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : undefined;
}

export function extractAcpElicitationMetadata(
  metadata: Record<string, unknown> | undefined,
): ACPA2AElicitation | undefined {
  const candidate = metadata?.[ACP_ELICITATION_METADATA_KEY];
  if (!isACPFormElicitationMetadata(candidate)) {
    return undefined;
  }
  const raw: ACPFormElicitationMetadata = candidate;

  const requestedSchema = asRecord(raw.requestedSchema);
  const properties = requestedSchema?.properties
    ? Object.fromEntries(
        Object.entries(requestedSchema.properties).flatMap(([key, value]) => {
          const property = asRecord(value);
          return property ? [[key, property]] : [];
        }),
      )
    : undefined;
  const required =
    Array.isArray(requestedSchema?.required) &&
    requestedSchema.required.every((value) => typeof value === "string")
      ? (requestedSchema.required as string[])
      : undefined;

  return {
    mode: "form",
    message: raw.message,
    metadata,
    requestedSchema: {
      title: typeof requestedSchema?.title === "string" ? requestedSchema.title : null,
      description:
        typeof requestedSchema?.description === "string" ? requestedSchema.description : null,
      properties,
      required,
    },
    sessionId: raw.sessionId,
  };
}

export function extractAcpAuthRequiredMetadata(
  metadata: Record<string, unknown> | undefined,
): A2AAuthRequiredState | undefined {
  const candidate = metadata?.[ACP_AUTH_REQUIRED_METADATA_KEY];
  if (!isACPAuthRequiredMetadata(candidate)) {
    return undefined;
  }
  const raw: ACPAuthRequiredMetadata = candidate;

  return {
    authMethods: Array.isArray(raw.authMethods)
      ? raw.authMethods.flatMap((value) => {
          if (
            typeof value !== "object" ||
            value === null ||
            typeof (value as { id?: unknown }).id !== "string"
          ) {
            return [];
          }

          const candidate = value as {
            id: string;
            name?: unknown;
            link?: unknown;
            description?: unknown;
          };
          // Plumb through the optional human-presentable fields when present
          // and well-typed. `link` is only populated by env-var-style ACP
          // auth methods; the agent/terminal variants don't carry a URL,
          // so consumers must render an open/copy action conditional on
          // `link !== undefined`.
          return [
            {
              id: candidate.id,
              ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
              ...(typeof candidate.link === "string" ? { link: candidate.link } : {}),
              ...(typeof candidate.description === "string"
                ? { description: candidate.description }
                : {}),
            },
          ];
        })
      : undefined,
    message: raw.message,
    metadata: raw as unknown as Record<string, unknown>,
  };
}

export function buildAcpElicitationResponseMetadata(
  response: ACPA2AElicitationResponse,
): Record<string, unknown> {
  return {
    [ACP_ELICITATION_RESPONSE_METADATA_KEY]: {
      kind: "acp.elicitation-response",
      action: response.action,
      ...(response.action === "accept" && response.content ? { content: response.content } : {}),
    },
  };
}
