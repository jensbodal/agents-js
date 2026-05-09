import type { AgentCard } from "@a2a-js/sdk";
import type { AnySchemaObject } from "ajv";
import { type JsonRpcRequest, type JsonRpcResponse, validateJsonRpcEnvelope } from "./json-rpc.ts";
import { validateJsonSchema } from "./json-schema.ts";
import type { ValidationOptions } from "./modes.ts";

const freeformObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const satisfies AnySchemaObject;

const jsonRpcIdSchema = {
  anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
} as const satisfies AnySchemaObject;

const textPartSchema = {
  type: "object",
  required: ["kind", "text"],
  properties: {
    kind: { const: "text" },
    text: { type: "string" },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const fileWithBytesSchema = {
  type: "object",
  required: ["bytes"],
  properties: {
    bytes: { type: "string" },
    mimeType: { type: "string" },
    name: { type: "string" },
  },
} as const satisfies AnySchemaObject;

const fileWithUriSchema = {
  type: "object",
  required: ["uri"],
  properties: {
    uri: { type: "string", minLength: 1 },
    mimeType: { type: "string" },
    name: { type: "string" },
  },
} as const satisfies AnySchemaObject;

const filePartSchema = {
  type: "object",
  required: ["kind", "file"],
  properties: {
    kind: { const: "file" },
    file: {
      oneOf: [fileWithBytesSchema, fileWithUriSchema],
    },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const dataPartSchema = {
  type: "object",
  required: ["kind", "data"],
  properties: {
    kind: { const: "data" },
    data: freeformObjectSchema,
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const partSchema = {
  oneOf: [textPartSchema, filePartSchema, dataPartSchema],
} as const satisfies AnySchemaObject;

const requestMessageSchema = {
  type: "object",
  required: ["messageId", "role", "parts"],
  properties: {
    kind: { const: "message" },
    messageId: { type: "string", minLength: 1 },
    role: { enum: ["user", "agent"] },
    parts: {
      type: "array",
      minItems: 1,
      items: partSchema,
    },
    taskId: { type: "string" },
    contextId: { type: "string" },
    referenceTaskIds: { type: "array", items: { type: "string" } },
    metadata: freeformObjectSchema,
    extensions: { type: "array", items: { type: "string" } },
  },
} as const satisfies AnySchemaObject;

const responseMessageSchema = {
  type: "object",
  required: ["kind", "role", "parts"],
  properties: {
    kind: { const: "message" },
    messageId: { type: "string", minLength: 1 },
    role: { enum: ["user", "agent"] },
    parts: {
      type: "array",
      minItems: 1,
      items: partSchema,
    },
    taskId: { type: "string" },
    contextId: { type: "string" },
    referenceTaskIds: { type: "array", items: { type: "string" } },
    metadata: freeformObjectSchema,
    extensions: { type: "array", items: { type: "string" } },
  },
} as const satisfies AnySchemaObject;

const pushNotificationConfigSchema = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", minLength: 1, pattern: "^https?://" },
    id: { type: "string" },
    token: { type: "string" },
    authentication: {
      type: "object",
      required: ["schemes"],
      properties: {
        credentials: { type: "string" },
        schemes: { type: "array", items: { type: "string" }, minItems: 1 },
      },
    },
  },
} as const satisfies AnySchemaObject;

const messageSendParamsSchema = {
  type: "object",
  required: ["message"],
  properties: {
    message: requestMessageSchema,
    configuration: {
      type: "object",
      properties: {
        acceptedOutputModes: { type: "array", items: { type: "string" } },
        blocking: { type: "boolean" },
        historyLength: { type: "integer", minimum: 0 },
        pushNotificationConfig: pushNotificationConfigSchema,
      },
    },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const messageSendRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "message/send" },
    params: messageSendParamsSchema,
  },
} as const satisfies AnySchemaObject;

const messageStreamRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "message/stream" },
    params: messageSendParamsSchema,
  },
} as const satisfies AnySchemaObject;

const taskStatusSchema = {
  type: "object",
  required: ["state"],
  properties: {
    state: {
      enum: [
        "submitted",
        "working",
        "input-required",
        "completed",
        "canceled",
        "failed",
        "rejected",
        "auth-required",
        "unknown",
      ],
    },
    timestamp: { type: "string" },
    message: responseMessageSchema,
  },
} as const satisfies AnySchemaObject;

