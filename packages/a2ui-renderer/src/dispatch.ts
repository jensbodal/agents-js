/**
 * Dispatcher that maps a single A2UI component envelope onto an `acp-*`
 * Lit primitive.
 *
 * Currently supports the ACP custom catalog (`ACP_CATALOG_ID`). Any other
 * catalog id triggers `A2uiRendererError`. Unknown component names within
 * the ACP catalog likewise error so hosts fail fast instead of silently
 * rendering nothing.
 */

import { ACP_CATALOG_ID } from "@agents-js/a2ui-types";
import { nothing, type TemplateResult } from "lit";
import { type A2uiEventHandler, ACP_BINDINGS, type BindingContext } from "./acp-bindings.ts";
import { DEFAULT_SURFACE_ID } from "./constants.ts";
import { A2uiRendererError } from "./errors.ts";

/** Minimum shape this renderer needs from an A2UI component entry. */
export interface A2uiComponentNode {
  /** Component type name as it appears in `updateComponents.components[].component`. */
  readonly component: string;
  /** Optional author-supplied component id used for child references. */
  readonly id?: string;
  /** Remaining properties as defined by the catalog schema. */
  readonly [key: string]: unknown;
}

/** Options accepted by the renderer. */
export interface RenderOptions {
  /** Catalog id of the surface being rendered. Must be `ACP_CATALOG_ID`. */
  readonly catalogId: string;
  /** Handler for wrapped Action events. */
  readonly onEvent: A2uiEventHandler;
  /** Surface id forwarded into every action payload. Defaults to {@link DEFAULT_SURFACE_ID}. */
  readonly surfaceId?: string;
  /**
   * Optional child resolver — used by `renderSurface` to thread sibling
   * components into the template. When omitted, child references return
   * empty templates so the dispatcher still produces a valid Lit result.
   */
  readonly resolveChild?: (id: string) => TemplateResult | typeof nothing;
}

/**
 * Render a single A2UI component node into a Lit `TemplateResult`.
 *
 * Throws `A2uiRendererError` when the catalog id is unknown or when the
 * component name is not present in the ACP catalog.
 */
export function renderA2uiComponent(node: A2uiComponentNode, opts: RenderOptions): TemplateResult {
  if (opts.catalogId !== ACP_CATALOG_ID) {
    throw new A2uiRendererError(
      `Unsupported catalog id "${opts.catalogId}". Supported catalog: ${ACP_CATALOG_ID}.`,
      { catalogId: opts.catalogId },
    );
  }

  const binding = ACP_BINDINGS[node.component];
  if (!binding) {
    throw new A2uiRendererError(
      `Unknown ACP component "${node.component}". Known components: ${Object.keys(ACP_BINDINGS).join(", ")}`,
      { catalogId: opts.catalogId, componentName: node.component },
    );
  }

  const ctx: BindingContext = {
    surfaceId: opts.surfaceId ?? DEFAULT_SURFACE_ID,
    onEvent: opts.onEvent,
    resolveChild: opts.resolveChild ?? (() => nothing),
  };

  try {
    return binding(node, ctx);
  } catch (cause) {
    throw new A2uiRendererError(
      `Failed to bind A2UI component "${node.component}": ${(cause as Error).message}`,
      { catalogId: opts.catalogId, componentName: node.component, cause },
    );
  }
}
