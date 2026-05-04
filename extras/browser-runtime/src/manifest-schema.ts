import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/**
 * The four POC manifest fields the Playground v2 manifest editor (M4) will
 * round-trip. Kept intentionally small in M1: future fields land additively
 * via `additionalProperties: false` plus schema bumps; the validator surface
 * (`createManifestValidator`) does not change.
 *
 * Runtime ids:
 *   - `mock`              — `createMockRuntimeAdapter` / `createMockRunner`.
 *                           Canned-response preview, ships with the playground.
 *   - `local-wasm-worker` — In-browser WebLLM runtime. Real model, ~700 MB
 *                           download, requires WebGPU.
 *   - `agents-js-gateway` — Remote runtime hosted by `apps/internal-gateway`.
 *                           Schema-valid but has NO adapter yet — the manifest
 *                           editor disables this option in the form. Reserved
 *                           for a future milestone (M5+); see DOT-307.
 */
export type RuntimeId = "mock" | "local-wasm-worker" | "agents-js-gateway";
export type PermissionsPolicy = "explicit" | "plan" | "yolo";

export interface ToolBoundary {
  name: string;
  allow?: boolean;
}

export interface ManifestDraft {
  name: string;
  runtime: RuntimeId;
  permissions: PermissionsPolicy;
  tools: ToolBoundary[];
}

/**
 * JSON-Schema 2020-12 description of `ManifestDraft`. Exported so consumers
 * (e.g. M4 manifest-editor live preview) can introspect or render schema-driven
 * form widgets without redeclaring the contract.
 *
 * `additionalProperties: false` everywhere — unknown keys must be a hard
 * rejection so a typo'd manifest never silently strips a field.
 */
export const MANIFEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["name", "runtime", "permissions", "tools"],
  properties: {
    name: { type: "string", minLength: 1 },
    runtime: { type: "string", enum: ["mock", "local-wasm-worker", "agents-js-gateway"] },
    permissions: { type: "string", enum: ["explicit", "plan", "yolo"] },
    tools: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1 },
          allow: { type: "boolean" },
        },
      },
    },
  },
} as const;

/**
 * Manifest-shaped validation result. Distinct from `ValidationResult` in
 * `action-validator.ts` because the manifest editor needs a smaller external
 * shape (no echoed `data`, errors as plain strings for direct UI rendering).
 * The action-validator type stays generic for the meta-agent loop's needs.
 */
export interface ManifestValidationResult {
  valid: boolean;
  errors?: string[];
}

export type ManifestValidator = (draft: unknown) => ManifestValidationResult;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const compiled = ajv.compile(MANIFEST_SCHEMA);

/**
 * Returns a validator bound to the compiled `MANIFEST_SCHEMA`. Wrapped as a
 * factory (rather than a free function) so M4's editor can swap in stricter
 * variants later (e.g. cross-field invariants like "yolo + tools.allow=false
 * is contradictory") without breaking the call site.
 */
export function createManifestValidator(): ManifestValidator {
  return (draft: unknown): ManifestValidationResult => {
    const ok = compiled(draft);
    if (ok) return { valid: true };
    const errors = (compiled.errors ?? []).map((e) => {
      const where = e.instancePath || "$";
      return `${where} ${e.keyword}: ${e.message ?? ""}`.trim();
    });
    return { valid: false, errors };
  };
}

/**
 * Renders a `ManifestDraft` as a deterministic YAML string for the manifest
 * editor's read-only preview pane.
 *
 * WHY this is a render-only helper (no `parseYaml` counterpart): the structured
 * `ManifestDraft` is the source of truth in the store. Allowing YAML round-trip
 * would invite formatting drift (quoting, key ordering, comment retention) and
 * force a YAML library dependency for a feature the UI never needs — the user
 * edits via form widgets, not raw YAML. If a future milestone needs YAML input,
 * add a parser then; until then, keep the seam closed.
 *
 * The output is byte-stable for a given input: keys are emitted in fixed order
 * (name, runtime, permissions, tools) and tools preserve their input order.
 */
export function renderManifestAsYaml(m: ManifestDraft): string {
  const lines: string[] = [];
  lines.push(`name: ${m.name}`);
  lines.push(`runtime: ${m.runtime}`);
  lines.push(`permissions: ${m.permissions}`);
  if (m.tools.length === 0) {
    lines.push("tools: []");
  } else {
    lines.push("tools:");
    for (const tool of m.tools) {
      lines.push(`  - name: ${tool.name}`);
      if (tool.allow !== undefined) {
        lines.push(`    allow: ${tool.allow}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Default manifest used to seed the playground store on first load and any
 * "reset draft" action. Picks the local-wasm runtime + explicit permissions —
 * the safest, lowest-surprise choice for a docs visitor.
 */
export const DEFAULT_MANIFEST: ManifestDraft = {
  name: "docs-meta-agent",
  runtime: "local-wasm-worker",
  permissions: "explicit",
  tools: [{ name: "searchDocs", allow: true }],
};
