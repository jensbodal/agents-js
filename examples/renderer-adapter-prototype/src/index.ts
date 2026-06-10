/**
 * `@agents-js/example-renderer-adapter-prototype` — ADR-0009 slot-2
 * host-local prototype proving the {@link RendererAdapter} lifecycle types
 * from `@agents-js/a2ui-host`.
 *
 * **Slot-2 purpose** (per ADR-0009): provide ONE host-local prototype
 * demonstrating that the lifecycle interface is implementable, the
 * documented ordering contract is testable, and the discriminated-union
 * apply payload + capture result + joinable stats work in practice. NOT
 * a production canvas integration.
 *
 * **Why a mock target instead of real HTMLCanvasElement**:
 *
 * Real Canvas2D requires a DOM. The ADR-0009 lifecycle contract is
 * backend-agnostic — proving it with a real canvas would entangle the
 * proof with DOM/jsdom setup, while a mock target with the same lifecycle
 * surface proves the SAME invariants without that ceremony.
 *
 * Future adapter implementations (real Canvas2D via OffscreenCanvas,
 * WebGL, WebGPU, WASM) consume the same `RendererAdapter` interface and
 * inherit the same lifecycle contract. This prototype proves the
 * contract is implementable; production backends prove the same contract
 * is performant.
 *
 * **What the prototype demonstrates**
 *
 * 1. A minimal `RendererAdapter` is implementable with mount + dispose
 *    only, leaving apply/resize/capture/stats as no-ops or omitted.
 * 2. A "full" `RendererAdapter` is implementable with all 6 lifecycle
 *    methods, exercising the discriminated-union apply payload, the
 *    discriminated-union capture result, and the joinable stats shape.
 * 3. The documented lifecycle ordering (mount before all, dispose
 *    last, mount-twice-error, methods-after-dispose-error) is
 *    behaviourally testable.
 * 4. dispose() idempotency works (calling twice is a no-op).
 * 5. `capture()` emits a REAL durable artifact — a JSON Canvas document
 *    produced by `@agents-js/canvas-model` — satisfying ADR-0009 slot-2
 *    goal (b). This binding gives the canvas-model durable-export surface
 *    its first live consumer through the renderer-controller boundary.
 *
 * **Critique-first reasoning**
 *
 * - **Boundary**: the renderer-adapter type surface comes from
 *   `@agents-js/a2ui-host`; the durable-artifact surface comes from
 *   `@agents-js/canvas-model`. The prototype does NOT depend on
 *   `@agents-js/host`, `@agents-js/gateway-runtime`, or any A2UI runtime
 *   package — the renderer-controller adapter sits below those layers and
 *   only reaches sideways to canvas-model at the `capture()` boundary, which
 *   is exactly where ADR-0009 places the durable-export handoff.
 * - **Default**: prototype defaults to deny-state-machine: methods called
 *   in invalid order throw with a descriptive error. Better than silent
 *   no-op for a slot-2 validation prototype.
 * - **Contract**: the prototype's `MockCanvasTarget` records every
 *   operation in an `ops` log so tests can assert exact lifecycle
 *   sequences. This is debug-aid scaffolding, not production behavior.
 * - **Safety**: dispose() is idempotent + sets phase to "disposed";
 *   subsequent calls to apply/resize/capture/stats throw. Mount-twice
 *   throws (per ADR-0009 contract: "Calling twice on the same instance
 *   is an error; callers ... should `dispose()` first and instantiate
 *   a fresh adapter").
 * - **Validation**: behavioural tests cover both minimal + full adapters,
 *   ordering errors, idempotent dispose, capture availability, the
 *   captured JSON Canvas document shape (real structured artifact, not a
 *   string) including the lossy-export warning, and stats-before-mount
 *   fallback to "unmounted" phase.
 *
 * @packageDocumentation
 */

import type {
  RendererAdapter,
  RendererAdapterApplyPayload,
  RendererAdapterCaptureResult,
  RendererAdapterDimensions,
  RendererAdapterMountOptions,
  RendererAdapterPhase,
  RendererAdapterStats,
} from "@agents-js/a2ui-host";
import {
  createA2uiCanvasNode,
  exportJsonCanvas,
  type JsonCanvasExportResult,
} from "@agents-js/canvas-model";

// ============================================================================
// Mock target (stands in for HTMLCanvasElement / OffscreenCanvas)
// ============================================================================

