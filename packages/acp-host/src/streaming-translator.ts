/**
 * Shared ACP→consumer event translator.
 *
 * Owns the canonical "ACP `SessionNotification` → typed sink call"
 * translation for ACP `SessionUpdate` variants the consumers care
 * about: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
 * `tool_call_update`, `plan`, `available_commands_update`,
 * `current_mode_update`, and `usage_update`. Two consumers feed it
 * via different sinks:
 *
 *   - **A2A executor** (`@agents-js/a2a/src/executor.ts`) — sink emits
 *     A2A `TaskStatusUpdateEvent`s with `state: "working"` and a
 *     `metadata.kind` discriminator (see `@agents-js/a2a/wire-kinds`).
 *     `Message` events are not used because `@a2a-js/sdk`'s server
 *     `events()` AsyncGenerator treats any `Message` as terminal,
 *     which would end the stream prematurely on the first non-text
 *     event. The TaskStatusUpdate path is non-terminal.
 *
 *   - **AG-UI handler** (`@agents-js/host/src/acp-to-agui-translator.ts`)
 *     — sink emits AG-UI `BaseEvent`s. The AG-UI consumer was
 *     historically served by `ACPSessionController` for non-streaming
 *     variants and continues that pattern; the streaming-translator
 *     callbacks for plan/commands/mode/usage exist on the AG-UI side
 *     as no-op stubs to satisfy the sink contract.
 *
 * Per ACP spec
 * (https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
 * `agent_message_chunk.content.text` carries the *delta*, not cumulative
 * text. The translator passes the delta through verbatim while also
 * computing and surfacing the cumulative text so sinks that need either
 * shape get both without re-deriving.
 *
 * State: per-instance `messageId → cumulativeText` maps for both
 * message and thought streams, scoped per session. Plan / commands /
 * mode / usage variants carry full state on each notification — the
 * translator forwards them stateless. One translator instance per
 * ACP session.
 *
 * Variants intentionally NOT translated: `config_option_update`,
 * `session_info_update`, `user_message_chunk`. The first two are
 * consumer-state concerns; the third is an echo of input the
 * consumer already has.
 */
import type {
  AvailableCommand,
  Cost,
  PlanEntry,
  SessionNotification,
} from "@agentclientprotocol/sdk";

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

/** Argument shape for `AcpStreamingSink.onPlanUpdate`. ACP `plan`
 *  notifications always carry the FULL set of entries — consumers
 *  replace plan state wholesale on receipt. Entries reuse the SDK's
 *  typed `PlanEntry` so `priority` is the proper `PlanEntryPriority`
 *  string enum and `status` is the proper `PlanEntryStatus`. */
export interface PlanUpdateCall {
  entries: PlanEntry[];
}

/** Argument shape for `AcpStreamingSink.onAvailableCommandsUpdate`.
 *  Carries the FULL set of commands available from the harness via
 *  the SDK's typed `AvailableCommand` shape (preserves
 *  description, input schema, and any extension metadata). */
export interface AvailableCommandsUpdateCall {
  commands: AvailableCommand[];
}

/** Argument shape for `AcpStreamingSink.onModeChange`.
 *  ACP `current_mode_update` notifications only carry `currentModeId`
 *  (the available-modes list lives in initial session metadata, not
 *  on transitions). Receivers that want labels/descriptions look up
 *  `modes` from session state. */
export interface ModeChangeCall {
  currentModeId: string;
}

/** Argument shape for `AcpStreamingSink.onUsageUpdate`. */
export interface UsageUpdateCall {
  /** Total context window size in tokens. */
  size: number;
  /** Tokens used so far in this session. */
  used: number;
  /** Cumulative session cost. Reuses the SDK's `Cost` type
   *  (`{ amount, currency }`) so multi-currency values are
   *  preserved end-to-end. `null` is a valid harness signal for
   *  "no-cost session"; `undefined` means the field was omitted. */
  cost?: Cost | null;
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
  /** Fired once per `plan` notification with the full updated entry list. */
  onPlanUpdate(input: PlanUpdateCall): void;
  /** Fired once per `available_commands_update` notification with the full set. */
  onAvailableCommandsUpdate(input: AvailableCommandsUpdateCall): void;
  /** Fired once per `current_mode_update` notification. */
  onModeChange(input: ModeChangeCall): void;
  /** Fired once per `usage_update` notification with token-budget telemetry. */
  onUsageUpdate(input: UsageUpdateCall): void;
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
        // Inside this branch TypeScript narrows `update` to the SDK's
        // `ToolCallNotification` shape, so `toolCallId` / `title` /
        // `status` are typed without casts. (`id`/`title` legacy
        // fallbacks are no longer needed — the SDK doesn't expose them
        // and pre-spec harnesses are out of scope.)
        if (!update.toolCallId) return;
        sink.onToolCallStart({
          toolCallId: update.toolCallId,
          title: update.title ?? "",
          ...(update.status !== undefined ? { status: update.status } : {}),
        });
        return;
      }
      case "tool_call_update": {
        if (!update.toolCallId) return;
        // ACP allows `null` status (= no-change). Treat as "no status
        // surface to executor" and let the receiver's progress/end
        // gate decide off the prior in-memory state.
        const status = update.status ?? undefined;
        sink.onToolCallUpdate({
          toolCallId: update.toolCallId,
          ...(status !== undefined ? { status } : {}),
          ...(update.content != null ? { content: update.content } : {}),
          ...(update.locations != null ? { rawLocations: update.locations } : {}),
        });
        return;
      }
      case "plan": {
        // ACP spec requires `entries: PlanEntry[]`. Forward the SDK's
        // typed shape directly so consumers receive proper
        // `priority: PlanEntryPriority` and `status: PlanEntryStatus`
        // string enums instead of widened strings.
        sink.onPlanUpdate({ entries: update.entries });
        return;
      }
      case "available_commands_update": {
        sink.onAvailableCommandsUpdate({ commands: update.availableCommands });
        return;
      }
      case "current_mode_update": {
        if (!update.currentModeId) return;
        sink.onModeChange({ currentModeId: update.currentModeId });
        return;
      }
      case "usage_update": {
        // Forward the structured `Cost` shape from the SDK
        // (`{ amount, currency }`) verbatim. `null` is a valid harness
        // signal for "no cost"; `undefined` means the field was omitted
        // and we drop it from the call so consumers can distinguish.
        sink.onUsageUpdate({
          size: update.size,
          used: update.used,
          ...(update.cost !== undefined ? { cost: update.cost } : {}),
        });
        return;
      }
      // Remaining variants (config_option_update, session_info_update,
      // user_message_chunk) are intentionally ignored — config + session
      // info are consumer-state concerns handled elsewhere; user_message_chunk
      // is an echo of input the consumer already has.
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
