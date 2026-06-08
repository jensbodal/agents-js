/**
 * Root landing surface (`/`).
 *
 * Renders an A2UI canvas surface through the a2ui-renderer pipeline
 * (`A2uiHost` + `renderSurface` — the same render path the chat surface mounts
 * and the RendererAdapter visual proof exercised) as the default page, with
 * navigation to the chat (`/chat`) and inbox (`/inbox`) surfaces.
 *
 * This supersedes the prior "root = chat app" default: the chat bootstrap now
 * lives in `chat.ts` (served at `/chat`). The three entry points are plain
 * multi-entry static HTML (vite `rollupOptions.input`) — no gateway or
 * SPA-fallback change.
 */
import { A2uiBridge, A2uiHost } from "@agents-js/a2ui-host";
import { renderSurface } from "@agents-js/a2ui-renderer";
import "@agents-js/ui-components";
import { buildLandingMessages } from "./landing-surface.ts";

function mountLanding(app: HTMLElement): void {
  app.innerHTML = `
    <header class="landing-hero">
      <h1>agents-js</h1>
      <p>Your agent. Everywhere.</p>
    </header>
    <main class="landing-body">
      <section id="landing-surface" class="landing-surface" aria-label="A2UI canvas surface"></section>
      <nav class="landing-nav" aria-label="Surfaces">
        <a class="landing-card" href="/chat">
          <span class="landing-card-title">Chat &rarr;</span>
          <span class="landing-card-desc">Talk to a runtime over ACP / AG-UI.</span>
        </a>
        <a class="landing-card" href="/inbox">
          <span class="landing-card-title">Inbox &rarr;</span>
          <span class="landing-card-desc">Browse delivered agent messages.</span>
        </a>
      </nav>
    </main>
  `;

  const surfaceMount = app.querySelector<HTMLElement>("#landing-surface");
  if (!surfaceMount) {
    throw new Error("Missing #landing-surface mount");
  }

  // The landing surface is non-interactive, so the bridge sink is a no-op —
  // there are no user-driven surface events to forward to a host.
  const bridge = new A2uiBridge({
    sink: {
      sendSurfaceEvent() {
        /* landing surface is non-interactive */
      },
    },
  });
  const host = new A2uiHost(surfaceMount, { renderer: renderSurface, onEvent: bridge.onEvent });
  bridge.attachHost(host);

  for (const message of buildLandingMessages()) {
    bridge.applyInbound(message);
  }
}

const app = document.getElementById("app");
if (!app) {
  throw new Error("Missing #app mount point");
}
mountLanding(app);
