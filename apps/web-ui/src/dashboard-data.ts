/**
 * Gateway dashboard data layer — pure mappers + IO seams.
 *
 * Splits the dashboard's logic from its DOM bootstrap (`dashboard-root.ts`) so
 * the fleet view-model and the SSE reducer are unit-testable without a browser,
 * mirroring the `host-view.ts` / `inbox.ts` pure-core split.
 *
 * The dashboard's connected-agent list is a low-frequency, accessible control
 * panel, so it renders as plain Lit DOM (`dashboard-root.ts`) rather than
 * through the A2UI `renderSurface` path — whose frozen catalog has no list
 * container (`AcpTranscript` is a chat surface with its own message model, not a
 * layout primitive). The wasm renderer keeps its own catalog for the viz panel.
 */
import type { A2uiSurfaceInput } from "@q4m/wasm-canvas-renderer";

/** The dashboard's view of one connected gateway harness/agent. */
export interface DashboardAgent {
  readonly id: string;
  readonly displayName: string;
  readonly primary: boolean;
  readonly ready: boolean;
}

/** Immutable fleet state keyed by harness id. */
export type DashboardState = ReadonlyMap<string, DashboardAgent>;

/** A minimal view of a gateway bus event (`/events` SSE envelope). */
export interface GatewayBusEventLike {
  readonly type: string;
  readonly payload: unknown;
}

export type FleetCardResult =
  | { readonly ok: true; readonly agents: DashboardAgent[] }
  | { readonly ok: false; readonly error: string; readonly message?: string };

/** Seed fleet state from an initial agent list (e.g. the agent-card snapshot). */
export function seedState(agents: readonly DashboardAgent[]): DashboardState {
  return new Map(agents.map((a) => [a.id, a]));
}

// -- SSE reducer -------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function coerceAgent(entry: unknown): DashboardAgent | null {
  const r = asRecord(entry);
  if (!r || typeof r.id !== "string") return null;
  return {
    id: r.id,
    displayName: typeof r.displayName === "string" ? r.displayName : r.id,
    primary: r.primary === true,
    ready: r.ready === true,
  };
}

/**
 * Apply one `gateway.harness.*` event to fleet state. Returns the SAME state
 * reference for events that don't change the fleet (no re-render churn).
 */
export function reduceHarnessEvent(
  state: DashboardState,
  event: GatewayBusEventLike,
): DashboardState {
  const p = asRecord(event.payload);
  if (!p) return state;

  switch (event.type) {
    case "gateway.harness.child-spawned": {
      const id = typeof p.harnessId === "string" ? p.harnessId : null;
      if (!id) return state;
      const next = new Map(state);
      // A spawn payload may carry a full fleet snapshot in `capabilities`.
      if (Array.isArray(p.capabilities)) {
        for (const entry of p.capabilities) {
          const agent = coerceAgent(entry);
          if (agent) next.set(agent.id, agent);
        }
      }
      const existing = state.get(id);
      next.set(id, {
        id,
        displayName: typeof p.harnessDisplayName === "string" ? p.harnessDisplayName : id,
        primary: existing?.primary ?? false,
        ready: true,
      });
      return next;
    }
    case "gateway.harness.child-exited": {
      const id = typeof p.harnessId === "string" ? p.harnessId : null;
      const existing = id ? state.get(id) : undefined;
      if (!id || !existing) return state;
      const next = new Map(state);
      next.set(id, { ...existing, ready: false });
      return next;
    }
    case "gateway.harness.card-changed": {
      // Key off harnessId for consistency with child-spawned/exited — the map
      // is harnessId-keyed, so never trust newEntry.id to match.
      const id = typeof p.harnessId === "string" ? p.harnessId : null;
      const agent = coerceAgent(p.newEntry);
      if (!id || !agent) return state;
      const next = new Map(state);
      next.set(id, { ...agent, id });
      return next;
    }
    default:
      return state;
  }
}

// -- Fleet view-model (pure) -------------------------------------------------

/** A render-ready agent row for the Lit dashboard. */
export interface FleetRow {
  readonly id: string;
  readonly displayName: string;
  readonly ready: boolean;
  readonly primary: boolean;
}

/** The dashboard's render-ready view: a summary line + one row per agent. */
export interface FleetView {
  readonly summary: string;
  readonly rows: FleetRow[];
}

