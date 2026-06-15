/**
 * A2Canvas board-host — the stateful bridge between the pure reducer and any
 * transport (SSE, WebSocket, a test harness).
 *
 * It owns the single mutable {@link A2CanvasBoard}, applies every event through
 * {@link applyA2CanvasUpdate} (so the single-writer invariant holds — the reducer
 * is still the sole mutator), and notifies subscribers only when an ingest
 * actually changes the board (stale/duplicate updates are silent no-ops, so the
 * viewer gets no spurious wakeups).
 *
 * It is transport-free on purpose: the gateway `/events` SSE handler is a thin
 * adapter over `subscribe()`, mounted via `composeAdditionalFetch` — the board
 * itself never reaches the renderer or the wire.
 */
import {
  type A2CanvasAgentUpdate,
  type A2CanvasBoard,
  type A2CanvasView,
  applyA2CanvasUpdate,
  emptyBoard,
  toA2CanvasView,
} from "./index.ts";

export type A2CanvasViewListener = (view: A2CanvasView) => void;

export interface A2CanvasBoardHost {
  /** Apply one update through the reducer; notifies subscribers iff the board changed. */
  ingest(ev: A2CanvasAgentUpdate): void;
  /** Apply a batch in order; notifies once per update that actually changed the board. */
  ingestAll(events: Iterable<A2CanvasAgentUpdate>): void;
  /** Current laned, newest-first snapshot for the viewer. */
  view(): A2CanvasView;
  /** Subscribe to post-change views. Returns an unsubscribe fn. */
  subscribe(listener: A2CanvasViewListener): () => void;
}

export function createA2CanvasBoardHost(boardId = "default"): A2CanvasBoardHost {
  let board: A2CanvasBoard = emptyBoard(boardId);
  const listeners = new Set<A2CanvasViewListener>();

  function ingest(ev: A2CanvasAgentUpdate): void {
    const next = applyA2CanvasUpdate(board, ev);
    if (next === board) return; // stale / no-op — reducer returned same ref, stay silent
    board = next;
    const view = toA2CanvasView(board);
    for (const listener of listeners) listener(view);
  }

  return {
    ingest,
    ingestAll(events) {
      for (const ev of events) ingest(ev);
    },
    view() {
      return toA2CanvasView(board);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
