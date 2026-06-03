/**
 * Pure host-bridge → chat-view transcript routing.
 *
 * Extracted from `applyHostState` in `main.ts` so the routing is unit
 * testable without the module-level glue. This is the link that broke in
 * DOT-532: in AG-UI mode the prompt is issued via `POST /agent`, so the A2A
 * client controller never observes the turn and its derived
 * `transcript`/`pendingText` stay empty. The host bridge carries the agent
 * text (assembled by `mapSnapshot` into `transcript`/`pendingAgentText`), so
 * when the bridge is active it becomes the source of truth for the rendered
 * transcript; otherwise (A2A mode, `?run=a2a`) the controller-derived
 * transcript is preserved untouched.
 */

export interface TranscriptEntry {
  id: string;
  role: string;
  text: string;
}

export interface HostBridgeViewInput {
  /** True when the host-bridge WS is active for the connected target. */
  showHostState: boolean;
  /** Status string to apply to the view regardless of source. */
  displayedStatus: string;
  /** Host-bridge transcript (from `mapSnapshot`); used only when active. */
  transcript?: TranscriptEntry[] | null;
  /** Host-bridge in-flight streaming text; used only when active. */
  pendingAgentText?: string | null;
}

/**
 * Merge host-bridge transcript state into the chat view.
 *
 * - host bridge active → `transcript`/`pendingText` come from the bridge.
 * - host bridge inactive → preserve the existing (controller-derived)
 *   `transcript`/`pendingText`; only `status` is updated.
 */
export function routeHostBridgeView<
  V extends { status: string; transcript: TranscriptEntry[]; pendingText: string },
>(view: V, input: HostBridgeViewInput): V {
  if (!input.showHostState) {
    return { ...view, status: input.displayedStatus };
  }
  return {
    ...view,
    status: input.displayedStatus,
    transcript: input.transcript ?? [],
    pendingText: input.pendingAgentText ?? "",
  };
}
