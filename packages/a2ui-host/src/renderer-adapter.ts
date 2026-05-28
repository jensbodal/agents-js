/**
 * Host-side renderer-controller adapter lifecycle per ADR-0009 (slot 1).
 *
 * **Why this lives here (peer to {@link SurfaceRenderer})**
 *
 * `@agents-js/a2ui-host` already owns the renderer-injection seam via
 * {@link SurfaceRenderer} — a snapshot-to-Lit-template function operating at
 * the SEMANTIC tier (one render per A2UI message, low frequency, audited).
 *
 * ADR-0009 formalizes a SECOND, ADDITIVE adapter shape at the PERFORMANCE
 * tier: long-lived adapter instances with mount/dispose lifecycle, optional
 * frame-tier `apply`/`resize`/`capture`/`stats`, and resource ownership
 * (GL contexts, SAB buffers, worker handles). These adapters are for
 * Canvas2D / WebGL / WebGPU / WASM renderers that own their frame loop
 * internally — NOT for the pure-function semantic snapshots that
 * `SurfaceRenderer` already handles.
 *
 * The two surfaces are PEERS, not a replacement. Pure-function renderers
 * keep using `SurfaceRenderer`; stateful frame-loop renderers implement
 * `RendererAdapter`. A future renderer that needs both shapes can compose
 * the two; we do not force lifecycle ceremony onto pure-function callers.
 *
 * The types-only slice deliberately does NOT introduce a new package or new
 * imports. Per cognee-claude architecture-lead Q4 decision and banked
 * `feedback-no-speculative-packaging`: don't split until forced. If a
 * future WebGL adapter needs to avoid the Lit dep tree that
 * `@agents-js/a2ui-host` carries, that's the point to spin out — not now.
 *
 * **Critique-first reasoning (boundaries / defaults / contracts / safety / validation)**
 *
 * - **Boundary**: this interface is the LAST place a renderer touches the
 *   host surface. Everything above it (A2UI/AG-UI scene intent, durable
 *   artifacts) is semantic-tier. Everything below it (GL contexts, SAB,
 *   worker IPC) is adapter-internal. Confusing the boundary leaks perf
 *   concerns into protocol contracts (ADR-0009 explicit non-goal) or
 *   protocol concerns into perf paths.
 * - **Default**: every lifecycle method EXCEPT `mount` and `dispose` is
 *   optional. A minimal adapter implements `mount + dispose` only. Reason:
 *   the adapter surface is broad enough that mandating every method drives
 *   implementers into stub no-ops that lie about capability. Optional-by-
 *   default surfaces a true capability matrix.
 * - **Contract**: discriminated-union `apply` payload uses verbatim shape
 *   from cognee-claude Q3 decision: `{ kind: "snapshot", snapshot } |
 *   { kind: "delta", update }`. Adapter authors switch on `kind` with
 *   `assertNever` exhaustiveness (consistent with banked
 *   `feedback-boundary-narrowing-drift`). Extending later
 *   (`{ kind: "incremental", patch }`) does not break implementations that
 *   handled `kind`.
 * - **Safety**: `mount` always returns `Promise<void>` (Q2 decision).
 *   Renderer init is commonly async — WASM compile, WebGPU device adapter
 *   request, texture preload. Forcing sync would push implementations into
 *   fire-and-forget patterns that race teardown.
 * - **Validation**: type-shape tests in
 *   `tests/renderer-adapter-types.test.ts` verify the interface is
 *   implementable with both minimal and full mock adapters and that
 *   generic parameters narrow correctly. Behavioural validation lives in
 *   slot-2 (host-local prototype, Canvas2D backend) where a real adapter
 *   surfaces ordering and resource-lifecycle invariants.
 *
 * **Lifecycle ordering (documented contract, NOT type-enforced in slot-1)**
 *
 * 1. `mount(target, opts?)` — REQUIRED first call. Attaches and allocates.
 *    Always async (returns `Promise<void>`).
 * 2. `apply(payload)` / `resize(dims)` / `capture(opts?)` / `stats()` —
 *    callable in any order after `mount`, any number of times.
 * 3. `dispose()` — REQUIRED last call. Idempotent: calling twice is a
 *    no-op. After `dispose`, no further methods may be invoked.
 *
 * Type-system enforcement of this ordering would require state machines
 * and phantom types that distort the interface for limited benefit. The
 * slot-2 prototype will validate that typical callers respect ordering and
 * inform whether to lift enforcement into types post-0.6.0.
 *
 * **Explicit non-goals for slot-1** (per ADR-0009)
 *
 * - No transport-side types. Renderer-internal only.
 * - No A2UI / AG-UI coupling. The caller bridges semantic snapshots to
 *   `apply({ kind: "snapshot", snapshot })` outside this interface.
 * - No canvas-model coupling. `Artifact` is generic; slot-2 binds it to
 *   JSON Canvas if the prototype needs it.
 * - No remote frame transport. Frames never cross the protocol envelope.
 * - No state-machine type enforcement. Documented contract only.
 *
 * @see docs/adrs/0009-renderer-controller-adapter-boundary.md
 */

