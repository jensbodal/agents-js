import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_METHODS, CLIENT_METHODS } from "@agentclientprotocol/sdk";
import type { AnySchemaObject } from "ajv";
import { isACPOpenExtensionProperty } from "../src/acp-policy-types.ts";

type ACPMethod =
  | (typeof AGENT_METHODS)[keyof typeof AGENT_METHODS]
  | (typeof CLIENT_METHODS)[keyof typeof CLIENT_METHODS];

type ACPMethodSide = "agent" | "client";
type ACPPayloadKind = "request" | "notification" | "response";
type NormalizationMode = "strict" | "loose";

interface ACPProtocolSchemaDefinition extends Record<string, unknown> {
  "x-method"?: string;
  "x-side"?: string;
  required?: string[];
  type?: unknown;
}

type ACPProtocolSchema = AnySchemaObject & {
  $schema?: string;
  $defs: Record<string, ACPProtocolSchemaDefinition>;
};

interface ACPGeneratedMethodSchemaInfo {
  allowsEmptyObject: boolean;
  definitionName: string;
  kind: ACPPayloadKind;
  method: ACPMethod;
  side: ACPMethodSide;
}

interface ACPGeneratedArtifacts {
  requestSchemas: Record<ACPMethod, ACPGeneratedMethodSchemaInfo>;
  responseSchemas: Record<ACPMethod, ACPGeneratedMethodSchemaInfo>;
  schemaVersion: string;
  strictDocument: ACPProtocolSchema;
  looseDocument: ACPProtocolSchema;
}

const require = createRequire(import.meta.url);
const packageJsonPath = require.resolve("@agentclientprotocol/sdk/package.json");
const schemaPath = join(dirname(packageJsonPath), "schema", "schema.json");

const methodWhitelist = [
  ...Object.values(AGENT_METHODS),
  ...Object.values(CLIENT_METHODS),
].sort() as ACPMethod[];
const methodWhitelistSet = new Set<ACPMethod>(methodWhitelist);

const OUTPUT_PATH = new URL("../src/generated/acp-schema.ts", import.meta.url);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readACPProtocolSchema(): ACPProtocolSchema {
  return JSON.parse(readFileSync(schemaPath, "utf8")) as ACPProtocolSchema;
}

function readACPVersion(): string {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version as string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectType(type: unknown): boolean {
  return type === "object" || (Array.isArray(type) && type.includes("object"));
}

function hasObjectShape(schema: Record<string, unknown>): boolean {
  return (
    isObjectType(schema.type) ||
    isObjectRecord(schema.properties) ||
    Array.isArray(schema.required) ||
    "additionalProperties" in schema ||
    "unevaluatedProperties" in schema
  );
}

function unionStrings(a: unknown, b: unknown): string[] {
  return [...new Set([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])])].filter(
    (value): value is string => typeof value === "string",
  );
}

function mergeSchemas(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(base)) {
    if (key === "properties" || key === "required") {
      continue;
    }

    merged[key] = cloneJson(value);
  }

  for (const [key, value] of Object.entries(extra)) {
    if (key === "properties" || key === "required") {
      continue;
    }

    merged[key] = cloneJson(value);
  }

  const baseProperties = isObjectRecord(base.properties) ? base.properties : {};
  const extraProperties = isObjectRecord(extra.properties) ? extra.properties : {};
  if (Object.keys(baseProperties).length > 0 || Object.keys(extraProperties).length > 0) {
    merged.properties = {
      ...cloneJson(baseProperties),
      ...cloneJson(extraProperties),
    };
  }

  const required = unionStrings(base.required, extra.required);
  if (required.length > 0) {
    merged.required = required;
  }

  if (isObjectType(base.type) || isObjectType(extra.type)) {
    merged.type = "object";
  }

  return merged;
}

