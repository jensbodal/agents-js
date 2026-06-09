/**
 * Harness-agnostic inbox sink — the poll→emit spine shared by every harness.
 *
 * {@link runInboxPoller} delivers each new durable-inbox row to an `onMessage`
 * sink. That sink does the same harness-independent work for any consumer:
 * extract the real author, map the row's fields into channel meta, present the
 * trusted relay as the gate-checked sender (the real author travels in meta, per
 * the adapter's sender-spoofing defense), surface a routable reply target, and
 * throw on a non-emit so the poller retries the row instead of marking it seen.
 *
 * Only the final hand-off — turning that mapped frame into something a specific
 * harness consumes — is harness-specific. {@link createInboxSink} injects that as
 * the `emit` callback: Claude Code passes `server.emitChannelMessage` (emitting a
 * `notifications/claude/channel` frame); a second harness passes its own surface.
 * The inbound transport a non-Claude harness ultimately uses is an open decision
 * (ADR-0008) and is deliberately NOT named here — this module only owns the
 * mapping spine, so a second-harness sink composes it rather than re-implementing
 * the loop.
 */
import type { InboxMessage } from "./gateway-inbox-client.ts";
import { replyTargetForRow } from "./reply-routing.ts";
import type { EmitResult } from "./server.ts";

/** Default trusted relay sender presented to the channel server's sender-gate. */
const DEFAULT_RELAY_SENDER = "agents-gateway-inbox";

/**
 * Harness-specific surface for one mapped inbound row. Returns a typed
 * {@link EmitResult}; a status other than `"emitted"` makes the sink throw so the
 * poller retries. Claude Code's impl is `ClaudeChannelServer.emitChannelMessage`.
 */
export type ChannelEmit = (input: {
  readonly content: string;
  readonly sender: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}) => Promise<EmitResult>;

/** Options for {@link createInboxSink}. */
export interface InboxSinkOptions {
  /** Harness-specific emit for one mapped row (the only non-generic part). */
  readonly emit: ChannelEmit;
  /**
   * Sender presented to the channel server's sender-gate. The real author always
   * travels in `meta.sender_identity`; the gate checks this trusted relay, never
   * row-supplied content. Defaults to {@link DEFAULT_RELAY_SENDER}.
   */
  readonly relaySender?: string;
  /**
   * Invoked with each row's routable reply target (or `undefined` when the row
   * carries no `send_message`-routable origin) so a caller can thread a bare
   * reply back to whoever pushed the most-recent message.
   */
  readonly onReplyTarget?: (target: string | undefined) => void;
  /** Optional structured logger for per-row emit outcomes. */
  readonly logger?: { readonly log: (message: string) => void };
}

/**
 * Build the {@link runInboxPoller} `onMessage` sink: map one inbox row to a
 * channel-emit input, report its reply target, and throw on a non-emit so the
 * poller retries rather than silently marking the row seen.
 */
export function createInboxSink(options: InboxSinkOptions): (row: InboxMessage) => Promise<void> {
  const relaySender = options.relaySender ?? DEFAULT_RELAY_SENDER;
  const log = options.logger?.log;
  return async (row: InboxMessage): Promise<void> => {
    const author = row.matrix_origin?.sender ?? row.sender ?? "unknown";
    // Remember where a bare reply should go, and surface it as a routable
    // `reply_to` attribute so the agent (and operator logs) can see it.
    const replyTo = replyTargetForRow(row);
    options.onReplyTarget?.(replyTo);
    const res = await options.emit({
      content: row.body,
      sender: relaySender,
      meta: {
        source: "agents_gateway_inbox",
        sender_identity: author,
        kind: row.kind ?? "agents_message",
        message_id: row.message_id,
        ...(replyTo ? { reply_to: replyTo } : {}),
        ...(row.idempotency_key ? { idempotency_key: row.idempotency_key } : {}),
        ...(row.matrix_origin?.room_id ? { room_id: row.matrix_origin.room_id } : {}),
        ...(row.matrix_origin?.event_id ? { matrix_event_id: row.matrix_origin.event_id } : {}),
      },
    });
    log?.(`INBOUND emit message_id=${row.message_id} status=${res.status}`);
    if (res.status !== "emitted") {
      // Surface non-emit so a sender-gate/sanitizer reject is visible and the
      // poller retries rather than silently marking the row seen.
      throw new Error(`emit rejected: ${res.status}`);
    }
  };
}