/**
 * Lifecycle phase tag carried in {@link RendererAdapterStats} for
 * observability and optional caller-side ordering checks.
 */
export type RendererAdapterPhase = "unmounted" | "mounted" | "disposed";

/**
 * Observability metadata returned by {@link RendererAdapter.stats}.
 *
 * The `joins` map carries identifiers that connect the renderer trace to
 * the rest of the observability chain (session id, request id, task id,
 * surface id) per ADR-0009's "metadata-joinable" framing. ADR-0009 flagged
 * that end-to-end correlation is not fully threaded yet, so this is named
 * `joins` rather than committing to specific keys; slot-2 prototype will
 * firm up the conventional set.
 *
 * Extend with backend-specific counters (frame budget, draw calls, buffer
 * sizes) via the `Stats` generic parameter on {@link RendererAdapter}.
 */
export interface RendererAdapterStats {
  /** Lifecycle phase the adapter is currently in. */
  readonly phase: RendererAdapterPhase;
  /** Joinable identifiers for observability correlation. Keys are not
   * normatively constrained in slot-1. */
  readonly joins?: Readonly<Record<string, string>>;
}

/**
 * Discriminated-union payload accepted by {@link RendererAdapter.apply}.
 *
 * Verbatim shape from cognee-claude Q3 decision: the snapshot branch
 * carries `snapshot`, the delta branch carries `update`. The asymmetric
 * field naming preserves caller-intent vocabulary (a "delta" carries an
 * "update"; a "snapshot" carries a "snapshot").
 *
 * Adapter authors switch on `kind` with `assertNever` exhaustiveness.
 * Extending later (e.g. `{ kind: "incremental"; patch: P }`) keeps existing
 * `kind`-switch implementations source-compatible at the `default` branch.
 */
export type RendererAdapterApplyPayload<Snapshot, Delta> =
  | { readonly kind: "snapshot"; readonly snapshot: Snapshot }
  | { readonly kind: "delta"; readonly update: Delta };

/**
 * Discriminated-union result of {@link RendererAdapter.capture}. The
 * `unavailable` branch handles "renderer not in a state to capture"
 * without exception-flow ceremony (e.g. a frame loop polling for the
 * next capture).
 */
export type RendererAdapterCaptureResult<Artifact> =
  | { readonly kind: "captured"; readonly artifact: Artifact }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * Viewport dimensions passed to {@link RendererAdapter.resize}. CSS pixels
 * by convention; adapters that need physical pixels combine with
 * `devicePixelRatio` themselves.
 */
export interface RendererAdapterDimensions {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio?: number;
}