function buildNormalizer(
  rootSchema: ACPProtocolSchema,
  mode: NormalizationMode,
): ACPProtocolSchema {
  const memo = new Map<string, Record<string, unknown>>();

  function normalizeDefinition(definitionName: string): Record<string, unknown> {
    const existing = memo.get(definitionName);
    if (existing) {
      return existing;
    }

    const placeholder: Record<string, unknown> = {};
    memo.set(definitionName, placeholder);
    Object.assign(placeholder, normalizeNode(rootSchema.$defs[definitionName]));
    return placeholder;
  }

  function resolveLocalRef(schema: Record<string, unknown>): Record<string, unknown> | null {
    const ref = schema.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) {
      return null;
    }

    return normalizeDefinition(ref.slice("#/$defs/".length));
  }

  function normalizeNode(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map((item) => normalizeNode(item));
    }

    if (!isObjectRecord(node)) {
      return node;
    }

    let schema: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") {
        schema[key] = value;
        continue;
      }

      schema[key] = normalizeNode(value);
    }

    if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
      const [singleSchema] = schema.allOf as Record<string, unknown>[];
      const base = { ...schema };
      delete base.allOf;
      schema = mergeSchemas(resolveLocalRef(singleSchema) ?? singleSchema, base);
    }

    for (const combinator of ["oneOf", "anyOf"] as const) {
      if (!Array.isArray(schema[combinator])) {
        continue;
      }

      const inheritedShape: Record<string, unknown> = {};
      for (const key of [
        "type",
        "properties",
        "required",
        "additionalProperties",
        "unevaluatedProperties",
      ] as const) {
        if (key in schema) {
          inheritedShape[key] = cloneJson(schema[key]);
        }
      }

      if (Object.keys(inheritedShape).length === 0) {
        continue;
      }

      schema[combinator] = (schema[combinator] as Record<string, unknown>[]).map((branch) =>
        mergeSchemas(inheritedShape, branch),
      );

      for (const key of Object.keys(inheritedShape)) {
        delete schema[key];
      }
    }

    if (!hasObjectShape(schema)) {
      return schema;
    }

    if (mode === "strict") {
      if (schema.additionalProperties === true) {
        return schema;
      }

      if (isObjectRecord(schema.properties)) {
        for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
          if (isACPOpenExtensionProperty(propertyName) && isObjectRecord(propertySchema)) {
            propertySchema.additionalProperties = true;
          }
        }
      }

      if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
        schema.unevaluatedProperties ??= false;
      } else {
        schema.additionalProperties ??= false;
      }
      return schema;
    }

    if (schema.additionalProperties === false) {
      delete schema.additionalProperties;
    }

    if (schema.unevaluatedProperties === false) {
      delete schema.unevaluatedProperties;
    }

    return schema;
  }

  const normalizedDefinitions = Object.fromEntries(
    Object.keys(rootSchema.$defs).map((definitionName) => [
      definitionName,
      normalizeDefinition(definitionName),
    ]),
  );

  return {
    ...cloneJson(rootSchema),
    $defs: normalizedDefinitions as ACPProtocolSchema["$defs"],
  };
}

function buildMethodRegistry(schema: ACPProtocolSchema): ACPGeneratedArtifacts {
  const requestSchemas: Partial<Record<ACPMethod, ACPGeneratedMethodSchemaInfo>> = {};
  const responseSchemas: Partial<Record<ACPMethod, ACPGeneratedMethodSchemaInfo>> = {};

  for (const [definitionName, definition] of Object.entries(schema.$defs)) {
    const method = definition["x-method"];
    const side = definition["x-side"];

    if (
      typeof method !== "string" ||
      (side !== "agent" && side !== "client") ||
      !methodWhitelistSet.has(method as ACPMethod)
    ) {
      continue;
    }

    const kind: ACPPayloadKind = definitionName.endsWith("Response")
      ? "response"
      : definitionName.endsWith("Notification")
        ? "notification"
        : "request";

    const info: ACPGeneratedMethodSchemaInfo = {
      allowsEmptyObject:
        definition.type === "object" &&
        (!Array.isArray(definition.required) || definition.required.length === 0),
      definitionName,
      kind,
      method: method as ACPMethod,
      side,
    };

    if (kind === "response") {
      responseSchemas[info.method] = info;
    } else {
      requestSchemas[info.method] = info;
    }
  }

  // ACP 0.24+ ships UNSTABLE bidirectional methods (the MCP-over-ACP transport
  // `mcp/connect` / `mcp/message` / `mcp/disconnect`, marked in the schema as
  // "not part of the spec yet, may be removed") that carry no agent/client
  // `x-side` and that agents-js does not implement. Forward-only: we do not
  // generate validators for unstable capabilities — auto-detect them from the
  // schema's UNSTABLE marker and exclude them from the coverage requirement.
  const unstableMethods = new Set<string>();
  for (const definition of Object.values(schema.$defs)) {
    const method = definition["x-method"];
    if (
      typeof method === "string" &&
      typeof definition.description === "string" &&
      definition.description.includes("UNSTABLE")
    ) {
      unstableMethods.add(method);
    }
  }
  const coverageWhitelist = methodWhitelist.filter((method) => !unstableMethods.has(method));

  const missingRequestSchemas = coverageWhitelist.filter((method) => !requestSchemas[method]);
  if (missingRequestSchemas.length > 0) {
    throw new Error(
      `ACP schema coverage incomplete for request payloads: ${missingRequestSchemas.join(", ")}`,
    );
  }

  const missingResponseSchemas = Object.values(requestSchemas)
    .filter(
      (info): info is ACPGeneratedMethodSchemaInfo =>
        Boolean(info) && info.kind === "request" && !responseSchemas[info.method],
    )
    .map((info) => info.method);

  if (missingResponseSchemas.length > 0) {
    throw new Error(
      `ACP schema coverage incomplete for response payloads: ${missingResponseSchemas.join(", ")}`,
    );
  }

  return {
    requestSchemas: requestSchemas as Record<ACPMethod, ACPGeneratedMethodSchemaInfo>,
    responseSchemas: responseSchemas as Record<ACPMethod, ACPGeneratedMethodSchemaInfo>,
    schemaVersion: readACPVersion(),
    strictDocument: buildNormalizer(schema, "strict"),
    looseDocument: buildNormalizer(schema, "loose"),
  };
}

