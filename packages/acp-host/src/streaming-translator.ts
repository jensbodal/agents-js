/**
 * Shared ACP-streaming translator.
 *
 * Owns the canonical "ACP `SessionNotification` → typed sink call"
 * translation for the streaming-shaped subset of `SessionUpdate` variants
 * (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
 * `tool_call_update`). Two consumers feed it via different sinks:
 *
 *   - **A2A executor** (`@agents-js/a2a/src/executor.ts`) — sink emits
 *     A2A `Message` events per chunk so the wire delivers per-token
 *     deltas. Replaces the previous burst-emitting buffer in v0.2.x
 *     that all-at-once-rendered the response on the CLI TUI.
 *
 *   - **AG-UI handler** (`@agents-js/host/src/acp-to-agui-translator.ts`)
 *     — sink emits AG-UI `BaseEvent`s, delegating non-streaming session
 *     updates back to the existing AG-UI translator surface so we don't
 *     re-implement plan / mode / config translation here.
 *
 * Per ACP spec
 * (https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
 * `agent_message_chunk.content.text` carries the *delta*, not cumulative
 * text. The translator passes the delta through verbatim while also
 * computing and surfacing the cumulative text so sinks that need either
 * shape get both without re-deriving.
 *
 * State: per-instance `messageId → cumulativeText` map, scoped per
 * session. One translator instance per ACP session.
 *
 * Non-streaming `SessionUpdate` variants (plan, current_mode_update,
 * available_commands_update, config_option_update, usage_update,
 * session_info_update) are explicitly *not* translated here — they're
 * handled by consumer-specific paths so this module stays focused on
 * the streaming-render contract.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk";

/**
 * Argument shape for `AcpStreamingSink.onTextDelta` and
 * `onThoughtDelta`. Both `delta` (incremental text added by this chunk)
 * and `cumulativeText` (running total per `messageId`) are surfaced so
 * sinks can choose either or both without re-deriving.
 */
export interface TextDeltaCall {
  /** Stable identifier for the in-flight message. ACP guarantees that
   *  all chunks belonging to one logical message share `messageId`. */
  messageId: string;
  /** The incremental text added by this chunk. Already a delta per ACP
   *  spec — translator does not re-compute. */
  delta: string;
  /** Running concatenation of all deltas for this `messageId` so far. */
  cumulativeText: string;
}

/** Argument shape for `AcpStreamingSink.onToolCallStart`. */
export interface ToolCallStartCall {
  toolCallId: string;
  /** Human-readable label from `ToolCall.title`. May be empty. */
  title: string;
  /** Initial status. Typically `"pending"` or `"in_progress"`. */
  status?: string;
}

/** Argument shape for `AcpStreamingSink.onToolCallUpdate`. */
export interface ToolCallUpdateCall {
  toolCallId: string;
  /** Updated status. `"completed"` / `"failed"` indicate terminal states. */
  status?: string;
  /** Optional updated content blocks (e.g. tool result diffs). */
  content?: unknown;
  /** Optional updated locations metadata. */
  rawLocations?: unknown;
}

/**
 * Sink contract: consumers implement these methods to receive translated
 * streaming events. Methods are invoked synchronously; the sink owns any
 * downstream async dispatch (e.g. publishing on an event bus, queuing on
 * an SSE writer).
 */
export interface AcpStreamingSink {
  /** Fired once per `agent_message_chunk` notification with non-empty text. */
  onTextDelta(input: TextDeltaCall): void;
  /** Fired once per `agent_thought_chunk` notification with non-empty text. */
  onThoughtDelta(input: TextDeltaCall): void;
  /** Fired once per `tool_call` notification (initial registration of a tool call). */
  onToolCallStart(input: ToolCallStartCall): void;
  /** Fired once per `tool_call_update` notification (status / content updates). */
  onToolCallUpdate(input: ToolCallUpdateCall): void;
}

/**
 * Stateful per-session translator. Instantiate one per ACP session.
 *
 * The translator does no I/O and holds no transport handles — it's a
 * pure data transformer with private accumulator state. Tests should
 * exercise it directly (no mocks needed) by passing
 * `RecordingAcpStreamingSink` (see `tests/streaming-translator.test.ts`).
 */
export class AcpStreamingTranslator {
  /**
   * Per-`messageId` running concatenation of agent-message deltas. ACP
   * spec: chunks with the same `messageId` belong to the same logical
   * message; a different `messageId` indicates a new message has
   * started.
   */
  private readonly messageCumulative = new Map<string, string>();

  /** Per-`messageId` running concatenation of agent-thought deltas.
   *  Tracked separately from message text so a `messageId` shared
   *  across both channels (rare but spec-allowed) doesn't cross-pollute. */
  private readonly thoughtCumulative = new Map<string, string>();

  feed(notification: SessionNotification, sink: AcpStreamingSink): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type !== "text") return;
        const text = update.content.text ?? "";
        if (text.length === 0) return;
        const messageId = readMessageId(update);
        if (!messageId) return; // Drop unidentifiable chunks rather than synthesize.
        const previous = this.messageCumulative.get(messageId) ?? "";
        const cumulativeText = previous + text;
        this.messageCumulative.set(messageId, cumulativeText);
        sink.onTextDelta({ messageId, delta: text, cumulativeText });
        return;
      }
      case "agent_thought_chunk": {
        if (update.content.type !== "text") return;
        const text = update.content.text ?? "";
        if (text.length === 0) return;
        const messageId = readMessageId(update);
        if (!messageId) return;
        const previous = this.thoughtCumulative.get(messageId) ?? "";
        const cumulativeText = previous + text;
        this.thoughtCumulative.set(messageId, cumulativeText);
        sink.onThoughtDelta({ messageId, delta: text, cumulativeText });
        return;
      }
      case "tool_call": {
        const toolCall = update as unknown as {
          toolCallId?: string;
          id?: string;
          title?: string;
          status?: string;
        };
        const toolCallId = toolCall.toolCallId ?? toolCall.id ?? "";
        if (!toolCallId) return;
        sink.onToolCallStart({
          toolCallId,
          title: toolCall.title ?? "",
          status: toolCall.status,
        });
        return;
      }
      case "tool_call_update": {
        const toolCall = update as unknown as {
          toolCallId?: string;
          id?: string;
          status?: string;
          content?: unknown;
          rawLocations?: unknown;
        };
        const toolCallId = toolCall.toolCallId ?? toolCall.id ?? "";
        if (!toolCallId) return;
        sink.onToolCallUpdate({
          toolCallId,
          status: toolCall.status,
          content: toolCall.content,
          rawLocations: toolCall.rawLocations,
        });
        return;
      }
      // Non-streaming variants are intentionally ignored. Consumers that
      // need plan / mode / commands / config / usage / session_info
      // forwarding handle those via their own paths.
      default:
        return;
    }
  }
}

/**
 * Read `messageId` defensively from a `ContentChunk`-shaped update.
 * The field is part of the ACP schema but marked UNSTABLE, and some
 * harness implementations may omit it.
 */
function readMessageId(update: unknown): string | undefined {
  if (
    update &&
    typeof update === "object" &&
    "messageId" in update &&
    typeof (update as { messageId: unknown }).messageId === "string"
  ) {
    const value = (update as { messageId: string }).messageId.trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}
