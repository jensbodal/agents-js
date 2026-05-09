import type { AnySchemaObject } from "ajv";
import { ValidationError } from "./errors.ts";
import { cloneValidationValue, validateJsonSchema } from "./json-schema.ts";
import type { ValidationOptions } from "./modes.ts";

const freeformObjectSchema = {
  type: "object",
  additionalProperties: true,
} as const satisfies AnySchemaObject;

const genericRuntimeManifestSchema = {
  type: "object",
  required: ["name", "version"],
  properties: {
    name: { type: "string", minLength: 1 },
    version: { type: "string", minLength: 1 },
    description: { type: "string" },
    runtime: { type: "string" },
    metadata: freeformObjectSchema,
    agentCard: freeformObjectSchema,
  },
} as const satisfies AnySchemaObject;

export type RuntimeManifestValidator = (
  input: unknown,
  options?: ValidationOptions,
) => unknown | undefined;

const runtimeValidators = new Map<string, RuntimeManifestValidator>();

function validateRuntimeId(runtimeId: string): string {
  const normalized = runtimeId.trim();
  if (normalized.length === 0) {
    throw new ValidationError("runtimeId must be a non-empty string", {
      field: "runtimeId",
      value: runtimeId,
      issues: [{ path: "runtimeId", message: "runtimeId cannot be empty" }],
    });
  }

  return normalized;
}

export function registerRuntimeValidator(
  runtimeId: string,
  validator: RuntimeManifestValidator,
): void {
  const key = validateRuntimeId(runtimeId);
  runtimeValidators.set(key, validator);
}

export function validateRuntimeManifest(
  input: unknown,
  runtimeId: string,
  options: ValidationOptions = {},
): unknown {
  const key = validateRuntimeId(runtimeId);

  const registeredValidator = runtimeValidators.get(key);
  if (registeredValidator) {
    const clonedInput = cloneValidationValue(input);
    const validated = registeredValidator(clonedInput, options);
    return validated === undefined ? clonedInput : validated;
  }

  return validateJsonSchema<unknown>(input, genericRuntimeManifestSchema, {
    ...options,
    field: "runtimeManifest",
    message: "Invalid runtime manifest",
  });
}

export function resetRuntimeValidatorsForTest(): void {
  runtimeValidators.clear();
}
