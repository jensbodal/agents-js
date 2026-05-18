import type {
  AgentsA2uiExtension,
  AgentsCanvasExtension,
  AgentsCanvasNode,
  CanvasSize,
  CreateA2uiCanvasNodeOptions,
  JsonCanvasExportResult,
  JsonObject,
  JsonValue,
  OcifDocument,
  OcifSchemaEntry,
} from "./types.ts";

export type {
  AgentsA2uiExtension,
  AgentsCanvasExtension,
  AgentsCanvasNode,
  AgentsProvenanceExtension,
  CanvasExportWarning,
  CanvasPoint,
  CanvasProvenance,
  CanvasSize,
  CreateA2uiCanvasNodeOptions,
  JsonCanvasDocument,
  JsonCanvasExportResult,
  JsonCanvasTextNode,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  OcifDocument,
  OcifNode,
  OcifResource,
  OcifSchemaEntry,
  OcifTextRepresentation,
} from "./types.ts";

export const AGENTS_A2UI_EXTENSION = "@agents-js/a2ui";
export const AGENTS_PROVENANCE_EXTENSION = "@agents-js/provenance";
export const AGENTS_CANVAS_EXTENSION_VERSION = "0.1.0";
export const OCIF_VERSION_URI = "https://canvasprotocol.org/ocif/v0.7.0";

const DEFAULT_SIZE: CanvasSize = { width: 360, height: 240 };
const JSON_CANVAS_LOSSY_MESSAGE =
  "JSON Canvas export is preview-only: interactive A2UI payload and provenance extensions are not representable in a text node.";
const TEXT_KEYS = new Set(["content", "label", "message", "text", "title", "value"]);

/**
 * Wrap an A2UI payload as a portable agents-js canvas node.
 */
export function createA2uiCanvasNode(
  surface: unknown,
  options: CreateA2uiCanvasNodeOptions = {},
): AgentsCanvasNode {
  const position = {
    x: finiteNumber(options.position?.x, 0),
    y: finiteNumber(options.position?.y, 0),
  };
  const size = {
    width: positiveNumber(options.size?.width, DEFAULT_SIZE.width),
    height: positiveNumber(options.size?.height, DEFAULT_SIZE.height),
  };
  const id = options.id ?? `canvas-${sanitizeId(readId(surface) ?? options.title ?? "a2ui")}`;
  const data: AgentsCanvasExtension[] = [
    {
      type: AGENTS_A2UI_EXTENSION,
      version: AGENTS_CANVAS_EXTENSION_VERSION,
      inert: true,
      payload: toInertJson(surface),
    },
  ];
  const provenance = toJsonObject(options.provenance);

  if (provenance && Object.keys(provenance).length > 0) {
    data.push({
      type: AGENTS_PROVENANCE_EXTENSION,
      version: AGENTS_CANVAS_EXTENSION_VERSION,
      payload: provenance,
    });
  }

  return {
    id,
    kind: "agents-js.a2ui",
    ...(options.title ? { title: options.title } : {}),
    position,
    size,
    data,
  };
}

/**
 * Export agents-js canvas nodes to a JSON Canvas 1.0-compatible preview.
 */
export function exportJsonCanvas(nodes: readonly AgentsCanvasNode[]): JsonCanvasExportResult {
  return {
    canvas: {
      nodes: nodes.map((node) => ({
        id: node.id,
        type: "text",
        text: createPreviewText(node),
        x: canvasInteger(node.position.x),
        y: canvasInteger(node.position.y),
        width: canvasInteger(node.size.width, 1),
        height: canvasInteger(node.size.height, 1),
      })),
      edges: [],
    },
    warnings: nodes.map((node) => ({
      nodeId: node.id,
      code: "json-canvas-lossy-a2ui",
      message: JSON_CANVAS_LOSSY_MESSAGE,
    })),
  };
}

/**
 * Export agents-js canvas nodes to an OCIF-style document that preserves
 * agents-js extensions beside a plain-text preview resource.
 */