const artifactSchema = {
  type: "object",
  required: ["artifactId", "parts"],
  properties: {
    artifactId: { type: "string", minLength: 1 },
    name: { type: "string" },
    description: { type: "string" },
    parts: {
      type: "array",
      minItems: 1,
      items: partSchema,
    },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const taskSchema = {
  type: "object",
  required: ["kind", "id", "contextId", "status"],
  properties: {
    kind: { const: "task" },
    id: { type: "string", minLength: 1 },
    contextId: { type: "string", minLength: 1 },
    status: taskStatusSchema,
    history: { type: "array", items: responseMessageSchema },
    artifacts: { type: "array", items: artifactSchema },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const taskStatusUpdateEventSchema = {
  type: "object",
  required: ["kind", "taskId", "contextId", "status", "final"],
  properties: {
    kind: { const: "status-update" },
    taskId: { type: "string", minLength: 1 },
    contextId: { type: "string", minLength: 1 },
    status: taskStatusSchema,
    final: { type: "boolean" },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const taskArtifactUpdateEventSchema = {
  type: "object",
  required: ["kind", "taskId", "contextId", "artifact"],
  properties: {
    kind: { const: "artifact-update" },
    taskId: { type: "string", minLength: 1 },
    contextId: { type: "string", minLength: 1 },
    artifact: artifactSchema,
    append: { type: "boolean" },
    lastChunk: { type: "boolean" },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const messageSendResultSchema = {
  oneOf: [responseMessageSchema, taskSchema],
} as const satisfies AnySchemaObject;

const streamEventResultSchema = {
  oneOf: [
    responseMessageSchema,
    taskSchema,
    taskStatusUpdateEventSchema,
    taskArtifactUpdateEventSchema,
  ],
} as const satisfies AnySchemaObject;

const taskIdParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
  },
} as const satisfies AnySchemaObject;

const tasksResubscribeRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "tasks/resubscribe" },
    params: taskIdParamsSchema,
  },
} as const satisfies AnySchemaObject;

const taskQueryParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
    historyLength: { type: "integer", minimum: 0 },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const tasksGetRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "tasks/get" },
    params: taskQueryParamsSchema,
  },
} as const satisfies AnySchemaObject;

const tasksCancelRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "tasks/cancel" },
    params: taskIdParamsSchema,
  },
} as const satisfies AnySchemaObject;

const authenticatedExtendedCardRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "agent/getAuthenticatedExtendedCard" },
    params: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const taskPushNotificationConfigSetParamsSchema = {
  type: "object",
  required: ["taskId", "pushNotificationConfig"],
  properties: {
    taskId: { type: "string", minLength: 1 },
    pushNotificationConfig: pushNotificationConfigSchema,
  },
} as const satisfies AnySchemaObject;

const pushNotificationConfigSetRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "tasks/pushNotificationConfig/set" },
    params: taskPushNotificationConfigSetParamsSchema,
  },
} as const satisfies AnySchemaObject;

const pushNotificationConfigGetParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
    pushNotificationConfigId: { type: "string" },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const pushNotificationConfigGetRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "tasks/pushNotificationConfig/get" },
    params: pushNotificationConfigGetParamsSchema,
  },
} as const satisfies AnySchemaObject;

const pushNotificationConfigListParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1 },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const pushNotificationConfigListRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "tasks/pushNotificationConfig/list" },
    params: pushNotificationConfigListParamsSchema,
  },
} as const satisfies AnySchemaObject;

