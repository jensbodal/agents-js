/**
 * A2UI validators — thin wrappers around the Zod schemas published by
 * `@a2ui/web_core` v0.9 (re-exported through `@agents-js/a2ui-types`).
 *
 * Three entrypoints:
 * - {@link validateA2uiMessage} / {@link isA2uiMessage} — validate
 *   server-to-client lifecycle messages (CreateSurface, UpdateComponents,
 *   UpdateDataModel, DeleteSurface).
 * - {@link validateA2uiComponent} — validate a single component entry
 *   (`{ component, id?, ...props }`) against a catalog. Defaults to the
 *   basic catalog shipped by `@a2ui/web_core`; pass `AcpCatalog` (or any
 *   other `Catalog`) to validate ACP / custom components.
 * - {@link validateA2uiSurfaceTree} — validate a list of components
 *   (the `updateComponents.components` payload), applying the same
 *   per-component rule to every entry.
 *
 * Error shape mirrors the existing ACP / A2A validators: failures return
 * a `ValidationResult` whose `error` is a `ValidationError` with
 * per-issue `path` + `message` entries.
 */

import type { A2uiMessage, ComponentApi } from "@agents-js/a2ui-types";
import { A2uiMessageSchema, BASIC_COMPONENTS, Catalog } from "@agents-js/a2ui-types";
import { z } from "zod";
import { ValidationError } from "./errors.ts";
import type { ValidationResult } from "./result.ts";
import { zodIssuesToValidationIssues } from "./zod-utils.ts";

/** Stable id for the built-in basic catalog (used when no catalog is supplied). */
export const BASIC_CATALOG_ID = "https://a2ui.org/catalog/basic/0.9";

let cachedBasicCatalog: Catalog<ComponentApi> | undefined;

/**
 * Returns a lazily-constructed `Catalog` wrapping `BASIC_COMPONENTS`.
 * Cached so repeated calls reuse the same instance.
 */
export function getBasicCatalog(): Catalog<ComponentApi> {
  if (!cachedBasicCatalog) {
    cachedBasicCatalog = new Catalog(BASIC_CATALOG_ID, [...BASIC_COMPONENTS]);
  }
  return cachedBasicCatalog;
}

/**
 * Envelope schema for a single component entry inside an A2UI
 * `updateComponents` message. Only the framework-owned fields are
 * validated here; component-specific property validation is delegated
 * to the catalog schema in {@link validateA2uiComponent}.
 */
const componentEnvelopeSchema = z
  .object({
    component: z.string().min(1),
    id: z.string().optional(),
    weight: z.number().optional(),
  })
  .passthrough();

type ComponentEnvelope = z.infer<typeof componentEnvelopeSchema>;

/**
 * Validate a lifecycle A2UI message (CreateSurface, UpdateComponents,
 * UpdateDataModel, DeleteSurface). Returns the typed message on
 * success.
 */
export function validateA2uiMessage(msg: unknown): ValidationResult<A2uiMessage> {
  const parsed = A2uiMessageSchema.safeParse(msg);

  if (!parsed.success) {
    const issues = zodIssuesToValidationIssues(parsed.error);
    return {
      valid: false,
      error: new ValidationError("Invalid A2UI message", {
        field: issues[0]?.path ?? "input",
        value: msg,
        issues,
      }),
    };
  }

  return { valid: true, value: parsed.data as A2uiMessage };
}

/**
 * Type guard form of {@link validateA2uiMessage}. Useful for narrowing
 * `unknown` values at the boundary of a transport without allocating a
 * result object.
 */
export function isA2uiMessage(msg: unknown): msg is A2uiMessage {
  return A2uiMessageSchema.safeParse(msg).success;
}

function describeCatalogComponents(catalog: Catalog<ComponentApi>): string {
  const names = Array.from(catalog.components.keys());
  return names.length > 0 ? names.join(", ") : "(none)";
}

/**
 * Validate a single component entry against a catalog. Accepts the
 * wire-format component envelope `{ component, id?, weight?, ...props }`
 * and delegates the property-shape check to the catalog's
 * `ComponentApi.schema` for `component`.
 *
 * Defaults to the basic catalog. Pass `AcpCatalog` (or any other
 * `Catalog`) to validate custom components.
 */
export function validateA2uiComponent(
  comp: unknown,
  catalog: Catalog<ComponentApi> = getBasicCatalog(),
): ValidationResult<ComponentEnvelope> {
  const envelope = componentEnvelopeSchema.safeParse(comp);
  if (!envelope.success) {
    const issues = zodIssuesToValidationIssues(envelope.error);
    return {
      valid: false,
      error: new ValidationError("Invalid A2UI component envelope", {
        field: issues[0]?.path ?? "component",
        value: comp,
        issues,
      }),
    };
  }

  const { component, id: _id, ...rest } = envelope.data;
  void _id;
  const api = catalog.components.get(component);
  if (!api) {
    return {
      valid: false,
      error: new ValidationError(`Unknown component "${component}" for catalog ${catalog.id}`, {
        field: "component",
        value: component,
        issues: [
          {
            path: "component",
            message: `Component is not registered in catalog ${catalog.id}. Known components: ${describeCatalogComponents(
              catalog,
            )}`,
          },
        ],
      }),
    };
  }

  const props = api.schema.safeParse(rest);
  if (!props.success) {
    const issues = zodIssuesToValidationIssues(props.error);
    return {
      valid: false,
      error: new ValidationError(`Invalid props for component "${component}"`, {
        field: issues[0]?.path ?? component,
        value: rest,
        issues,
      }),
    };
  }

  return { valid: true, value: envelope.data };
}

/**
 * A surface component tree — the `components` array of an
 * `updateComponents` message.
 */
export type SurfaceTree = ComponentEnvelope[];

/**
 * Validate a full component tree against a catalog. Fails fast on the
 * first invalid component and accumulates issues from both envelope and
 * property-level failures.
 */
export function validateA2uiSurfaceTree(
  tree: unknown,
  catalog: Catalog<ComponentApi> = getBasicCatalog(),
): ValidationResult<SurfaceTree> {
  if (!Array.isArray(tree)) {
    return {
      valid: false,
      error: new ValidationError("A2UI surface tree must be an array", {
        field: "tree",
        value: tree,
        issues: [{ path: "tree", message: "Expected array of component entries" }],
      }),
    };
  }

  if (tree.length === 0) {
    return {
      valid: false,
      error: new ValidationError("A2UI surface tree must contain at least one component", {
        field: "tree",
        value: tree,
        issues: [{ path: "tree", message: "Expected at least one component entry" }],
      }),
    };
  }

  const validated: SurfaceTree = [];
  for (let i = 0; i < tree.length; i++) {
    const result = validateA2uiComponent(tree[i], catalog);
    if (!result.valid) {
      const scopedIssues = result.error.issues.map((issue) => ({
        ...issue,
        path: `[${i}]${issue.path ? `.${issue.path}` : ""}`,
      }));
      return {
        valid: false,
        error: new ValidationError(`Invalid A2UI component at index ${i}`, {
          field: scopedIssues[0]?.path ?? `[${i}]`,
          value: tree[i],
          issues: scopedIssues,
        }),
      };
    }
    validated.push(result.value);
  }

  return { valid: true, value: validated };
}
