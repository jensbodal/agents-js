/**
 * A2Canvas — Agent-to-canvas projection model (M0).
 *
 * Architecture (Jens's steering) + identity-grounded card contract (cognee-claude):
 *   agents emit `agent.update`  (the card IS the identity/presence record projected;
 *                                agents NEVER write the renderer or board directly)
 *     -> A2Canvas reducer        (THE single writer; owns merge + order)
 *     -> canonical board state    (this module)
 *     -> canvas-model             (visual model: createA2uiCanvasNode / exportJsonCanvas)
 *     -> wasm-canvas              (renders only; never canonical state)
 *     -> iPhone/browser viewer    (consumes the reduced view via toA2CanvasView)
 *
 * Identity invariants (tie the card to the signed-identity model):
 *   - `principal.id` + `signed` come from SIGNED-PEER -> JWT -> verifier-derived subject.
 *     The card shows VERIFIED who, never a self-asserted X-Agent-Name. `signed:false`
 *     renders as 'unverified' — a spoofed update is visibly untrusted, not a trusted card.
 *   - `authority.scopes` = what the JWT actually granted ('with what authority' is real).
 *
 * Boundary invariants (for @cognee-codex review):
 *   - The only way in is an `A2CanvasAgentUpdate`. No direct agent writes to the renderer.
 *   - `applyA2CanvasUpdate` is pure and the SOLE mutator of board state; ordering/merge
 *     is decided here (by `ts`), not in producers or the renderer.
 *   - wasm-canvas receives a derived surface, never this board object.
 */

/** WHO — the verifier-derived principal. Never a self-asserted X-Agent-Name. */
export interface A2CanvasPrincipal {
  /** e.g. "agent:hostname-null-claude-0" (or "human:jens"). */
  readonly id: string;
  /** From the signed-peer -> JWT -> verifier chain. `false` => render 'unverified'. */
  readonly signed: boolean;
  readonly mxid?: string;
}

/** WITH WHAT AUTHORITY — scopes granted by the JWT, not claimed. */
export interface A2CanvasAuthority {
  readonly scopes: readonly string[];
  readonly assertedVia: "jwt" | "none";
}

/** A follow-up the viewer can open. */
export interface A2CanvasAction {
  readonly label: string;
  readonly ref: string;
}

/** The normalized event an agent emits — the single entry point into A2Canvas. */
export interface A2CanvasAgentUpdate {
  readonly kind: "agent.update";
  readonly principal: A2CanvasPrincipal; // WHO
  readonly host: string; // WHERE (real host: malar / LXC189 / olthoi0 / hostname-null)
  readonly task: { readonly id?: string; readonly label: string }; // FOR WHAT TASK
  readonly authority: A2CanvasAuthority; // WITH WHAT AUTHORITY
  readonly change: { readonly kind: string; readonly summary: string; readonly detail?: unknown }; // WHAT CHANGED
  readonly next?: { readonly actions: readonly A2CanvasAction[] }; // WHAT CAN I OPEN NEXT
  readonly ts: number; // ms epoch — authoritative ordering key
  readonly correlationId?: string;
}

/** A single rendered card: the latest update per (principal, task), identity-true. */
export interface A2CanvasCard {
  /** Stable id: `${principal.id}:${task.id ?? "_"}`. */
  readonly id: string;
  /** M0: lane = principal.id. */
  readonly lane: string;
  readonly principal: A2CanvasPrincipal;
  readonly host: string;
  readonly task: { readonly id?: string; readonly label: string };
  readonly authority: A2CanvasAuthority;
  readonly change: { readonly kind: string; readonly summary: string; readonly detail?: unknown };
  readonly next?: { readonly actions: readonly A2CanvasAction[] };
  /** = latest update ts; orders cards within a lane. */
  readonly order: number;
  readonly updatedAt: number;
  readonly correlationId?: string;
}

/** Canonical board state. The reducer is its ONLY writer. */
export interface A2CanvasBoard {
  readonly boardId: string; // M0: "default"; M1: per task/context
  readonly cards: ReadonlyMap<string, A2CanvasCard>; // keyed by card.id
  readonly seq: number; // monotonic; lets the viewer detect change cheaply
}

export function emptyBoard(boardId = "default"): A2CanvasBoard {
  return { boardId, cards: new Map(), seq: 0 };
}

function cardId(principalId: string, taskId?: string): string {
  return `${principalId}:${taskId ?? "_"}`;
}

/**
 * The single-writer reducer. Pure: `(board, event) => board`.
 * - One card per (principal.id, task.id); a newer update REPLACES it (M0 latest-wins).
 * - Stale updates (`ts` <= current card.order) are ignored — ordering owned HERE.
 * - Never mutates the input; returns the same ref when nothing changed.
 */
export function applyA2CanvasUpdate(board: A2CanvasBoard, ev: A2CanvasAgentUpdate): A2CanvasBoard {
  if (ev.kind !== "agent.update") return board;
  const id = cardId(ev.principal.id, ev.task.id);
  const existing = board.cards.get(id);
  if (existing && existing.order >= ev.ts) return board; // stale -> ignore
  const card: A2CanvasCard = {
    id,
    lane: ev.principal.id,
    principal: ev.principal,
    host: ev.host,
    task: ev.task,
    authority: ev.authority,
    change: ev.change,
    next: ev.next,
    order: ev.ts,
    updatedAt: ev.ts,
    correlationId: ev.correlationId,
  };
  const cards = new Map(board.cards);
  cards.set(id, card);
  return { boardId: board.boardId, cards, seq: board.seq + 1 };
}

/** Is this card identity-trusted, or must the viewer render it 'unverified'? */
export function isVerified(card: A2CanvasCard): boolean {
  return card.principal.signed && card.authority.assertedVia === "jwt";
}

/** Viewer read-seam: ordered, laned snapshot the iPhone/browser viewer consumes. */
export interface A2CanvasView {
  readonly boardId: string;
  readonly seq: number;
  readonly lanes: readonly A2CanvasLane[];
}
export interface A2CanvasLane {
  readonly lane: string; // = principal.id (M0)
  readonly cards: readonly A2CanvasCard[]; // newest-first
}

/** Derive the viewer snapshot: cards laned by principal, newest-first, lanes name-sorted. */
export function toA2CanvasView(board: A2CanvasBoard): A2CanvasView {
  const byLane = new Map<string, A2CanvasCard[]>();
  for (const card of board.cards.values()) {
    const arr = byLane.get(card.lane);
    if (arr) arr.push(card);
    else byLane.set(card.lane, [card]);
  }
  const lanes: A2CanvasLane[] = [...byLane.entries()]
    .map(([lane, cards]) => ({ lane, cards: [...cards].sort((a, b) => b.order - a.order) }))
    .sort((a, b) => a.lane.localeCompare(b.lane));
  return { boardId: board.boardId, seq: board.seq, lanes };
}

/**
 * Renderer seam (signature only — wasm-canvas stays render-only). The host/web-ui maps
 * board -> canvas-model nodes (one per card via `createA2uiCanvasNode`) ->
 * `A2uiSurfaceInput` for wasm-canvas; the board is NEVER handed to the renderer.
 *
 * The concrete mapping lands in the M1 viewer PR (web-ui, reusing
 * `apps/web-ui/src/dashboard-data.ts` `buildVizSurface`), not here, to keep this
 * model free of any wasm-canvas / renderer dependency:
 *
 *   boardToCanvasSurface(board: A2CanvasBoard): A2uiSurfaceInput
 */