export function exportOcif(nodes: readonly AgentsCanvasNode[]): OcifDocument {
  return {
    ocif: OCIF_VERSION_URI,
    nodes: nodes.map((node) => ({
      id: node.id,
      position: [node.position.x, node.position.y],
      size: [node.size.width, node.size.height],
      resource: resourceIdForNode(node),
      data: node.data.map(cloneJsonObject),
    })),
    resources: nodes.map((node) => ({
      id: resourceIdForNode(node),
      representations: [
        {
          mimeType: "text/plain",
          content: createPreviewText(node),
        },
      ],
    })),
    schemas: createOcifSchemaEntries(),
  };
}

/**
 * Convert arbitrary input into inert JSON by dropping executable values and
 * normalizing values such as Date and bigint.
 */
export function toInertJson(value: unknown): JsonValue {
  return sanitizeJson(value, new WeakSet<object>()) ?? null;
}

function createPreviewText(node: AgentsCanvasNode): string {
  const title = node.title ?? node.id;
  const payload = findA2uiPayload(node);
  const previewLines = collectPreviewText(payload).slice(0, 5);

  return [
    `# ${title}`,
    "",
    "Preview-only JSON Canvas export.",
    "",
    ...(previewLines.length > 0
      ? previewLines
      : ["A2UI payload is preserved in the OCIF-style @agents-js/a2ui extension."]),
  ].join("\n");
}

function collectPreviewText(value: JsonValue | undefined, results: string[] = []): string[] {
  if (results.length >= 5 || value === undefined || value === null) return results;
  if (Array.isArray(value)) {
    for (const item of value) collectPreviewText(item, results);
    return results;
  }
  if (typeof value !== "object") return results;

  for (const [key, entry] of Object.entries(value)) {
    if (results.length >= 5) return results;
    if (TEXT_KEYS.has(key) && typeof entry === "string" && entry.trim()) {
      results.push(entry.trim());
      continue;
    }
    collectPreviewText(entry, results);
  }

  return results;
}

function findA2uiPayload(node: AgentsCanvasNode): JsonValue | undefined {
  return node.data.find((entry): entry is AgentsA2uiExtension => {
    return entry.type === AGENTS_A2UI_EXTENSION;
  })?.payload;
}

function resourceIdForNode(node: AgentsCanvasNode): string {
  return `${node.id}-resource`;
}

function createOcifSchemaEntries(): OcifSchemaEntry[] {
  return [
    {
      name: AGENTS_A2UI_EXTENSION,
      uri: "urn:agents-js:ocif-extension:a2ui:v0.1",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "agents-js A2UI OCIF extension",
        type: "object",
        required: ["type", "version", "inert", "payload"],
        properties: {
          type: { const: AGENTS_A2UI_EXTENSION },
          version: { const: AGENTS_CANVAS_EXTENSION_VERSION },
          inert: { const: true },
          payload: {},
        },
        additionalProperties: false,
      },
    },
    {
      name: AGENTS_PROVENANCE_EXTENSION,
      uri: "urn:agents-js:ocif-extension:provenance:v0.1",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "agents-js provisional provenance OCIF extension",
        type: "object",
        required: ["type", "version", "payload"],
        properties: {
          type: { const: AGENTS_PROVENANCE_EXTENSION },
          version: { const: AGENTS_CANVAS_EXTENSION_VERSION },
          payload: { type: "object" },
        },
        additionalProperties: false,
      },
    },
  ];
}

function sanitizeJson(value: unknown, seen: WeakSet<object>): JsonValue | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return null;
  if (seen.has(value)) return null;

  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.map((item) => sanitizeJson(item, seen) ?? null);
    seen.delete(value);
    return output;
  }

  const output: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const sanitized = sanitizeJson(entry, seen);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  seen.delete(value);
  return output;
}

function cloneJsonObject(value: unknown): JsonObject {
  const cloned = toInertJson(value);
  return cloned && typeof cloned === "object" && !Array.isArray(cloned) ? cloned : {};
}

function toJsonObject(value: unknown): JsonObject | undefined {
  const json = toInertJson(value);
  return json && typeof json === "object" && !Array.isArray(json) ? json : undefined;
}

function readId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.trim().length > 0 ? id : undefined;
}

function sanitizeId(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "a2ui";
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function canvasInteger(value: number, minimum = Number.NEGATIVE_INFINITY): number {
  return Math.max(minimum, Math.round(value));
}
