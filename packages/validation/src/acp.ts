import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type { AnySchemaObject } from "ajv";
import { z } from "zod";
import { ValidationError } from "./errors.ts";
import {
  type ACPGeneratedMethodSchemaInfo,
  acpGeneratedSchemaArtifacts,
} from "./generated/acp-schema.ts";
import { type JsonSchemaValidationArtifacts, validateJsonSchemaArtifacts } from "./json-schema.ts";
import { resolveValidationMode, type ValidationMode, type ValidationOptions } from "./modes.ts";
import { toValidationIssues, zodObjectWithMode } from "./zod-utils.ts";

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

const acpMethodWhitelist = [
  ...Object.values(AGENT_METHODS),
  ...Object.values(CLIENT_METHODS),
].sort() as ACPMethod[];
const acpMethodWhitelistSet = new Set<ACPMethod>(acpMethodWhitelist);

type JsonRpcId = string | number | null;

type ACPGeneratedSchemaDocument = {
  $schema?: string;
  $defs: Record<string, AnySchemaObject>;
};

type ACPMethodSchemaInfo = Omit<ACPGeneratedMethodSchemaInfo, "method"> & { method: ACPMethod };

export type ACPMethod =
  | (typeof AGENT_METHODS)[keyof typeof AGENT_METHODS]
  | (typeof CLIENT_METHODS)[keyof typeof CLIENT_METHODS];

export interface ACPErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface ACPRequestLikeEnvelope {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface ACPRequestEnvelope {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: ACPMethod;
  params?: unknown;
}

export interface ACPResponseEnvelope {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: ACPErrorObject;
}

export type ACPEnvelope = ACPRequestLikeEnvelope | ACPResponseEnvelope;

export interface ACPResponseValidationOptions extends ValidationOptions {
  method: ACPMethod;
}

const strictDocument = acpGeneratedSchemaArtifacts.strictDocument as ACPGeneratedSchemaDocument;
const looseDocument = acpGeneratedSchemaArtifacts.looseDocument as ACPGeneratedSchemaDocument;

function buildACPEnvelopeSchema(mode: ValidationMode) {
  const errorSchema = zodObjectWithMode(
    {
      code: z.number(),
      message: z.string(),
      data: z.unknown().optional(),
    },
    mode,
  );

  return zodObjectWithMode(
    {
      jsonrpc: z.literal("2.0"),
      id: jsonRpcIdSchema.optional(),
      method: z.string().optional(),
      params: z.unknown().optional(),
      result: z.unknown().optional(),
      error: errorSchema.optional(),
    },
    mode,
  ).superRefine((value, context) => {
    const hasMethod = value.method !== undefined;
    const hasResult = value.result !== undefined;
    const hasError = value.error !== undefined;

    if (!hasMethod && !hasResult && !hasError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: 'ACP envelope must contain either "method" or response fields',
      });
      return;
    }

    if (hasMethod && (hasResult || hasError)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["method"],
        message: "ACP envelope cannot include both request and response fields",
      });
    }

    if (!hasMethod && value.id === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "ACP response envelopes must include id",
      });
    }

    if (hasResult === hasError && !hasMethod) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: 'ACP response envelopes must include exactly one of "result" or "error"',
      });
    }
  });
}

const acpEnvelopeSchemaCache = new Map<ValidationMode, ReturnType<typeof buildACPEnvelopeSchema>>();

function getACPEnvelopeSchema(mode: ValidationMode) {
  let schema = acpEnvelopeSchemaCache.get(mode);
  if (!schema) {
    schema = buildACPEnvelopeSchema(mode);
    acpEnvelopeSchemaCache.set(mode, schema);
  }

  return schema;
}

function toSchemaInfoMap(
  entries: Record<string, ACPGeneratedMethodSchemaInfo>,
): Map<ACPMethod, ACPMethodSchemaInfo> {
  return new Map(
    Object.values(entries).map((info) => [
      info.method as ACPMethod,
      {
        ...info,
        method: info.method as ACPMethod,
      },
    ]),
  );
}

/**
 * Method-keyed registry of ACP request and notification schemas. Built from
 * the generated `acpGeneratedSchemaArtifacts.requestSchemas` Record so the
 * keys stay locked to the ACP method whitelist.
 */
const acpRequestSchemas = toSchemaInfoMap(acpGeneratedSchemaArtifacts.requestSchemas);
/**
 * Method-keyed registry of ACP response schemas. Built from the generated
 * `acpGeneratedSchemaArtifacts.responseSchemas` Record so each method's
 * response shape is validated against the same SDK definition the request
 * was paired with.
 */
const acpResponseSchemas = toSchemaInfoMap(acpGeneratedSchemaArtifacts.responseSchemas);
const acpSchemaArtifactsCache = new Map<string, JsonSchemaValidationArtifacts>();

export const ACP_METHOD_WHITELIST = Object.freeze([...acpMethodWhitelist]) as readonly ACPMethod[];

function createDefinitionWrapper(
  document: ACPGeneratedSchemaDocument,
  definitionName: string,
): AnySchemaObject {
  return {
    $schema: document.$schema,
    $ref: `#/$defs/${definitionName}`,
    $defs: document.$defs,
  };
}

