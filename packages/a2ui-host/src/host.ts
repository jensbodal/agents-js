/**
 * Browser-side A2UI host.
 *
 * Owns one {@link MessageProcessor} (+ its {@link SurfaceGroupModel}) per
 * mount point, validates every incoming A2UI lifecycle message through
 * `validateA2uiMessage`, feeds the processor, and re-renders the current
 * `SurfaceGroupModel` via the renderer's `renderSurface` output into the
 * host-provided mount element using Lit's `render()`.
 *
 * User-driven events from the rendered primitives flow back to the caller
 * through the `onEvent` option — typically routed onward by
 * {@link A2uiBridge}.
 *
 * The host is deliberately agnostic to the transport: {@link applyMessage}
 * is the only ingress. Callers are responsible for re-entering it as new
 * messages arrive.
 */
import type { A2uiMessage, Catalog, ComponentApi, SurfaceGroupModel } from "@agents-js/a2ui-types";
import { ACP_CATALOG_ID, AcpCatalog, MessageProcessor } from "@agents-js/a2ui-types";
import { getBasicCatalog, validateA2uiMessage } from "@agents-js/validation";
import { render, type TemplateResult } from "lit";

/**
 * Callback invoked when a rendered ACP primitive emits an action.
 *
 * The `<P>` generic narrows the surface-event payload envelope so consumers
 * that know their wire contract can typecheck payloads end-to-end without
 * re-validating at every sink. Defaults to `Record<string, unknown>` to
 * preserve source compat with callers that have not narrowed.
 */
export type A2uiHostEventHandler<P = Record<string, unknown>> = (
  surfaceId: string,
  actionName: string,
  payload: P,
) => void;

/**
 * Renderer function matching `renderSurface` from `@agents-js/a2ui-renderer`.
 * Injected so the host module stays renderer-agnostic (and unit-testable
 * without a DOM-capable `lit` import chain).
 *
 * The renderer's own event handler remains `Record<string, unknown>` at the
 * wire-interior — DOM event details have to be accepted as `unknown`
 * regardless — but the `<P>` generic on {@link A2uiHost} lets the host cast
 * once at its boundary before re-emitting through its own `onEvent`.
 */
export type SurfaceRenderer = (
  model: SurfaceGroupModel<ComponentApi>,
  opts: { catalogId: string; onEvent: A2uiHostEventHandler<Record<string, unknown>> },
) => TemplateResult;

/** Options for constructing an {@link A2uiHost}. */
export interface A2uiHostOptions<P = Record<string, unknown>> {
  /** Receives user-driven events dispatched by rendered primitives. */
  readonly onEvent: A2uiHostEventHandler<P>;
  /**
   * Template factory. Pass `renderSurface` from `@agents-js/a2ui-renderer`
   * in production; tests can inject a stub to avoid pulling in Lit / ACP
   * primitives.
   */
  readonly renderer: SurfaceRenderer;
  /**
   * Catalog id passed to the renderer. Defaults to `ACP_CATALOG_ID` so the
   * ACP primitives resolve without extra wiring.
   */
  readonly catalogId?: string;
  /**
   * Override the catalog list used by the internal {@link MessageProcessor}.
   * Defaults to `[basic, ACP]` — matching the gateway-side `SurfaceSession`
   * defaults so surface ids resolve identically on both sides of the wire.
   */
  readonly catalogs?: readonly Catalog<ComponentApi>[];
  /**
   * Called when {@link applyMessage} receives a payload that fails
   * `validateA2uiMessage`. Defaults to a `console.warn` — supply a custom
   * handler to capture validation failures in tests or to push them onto a
   * structured log.
   */
  readonly onInvalidMessage?: (error: Error, raw: unknown) => void;
}

function defaultCatalogs(): Catalog<ComponentApi>[] {
  return [getBasicCatalog(), AcpCatalog];
}

/**
 * Renders a live `SurfaceGroupModel` into a DOM mount point, applying A2UI
 * lifecycle messages as they arrive.
 */