function renderGeneratedModule(artifacts: ACPGeneratedArtifacts): string {
  return `// This file is generated by packages/validation/scripts/generate-acp-schema.ts.
// Do not edit by hand.

import type { AnySchemaObject } from "ajv";

export type ACPMethodSide = "agent" | "client";
export type ACPPayloadKind = "request" | "notification" | "response";

export interface ACPGeneratedMethodSchemaInfo {
  allowsEmptyObject: boolean;
  definitionName: string;
  kind: ACPPayloadKind;
  method: string;
  side: ACPMethodSide;
}

export interface ACPGeneratedSchemaArtifacts {
  requestSchemas: Record<string, ACPGeneratedMethodSchemaInfo>;
  responseSchemas: Record<string, ACPGeneratedMethodSchemaInfo>;
  schemaVersion: string;
  strictDocument: AnySchemaObject;
  looseDocument: AnySchemaObject;
}

export const acpGeneratedSchemaArtifacts = ${JSON.stringify(artifacts, null, 2)} as const satisfies ACPGeneratedSchemaArtifacts;
`;
}

function formatGeneratedModule(outputPath: URL, contents: string): string {
  const outputFilePath = fileURLToPath(outputPath);
  const tempFilePath = join(dirname(outputFilePath), ".acp-schema.tmp.ts");

  try {
    writeFileSync(tempFilePath, contents, "utf8");
    const formatted = spawnSync("bunx", ["biome", "format", "--write", tempFilePath], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: "pipe",
    });

    if (formatted.status !== 0) {
      throw new Error(
        formatted.stderr || formatted.stdout || "Biome format failed for generated ACP schema",
      );
    }

    return readFileSync(tempFilePath, "utf8");
  } finally {
    rmSync(tempFilePath, { force: true });
  }
}

function writeGeneratedArtifacts(outputPath: URL, contents: string, checkOnly: boolean): void {
  const outputFilePath = fileURLToPath(outputPath);
  const formattedContents = formatGeneratedModule(outputPath, contents);
  const existingContents = (() => {
    try {
      return readFileSync(outputFilePath, "utf8");
    } catch {
      return null;
    }
  })();

  if (checkOnly) {
    if (existingContents !== formattedContents) {
      throw new Error(`Generated ACP schema artifacts are stale: ${outputFilePath}`);
    }
    return;
  }

  mkdirSync(dirname(outputFilePath), { recursive: true });
  writeFileSync(outputFilePath, formattedContents, "utf8");
}

const checkOnly = process.argv.includes("--check");
const artifacts = buildMethodRegistry(readACPProtocolSchema());
writeGeneratedArtifacts(OUTPUT_PATH, renderGeneratedModule(artifacts), checkOnly);