function getACPMethodSchemaArtifacts(definitionName: string): JsonSchemaValidationArtifacts {
  const cached = acpSchemaArtifactsCache.get(definitionName);
  if (cached) {
    return cached;
  }

  const artifacts: JsonSchemaValidationArtifacts = {
    looseSchema: createDefinitionWrapper(looseDocument, definitionName),
    strictSchema: createDefinitionWrapper(strictDocument, definitionName),
  };
  acpSchemaArtifactsCache.set(definitionName, artifacts);
  return artifacts;
}

function validateACPEnvelopeShape(input: unknown, options: ValidationOptions = {}): ACPEnvelope {
  const mode = resolveValidationMode(options);
  const parsed = getACPEnvelopeSchema(mode).safeParse(input);

  if (!parsed.success) {
    throw new ValidationError("Invalid ACP envelope", {
      field: "jsonrpc",
      value: input,
      issues: toValidationIssues(parsed.error),
      jsonRpcCode: -32600,
    });
  }

  return parsed.data as ACPEnvelope;
}

function makeProtocolError(
  message: string,
  path: string,
  value: unknown,
  jsonRpcCode?: -32600 | -32602,
): never {
  throw new ValidationError(message, {
    field: path,
    value,
    issues: [{ path, message }],
    jsonRpcCode,
  });
}

function normalizeACPRequestParams(
  params: unknown,
  paramsWasOmitted: boolean,
  info: ACPMethodSchemaInfo,
): unknown {
  if (paramsWasOmitted && info.allowsEmptyObject) {
    return {};
  }

  return params;
}

export function validateACPEnvelope(input: unknown, options: ValidationOptions = {}): ACPEnvelope {
  return validateACPEnvelopeShape(input, options);
}

export function validateACPMethod(input: unknown): ACPMethod {
  const method =
    typeof input === "string"
      ? input
      : typeof input === "object" && input !== null && "method" in input
        ? (input as { method?: unknown }).method
        : undefined;

  if (typeof method !== "string" || method.length === 0) {
    throw new ValidationError("ACP method must be a non-empty string", {
      field: "method",
      value: method,
      issues: [{ path: "method", message: "Missing or invalid method" }],
      jsonRpcCode: -32600,
    });
  }

  if (!acpMethodWhitelistSet.has(method as ACPMethod)) {
    throw new ValidationError(`Unsupported ACP method: ${method}`, {
      field: "method",
      value: method,
      issues: [
        {
          path: "method",
          message: "Method is not part of the ACP method whitelist",
        },
      ],
      jsonRpcCode: -32600,
    });
  }

  return method as ACPMethod;
}

export function validateACPRequest(
  input: unknown,
  options: ValidationOptions = {},
): ACPRequestEnvelope {
  const mode = resolveValidationMode(options);
  const envelope = validateACPEnvelopeShape(input, options);
  if (!("method" in envelope)) {
    makeProtocolError("ACP request envelopes must include method", "method", input, -32600);
  }

  const method = validateACPMethod(envelope.method);
  const schemaInfo = acpRequestSchemas.get(method);
  if (!schemaInfo) {
    throw new Error(`Missing ACP request schema for method: ${method}`);
  }

  if (schemaInfo.kind === "notification") {
    if (envelope.id !== undefined) {
      makeProtocolError(
        `ACP notification ${method} must not include id`,
        "id",
        envelope.id,
        -32600,
      );
    }
  } else if (envelope.id === undefined) {
    makeProtocolError(`ACP request ${method} must include id`, "id", envelope.id, -32600);
  }

  const paramsWasOmitted = !Object.hasOwn(envelope, "params");
  const params = validateJsonSchemaArtifacts<unknown>(
    normalizeACPRequestParams(envelope.params, paramsWasOmitted, schemaInfo),
    getACPMethodSchemaArtifacts(schemaInfo.definitionName),
    {
      draft: "2020",
      field: "params",
      message: `Invalid ACP ${method} params`,
      jsonRpcCode: -32602,
      mode,
    },
  );

  return {
    ...envelope,
    method,
    params,
  };
}

export function validateACPResponse(
  input: unknown,
  options: ACPResponseValidationOptions,
): ACPResponseEnvelope {
  const mode = resolveValidationMode(options);
  const envelope = validateACPEnvelopeShape(input, options);
  if ("method" in envelope) {
    makeProtocolError(
      "ACP response envelopes must not include method",
      "method",
      envelope.method,
      -32600,
    );
  }

  const method = validateACPMethod(options.method);
  const requestSchema = acpRequestSchemas.get(method);
  if (!requestSchema) {
    throw new Error(`Missing ACP request schema for method: ${method}`);
  }

  if (requestSchema.kind === "notification") {
    makeProtocolError(
      `ACP notification ${method} does not produce a response`,
      "method",
      method,
      -32600,
    );
  }

  if (envelope.error !== undefined) {
    return envelope;
  }

  const responseSchema = acpResponseSchemas.get(method);
  if (!responseSchema) {
    throw new Error(`Missing ACP response schema for method: ${method}`);
  }

  const result = validateJsonSchemaArtifacts<unknown>(
    envelope.result,
    getACPMethodSchemaArtifacts(responseSchema.definitionName),
    {
      draft: "2020",
      field: "result",
      message: `Invalid ACP ${method} response result`,
      mode,
    },
  );

  return {
    ...envelope,
    result,
  };
}
