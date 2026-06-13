/**
 * Gateway dashboard — the web-ui front door (`/`).
 *
 * Renders the connected-agent fleet as accessible Lit DOM (a real `<ul>` of
 * agent rows — selectable, navigable), seeded from the gateway agent-card and
 * kept live by the `/events` SSE stream. An embedded wasm canvas viz panel
 * (`dashboard-viz-panel.ts`) paints a high-frequency activity feed beside it —
 * each renderer doing what ADR-0009 scopes it for (DOM for the control panel,
 * wasm canvas for the high-frequency visualization).
 *
 * This is the single front door: the former `/dashboard` route and the old
 * landing page are retired. Chat/inbox are reachable from the header nav.
 */
import { resolveBrowserLaunchConfig } from "@agents-js/ui-components/web-ui-glue";
import { html, nothing, render } from "lit";
import {
  type DashboardState,
  type FleetView,
  fetchFleetCard,
  reduceHarnessEvent,
  type StreamStatus,
  seedState,
  subscribeEvents,
  toFleetView,
} from "./dashboard-data.ts";
import { mountVizPanel } from "./dashboard-viz-panel.ts";

const app = document.getElementById("app");
if (!app) throw new Error("Missing #app mount point");

// Static page chrome (fixed markup — no interpolation). The live agent list
// renders into #dashboard-surface via Lit; the wasm viz panel owns
// #dashboard-viz imperatively, so the two never fight over the same subtree.
app.innerHTML = `
  <header class="dashboard-hero">
    <div class="dashboard-hero-title">
      <h1>Gateway Dashboard</h1>
      <p>Control plane &middot; live fleet</p>
    </div>
    <nav class="dashboard-nav" aria-label="Surfaces">
      <a class="dashboard-navlink" href="/chat">Chat &rarr;</a>
      <a class="dashboard-navlink" href="/inbox">Inbox &rarr;</a>
    </nav>
  </header>
  <main class="dashboard-body">
    <section id="dashboard-surface" class="dashboard-surface" aria-label="Connected agents"></section>
    <section id="dashboard-viz" class="dashboard-viz" aria-label="Live gateway activity"></section>
  </main>
`;

const surfaceMount = app.querySelector<HTMLElement>("#dashboard-surface");
const vizMount = app.querySelector<HTMLElement>("#dashboard-viz");
if (!surfaceMount || !vizMount) {
  throw new Error("Missing dashboard mount points");
}

function renderFleet(view: FleetView, error: string | null): void {
  if (!surfaceMount) return;
  const tpl = error
    ? html`<p class="dashboard-error" role="alert">${error}</p>`
    : html`
        <p class="dashboard-summary">${view.summary}</p>
        <ul class="agent-list">
          ${view.rows.map(
            (r) => html`
              <li class="agent-row" data-ready=${String(r.ready)}>
                <span class="agent-dot ${r.ready ? "ok" : "down"}" aria-hidden="true"></span>
                <span class="agent-name">${r.displayName}</span>
                ${r.primary ? html`<span class="agent-badge">primary</span>` : nothing}
                <span class="agent-status">${r.ready ? "ready" : "down"}</span>
              </li>
            `,
          )}
        </ul>
      `;
  render(tpl, surfaceMount);
}

const browserEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
const launchConfig = resolveBrowserLaunchConfig({
  search: new URLSearchParams(window.location.search),
  savedUrl: undefined,
  envTargetUrl: browserEnv?.VITE_AGENTS_DEFAULT_TARGET_URL,
  envWsUrl: browserEnv?.VITE_AGENTS_DEFAULT_WS_URL,
});
const gatewayUrl = launchConfig.defaultTargetUrl || window.location.origin;

let state: DashboardState = seedState([]);
let connection: StreamStatus = "open";
let fatalError: string | null = null;

function rerender(): void {
  if (fatalError) {
    renderFleet(toFleetView(state), fatalError);
    return;
  }
  const view = toFleetView(state);
  // Flag a dropped SSE stream so live-looking fleet state isn't trusted as live.
  const summary = connection === "reconnecting" ? `${view.summary} · reconnecting…` : view.summary;
  renderFleet({ ...view, summary }, null);
}

rerender();

void (async () => {
  const viz = await mountVizPanel(vizMount);

  const card = await fetchFleetCard(gatewayUrl);
  if (card.ok) {
    state = seedState(card.agents);
  } else {
    // Error-first: a reachable-but-broken gateway shows the reason, never blank.
    fatalError = `Gateway unreachable — ${card.error}${card.message ? `: ${card.message}` : ""}`;
    console.error("[dashboard] agent-card fetch failed", card);
  }
  rerender();

  // Live fleet + activity updates. A dropped stream auto-reconnects; `onStatus`
  // surfaces the gap so stale state isn't shown as live.
  subscribeEvents(
    gatewayUrl,
    (event) => {
      viz.pushEvent(event.type);
      const next = reduceHarnessEvent(state, event);
      if (next !== state) {
        state = next;
        rerender();
      }
    },
    (status) => {
      if (connection !== status) {
        connection = status;
        rerender();
      }
    },
  );
})().catch((error: unknown) => {
  fatalError = `Dashboard failed to mount: ${String(error)}`;
  console.error(error);
  rerender();
});