export class A2uiHost<P = Record<string, unknown>> {
  private readonly mount: HTMLElement;
  private readonly onEvent: A2uiHostEventHandler<P>;
  private readonly catalogId: string;
  private readonly onInvalidMessage: (error: Error, raw: unknown) => void;
  private readonly renderer: SurfaceRenderer;
  private processor: MessageProcessor<ComponentApi>;
  private destroyed = false;
  // A batch of messages may arrive in a single tick (e.g. CreateSurface +
  // multiple UpdateComponents). Coalesce them into one render per microtask
  // so Lit's diff work runs once per burst instead of per message.
  private renderScheduled = false;

  constructor(mount: HTMLElement, opts: A2uiHostOptions<P>) {
    this.mount = mount;
    this.onEvent = opts.onEvent;
    this.renderer = opts.renderer;
    this.catalogId = opts.catalogId ?? ACP_CATALOG_ID;
    this.onInvalidMessage =
      opts.onInvalidMessage ??
      ((error, raw) => {
        console.warn("[a2ui-host] Dropping invalid A2UI message:", error.message, raw);
      });
    // Spread into a fresh mutable array: upstream `MessageProcessor`
    // accepts `Catalog<T>[]`, but the public option stays `readonly` so
    // callers cannot mutate the list we hold.
    const catalogs = opts.catalogs ? [...opts.catalogs] : defaultCatalogs();
    this.processor = new MessageProcessor<ComponentApi>(catalogs);
  }

  /**
   * Test-only accessor for the underlying {@link SurfaceGroupModel}.
   * Production callers must drive state through {@link applyMessage} — the
   * sanctioned coalesced ingress that runs validation and schedules a render
   * — rather than reading or mutating the model out-of-band. Exposing this
   * as a method (not a getter) makes it grep-visible at every call site and
   * preserves the invariant that the only public state-mutating entry point
   * is {@link applyMessage}.
   */
  getModelForTesting(): SurfaceGroupModel<ComponentApi> {
    return this.processor.model;
  }

  /** `true` once {@link destroy} has run. Read by the bridge. */
  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /**
   * Validate `message` and, if accepted, feed it to the internal processor
   * then re-render. Invalid messages are routed to `onInvalidMessage` and
   * dropped — the caller does not need to pre-validate, but pre-validation
   * is also harmless.
   */
  applyMessage(message: unknown): void {
    if (this.destroyed) return;

    const result = validateA2uiMessage(message);
    if (!result.valid) {
      this.onInvalidMessage(result.error, message);
      return;
    }

    try {
      this.processor.processMessages([result.value satisfies A2uiMessage]);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onInvalidMessage(error, message);
      return;
    }

    this.scheduleRender();
  }

  /**
   * Re-render the current surface group without applying a new message.
   * Useful after external state changes that affect the data model.
   */
  rerender(): void {
    if (this.destroyed) return;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      if (this.destroyed) return;
      this.renderToMount();
    });
  }

  /**
   * Build — without mounting — the `TemplateResult` the host would render
   * for the current surface group. Primary consumer is tests; callers that
   * want the rendered output should use {@link applyMessage} and inspect
   * the mount element.
   */
  buildTemplate(): TemplateResult {
    // The renderer emits `Record<string, unknown>` payloads because its
    // event interior reads arbitrary DOM CustomEvent detail. The host's
    // `<P>` narrowing is a compile-time promise from the wiring site that
    // those payloads match `P`; we cast once at the boundary — preserving
    // the identity of `this.onEvent` so the bridge's `createHost` contract
    // (renderer receives bridge.onEvent verbatim) stays load-bearing for
    // reference-equality checks.
    const onEventForRenderer = this.onEvent as unknown as A2uiHostEventHandler<
      Record<string, unknown>
    >;
    return this.renderer(this.processor.model, {
      catalogId: this.catalogId,
      onEvent: onEventForRenderer,
    });
  }

  /**
   * Dispose the processor and clear the mount. Safe to call multiple times;
   * subsequent {@link applyMessage} calls become no-ops. Call this from a
   * consumer's teardown hook (Obsidian `onClose`, Vite HMR dispose, etc.)
   * so the `SurfaceGroupModel` does not leak across reloads.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.processor.model.dispose();
    } catch (err) {
      // Dispose is best-effort — swallowing keeps destroy() idempotent.
      console.warn(
        "[a2ui-host] SurfaceGroupModel.dispose failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
    this.clearMount();
  }

  protected renderToMount(): void {
    render(this.buildTemplate(), this.mount);
  }

  protected clearMount(): void {
    render(null, this.mount);
  }
}
