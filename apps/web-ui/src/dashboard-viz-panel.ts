/**
 * Wasm canvas viz panel — the gateway dashboard's live activity surface.
 *
 * Per ADR-0009 the wasm/WebGL renderer is the *high-frequency* tier, so the
 * canvas is no longer the whole dashboard (that's the accessible Lit surface in
 * `dashboard-root.ts`) — it's an embedded panel that paints a live feed of
 * gateway events. Mounts through the renderer-agnostic `mountDashboardSurface`
 * seam (`dashboard-controller.ts`) + `createWasmCanvasRendererAdapter`.
 *
 * The wasm adapter has no delta path (`Delta = never`), so live updates are
 * repeated `apply({kind:"snapshot"})` coalesced to ≤1 paint per animation frame.
 */
import { createWasmCanvasRendererAdapter, resolveA2uiSurface } from "@q4m/wasm-canvas-renderer";
import { mountDashboardSurface } from "./dashboard-controller.ts";
import { buildVizSurface } from "./dashboard-data.ts";

const VIZ_WIDTH = 680;
const VIZ_HEIGHT = 200;
const EVENT_BUFFER = 64;

export interface VizPanelHandle {
  /** Record a gateway event type and schedule a coalesced repaint. */
  pushEvent(type: string): void;
  /** Tear down the renderer and cancel any pending frame. */
  dispose(): Promise<void>;
}

export async function mountVizPanel(container: HTMLElement): Promise<VizPanelHandle> {
  const canvas = document.createElement("canvas");
  canvas.width = VIZ_WIDTH;
  canvas.height = VIZ_HEIGHT;
  canvas.dataset.testid = "dashboard-viz-canvas";
  container.appendChild(canvas);

  const adapter = createWasmCanvasRendererAdapter({ width: VIZ_WIDTH, logger: console });
  const events: string[] = [];
  const handle = await mountDashboardSurface(
    adapter,
    canvas,
    resolveA2uiSurface(buildVizSurface(events)),
  );

  let frame = 0;
  function schedulePaint(): void {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      void adapter.apply?.({
        kind: "snapshot",
        snapshot: resolveA2uiSurface(buildVizSurface(events)),
      });
    });
  }

  return {
    pushEvent(type: string): void {
      events.push(type);
      if (events.length > EVENT_BUFFER) events.splice(0, events.length - EVENT_BUFFER);
      schedulePaint();
    },
    async dispose(): Promise<void> {
      if (frame !== 0) cancelAnimationFrame(frame);
      await handle.dispose();
    },
  };
}
