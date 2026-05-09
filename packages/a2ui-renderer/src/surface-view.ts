/**
 * Surface-view: compose a full A2UI surface tree into a single Lit
 * `TemplateResult` by delegating to {@link renderA2uiComponent} per node.
 *
 * The renderer is pure: it reads a snapshot of the surface group's component
 * state and produces a template. Hosts are expected to subscribe to surface
 * / component events and re-invoke `renderSurface` on change.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { A2uiEventHandler } from "./acp-bindings.ts";
import { type A2uiComponentNode, renderA2uiComponent } from "./dispatch.ts";
import { A2uiRendererError } from "./errors.ts";

/**
 * Minimal shape of a `@a2ui/web_core` `ComponentModel` that the surface
 * view reads. Both real models and plain-object fakes satisfy this shape.
 */
export interface ComponentLike {
  readonly id: string;
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

/** Minimal shape of a surface as the renderer needs it. */
export interface SurfaceLike {
  readonly id: string;
  readonly componentsModel: {
    readonly entries: IterableIterator<[string, ComponentLike]>;
  };
}

/** Minimal shape of a `SurfaceGroupModel` as the renderer needs it. */
export interface SurfaceGroupLike {
  readonly surfacesMap: ReadonlyMap<string, SurfaceLike>;
}

/** Options for {@link renderSurface}. */
export interface RenderSurfaceOptions {
  /** Catalog id of the surface. Must match the catalog used to populate the group. */
  readonly catalogId: string;
  /** Action-event dispatcher forwarded to every component. */
  readonly onEvent: A2uiEventHandler;
  /**
   * Explicit surface id to render. When omitted, renders every surface in the
   * group in a stable `surfacesMap` iteration order.
   */
  readonly surfaceId?: string;
}

/**
 * Discover the "root" component of a surface. A root is a component that is
 * not referenced as a child by any sibling (via `children` arrays or scalar
 * id refs like `AcpChatApp.transcript`). When the surface has exactly one
 * component, that component is the root. When no unique root exists, the
 * first component in iteration order is used as a stable fallback.
 */
function findRoot(components: ReadonlyMap<string, A2uiComponentNode>): string | undefined {
  if (components.size === 0) return undefined;
  const referenced = new Set<string>();
  for (const comp of components.values()) {
    for (const [key, value] of Object.entries(comp)) {
      if (key === "id" || key === "component") continue;
      if (typeof value === "string" && components.has(value)) {
        referenced.add(value);
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === "string" && components.has(entry)) {
            referenced.add(entry);
          }
        }
      }
    }
  }
  for (const id of components.keys()) {
    if (!referenced.has(id)) return id;
  }
  // Cycle or self-referential tree: fall back to the first entry.
  const first = components.keys().next();
  return first.done ? undefined : first.value;
}

/** Build a map of id -> lazy resolver across a surface's components. */
function buildSurfaceTemplate(
  surface: SurfaceLike,
  opts: RenderSurfaceOptions,
): TemplateResult | typeof nothing {
  const components = new Map<string, A2uiComponentNode>();
  for (const [id, model] of surface.componentsModel.entries) {
    const node: A2uiComponentNode = {
      component: model.type,
      id: model.id,
      ...model.properties,
    };
    components.set(id, node);
  }

  const resolveChild = (id: string): TemplateResult | typeof nothing => {
    const child = components.get(id);
    if (!child) return nothing;
    return renderA2uiComponent(child, {
      catalogId: opts.catalogId,
      onEvent: opts.onEvent,
      surfaceId: surface.id,
      resolveChild,
    });
  };

  const rootId = findRoot(components);
  if (!rootId) return nothing;
  return resolveChild(rootId);
}

/**
 * Render a full A2UI surface (or every surface in a group) into a single
 * Lit `TemplateResult`.
 */
export function renderSurface(
  surfaceModel: SurfaceGroupLike,
  opts: RenderSurfaceOptions,
): TemplateResult {
  if (opts.surfaceId !== undefined) {
    const surface = surfaceModel.surfacesMap.get(opts.surfaceId);
    if (!surface) {
      throw new A2uiRendererError(`Unknown surface id "${opts.surfaceId}"`, {
        catalogId: opts.catalogId,
      });
    }
    const tpl = buildSurfaceTemplate(surface, opts);
    return html`${tpl}`;
  }

  const parts: Array<TemplateResult | typeof nothing> = [];
  for (const surface of surfaceModel.surfacesMap.values()) {
    parts.push(buildSurfaceTemplate(surface, opts));
  }
  return html`${parts}`;
}
