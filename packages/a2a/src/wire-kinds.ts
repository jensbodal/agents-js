/**
 * Discriminator schema for `TaskStatusUpdateEvent.metadata.kind`.
 *
 * The A2A wire surfaces non-text agent signals (thoughts, tool calls,
 * plans, mode changes, usage telemetry) via `TaskStatusUpdateEvent`
 * with a typed `metadata.kind` discriminator. We can't use `Message`
 * events for these because `@a2a-js/sdk`'s server `events()`
 * AsyncGenerator treats any `Message` as terminal — emitting a
 * thought/tool Message would end the SSE stream and drop the rest of
 * the turn (this is exactly the bug that caused the
 * `c93c95a` revert in the v0.3.0 work).
 *
 * `TaskStatusUpdateEvent` with `state: "working"` and `final: false`
 * is the proven non-terminal path the existing `agent_message_chunk`
 * text-streaming uses. Reusing it for non-text variants keeps the
 * wire shape uniform and forward-compatible: receivers that don't
 * recognize a `kind` simply observe a working-state status ping and
 * continue, so older clients degrade gracefully.
 *
 * **Schema-derived types**: `priority`, `cost`, `status`, `mode`, and
 * `command` shapes are taken straight from the ACP SDK's typed schema
 * (`@agentclientprotocol/sdk` re-exports `schema/types.gen`). We
 * deliberately do NOT redefine these as widened-string fields — that
 * would silently drop spec data (e.g. structured Cost objects, the
 * PlanEntryPriority string enum). When the SDK ships a new value in
 * one of those enums, the wire surface inherits it for free; when the
 * SDK changes a shape, our code stops compiling at the boundary
 * instead of silently mismatching at runtime.
 */
import type { AvailableCommand, Cost, PlanEntry } from "@agentclientprotocol/sdk";

/** Allowed values for `TaskStatusUpdateEvent.metadata.kind`. */
export type AgentEventKind =
  | "thought"
  | "tool-call-start"
  | "tool-call-progress"
  | "tool-call-end"
  | "plan"
  | "commands"
  | "mode-changed"
  | "usage";

/** Metadata for an `agent_thought_chunk` ACP notification.
 *  The `delta` is the incremental text added by this chunk;
 *  `cumulativeText` is the running concatenation per `messageId`. */
export interface ThoughtMetadata {
  kind: "thought";
  messageId: string;
  delta: string;
  cumulativeText: string;
}

/** Metadata for the initial registration of a tool call. */
export interface ToolCallStartMetadata {
  kind: "tool-call-start";
  toolCallId: string;
  toolName: string;
  /** ACP status at time of start: typically `"pending"` or `"in_progress"`. */
  status?: string;
}

/** Metadata for a non-terminal tool-call status transition (e.g.
 *  `pending` → `in_progress`). Receivers should update the active
 *  tool's displayed status WITHOUT moving it to completed. */
export interface ToolCallProgressMetadata {
  kind: "tool-call-progress";
  toolCallId: string;
  /** Current non-terminal status: `"pending"`, `"in_progress"`, etc. */
  status: string;
}

/** Terminal status values for tool-call-end metadata. ACP defines
 *  `pending` / `in_progress` as non-terminal and `completed` /
 *  `failed` as terminal. We accept any string here so receivers see
 *  what the harness actually sent (and so newly-introduced terminal
 *  states don't get filtered at the executor boundary), but the
 *  executor's `TERMINAL_TOOL_STATUSES` gate guarantees only terminal
 *  statuses produce this kind. */
export type ToolCallEndStatus = string;

/** Metadata for a terminal tool-call transition (`completed` /
 *  `failed`). Receivers move the call from active to completed. */
export interface ToolCallEndMetadata {
  kind: "tool-call-end";
  toolCallId: string;
  /** Terminal status as reported by the harness. Guaranteed
   *  terminal by the executor's gating logic — non-terminal
   *  statuses arrive as `tool-call-progress` instead. */
  status: ToolCallEndStatus;
  /** Optional terminal-status content (result text or error text). */
  resultText?: string;
  errorText?: string;
}

/** Metadata for an ACP `plan` notification — the agent's structured
 *  todo-list. Always carries the FULL set of entries; consumers
 *  replace state wholesale on receipt. Entries reuse the SDK's typed
 *  `PlanEntry` shape so `priority` is the proper `PlanEntryPriority`
 *  string enum (`"high"` / `"medium"` / `"low"`) and `status` is the
 *  proper `PlanEntryStatus` enum. */
export interface PlanMetadata {
  kind: "plan";
  entries: PlanEntry[];
}

/** Metadata for an `available_commands_update` notification — the
 *  set of slash-commands currently available from the harness. Uses
 *  the SDK's typed `AvailableCommand` shape so consumers get the full
 *  per-command metadata (description, input schema if any) without
 *  re-narrowing. Replaces state wholesale on receipt. */
export interface CommandsMetadata {
  kind: "commands";
  commands: AvailableCommand[];
}

/** Metadata for a `current_mode_update` notification — mode
 *  transitions like plan→execute or model swaps. ACP's
 *  `CurrentModeUpdate` only carries the new `currentModeId`; the
 *  available-modes list is delivered separately (initial session
 *  metadata or a `session_info_update`), so receivers that want
 *  labels look up `modes` from session state. */
export interface ModeChangedMetadata {
  kind: "mode-changed";
  /** ACP `SessionModeId` — opaque string from the SDK; receivers
   *  should treat unknown ids as valid (forward-compat). */
  modeId: string;
}

/** Metadata for a `usage_update` notification — token-budget
 *  telemetry. `cost` reuses the SDK's `Cost` type
 *  (`{ amount: number; currency: string }`) so structured
 *  multi-currency values are preserved end-to-end. `null` is
 *  surfaced as-is (some harnesses report no-cost sessions
 *  explicitly); `undefined` means the field was omitted. */
export interface UsageMetadata {
  kind: "usage";
  size: number;
  used: number;
  cost?: Cost | null;
}

/** Discriminated union of all agent-event metadata shapes that ride
 *  on `TaskStatusUpdateEvent.metadata`. Use this as the type for
 *  `metadata` when emitting a non-text agent event. */
export type AgentEventMetadata =
  | ThoughtMetadata
  | ToolCallStartMetadata
  | ToolCallProgressMetadata
  | ToolCallEndMetadata
  | PlanMetadata
  | CommandsMetadata
  | ModeChangedMetadata
  | UsageMetadata;

/** Re-export the SDK schema types we ride on so consumers don't
 *  need to take a separate dependency on `@agentclientprotocol/sdk`
 *  just to read these. */
export type { AvailableCommand, Cost, PlanEntry };

/** Type guard: does this `metadata` carry a known agent-event kind? */
export function isAgentEventMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is AgentEventMetadata & Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return false;
  const kind = (metadata as { kind?: unknown }).kind;
  if (typeof kind !== "string") return false;
  return (
    kind === "thought" ||
    kind === "tool-call-start" ||
    kind === "tool-call-progress" ||
    kind === "tool-call-end" ||
    kind === "plan" ||
    kind === "commands" ||
    kind === "mode-changed" ||
    kind === "usage"
  );
}
