/**
 * A2Canvas viewer data layer — pure parse + view-model, plus the SSE IO seam.
 *
 * Splits the viewer's logic from its DOM bootstrap (the Lit element) so the
 * frame parsing and the identity-grounded card mapping are unit-testable
 * without a browser — mirroring the `dashboard-data.ts` / `dashboard-root.ts`
 * split.
 *
 * The key M0 invariant lives here: `isVerified` (from the model) decides
 * whether a card renders trusted or `unverified`, so a spoofed/unsigned update
 * is *visibly* untrusted in the UI rather than silently rendered as real.
 */
import { type A2CanvasCard, type A2CanvasView, isVerified } from "@agents-js/a2canvas";

/** A render-ready card: flat display fields + the trust flag the badge keys on. */
export interface ViewerCard {
  readonly id: string;
  readonly who: string; // principal.id (verifier-derived, never X-Agent-Name)
  readonly host: string;
  readonly task: string;
  readonly summary: string;
  readonly updatedAt: number;
  /** isVerified(card): signed && assertedVia==="jwt". `false` → render 'unverified'. */
  readonly verified: boolean;
  readonly actions: readonly { readonly label: string; readonly ref: string }[];
}

export interface ViewerLane {
  readonly lane: string;
  readonly cards: readonly ViewerCard[];
}

function asViewerCard(card: A2CanvasCard): ViewerCard {
  return {
    id: card.id,
    who: card.principal.id,
    host: card.host,
    task: card.task.label,
    summary: card.change.summary,
    updatedAt: card.updatedAt,
    verified: isVerified(card),
    actions: card.next?.actions ?? [],
  };
}

/** Map a board view to render-ready lanes, computing the trust flag per card. */
export function toViewerLanes(view: A2CanvasView): ViewerLane[] {
  return view.lanes.map((lane) => ({
    lane: lane.lane,
    cards: lane.cards.map(asViewerCard),
  }));
}

/**
 * Parse one SSE `data:` payload into an {@link A2CanvasView}. Returns `null` on
 * malformed JSON or wrong shape instead of throwing, so a single bad frame
 * never tears down the live viewer.
 */
export function parseA2CanvasView(data: string): A2CanvasView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { lanes?: unknown }).lanes)
  ) {
    return null;
  }
  return parsed as A2CanvasView;
}

/** Liveness of the `/a2canvas/events` stream, surfaced so the UI can flag a drop. */
export type StreamStatus = "open" | "reconnecting";

/**
 * Subscribe to the gateway `/a2canvas/events` SSE stream. `EventSource`
 * auto-reconnects on a drop but silently — `onStatus` lets the viewer surface a
 * "reconnecting" signal so it never shows a stale board as if it were live.
 * Returns an unsubscribe that closes the stream. Mirrors `subscribeEvents`.
 */
export function subscribeA2CanvasView(
  gatewayUrl: string,
  onView: (view: A2CanvasView) => void,
  onStatus?: (status: StreamStatus) => void,
): () => void {
  const url = new URL("/a2canvas/events", gatewayUrl);
  const source = new EventSource(url.toString());
  source.onopen = () => onStatus?.("open");
  source.onmessage = (ev: MessageEvent) => {
    const view = parseA2CanvasView(ev.data);
    if (view) onView(view);
  };
  source.onerror = () => onStatus?.("reconnecting");
  return () => source.close();
}