/**
 * Mock canvas-like target. Records every operation in `ops` so tests can
 * assert exact lifecycle sequences without DOM setup.
 *
 * Production adapters would target `HTMLCanvasElement` (DOM thread) or
 * `OffscreenCanvas` (worker thread). The prototype's mock has the same
 * lifecycle surface (allocate / draw / resize / clear) without the DOM.
 */
export interface MockCanvasTarget {
  /** Operation log, populated by the adapter. Tests assert against this. */
  readonly ops: string[];

  /** Current viewport dimensions (last resize wins). */
  width: number;
  height: number;

  /** Last applied frame snapshot string (for capture). */
  lastFrame: string;
}

export function createMockCanvasTarget(): MockCanvasTarget {
  return {
    ops: [],
    width: 0,
    height: 0,
    lastFrame: "",
  };
}

// ============================================================================
// Scene snapshot + delta shapes (caller-defined)
// ============================================================================

/**
 * Full scene snapshot — replaces target state. Simplified for the
 * prototype; production schemas would carry richer scene graph data.
 */
export interface SceneSnapshot {
  readonly bgColor: string;
  readonly items: readonly string[];
}

/**
 * Incremental scene delta — applied on top of current state.
 */
export interface SceneDelta {
  readonly added?: readonly string[];
  readonly removed?: readonly string[];
}

/**
 * Captured artifact type. The adapter's `capture()` binds to
 * `@agents-js/canvas-model`: it emits a {@link JsonCanvasExportResult} — a
 * real, structured JSON Canvas document (nodes + edges + lossy-export
 * warnings) — NOT a hand-rolled string. This is the ADR-0009 slot-2 goal
 * (b) ("renderer can emit JSON Canvas durable artifacts via the `capture()`
 * method") made real: canvas-model's durable-export surface gets its first
 * live consumer through the renderer-controller boundary.
 */
export type SceneArtifact = JsonCanvasExportResult;

// ============================================================================
// Prototype adapter — full lifecycle implementation
// ============================================================================

/**
 * Options accepted by the prototype's `mount`. The shape is OPTIONAL +
 * backend-specific per ADR-0009 Q4 decision (mount opts are
 * `Record<string, unknown>`). The prototype reads `initialBgColor` if
 * supplied; otherwise defaults to "#fff".
 */
export interface PrototypeMountOptions {
  readonly initialBgColor?: string;
  /**
   * Surface identity carried onto the captured JSON Canvas node id and the
   * `stats()` `surface_id` join. Defaults to `"prototype"`.
   */
  readonly surfaceId?: string;
}

/**
 * Internal phase tracking. Distinct from {@link RendererAdapterPhase} so
 * we can layer additional lifecycle states without polluting the public
 * Stats shape.
 */
type InternalPhase = "unmounted" | "mounted" | "disposed";

/**
 * Build a full prototype adapter. Implements every lifecycle method
 * (mount/apply/resize/capture/stats/dispose) to demonstrate the contract.
 */
export function createPrototypeAdapter(): RendererAdapter<
  MockCanvasTarget,
  SceneSnapshot,
  SceneDelta,
  SceneArtifact,
  RendererAdapterStats
