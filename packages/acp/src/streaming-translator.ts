/**
 * Shared ACP→consumer event translator.
 *
 * Owns the canonical "ACP `SessionNotification` → typed sink call"
 * translation for ACP `SessionUpdate` variants the consumers care
 * about: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
 * `tool_call_update`, `plan`, `available_commands_update`,
 * `current_mode_update`, `usage_update`, and `session_info_update`.
 * Two consumers feed it via different sinks:
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
 * Variants intentionally NOT translated: `config_option_update` and
 * `user_message_chunk`. `config_option_update` is a consumer-state
 * concern handled at the ACP-host layer; `user_message_chunk` is an
 * echo of input the consumer already has.
 */
import type {
  AvailableCommand,
  Cost,
  PlanEntry,
  SessionNotification,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
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
  /** ACP `ToolCall.kind` — category (read/edit/execute/think/...). Renamed
   *  to `toolKind` so it doesn't collide with discriminator `kind` fields
   *  on downstream metadata envelopes. */
  toolKind?: ToolKind;
  /** ACP `ToolCall.content` — content blocks the harness produced at start
   *  (text/image/audio/resource_link/resource/diff/terminal). Carried
   *  unchanged so consumers can render the proper variant. */
  content?: ToolCallContent[];
  /** ACP `ToolCall.locations` — file paths + optional line numbers for
   *  "follow-along" features. */
  locations?: ToolCallLocation[];
  /** ACP `ToolCall.rawInput` — the unredacted args sent to the tool.
   *  Schema-typed as `unknown` because tools define their own input
   *  shapes. */
  rawInput?: unknown;
  /** ACP `ToolCall.rawOutput` — the unredacted output. Optional at
   *  start because most tools haven't produced output yet, but some
   *  harnesses populate eagerly. */
  rawOutput?: unknown;
}

/** Argument shape for `AcpStreamingSink.onToolCallUpdate`.
 *
 *  Mirrors the ACP `ToolCallUpdate` shape with three-state semantics
 *  for `content` / `locations`: `undefined` = no change, `null` =
 *  explicit clear, value = replacement. `status` and `toolKind` use
 *  two-state semantics (absent vs present) — the SDK admits `null`
 *  for status but its meaning ("no change") is equivalent to absence
 *  on the wire, so the translator normalizes to `undefined`. */
export interface ToolCallUpdateCall {
  toolCallId: string;
  /** Updated status. `"completed"` / `"failed"` indicate terminal
   *  states; absent means the harness sent a payload-only update.
   *  Receivers preserve their prior status when this is absent. */
  status?: string;
  /** Replacement content blocks per ACP `ToolCallUpdate.content`. */
  content?: ToolCallContent[] | null;
  /** Replacement locations per ACP `ToolCallUpdate.locations`. Renamed
   *  from the prior `rawLocations` to match the SDK's typed shape. */
  locations?: ToolCallLocation[] | null;
  /** Updated tool kind. ACP allows mid-call kind transitions (rare). */
  toolKind?: ToolKind;
  /** Updated raw args — ACP allows mid-call replacement. */
  rawInput?: unknown;
  /** Updated raw output. Most commonly populated on terminal status. */
  rawOutput?: unknown;
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

/** Argument shape for `AcpStreamingSink.onSessionInfoUpdate`.
 *
 *  Mirrors ACP `SessionInfoUpdate` (title + updatedAt). Both fields
 *  are `string | null | undefined` per the SDK: `null` is an explicit
 *  clear ("agent withdrew the title / has no timestamp"), `undefined`
 *  means the field was omitted from the notification (no change),
 *  and a string is a replacement. */
export interface SessionInfoUpdateCall {
  /** Human-readable session title. `null` clears, `undefined` means
   *  no change. */
  title?: string | null;
  /** ISO 8601 timestamp of last activity. `null` clears, `undefined`
   *  means no change. */
  updatedAt?: string | null;
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
  /** Fired once per `session_info_update` notification with session
   *  metadata (title / updatedAt). */
  onSessionInfoUpdate(input: SessionInfoUpdateCall): void;
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
        // `ToolCallNotification` shape, so all `ToolCall` fields are
        // typed without casts. The translator forwards the full set
        // (kind, content, locations, rawInput, rawOutput) so consumers
        // can render rich tool-call detail. Each is conditionally
        // included so receivers can distinguish "harness omitted" from
        // "harness sent empty".
        if (!update.toolCallId) return;
        sink.onToolCallStart({
          toolCallId: update.toolCallId,
          title: update.title ?? "",
          ...(update.status !== undefined ? { status: update.status } : {}),
          ...(update.kind !== undefined ? { toolKind: update.kind } : {}),
          ...(update.content !== undefined ? { content: update.content } : {}),
          ...(update.locations !== undefined ? { locations: update.locations } : {}),
          ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
          ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
        });
        return;
      }
      case "tool_call_update": {
        if (!update.toolCallId) return;
        // The ACP SDK distinguishes three states for content / locations:
        // omitted (`undefined`) = no change, `null` = explicit clear,
        // value = replacement. Those forward through to the sink as
        // `T[] | null | undefined`. Status and kind use two-state
        // semantics — the SDK admits `null` (= "no change" by spec)
        // but its meaning is equivalent to absence on the wire, so we
        // normalize `null` to `undefined` here. Receivers don't need
        // to special-case null for these fields.
        sink.onToolCallUpdate({
          toolCallId: update.toolCallId,
          ...(typeof update.status === "string" ? { status: update.status } : {}),
          ...(update.content !== undefined ? { content: update.content } : {}),
          ...(update.locations !== undefined ? { locations: update.locations } : {}),
          ...(update.kind != null ? { toolKind: update.kind } : {}),
          ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
          ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
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
      case "session_info_update": {
        // ACP `SessionInfoUpdate` lets the harness mutate session
        // metadata (title / updatedAt) at any point. Three-state per
        // field: undefined = omitted (no change), null = explicit
        // clear, string = replacement. Forward exactly so the TUI can
        // render dynamic session names without inventing "no-change"
        // semantics on the receiver side.
        sink.onSessionInfoUpdate({
          ...(update.title !== undefined ? { title: update.title } : {}),
          ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
        });
        return;
      }
      // Remaining variants (config_option_update, user_message_chunk)
      // are intentionally ignored — config is a consumer-state concern
      // handled elsewhere; user_message_chunk is an echo of input the
      // consumer already has.
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
