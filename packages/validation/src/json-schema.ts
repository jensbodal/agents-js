import Ajv, { type AnySchemaObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidationErrorOptions } from "./errors.ts";
import { ValidationError } from "./errors.ts";
import { resolveValidationMode, type ValidationMode, type ValidationOptions } from "./modes.ts";

type SchemaDraft = "default" | "2020";
type SchemaMode = "mode" | "original";
type StrictnessMode = Exclude<ValidationMode, "filter">;

export interface JsonSchemaValidationOptions extends ValidationOptions {
  draft?: SchemaDraft;
  formats?: boolean;
  field: string;
  message: string;
  jsonRpcCode?: -32600 | -32602;
  schemaMode?: SchemaMode;
}

export interface JsonSchemaValidationArtifacts {
  looseSchema: AnySchemaObject;
  strictSchema: AnySchemaObject;
}

const strictifiedSchemaCache = new WeakMap<object, AnySchemaObject>();
const loosenedSchemaCache = new WeakMap<object, AnySchemaObject>();
const validatorCache = new WeakMap<object, Map<string, ValidateFunction>>();

function isFiniteSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value);
}

function cloneJsonLikeValue<T>(value: T): T {
  const clone = (
    globalThis as {
      structuredClone?: <U>(value: U) => U;
    }
  ).structuredClone;

  if (typeof clone === "function") {
    return clone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function registerACPNumericFormats(ajv: Ajv | Ajv2020): void {
  ajv.addFormat("uint16", {
    type: "number",
    validate: (value) => isFiniteSafeInteger(value) && value >= 0 && value <= 65_535,
  });
  ajv.addFormat("uint32", {
    type: "number",
    validate: (value) => isFiniteSafeInteger(value) && value >= 0 && value <= 4_294_967_295,
  });
  ajv.addFormat("uint64", {
    type: "number",
    validate: (value) => isFiniteSafeInteger(value) && value >= 0,
  });
  ajv.addFormat("int64", {
    type: "number",
    validate: isFiniteSafeInteger,
  });
  ajv.addFormat("double", {
    type: "number",
    validate: (value) => typeof value === "number" && Number.isFinite(value),
  });
}

export function cloneValidationValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  return cloneJsonLikeValue(value);
}

function isObjectSchemaNode(node: Record<string, unknown>): boolean {
  return hasDirectObjectShape(node) || hasComposedObjectConstraints(node);
}

function hasComposedObjectConstraints(node: Record<string, unknown>): boolean {
  return "oneOf" in node || "anyOf" in node || "allOf" in node;
}

function hasDirectObjectShape(node: Record<string, unknown>): boolean {
  const type = node.type;
  return (
    type === "object" ||
    (Array.isArray(type) && type.includes("object")) ||
    "properties" in node ||
    "patternProperties" in node ||
    "required" in node ||
    "additionalProperties" in node ||
    "unevaluatedProperties" in node
  );
}

function visitSchemaNode(node: unknown, mode: StrictnessMode, inCombinatorChild: boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      visitSchemaNode(item, mode, false);
    }
    return;
  }

  if (node === null || typeof node !== "object") {
    return;
  }

  const schema = node as Record<string, unknown>;

  for (const [key, value] of Object.entries(schema)) {
    const nextInCombinatorChild = key === "oneOf" || key === "anyOf" || key === "allOf";

    if (Array.isArray(value)) {
      for (const item of value) {
        visitSchemaNode(item, mode, nextInCombinatorChild);
      }
      continue;
    }

    visitSchemaNode(value, mode, false);
  }

  if (!isObjectSchemaNode(schema)) {
    return;
  }

  if (mode === "strict") {
    if (schema.additionalProperties !== undefined || schema.unevaluatedProperties !== undefined) {
      return;
    }

    if (inCombinatorChild) {
      if (hasComposedObjectConstraints(schema)) {
        schema.unevaluatedProperties = false;
      }
      return;
    }

    if (hasComposedObjectConstraints(schema)) {
      if (hasDirectObjectShape(schema)) {
        schema.unevaluatedProperties = false;
      }
      return;
    }

    schema.additionalProperties = false;
    return;
  }

  if (schema.additionalProperties === false) {
    schema.additionalProperties = true;
  }

  if (schema.unevaluatedProperties === false) {
    schema.unevaluatedProperties = true;
  }
}