> {
  let phase: InternalPhase = "unmounted";
  let target: MockCanvasTarget | null = null;
  let surfaceId = "prototype";
  let bgColor = "#fff";
  let items: string[] = [];
  let frameCount = 0;

  function ensureMounted(method: string): MockCanvasTarget {
    if (phase === "unmounted") {
      throw new Error(`renderer-adapter-prototype: ${method} called before mount`);
    }
    if (phase === "disposed") {
      throw new Error(`renderer-adapter-prototype: ${method} called after dispose`);
    }
    if (target === null) {
      throw new Error(`renderer-adapter-prototype: target lost (invariant violation)`);
    }
    return target;
  }

  return {
    async mount(t, opts?: RendererAdapterMountOptions): Promise<void> {
      if (phase === "mounted") {
        throw new Error(
          "renderer-adapter-prototype: mount called twice on same instance (dispose + new instance instead)",
        );
      }
      if (phase === "disposed") {
        throw new Error(
          "renderer-adapter-prototype: mount called after dispose (instantiate a fresh adapter instead)",
        );
      }
      target = t;
      const proto = opts as PrototypeMountOptions | undefined;
      bgColor = proto?.initialBgColor ?? "#fff";
      surfaceId = proto?.surfaceId ?? "prototype";
      items = [];
      frameCount = 0;
      target.ops.push(`mount bg=${bgColor}`);
      phase = "mounted";
    },

    async apply(payload: RendererAdapterApplyPayload<SceneSnapshot, SceneDelta>): Promise<void> {
      const t = ensureMounted("apply");
      switch (payload.kind) {
        case "snapshot": {
          bgColor = payload.snapshot.bgColor;
          items = [...payload.snapshot.items];
          break;
        }
        case "delta": {
          if (payload.update.added) {
            items = [...items, ...payload.update.added];
          }
          if (payload.update.removed) {
            const removedSet = new Set(payload.update.removed);
            items = items.filter((i) => !removedSet.has(i));
          }
          break;
        }
        default: {
          // assertNever — discriminated-union exhaustiveness
          const _exhaustive: never = payload;
          throw new Error(
            `renderer-adapter-prototype: unhandled apply payload kind: ${JSON.stringify(_exhaustive)}`,
          );
        }
      }
      frameCount += 1;
      const frame = `frame${frameCount} bg=${bgColor} items=[${items.join(",")}]`;
      t.lastFrame = frame;
      t.ops.push(`apply ${payload.kind}`);
    },

    resize(dims: RendererAdapterDimensions): void {
      const t = ensureMounted("resize");
      t.width = dims.width;
      t.height = dims.height;
      t.ops.push(`resize ${dims.width}x${dims.height}`);
    },

    capture(): RendererAdapterCaptureResult<SceneArtifact> {
      const t = ensureMounted("capture");
      if (frameCount === 0) {
        return {
          kind: "unavailable",
          reason: "no frame applied yet",
        };
      }

      // Reconstruct the current scene as an A2UI-surface-shaped payload, then
      // hand it to canvas-model. `createA2uiCanvasNode` stores the payload
      // inert and `exportJsonCanvas` produces a durable JSON Canvas document
      // (with the lossy-preview warning canvas-model emits). Each item's
      // `text` field is harvested into the JSON Canvas preview by
      // canvas-model's TEXT_KEYS pass — so labels appear in the artifact.
      const surface = {
        id: surfaceId,
        background: bgColor,
        components: items.map((label, index) => ({
          id: `${surfaceId}-c${index}`,
          type: "text",
          text: label,
        })),
      };
      const node = createA2uiCanvasNode(surface, {
        id: surfaceId,
        title: `renderer capture (frame ${frameCount})`,
        size: { width: t.width || 360, height: t.height || 240 },
      });
      return {
        kind: "captured",
        artifact: exportJsonCanvas([node]),
      };
    },

    stats(): RendererAdapterStats {
      // stats() is safe to call before mount per ADR-0009 contract.
      const renderedPhase: RendererAdapterPhase = phase;
      return {
        phase: renderedPhase,
        joins: {
          // joinable observability identifiers per ADR-0009
          surface_id: surfaceId,
          frame_count: String(frameCount),
        },
      };
    },

    dispose(): void {
      if (phase === "disposed") {
        // Idempotent per ADR-0009 contract.
        return;
      }
      if (target !== null) {
        target.ops.push("dispose");
      }
      target = null;
      items = [];
      frameCount = 0;
      phase = "disposed";
    },
  };
}

// ============================================================================
// Minimal adapter — only mount + dispose implemented
// ============================================================================

/**
 * Build a MINIMAL prototype adapter. Only implements `mount` and
 * `dispose` — the other lifecycle methods are omitted entirely (the
 * interface declares them optional per ADR-0009 "all non-mount/dispose
 * methods OPTIONAL" decision).
 *
 * Demonstrates that adapters which don't need apply/resize/capture/stats
 * can express that by omitting the methods — no stubs that lie about
 * capability.
 */
export function createMinimalPrototypeAdapter(): RendererAdapter<
  MockCanvasTarget,
  SceneSnapshot,
  SceneDelta,
  SceneArtifact,
  RendererAdapterStats
> {
  let phase: InternalPhase = "unmounted";
  let target: MockCanvasTarget | null = null;

  return {
    async mount(t): Promise<void> {
      if (phase !== "unmounted") {
        throw new Error("renderer-adapter-minimal: mount called twice");
      }
      target = t;
      t.ops.push("minimal-mount");
      phase = "mounted";
    },

    dispose(): void {
      if (phase === "disposed") return;
      if (target !== null) {
        target.ops.push("minimal-dispose");
      }
      target = null;
      phase = "disposed";
    },
  };
}