/**
 * Optional mount-time options passed to {@link RendererAdapter.mount}.
 *
 * Open-ended `Record<string, unknown>` shape on purpose: backend-specific
 * options (preferred WebGPU power preference, OffscreenCanvas worker
 * thread handle, Canvas2D alpha hint) vary too widely to firm up here.
 * Adapter authors document accepted keys in their own JSDoc.
 */
export type RendererAdapterMountOptions = Readonly<Record<string, unknown>>;

/**
 * The host-side renderer-controller adapter lifecycle (ADR-0009 slot 1).
 *
 * Implementations attach to a `Target` (DOM element, OffscreenCanvas,
 * worker reference), accept `apply` payloads (snapshots or deltas), and
 * own their own frame loop / resource lifecycle internally.
 *
 * Peer to {@link SurfaceRenderer}: do NOT bundle the two. Choose one or the
 * other per renderer; compose if a renderer needs both surfaces.
 *
 * @typeParam Target - Mount target shape (e.g. `HTMLElement`,
 *   `OffscreenCanvas`, `{ worker: Worker }`).
 * @typeParam Snapshot - Full-state payload for `apply({kind:"snapshot"})`.
 * @typeParam Delta - Incremental-update payload for `apply({kind:"delta"})`.
 * @typeParam Artifact - Durable artifact shape returned by `capture`
 *   (PNG bytes, JSON Canvas node, scene description, etc.).
 * @typeParam Stats - Backend-specific observability extension.
 */
export interface RendererAdapter<
  Target = unknown,
  Snapshot = unknown,
  Delta = unknown,
  Artifact = unknown,
  Stats extends RendererAdapterStats = RendererAdapterStats,
> {
  /**
   * Attach to `target` and allocate resources. MUST be called before any
   * other method. Always async — implementations that complete
   * synchronously still return `Promise<void>` for uniform call sites
   * (Q2 decision: WASM/WebGPU/texture-preload commonly async).
   *
   * Calling twice on the same instance is an error; callers that need to
   * remount should `dispose()` first and instantiate a fresh adapter.
   */
  mount(target: Target, opts?: RendererAdapterMountOptions): Promise<void>;

  /**
   * Apply a scene update to the renderer's state. Discriminated-union
   * payload: snapshot replaces full state; delta is an incremental update.
   * Adapter authors switch on `kind` with `assertNever` exhaustiveness.
   *
   * Optional: adapters that only render at mount time (one-shot
   * rasterizers) may omit this method. Calling before `mount` is an error.
   */
  apply?(payload: RendererAdapterApplyPayload<Snapshot, Delta>): void | Promise<void>;

  /**
   * Handle viewport / canvas dimension changes. Optional: adapters with
   * fixed dimensions or that observe their target directly (e.g.
   * ResizeObserver internally) may omit this method. Calling before
   * `mount` is an error.
   */
  resize?(dims: RendererAdapterDimensions): void | Promise<void>;

  /**
   * Emit a durable artifact representing the renderer's current state.
   * Returns a discriminated-union result; the `unavailable` branch
   * handles "not in a state to capture" without throwing.
   *
   * Optional: adapters without a durable-artifact concept (ambient
   * always-on visualizations) may omit this method.
   */
  capture?(
    opts?: Readonly<Record<string, unknown>>,
  ): RendererAdapterCaptureResult<Artifact> | Promise<RendererAdapterCaptureResult<Artifact>>;

  /**
   * Return joinable observability metadata. Always safe to call
   * (including before `mount` — returns `{ phase: "unmounted" }`).
   *
   * Optional: adapters without observability needs may omit this method;
   * callers can synthesize `{ phase: "mounted" }` defensively.
   */
  stats?(): Stats | Promise<Stats>;

  /**
   * Release resources and detach from target. MUST be the last call on
   * this instance. Idempotent: calling twice is a no-op. After `dispose`,
   * no further methods may be invoked.
   */
  dispose(): void | Promise<void>;
}
