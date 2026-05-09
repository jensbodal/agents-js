import { z } from "zod";
import { ValidationError } from "./errors.ts";
import { resolveValidationMode, type ValidationMode, type ValidationOptions } from "./modes.ts";
import { toValidationIssues, zodObjectWithMode } from "./zod-utils.ts";

const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

function buildJsonRpcRequestSchema(mode: ValidationMode) {
  return zodObjectWithMode(
    {
      jsonrpc: z.literal("2.0"),
      id: jsonRpcIdSchema.optional(),
      method: z.string().min(1),
      params: z.unknown().optional(),
    },
    mode,
  );
}

function buildJsonRpcResponseSchema(mode: ValidationMode) {
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
      id: jsonRpcIdSchema,
      result: z.unknown().optional(),
      error: errorSchema.optional(),
    },
    mode,
  ).superRefine((value, context) => {
    const hasResult = value.result !== undefined;
    const hasError = value.error !== undefined;

    if (hasResult === hasError) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Response must include exactly one of "result" or "error"',
        path: ["result"],
      });
    }
  });
}

const jsonRpcRequestSchemaCache = new Map<
  ValidationMode,
  ReturnType<typeof buildJsonRpcRequestSchema>
>();
const jsonRpcResponseSchemaCache = new Map<
  ValidationMode,
  ReturnType<typeof buildJsonRpcResponseSchema>
>();

function getJsonRpcRequestSchema(mode: ValidationMode) {
  let schema = jsonRpcRequestSchemaCache.get(mode);
  if (!schema) {
    schema = buildJsonRpcRequestSchema(mode);
    jsonRpcRequestSchemaCache.set(mode, schema);
  }

  return schema;
}

function getJsonRpcResponseSchema(mode: ValidationMode) {
  let schema = jsonRpcResponseSchemaCache.get(mode);
  if (!schema) {
    schema = buildJsonRpcResponseSchema(mode);
    jsonRpcResponseSchemaCache.set(mode, schema);
  }

  return schema;
}

/** JSON-RPC 2.0 request envelope */
export const jsonRpcRequestSchema = getJsonRpcRequestSchema("strict");

/** JSON-RPC 2.0 response envelope */
export const jsonRpcResponseSchema = getJsonRpcResponseSchema("strict");

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcResponse = z.infer<typeof jsonRpcResponseSchema>;

export function validateJsonRpcEnvelope(
  input: unknown,
  kind: "request" | "response",
  options: ValidationOptions = {},
): JsonRpcRequest | JsonRpcResponse {
  const mode = resolveValidationMode(options);
  const result =
    kind === "request"
      ? getJsonRpcRequestSchema(mode).safeParse(input)
      : getJsonRpcResponseSchema(mode).safeParse(input);

  if (!result.success) {
    throw new ValidationError(`Invalid JSON-RPC ${kind} envelope`, {
      field: "jsonrpc",
      value: input,
      issues: toValidationIssues(result.error),
      jsonRpcCode: kind === "request" ? -32600 : undefined,
    });
  }

  return result.data;
}
