/**
 * Reply-target routing for `agents_js_reply`.
 *
 * **Why this exists**
 *
 * Inbound rows surface in the `<channel>` tag with `sender` pinned to the
 * trusted relay (`agents-gateway-inbox`), NOT the real author — the author
 * travels in `meta`. If the agent naively replies with `target=<sender>` it
 * targets the relay, which has no Matrix or inbox routing and the gateway
 * rejects with `unknown-target` (404). The fix: the adapter derives a
 * *routable* reply target from the row itself and uses it when the caller
 * omits `target`, so a bare `agents_js_reply(content)` threads back to
 * whoever actually pushed the most-recent message.
 *
 * These helpers are pure so the routing contract is unit-testable away from
 * the launcher's top-level wiring.
 */

/** Minimal shape of an inbound row needed to resolve a reply target. */
export interface ReplyRoutingRow {
  /** Native author identity (mesh-routable) for `agents_message` rows. */
  readonly sender?: string;
  /** Inbox kind discriminator (`agents_message` | `matrix_room_mention`). */
  readonly kind?: string;
  /** Present on bridge-fanout rows; carries the originating room + sender. */
  readonly matrix_origin?: { readonly room_id?: string; readonly sender?: string };
}

/**
 * Routable reply target for a single inbound row, or `undefined` when the
 * row carries no addressable origin (e.g. a system/relay message).
 *
 * - Matrix room mention → reply into the originating room, falling back to
 *   the sender's mxid, then any native author.
 * - Native agent message → the authoring agent identity.
 */
export function replyTargetForRow(row: ReplyRoutingRow): string | undefined {
  if (row.kind === "matrix_room_mention" || row.matrix_origin) {
    return row.matrix_origin?.room_id ?? row.matrix_origin?.sender ?? row.sender ?? undefined;
  }
  return row.sender ?? undefined;
}

/**
 * Final reply target precedence: an explicit caller-supplied `target` wins,
 * else the most-recent inbound row's routable target, else a configured
 * coordinator fallback. `undefined` means "no routable target" — the caller
 * should surface a clear error rather than emit to the relay.
 */
export function resolveReplyTarget(
  explicit: string | undefined,
  lastInbound: string | undefined,
  fallback: string | undefined,
): string | undefined {
  return explicit ?? lastInbound ?? fallback ?? undefined;
}
