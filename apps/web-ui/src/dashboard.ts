/**
 * Gateway Dashboard route (`/dashboard`).
 *
 * Renders the EMPTY dashboard A2UI surface through the a2ui-renderer pipeline
 * (`A2uiBridge` + `A2uiHost` + `renderSurface`) — the same proven render path
 * the landing (`/`) and chat (`/chat`) surfaces use — so the dashboard route is
 * servable today.
 *
 * M0 target: render this same surface through the **wasm-canvas
 * `RendererAdapter`** (the canvas seam, proven end-to-end in the wasm-canvas
 * adapter demo). That swap point is `mountDashboardSurface` in
 * `dashboard-controller.ts` — renderer-agnostic over any ADR-0009
 * `RendererAdapter`. The wasm-canvas adapter plugs in there once it is a
 * workspace dependency (cross-repo wiring). The empty surface content
 * (`buildDashboardSurface`) is renderer-independent, so neither the route nor
 * the surface changes when the canvas renderer swaps in.
 */
import { A2uiBridge, A2uiHost } from "@agents-js/a2ui-host";
import { renderSurface } from "@agents-js/a2ui-renderer";
import "@agents-js/ui-components";
import { buildDashboardSurface } from "./dashboard-surface.ts";

function mountDashboard(app: HTMLElement): void {
  app.innerHTML = `
    <header class="dashboard-hero">
      <h1>Gateway Dashboard</h1>
      <p>Control plane &middot; empty</p>
    </header>
    <main class="dashboard-body">
      <section id="dashboard-surface" class="dashboard-surface" aria-label="Gateway dashboard canvas surface"></section>
    </main>
  `;

  const surfaceMount = app.querySelector<HTMLElement>("#dashboard-surface");
  if (!surfaceMount) {
    throw new Error("Missing #dashboard-surface mount point");
  }

  const bridge = new A2uiBridge({
    sink: {
      sendSurfaceEvent() {
        /* dashboard surface is non-interactive in the empty M0 frame */
      },
    },
  });
  const host = new A2uiHost(surfaceMount, { renderer: renderSurface, onEvent: bridge.onEvent });
  bridge.attachHost(host);

  for (const message of buildDashboardSurface()) {
    bridge.applyInbound(message);
  }
}

const app = document.getElementById("app");
if (!app) {
  throw new Error("Missing #app mount point");
}
mountDashboard(app);
