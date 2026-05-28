/**
 * Type-shape validation for {@link RendererAdapter} (ADR-0009 slot 1).
 *
 * Slot-1 is types-only — no behavioural semantics to test. We verify:
 * 1. Minimal adapter (mount + dispose only) satisfies the interface.
 * 2. Full adapter implementing every method type-checks with narrowed
 *    generic parameters.
 * 3. `apply` discriminated-union payload narrows in adapter switches.
 * 4. `capture` discriminated-union result narrows in caller handling.
 * 5. Async `mount` returns Promise (Q2 decision).
 *
 * Behavioural validation lives in slot-2 (host-local prototype, Canvas2D
 * backend) where a real adapter surfaces ordering invariants.
 */
import { describe, expect, test } from "bun:test";
import type {
  RendererAdapter,
  RendererAdapterApplyPayload,
  RendererAdapterCaptureResult,
  RendererAdapterDimensions,
  RendererAdapterStats,
} from "../src/renderer-adapter.ts";

describe("RendererAdapter — type-shape validation (ADR-0009 slot 1)", () => {
  test("minimal adapter (mount + dispose only) satisfies the interface", () => {
    const adapter: RendererAdapter = {
      async mount(_target: unknown): Promise<void> {},
      dispose(): void {},
    };
    expect(typeof adapter.mount).toBe("function");
    expect(typeof adapter.dispose).toBe("function");
    expect(adapter.apply).toBeUndefined();
    expect(adapter.resize).toBeUndefined();
    expect(adapter.capture).toBeUndefined();
    expect(adapter.stats).toBeUndefined();
  });

  test("full adapter with narrowed generics type-checks end-to-end", () => {
    interface SceneSnapshot {
      readonly nodes: readonly { readonly id: string }[];
    }
    interface SceneDelta {
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
    interface PngArtifact {
      readonly mime: "image/png";
      readonly bytes: Uint8Array;
    }
    interface FrameStats extends RendererAdapterStats {
      readonly frameCount: number;
      readonly frameBudgetMs: number;
    }

    const adapter: RendererAdapter<
      HTMLElement,
      SceneSnapshot,
      SceneDelta,
      PngArtifact,
      FrameStats
    > = {
      async mount(_target: HTMLElement): Promise<void> {},
      apply(payload: RendererAdapterApplyPayload<SceneSnapshot, SceneDelta>): void {
        // Adapter-side switch — both branches typed.
        switch (payload.kind) {
          case "snapshot": {
            const _nodes: readonly { readonly id: string }[] = payload.snapshot.nodes;
            return;
          }
          case "delta": {
            const _added: readonly string[] = payload.update.added;
            return;
          }
        }
      },
      resize(_dims: RendererAdapterDimensions): void {},
      capture(): RendererAdapterCaptureResult<PngArtifact> {
        return { kind: "unavailable", reason: "not implemented" };
      },
      stats(): FrameStats {
        return { phase: "mounted", frameCount: 0, frameBudgetMs: 16.7 };
      },
      dispose(): void {},
    };
    expect(adapter.mount).toBeDefined();
    expect(adapter.apply).toBeDefined();
    expect(adapter.resize).toBeDefined();
    expect(adapter.capture).toBeDefined();
    expect(adapter.stats).toBeDefined();
    expect(adapter.dispose).toBeDefined();
  });

  test("apply payload narrows via kind discriminator", () => {
    function handleSnapshot<S>(payload: RendererAdapterApplyPayload<S, unknown>): S | null {
      if (payload.kind === "snapshot") {
        return payload.snapshot;
      }
      return null;
    }
    function handleDelta<D>(payload: RendererAdapterApplyPayload<unknown, D>): D | null {
      if (payload.kind === "delta") {
        return payload.update;
      }
      return null;
    }
    expect(handleSnapshot({ kind: "snapshot", snapshot: { v: 1 } })).toEqual({ v: 1 });
    expect(handleSnapshot({ kind: "delta", update: { d: 1 } })).toBeNull();
    expect(handleDelta({ kind: "delta", update: { d: 2 } })).toEqual({ d: 2 });
    expect(handleDelta({ kind: "snapshot", snapshot: { v: 2 } })).toBeNull();
  });

  test("capture result narrows via kind discriminator", () => {
    function describeCapture<A>(result: RendererAdapterCaptureResult<A>): string {
      if (result.kind === "captured") {
        return `got: ${typeof result.artifact}`;
      }
      return `unavailable: ${result.reason}`;
    }
    expect(describeCapture({ kind: "captured", artifact: { png: true } })).toBe("got: object");
    expect(describeCapture({ kind: "unavailable", reason: "before mount" })).toBe(
      "unavailable: before mount",
    );
  });

  test("async mount returns Promise (Q2 decision)", async () => {
    const adapter: RendererAdapter<{ worker: Worker }> = {
      async mount(_target: { worker: Worker }): Promise<void> {},
      async dispose(): Promise<void> {},
    };
    const mountResult = adapter.mount({ worker: {} as Worker });
    expect(mountResult instanceof Promise).toBe(true);
    await mountResult;
  });

  test("dimensions: devicePixelRatio is optional", () => {
    const minDims: RendererAdapterDimensions = { width: 100, height: 50 };
    const fullDims: RendererAdapterDimensions = {
      width: 100,
      height: 50,
      devicePixelRatio: 2,
    };
    expect(minDims.devicePixelRatio).toBeUndefined();
    expect(fullDims.devicePixelRatio).toBe(2);
  });

  test("stats: joins map is optional, accepts string-to-string", () => {
    const minStats: RendererAdapterStats = { phase: "mounted" };
    const fullStats: RendererAdapterStats = {
      phase: "mounted",
      joins: { sessionId: "s-1", surfaceId: "surf-1" },
    };
    expect(minStats.joins).toBeUndefined();
    expect(fullStats.joins?.sessionId).toBe("s-1");
  });

  test("phase tag union covers documented lifecycle states", () => {
    const states: RendererAdapterStats["phase"][] = ["unmounted", "mounted", "disposed"];
    expect(states.length).toBe(3);
  });

  test("dispose is callable twice (idempotent per contract)", async () => {
    let disposeCount = 0;
    const adapter: RendererAdapter = {
      async mount(_target: unknown): Promise<void> {},
      dispose(): void {
        disposeCount++;
      },
    };
    adapter.dispose();
    adapter.dispose();
    expect(disposeCount).toBe(2);
    // NOTE: idempotency is an implementer contract, not enforced here.
    // This test documents that the interface permits double-dispose;
    // implementations decide what to do (slot-2 prototype enforces no-op).
  });
});