function transformSchemaForMode(
  schema: AnySchemaObject,
  mode: ValidationMode,
  schemaMode: SchemaMode,
): AnySchemaObject {
  if (schemaMode === "original") {
    return schema;
  }

  if (mode === "filter") {
    const cached = strictifiedSchemaCache.get(schema);
    if (cached) {
      return cached;
    }

    const cloned = cloneJsonLikeValue(schema);
    visitSchemaNode(cloned, "strict", false);
    strictifiedSchemaCache.set(schema, cloned);
    return cloned;
  }

  if (mode === "strict") {
    const cached = strictifiedSchemaCache.get(schema);
    if (cached) {
      return cached;
    }

    const cloned = cloneJsonLikeValue(schema);
    visitSchemaNode(cloned, "strict", false);
    strictifiedSchemaCache.set(schema, cloned);
    return cloned;
  }

  const cached = loosenedSchemaCache.get(schema);
  if (cached) {
    return cached;
  }

  const cloned = cloneJsonLikeValue(schema);
  visitSchemaNode(cloned, "loose", false);
  loosenedSchemaCache.set(schema, cloned);
  return cloned;
}

function createAjvInstance(
  draft: SchemaDraft,
  _mode: ValidationMode,
  formats: boolean,
  _schemaMode: SchemaMode,
) {
  const options = {
    allErrors: true,
    discriminator: true,
    strict: false,
    removeAdditional: false,
  };

  const ajv = draft === "2020" ? new Ajv2020(options) : new Ajv(options);
  if (formats) {
    addFormats(ajv);
  }

  registerACPNumericFormats(ajv);

  return ajv;
}

