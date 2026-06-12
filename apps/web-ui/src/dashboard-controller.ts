/**
 * Renderer-agnostic mount orchestration for the Gateway Dashboard surface.
 *
 * This is the seam between the dashboard route and ANY ADR-0009
 * `RendererAdapter` — the wasm-canvas renderer (the M0 target) or any other.
 * It owns only the lifecycle ordering (`mount` → optional `apply` → `dispose`)
 * so the DOM bootstrap in `dashboard.ts` stays thin and this logic is unit
 * testable without a real canvas or WASM module (mirrors the `host-view.ts`
 * pure-logic split).
 *
 * "Start empty" is honored two ways: pass the empty dashboard snapshot to paint
 * the empty-state marker, or mount an adapter that omits `apply` to leave the
 * canvas blank. Either way the adapter is mounted and disposable.
 */
import type { RendererAdapter } from "@agents-js/a2ui-host";

export interface DashboardSurfaceHandle {
  /** Tear down the renderer and detach from the canvas. Idempotent per ADR-0009. */
  dispose(): Promise<void>;
}

/**
 * Mount `adapter` onto `canvas`, then apply the dashboard `snapshot` if the
 * adapter supports `apply` (optional in the base contract). Returns a handle
 * whose `dispose()` releases the renderer.
 */
export async function mountDashboardSurface<Snapshot>(
  adapter: RendererAdapter<HTMLCanvasElement, Snapshot>,
  canvas: HTMLCanvasElement,
  snapshot: Snapshot,
): Promise<DashboardSurfaceHandle> {
  await adapter.mount(canvas);
  if (adapter.apply) {
    await adapter.apply({ kind: "snapshot", snapshot });
  }
  return {
    async dispose() {
      await adapter.dispose();
    },
  };
}