/**
 * Project fleet state into a render-ready view-model. Pure: the Lit template in
 * `dashboard-root.ts` maps `rows` to accessible DOM. Empty fleet yields an
 * explicit empty-state summary and no rows (the view renders a non-blank
 * marker).
 */
export function toFleetView(state: DashboardState): FleetView {
  const rows = [...state.values()].map((a) => ({
    id: a.id,
    displayName: a.displayName,
    ready: a.ready,
    primary: a.primary,
  }));
  const ready = rows.filter((r) => r.ready).length;
  const summary =
    rows.length === 0 ? "No agents connected yet." : `${ready}/${rows.length} agents ready`;
  return { summary, rows };
}

// -- Wasm viz panel surface (pure) -------------------------------------------

/** Max activity rows painted on the wasm viz canvas. */
export const VIZ_FEED_LIMIT = 8;

/**
 * Build the wasm viz panel's surface — a live activity feed of the most recent
 * gateway event types. Uses the wasm renderer's OWN catalog (`AcpColumn` +
 * `AcpMessage`), which is richer than the Lit `ACP_BINDINGS` set. Pure so it is
 * unit-testable without loading the wasm module (the `A2uiSurfaceInput` import
 * is type-only).
 */
export function buildVizSurface(eventTypes: readonly string[]): A2uiSurfaceInput {
  if (eventTypes.length === 0) {
    return {
      root: "viz-root",
      components: {
        "viz-root": { type: "AcpColumn", gap: 8, children: ["viz-idle"] },
        "viz-idle": { type: "AcpMessage", body: "Idle — waiting for gateway activity…" },
      },
    };
  }
  const recent = eventTypes.slice(-VIZ_FEED_LIMIT);
  const components: Record<
    string,
    { type: string; body?: string; gap?: number; children?: string[] }
  > = {};
  const childIds: string[] = [];
  recent.forEach((type, i) => {
    const id = `viz-row-${i}`;
    components[id] = { type: "AcpMessage", body: type };
    childIds.push(id);
  });
  components["viz-root"] = { type: "AcpColumn", gap: 8, children: childIds };
  return { root: "viz-root", components: components as A2uiSurfaceInput["components"] };
}

// -- IO seams ----------------------------------------------------------------

/**
 * Fetch the gateway agent-card and map `capabilities.harnesses[]` to agents.
 * Mirrors `inbox.ts` `fetchInbox`'s discriminated-union error contract.
 */
export async function fetchFleetCard(
  gatewayUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FleetCardResult> {
  const url = new URL("/.well-known/agent-card.json", gatewayUrl);
  let res: Response;
  try {
    res = await fetchImpl(url.toString());
  } catch (err) {
    return { ok: false, error: "network-error", message: errMessage(err) };
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    return {
      ok: false,
      error: "invalid-response",
      message: `HTTP ${res.status} — ${errMessage(err)}`,
    };
  }
  const caps = asRecord(asRecord(parsed)?.capabilities);
  const harnesses = caps?.harnesses;
  if (!Array.isArray(harnesses)) {
    return { ok: false, error: "invalid-response", message: `HTTP ${res.status} — no harnesses[]` };
  }
  const agents = harnesses.map(coerceAgent).filter((a): a is DashboardAgent => a !== null);
  return { ok: true, agents };
}

/** Liveness of the `/events` stream, surfaced so the UI can flag a drop. */
export type StreamStatus = "open" | "reconnecting";

/**
 * Subscribe to the gateway `/events` SSE stream (trusted-network gated, no
 * Bearer). `EventSource` auto-reconnects on a drop, but silently — `onStatus`
 * lets the caller surface a "reconnecting" signal so the dashboard never shows
 * stale fleet state as if it were live. Returns an unsubscribe that closes the
 * stream.
 */
export function subscribeEvents(
  gatewayUrl: string,
  onEvent: (event: GatewayBusEventLike) => void,
  onStatus?: (status: StreamStatus) => void,
): () => void {
  const url = new URL("/events", gatewayUrl);
  const source = new EventSource(url.toString());
  source.onopen = () => onStatus?.("open");
  source.onmessage = (ev: MessageEvent) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ev.data);
    } catch {
      return;
    }
    const r = asRecord(parsed);
    if (r && typeof r.type === "string") {
      onEvent({ type: r.type, payload: r.payload });
    }
  };
  // Fires on both transient reconnects and permanent close; either way the
  // stream is not currently live, so flag it.
  source.onerror = () => onStatus?.("reconnecting");
  return () => source.close();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