interface AjvErrorLike {
  instancePath?: string;
  keyword?: string;
  params?: unknown;
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function getContainerAtInstancePath(
  value: unknown,
  instancePath: string,
): Record<string, unknown> | null {
  if (instancePath === "") {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  const segments = instancePath
    .split("/")
    .slice(1)
    .map((segment) => decodeJsonPointerSegment(segment));
  let current: unknown = value;

  for (const segment of segments) {
    if (Array.isArray(current)) {
      current = current[Number(segment)];
      continue;
    }

    if (typeof current !== "object" || current === null) {
      return null;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "object" && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : null;
}

function removeUnknownProperty(container: Record<string, unknown>, propertyName: string): boolean {
  if (!(propertyName in container)) {
    return false;
  }

  delete container[propertyName];
  return true;
}

function stripUnknownPropertiesFromAjvErrors(
  value: unknown,
  errors: ReadonlyArray<AjvErrorLike> | null | undefined,
): boolean {
  let mutated = false;

  for (const error of errors ?? []) {
    if (error.keyword !== "additionalProperties" && error.keyword !== "unevaluatedProperties") {
      continue;
    }

    const paramName =
      error.keyword === "additionalProperties" ? "additionalProperty" : "unevaluatedProperty";
    const propertyName =
      typeof error.params === "object" &&
      error.params !== null &&
      paramName in error.params &&
      typeof (error.params as Record<string, unknown>)[paramName] === "string"
        ? ((error.params as Record<string, unknown>)[paramName] as string)
        : undefined;

    if (!propertyName) {
      continue;
    }

    const container = getContainerAtInstancePath(value, error.instancePath ?? "");
    if (container && removeUnknownProperty(container, propertyName)) {
      mutated = true;
    }
  }

  return mutated;
}

function toValidationError(
  errors: ReadonlyArray<AjvErrorLike> | null | undefined,
  message: string,
  options: Omit<ValidationErrorOptions, "issues">,
): ValidationError {
  return ValidationError.fromAjvErrors(errors, message, options);
}

function getValidator(
  schema: AnySchemaObject,
  mode: ValidationMode,
  draft: SchemaDraft,
  formats: boolean,
  schemaMode: SchemaMode,
): ValidateFunction {
  let cache = validatorCache.get(schema);
  if (!cache) {
    cache = new Map<string, ValidateFunction>();
    validatorCache.set(schema, cache);
  }

  const cacheKey = `${mode}:${draft}:${formats}:${schemaMode}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const ajv = createAjvInstance(draft, mode, formats, schemaMode);
  const validator = ajv.compile(transformSchemaForMode(schema, mode, schemaMode));
  cache.set(cacheKey, validator);
  return validator;
}

export function validateJsonSchema<T>(
  input: unknown,
  schema: AnySchemaObject,
  options: JsonSchemaValidationOptions,
): T {
  const mode = resolveValidationMode(options);
  const schemaMode = options.schemaMode ?? "mode";
  const draft = options.draft ?? "default";
  const formats = options.formats ?? false;

  if (mode === "filter" && schemaMode === "mode") {
    const looseValue = cloneValidationValue(input);
    const looseValidator = getValidator(schema, "loose", draft, formats, schemaMode);
    if (!looseValidator(looseValue)) {
      throw toValidationError(looseValidator.errors, options.message, {
        field: options.field,
        value: input,
        jsonRpcCode: options.jsonRpcCode,
      });
    }

    const filteredValue = cloneValidationValue(looseValue);
    const strictValidator = getValidator(schema, "strict", draft, formats, schemaMode);
    while (!strictValidator(filteredValue)) {
      if (!stripUnknownPropertiesFromAjvErrors(filteredValue, strictValidator.errors)) {
        break;
      }
    }

    if (!strictValidator(filteredValue)) {
      throw toValidationError(strictValidator.errors, options.message, {
        field: options.field,
        value: input,
        jsonRpcCode: options.jsonRpcCode,
      });
    }

    return filteredValue as T;
  }

  const value = cloneValidationValue(input);
  const validator = getValidator(schema, mode, draft, formats, schemaMode);
  if (!validator(value)) {
    throw toValidationError(validator.errors, options.message, {
      field: options.field,
      value: input,
      jsonRpcCode: options.jsonRpcCode,
    });
  }

  return value as T;
}

export function validateJsonSchemaArtifacts<T>(
  input: unknown,
  artifacts: JsonSchemaValidationArtifacts,
  options: JsonSchemaValidationOptions,
): T {
  const mode = resolveValidationMode(options);
  const draft = options.draft ?? "default";
  const formats = options.formats ?? false;

  if (mode === "filter") {
    const looseValue = cloneValidationValue(input);
    const looseValidator = getValidator(artifacts.looseSchema, "loose", draft, formats, "original");
    if (!looseValidator(looseValue)) {
      throw toValidationError(looseValidator.errors, options.message, {
        field: options.field,
        value: input,
        jsonRpcCode: options.jsonRpcCode,
      });
    }

    const filteredValue = cloneValidationValue(looseValue);
    const strictValidator = getValidator(
      artifacts.strictSchema,
      "strict",
      draft,
      formats,
      "original",
    );
    while (!strictValidator(filteredValue)) {
      if (!stripUnknownPropertiesFromAjvErrors(filteredValue, strictValidator.errors)) {
        break;
      }
    }

    if (!strictValidator(filteredValue)) {
      throw toValidationError(strictValidator.errors, options.message, {
        field: options.field,
        value: input,
        jsonRpcCode: options.jsonRpcCode,
      });
    }

    return filteredValue as T;
  }

  const schema = mode === "loose" ? artifacts.looseSchema : artifacts.strictSchema;
  const value = cloneValidationValue(input);
  const validator = getValidator(
    schema,
    mode === "loose" ? "loose" : "strict",
    draft,
    formats,
    "original",
  );
  if (!validator(value)) {
    throw toValidationError(validator.errors, options.message, {
      field: options.field,
      value: input,
      jsonRpcCode: options.jsonRpcCode,
    });
  }

  return value as T;
}