const pushNotificationConfigDeleteParamsSchema = {
  type: "object",
  required: ["id", "pushNotificationConfigId"],
  properties: {
    id: { type: "string", minLength: 1 },
    pushNotificationConfigId: { type: "string", minLength: 1 },
    metadata: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

const pushNotificationConfigDeleteRequestSchema = {
  type: "object",
  required: ["jsonrpc", "method", "params"],
  properties: {
    jsonrpc: { const: "2.0" },
    id: jsonRpcIdSchema,
    method: { const: "tasks/pushNotificationConfig/delete" },
    params: pushNotificationConfigDeleteParamsSchema,
  },
} as const satisfies AnySchemaObject;

const skillSchema = {
  type: "object",
  required: ["id", "name", "description"],
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
  },
} as const satisfies AnySchemaObject;

const agentCardSchema = {
  type: "object",
  required: [
    "name",
    "description",
    "url",
    "version",
    "protocolVersion",
    "skills",
    "defaultInputModes",
    "defaultOutputModes",
    "capabilities",
  ],
  properties: {
    name: { type: "string", minLength: 1 },
    description: { type: "string", minLength: 1 },
    url: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    protocolVersion: { type: "string", minLength: 1 },
    skills: { type: "array", items: skillSchema },
    defaultInputModes: { type: "array", items: { type: "string" } },
    defaultOutputModes: { type: "array", items: { type: "string" } },
    capabilities: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

export function validateA2ARequest(
  input: unknown,
  options: ValidationOptions = {},
): JsonRpcRequest {
  const request = validateJsonRpcEnvelope(input, "request", options) as JsonRpcRequest;

  if (request.method === "message/send") {
    return validateJsonSchema<JsonRpcRequest>(request, messageSendRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A message/send request",
    });
  }

  if (request.method === "message/stream") {
    return validateJsonSchema<JsonRpcRequest>(request, messageStreamRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A message/stream request",
    });
  }

  if (request.method === "tasks/get") {
    return validateJsonSchema<JsonRpcRequest>(request, tasksGetRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A tasks/get request",
    });
  }

  if (request.method === "tasks/cancel") {
    return validateJsonSchema<JsonRpcRequest>(request, tasksCancelRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A tasks/cancel request",
    });
  }

  if (request.method === "tasks/resubscribe") {
    return validateJsonSchema<JsonRpcRequest>(request, tasksResubscribeRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A tasks/resubscribe request",
    });
  }

  if (request.method === "agent/getAuthenticatedExtendedCard") {
    return validateJsonSchema<JsonRpcRequest>(request, authenticatedExtendedCardRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A agent/getAuthenticatedExtendedCard request",
    });
  }

  if (request.method === "tasks/pushNotificationConfig/set") {
    return validateJsonSchema<JsonRpcRequest>(request, pushNotificationConfigSetRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A tasks/pushNotificationConfig/set request",
    });
  }

  if (request.method === "tasks/pushNotificationConfig/get") {
    return validateJsonSchema<JsonRpcRequest>(request, pushNotificationConfigGetRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A tasks/pushNotificationConfig/get request",
    });
  }

  if (request.method === "tasks/pushNotificationConfig/list") {
    return validateJsonSchema<JsonRpcRequest>(request, pushNotificationConfigListRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A tasks/pushNotificationConfig/list request",
    });
  }

  if (request.method === "tasks/pushNotificationConfig/delete") {
    return validateJsonSchema<JsonRpcRequest>(request, pushNotificationConfigDeleteRequestSchema, {
      ...options,
      formats: true,
      field: "params",
      jsonRpcCode: -32602,
      message: "Invalid A2A tasks/pushNotificationConfig/delete request",
    });
  }

  return request;
}

export function validateA2AResponse(
  input: unknown,
  options: ValidationOptions = {},
): JsonRpcResponse {
  const response = validateJsonRpcEnvelope(input, "response", options) as JsonRpcResponse;

  if (response.error !== undefined) {
    return response;
  }

  const result = response.result;
  if (typeof result === "object" && result !== null && "kind" in result) {
    const validatedResult = validateJsonSchema<unknown>(result, streamEventResultSchema, {
      ...options,
      formats: true,
      field: "result",
      message: "Invalid A2A response result",
    });

    return {
      ...response,
      result: validatedResult,
    };
  }

  return response;
}

export function validateAgentCard(input: unknown, options: ValidationOptions = {}): AgentCard {
  return validateJsonSchema<AgentCard>(input, agentCardSchema, {
    ...options,
    formats: true,
    field: "agentCard",
    message: "Invalid AgentCard",
  });
}

export function validateA2AMessageSendResponseResult(
  input: unknown,
  options: ValidationOptions = {},
): unknown {
  return validateJsonSchema<unknown>(input, messageSendResultSchema, {
    ...options,
    formats: true,
    field: "result",
    message: "Invalid A2A message/send result",
  });
}

/**
 * Server-side bridge of A2A request and result schemas. Each entry is the
 * imported AJV schema or zod schema constant the gateway dispatches against
 * for one of the user-facing A2A methods (`message/send`, `message/stream`,
 * `tasks/*`, push-notification config CRUD, authenticated extended card,
 * stream events). The keys are the export names of the schemas themselves;
 * dispatch happens by switching on JSON-RPC `method` rather than by a
 * Map lookup, so the registry's only role is to be the canonical "what the
 * server can validate" list.
 */
export const a2aValidationSchemas = {
  messageSendRequestSchema,
  messageStreamRequestSchema,
  tasksGetRequestSchema,
  tasksCancelRequestSchema,
  tasksResubscribeRequestSchema,
  authenticatedExtendedCardRequestSchema,
  pushNotificationConfigSetRequestSchema,
  pushNotificationConfigGetRequestSchema,
  pushNotificationConfigListRequestSchema,
  pushNotificationConfigDeleteRequestSchema,
  messageSendResultSchema,
  streamEventResultSchema,
  agentCardSchema,
};
