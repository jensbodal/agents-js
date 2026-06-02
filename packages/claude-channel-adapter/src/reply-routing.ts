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
  /**
   * Native author identity for `agents_message` rows — the only field that
   * yields a `send_message`-routable target (a directory entity name). Matrix
   * room/mxid origins are intentionally NOT consulted; see {@link replyTargetForRow}.
   */
  readonly sender?: string;
}

/**
 * A target string the gateway's `send_message` can actually resolve. The
 * gateway resolves `target` against a directory keyed by peer ENTITY NAME
 * (`TargetDirectory.resolve` in host/load-trust-manifest.ts) — there is NO
 * reverse lookup from a Matrix room id or mxid. So a raw room id (`!room:hs`)
 * or mxid (`@alice:hs`) is NOT routable and 404s with `unknown-target`; only
 * a plain entity name resolves.
 */
function isRoutableEntityName(s: string | undefined): s is string {
  return !!s && !s.startsWith("@") && !s.startsWith("!");
}

/**
 * Routable reply target for a single inbound row, or `undefined` when the row
 * carries no `send_message`-routable origin.
 *
 * Returns the row's `sender` only when it is a plausible directory entity name
 * (a native agent identity). For Matrix room mentions the origin is a room id
 * / mxid, which the gateway directory cannot resolve, so this returns
 * `undefined` and the caller falls through to an explicit `target` or the
 * configured fallback. Replying *into* the originating Matrix room needs a
 * gateway-side reverse route (room id/mxid → entity) that does not exist yet —
 * tracked as a follow-up, not papered over with a guaranteed-404 target.
 */
export function replyTargetForRow(row: ReplyRoutingRow): string | undefined {
  return isRoutableEntityName(row.sender) ? row.sender : undefined;
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
