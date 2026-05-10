import type {
  AgentCard,
  DeleteTaskPushNotificationConfigParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from "@a2a-js/sdk";
// Agent-event payload shapes are taken straight from the ACP SDK so
// receivers see spec-typed enums + structured values (e.g.
// `PlanEntryPriority`, `Cost`) rather than widened strings/numbers.
import type { AvailableCommand, Cost, PlanEntry } from "@agentclientprotocol/sdk";

export type AgentTargetMode = "auto" | "card" | "base" | "agui";

export interface AgentTargetInput {
  url: string;
  headers?: Record<string, string>;
  mode?: AgentTargetMode;
}

export interface CapabilitySummary {
  inputModes: string[];
  outputModes: string[];
  supportsTextInput: boolean;
  supportsTextOutput: boolean;
  supportsStreaming: boolean;
  supportsPushNotifications: boolean;
  raw: AgentCard["capabilities"];
}

export interface ResolvedAgentTarget {
  baseUrl: string;
  cardUrl: string;
  card: AgentCard;
  protocolVersion?: string;
  capabilities: CapabilitySummary;
}

export interface ProbeResult {
  method: "GET" | "OPTIONS";
  url: string;
  ok: boolean;
  status: number;
  contentType?: string;
  bodySnippet?: string;
}

export type TargetInspectionStatus = "idle" | "probing" | "ready" | "unreachable";

export interface TargetInspection {
  status: TargetInspectionStatus;
  card?: AgentCard;
  results?: ProbeResult[];
  error?: string;
}

export interface DebugRecord {
  requestId: string;
  timestamp: string;
  direction: "outbound" | "inbound";
  kind: "http" | "probe" | "client";
  method: string;
  url: string;
  headers: Record<string, string>;
  status?: number;
  contentType?: string;
  body?: string;
}

export interface TranscriptEntry {
  id: string;
  role: "user" | "agent";
  text: string;
  messageId?: string;
  taskId?: string;
  contextId?: string;
}

export type A2ASendResult = Message | Task;

/** AG-UI event types that may appear in SSE streams alongside standard A2A events. */
export type A2AStreamEvent =
  | A2AReasoningStartEvent
  | A2AReasoningMessageStartEvent
  | A2AReasoningMessageContentEvent
  | A2AReasoningMessageEndEvent
  | A2AReasoningMessageChunkEvent
  | A2AReasoningEndEvent
  | A2AReasoningEncryptedEvent
  | A2AToolCallStartEvent
  | A2AToolCallArgsEvent
  | A2AToolCallEndEvent
  | A2ARunStartedEvent
  | A2ARunFinishedEvent
  | A2ARunErrorEvent;

export interface ACPA2AElicitationSchema {
  description?: string | null;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  title?: string | null;
}

export interface ACPA2AElicitation {
  metadata?: Record<string, unknown>;
  message: string;
  mode: "form";
  requestedSchema: ACPA2AElicitationSchema;
  sessionId?: string;
}

export type ACPA2AElicitationContentValue = string | number | boolean | string[];

export interface ACPA2AElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, ACPA2AElicitationContentValue>;
}

/**
 * Lightweight typed view of an active auth-required prompt for UI consumers.
 *
 * Each `authMethods[]` entry carries the protocol-level method id alongside
 * optional human-presentable fields. `link` is the URL the user opens to
 * authenticate (when applicable — `agent` and `terminal` ACP variants do
 * NOT carry a link, so consumers MUST handle the missing-URL case rather
 * than producing broken open/copy actions).
 */
export interface A2AAuthRequiredState {
  authMethods?: Array<{
    /** Protocol-level method id passed back via {@link A2AClientController.respondToAuthRequired}. */
    id: string;
    /** Human-readable label (e.g. "Sign in with Google"). */
    name?: string;
    /** Optional URL where the user obtains credentials. ONLY present on env-var-style methods. */
    link?: string;
    /** Optional helper text describing the method. */
    description?: string;
  }>;
  message?: string;
  metadata?: Record<string, unknown>;
}

export type SessionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "sending"
  | "waiting"
  | "input_required"
  | "auth_required"
  | "completed"
  | "error";

/**
 * View-model for rendering a polished, protocol-neutral session status in
 * downstream UIs. Produced by {@link describeSessionStatus}.
 *
 * Severity levels are stable across UI clients: `info` for the calm idle/done
 * states, `busy` for in-flight turns, `actionable` for states that need user
 * intervention (input-required, auth-required), and `error` for failures.
 *
 * Action descriptors are discriminated by `kind` so consumers can switch on
 * the protocol semantics (`respond_input`, `respond_auth`, `retry`, `cancel`)
 * while still overriding `label` for their own UX voice.
 */
export interface SessionStatusViewModel {
  /** Concise, protocol-neutral user-facing label (e.g. "Awaiting input"). */
  label: string;
  /** Optional helper text for secondary copy / tooltip. */
  helperText?: string;
  severity: "info" | "busy" | "actionable" | "error";
  /** True if the session is in flight and the user should wait. */
  busy: boolean;
  /** True if the session reached a final state (completed, canceled, failed). */
  terminal: boolean;
  /** True if the session can recover via a user action (input/auth). */
  recoverable: boolean;
  /** Primary user action when one is available (e.g. provide input). */
  primaryAction?: SessionStatusAction;
  /** Secondary user action (e.g. cancel an in-flight turn). */
  secondaryAction?: SessionStatusAction;
}

export interface SessionStatusAction {
  kind: "respond_input" | "respond_auth" | "retry" | "cancel" | "reset";
  label: string;
}

/**
 * Snapshot of a single in-flight or recently-completed tool call.
 * Mirrored on session state so the TUI can render an inline status
 * row that swaps in place as the call progresses.
 */
export interface ActiveToolCall {
  toolCallId: string;
  toolName: string;
  status: string;
  /** Wall-clock ms timestamp at which the call was first observed. */
  startedAt: number;
}

export interface A2ASessionState {
  sessionId: string;
  target?: ResolvedAgentTarget;
  targetInput?: AgentTargetInput;
  targetInspection?: TargetInspection;
  contextId?: string;
  taskId?: string;
  transcript: TranscriptEntry[];
  status: SessionStatus;
  debugRecords: DebugRecord[];
  lastError?: string;
  pendingAgentText?: string;
  taskState?: string;
  resumableTaskId?: string;
  activeElicitation?: ACPA2AElicitation;
  activeAuth?: A2AAuthRequiredState;
  /** Cumulative thinking text accumulated by `reasoning.message.chunk`
   *  events for the current turn. Cleared when first
   *  `message.delta`/`message.completed` arrives or on `turn.started`. */
  pendingThoughtText?: string;
  /** Tool calls currently in flight, keyed by `toolCallId`. Entries are
   *  added on `tool_call.start` and removed on `tool_call.end`. The TUI's
   *  active-action status line renders the most recent entry. */
  activeToolCalls: ActiveToolCall[];
  /** Tool calls that have terminated this session. Used for the
   *  transcript-history rendering once a turn completes (the TUI
   *  surfaces the full tool timeline alongside the agent reply). */
  completedToolCalls: ActiveToolCall[];
  /** Most-recent plan from the harness. `null` when no plan has been
   *  reported. ACP `plan` notifications carry the full set; we
   *  replace state wholesale on receipt. Reuses the SDK's `PlanEntry`
   *  shape so consumers see the proper `priority: PlanEntryPriority`
   *  string enum. */
  currentPlan: PlanEntry[] | null;
  /** Slash-commands the harness has reported as available. Empty
   *  when the harness has not reported any. Drives the TUI's
   *  slash-command autocomplete. Reuses the SDK's `AvailableCommand`
   *  shape so the autocomplete UI sees description + input schema. */
  availableCommands: AvailableCommand[];
  /** Most-recent mode id reported by the harness (e.g. plan vs
   *  execute, or a model-name swap). The available-modes list lives
   *  in session metadata; receivers that want to render mode names
   *  look it up from there. */
  currentMode?: { modeId: string };
  /** Most-recent token-budget telemetry. `cost` reuses the SDK's
   *  `Cost` type (`{ amount, currency }`) so multi-currency values
   *  are preserved end-to-end. */
  lastUsage?: { size: number; used: number; cost?: Cost | null };
}

export interface SendTurnOptions {
  contextId?: string;
  taskId?: string;
  blocking?: boolean;
  poll?: boolean;
  pollIntervalMs?: number;
  /** Maximum time in milliseconds to wait for the polling loop to reach a terminal state (default: 30 000). */
  pollTimeoutMs?: number;
  historyLength?: number;
  acceptedOutputModes?: string[];
  metadata?: Record<string, unknown>;
  stream?: boolean;
  suppressTranscriptEntry?: boolean;
  /**
   * Idle threshold in milliseconds for emitting `stream.idle` events.
   *
   * Defaults to `0` (disabled). When non-zero, the SDK emits a
   * `stream.idle` event if no stream event has arrived within this window.
   * Idle detection only applies to streaming sends; the timer clears on
   * event arrival, completion, abort, cancel, or error.
   */
  idleThresholdMs?: number;
  /**
   * Abort signal observed by the send path.
   *
   * - If the signal is already aborted when `sendTurn` is invoked, the SDK
   *   short-circuits before any transport call and emits an `abort.send` event.
   * - For streaming sends, mid-stream abort breaks out of the SSE loop and
   *   emits `abort.stream`.
   * - For non-streaming sends, the polling loop observes the signal and
   *   exits promptly on abort.
   *
   * The signal is purely cooperative — the SDK does not call `signal.throwIfAborted`
   * to surface an exception to the caller; it converts abort into structured
   * events instead so UI consumers can distinguish abort from transport errors.
   */
  signal?: AbortSignal;
}

/**
 * Options for {@link A2AClientController.cancelTask}.
 *
 * When `taskId` is omitted, the controller defaults to the active session's
 * `taskId` if present, falling back to `resumableTaskId`. This matches what
 * UI consumers (Raycast, CLI, web-ui) typically want when the user clicks a
 * "Cancel" affordance.
 */
export interface CancelTaskOptions {
  /** Override the task id to cancel. Defaults to the controller's active or resumable task. */
  taskId?: string;
}

/**
 * Result of {@link A2AClientController.cancelTask}.
 *
 * `outcome` distinguishes:
 * - `"canceled"` — the transport's `cancelTask` call resolved successfully.
 *   `task` carries the resulting Task (typically with state `"canceled"`).
 * - `"no-target"` — no resolved target on the controller; nothing to cancel.
 * - `"no-task"` — no task id was supplied or available on session state.
 * - `"failed"` — the transport rejected the cancellation; `error` carries the
 *   message.
 */
export type CancelTaskResult =
  | { outcome: "canceled"; taskId: string; task: Task }
  | { outcome: "no-target" }
  | { outcome: "no-task" }
  | { outcome: "failed"; taskId: string; error: string; cause?: unknown };

export interface ResumeTurnOptions {
  poll?: boolean;
  pollIntervalMs?: number;
  /** Maximum time in milliseconds to wait for the polling loop to reach a terminal state (default: 30 000). */
  pollTimeoutMs?: number;
  historyLength?: number;
  stream?: boolean;
  /**
   * Thread identifier used for AG-UI `run.*` lifecycle correlation. When the caller knows the
   * task's original contextId, passing it here lets consumers correlate resumed runs to the
   * same thread as the originating turn. When omitted, a fresh UUID is generated.
   */
  contextId?: string;
  /** Idle threshold in milliseconds. See {@link SendTurnOptions.idleThresholdMs}. */
  idleThresholdMs?: number;
  /** Abort signal observed by the resume path. See {@link SendTurnOptions.signal}. */
  signal?: AbortSignal;
}

export interface A2ATargetResolvedEvent {
  type: "target.resolved";
  target: ResolvedAgentTarget;
}

/** A single JSON Patch (RFC 6902) operation. */
export interface JsonPatchOperation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: unknown;
  from?: string;
}

export interface A2ASessionUpdatedEvent {
  type: "session.updated";
  state: A2ASessionState;
  /** Optional JSON Patch (RFC 6902) operations to apply to the current state instead of replacing it wholesale. */
  delta?: JsonPatchOperation[];
}

export interface A2ATurnStartedEvent {
  type: "turn.started";
  text: string;
  contextId?: string;
  taskId?: string;
  suppressTranscriptEntry?: boolean;
}

/**
 * A partial message update.
 *
 * **Note on `text` vs `delta` semantics:**
 * - `text` carries the **accumulated** message text (all content so far).
 * - `delta` (AG-UI spec alias) carries the **incremental** chunk for this update.
 *
 * Emitters that know the incremental value should populate `delta`; otherwise
 * only `text` is set. Consumers that want AG-UI-spec-shaped payloads should
 * prefer `delta` when present. Pure incremental-only semantics would drop the
 * accumulated `text`, which is not the current compatibility contract.
 */
export interface A2AMessageDeltaEvent {
  type: "message.delta";
  /** Accumulated text so far (agents-js legacy). */
  text: string;
  /** Incremental text chunk for this update (AG-UI spec alias). Optional during transition. */
  delta?: string;
  /** AG-UI spec: stable identifier for the message being streamed. */
  messageId?: string;
  message?: Message;
  task?: Task;
  contextId?: string;
  taskId?: string;
}

export interface A2AMessageCompletedEvent {
  type: "message.completed";
  text: string;
  message?: Message;
  task?: Task;
  contextId?: string;
  taskId?: string;
}

export interface A2ATaskUpdatedEvent {
  type: "task.updated";
  task: Task;
}

export interface A2ATaskStatusUpdatedEvent {
  type: "task.status.updated";
  update: TaskStatusUpdateEvent;
}

export interface A2ATaskArtifactUpdatedEvent {
  type: "task.artifact.updated";
  update: TaskArtifactUpdateEvent;
}

export interface A2AErrorEvent {
  type: "error";
  error: string;
  cause?: unknown;
}

/**
 * Lifecycle signals for streaming/non-streaming sends. Lifecycle events are
 * pure diagnostics: they never participate in `transcript` / `pendingAgentText`
 * / task-state transitions. UI consumers can render "request sent",
 * "stream opened", and idle-warning states without inventing client-only
 * heuristics.
 */
export interface A2ARequestSentEvent {
  type: "request.sent";
  /** Wall-clock ISO-8601 timestamp when the underlying transport call was issued. */
  timestamp: string;
  /** Whether this is a streaming or non-streaming request path. */
  streaming: boolean;
  contextId?: string;
  taskId?: string;
}

export interface A2AStreamOpenedEvent {
  type: "stream.opened";
  timestamp: string;
  contextId?: string;
  taskId?: string;
}

/** First event has been received from the stream (or first response from non-streaming). */
export interface A2AStreamFirstEventEvent {
  type: "stream.first_event";
  timestamp: string;
  contextId?: string;
  taskId?: string;
}

/** A new event has arrived; useful for clients that want to track last-activity. */
export interface A2AStreamLastEventEvent {
  type: "stream.last_event";
  timestamp: string;
  contextId?: string;
  taskId?: string;
}

/**
 * Stream has been silent for the configured idle threshold without reaching
 * a terminal state. UI consumers should surface a user-facing "no stream
 * event for N seconds" warning. Idle timer clears on event arrival,
 * completion, abort, cancel, or error.
 */
export interface A2AStreamIdleEvent {
  type: "stream.idle";
  /** Wall-clock ISO-8601 timestamp when the idle threshold was crossed. */
  timestamp: string;
  /** How long the stream has been idle, in milliseconds. */
  idleMs: number;
  /** The configured idle threshold. */
  thresholdMs: number;
  contextId?: string;
  taskId?: string;
}

/** Stream closed cleanly (terminal task state reached or generator exhausted). */
export interface A2AStreamClosedEvent {
  type: "stream.closed";
  timestamp: string;
  /** Reason the stream closed: "completed" | "exhausted" | "error" | "aborted" | "canceled". */
  reason: "completed" | "exhausted" | "error" | "aborted" | "canceled";
  contextId?: string;
  taskId?: string;
}

/**
 * Send was aborted by an `AbortSignal` before any transport request was issued.
 *
 * Emitted instead of `error` when {@link SendTurnOptions.signal} is already
 * aborted on entry to `sendTurn`/`resumeTurn`, or when an abort fires while
 * the controller is still preparing the request. UI consumers should render
 * a user-facing "canceled before send" state rather than an error.
 */
export interface A2AAbortSendEvent {
  type: "abort.send";
  /** Abort reason as a human-readable string, when available. */
  reason?: string;
  /** Optional task id when the abort happened during resume of a known task. */
  taskId?: string;
  /** Optional context id when known. */
  contextId?: string;
}

/**
 * Send/resume stream was aborted by an `AbortSignal` mid-flight.
 *
 * Emitted when the abort fires after the streaming connection opened but
 * before it reaches a terminal task state. Distinguishes user-initiated
 * stream abort from transport-level errors.
 */
export interface A2AAbortStreamEvent {
  type: "abort.stream";
  reason?: string;
  taskId?: string;
  contextId?: string;
}

/**
 * Local cancellation was requested by the caller. Useful for UI consumers
 * that want to render a "canceling..." state before a remote-cancel result
 * (`cancellation.succeeded` / `cancellation.failed`) lands.
 *
 * Emitted by `A2AClientController.cancelTask` when it is about to invoke
 * the transport-level cancel.
 */
export interface A2ACancellationRequestedEvent {
  type: "cancellation.requested";
  taskId: string;
  contextId?: string;
}

/**
 * Remote-side `cancelTask` completed successfully.
 *
 * UI consumers can use this to confirm to the user that the remote agent
 * actually accepted the cancellation, vs falling back to local-only
 * teardown (which they would infer from a `cancellation.failed` event or
 * a non-`canceled` outcome on `A2AClientController.cancelTask`).
 */
export interface A2ACancellationSucceededEvent {
  type: "cancellation.succeeded";
  taskId: string;
  contextId?: string;
}

/**
 * Remote-side `cancelTask` rejected. The corresponding `error` event
 * carries the underlying transport message; this event lets consumers
 * distinguish cancellation-failure from a generic operation error.
 */
export interface A2ACancellationFailedEvent {
  type: "cancellation.failed";
  taskId: string;
  error: string;
  cause?: unknown;
  contextId?: string;
}

/**
 * AG-UI spec: signals the start of an agent run (one user turn).
 *
 * Emitted alongside the existing agents-js `turn.started` event during the
 * transition window. `runId` is unique per turn; `threadId` is session-level
 * and typically maps to the A2A `contextId`.
 */
export interface A2ARunStartedEvent {
  type: "run.started";
  /** Per-turn unique identifier for this run. */
  runId: string;
  /** Session-level identifier (maps to A2A contextId). */
  threadId: string;
  /** Optional parent run identifier for nested runs. */
  parentRunId?: string;
  /** Optional opaque input payload that started the run. */
  input?: unknown;
}

/**
 * AG-UI spec: signals the successful completion of an agent run.
 *
 * Emitted alongside the existing agents-js `message.completed` event during
 * the transition window. Shares `runId`/`threadId` with the preceding
 * {@link A2ARunStartedEvent}.
 */
export interface A2ARunFinishedEvent {
  type: "run.finished";
  runId: string;
  threadId: string;
  /** Optional opaque result payload. */
  result?: unknown;
}

/**
 * AG-UI spec: signals that an agent run failed.
 *
 * Emitted alongside the existing agents-js `error` event during the
 * transition window. `runId`/`threadId` are populated when an in-flight turn
 * context is available; otherwise they may be omitted.
 */
export interface A2ARunErrorEvent {
  type: "run.error";
  runId?: string;
  threadId?: string;
  message: string;
  code?: string;
}

export interface A2ADebugRecordEvent {
  type: "debug.record";
  record: DebugRecord;
}

/**
 * Signals the start of a new message.
 *
 * The `role` union is widened beyond the AG-UI spec to keep `"agent"` as an
 * agents-js-local alias for `"assistant"` (pre-existing semantics). All spec
 * values (`"developer" | "system" | "assistant" | "user" | "tool"`) are also
 * accepted. No value is narrowed away — this is an additive widening.
 */
export interface A2AMessageStartEvent {
  type: "message.start";
  role: "user" | "agent" | "assistant" | "system" | "tool" | "developer";
  messageId: string;
}

export interface A2AMessageEndEvent {
  type: "message.end";
  messageId: string;
}

export interface A2AStepStartedEvent {
  type: "step.started";
  stepId: string;
  name?: string;
}

export interface A2AStepFinishedEvent {
  type: "step.finished";
  stepId: string;
  result?: string;
}

export interface A2ACustomEvent {
  type: "custom";
  /** Application-specific event name (e.g., "progress.update", "my.namespace.event"). */
  name: string;
  /** Arbitrary JSON-serializable payload. */
  data: unknown;
}

// --- AG-UI Reasoning Events (chain-of-thought visibility) ---

export interface A2AReasoningStartEvent {
  type: "reasoning.start";
  /** AG-UI spec: identifier for the reasoning message this event begins. */
  messageId?: string;
}

export interface A2AReasoningMessageStartEvent {
  type: "reasoning.message.start";
  messageId: string;
}

/**
 * Streams a full reasoning content block.
 *
 * Emitters should populate both `text` (agents-js legacy) and `delta` (AG-UI
 * spec alias) with the same value during the transition window.
 */
export interface A2AReasoningMessageContentEvent {
  type: "reasoning.message.content";
  /** Reasoning text (agents-js legacy field). */
  text: string;
  /** AG-UI spec alias for the reasoning chunk. Mirrors `text` when set. */
  delta?: string;
  /** AG-UI spec: identifier of the reasoning message this content belongs to. */
  messageId?: string;
}

export interface A2AReasoningMessageEndEvent {
  type: "reasoning.message.end";
  messageId: string;
}

/**
 * Streams an incremental reasoning chunk.
 *
 * Emitters should populate both `text` (agents-js legacy) and `delta` (AG-UI
 * spec alias) with the same value during the transition window.
 */
export interface A2AReasoningMessageChunkEvent {
  type: "reasoning.message.chunk";
  /** Reasoning chunk text (agents-js legacy field). */
  text: string;
  /** AG-UI spec alias for the reasoning chunk. Mirrors `text` when set. */
  delta?: string;
  /** AG-UI spec: identifier of the reasoning message this chunk belongs to. */
  messageId?: string;
}

export interface A2AReasoningEndEvent {
  type: "reasoning.end";
  /** AG-UI spec: identifier of the reasoning message that is ending. */
  messageId?: string;
}

/**
 * Encrypted reasoning payload.
 *
 * `data` is the agents-js legacy field carrying the encrypted value. The
 * AG-UI spec shape uses `subtype`, `entityId`, and `encryptedValue`. When an
 * emitter populates the spec-shaped fields, `data` should mirror
 * `encryptedValue` for backward compatibility with existing consumers.
 */
export interface A2AReasoningEncryptedEvent {
  type: "reasoning.encrypted";
  /** Encrypted reasoning data, typically base64-encoded (agents-js legacy field; mirrors `encryptedValue` when both are set). */
  data: string;
  /** AG-UI spec: whether the encrypted payload represents a reasoning message or a tool call. */
  subtype?: "message" | "tool-call";
  /** AG-UI spec: identifier of the entity (message or tool call) whose content is encrypted. */
  entityId?: string;
  /** AG-UI spec: the encrypted payload. Should mirror `data` during the transition window. */
  encryptedValue?: string;
}

// --- AG-UI Tool Call Lifecycle Events ---

/**
 * Marks the start of a tool call. Emitted once per `toolCallId` before any
 * `tool_call.args` or `tool_call.end` event.
 */
export interface A2AToolCallStartEvent {
  type: "tool_call.start";
  /** The ID of the tool call that is starting. */
  toolCallId: string;
  /** The name (or title) of the tool being invoked. */
  toolCallName: string;
  /** Optional parent message ID this tool call is attached to. */
  parentMessageId?: string;
}

/**
 * Incremental JSON argument chunk for a tool call.
 *
 * Emitters should populate both `argsChunk` (agents-js legacy) and `delta`
 * (AG-UI spec alias) with the same value during the transition window.
 */
export interface A2AToolCallArgsEvent {
  type: "tool_call.args";
  /** The ID of the tool call these argument chunks belong to. */
  toolCallId: string;
  /** Incremental JSON argument chunk for the tool call (agents-js legacy field). */
  argsChunk: string;
  /** AG-UI spec alias for the incremental JSON argument chunk. Mirrors `argsChunk` when set. */
  delta?: string;
}

/**
 * Marks the end of a tool call. Emitted once per `toolCallId` after all
 * `tool_call.args` events and when the underlying tool call reaches a
 * terminal state (completed or failed).
 */
export interface A2AToolCallEndEvent {
  type: "tool_call.end";
  /** The ID of the tool call that has finished. */
  toolCallId: string;
  /** Terminal status reported by the harness, e.g. `"completed"`,
   *  `"failed"`, `"cancelled"`. */
  status?: string;
}

// --- Agent-event metadata fan-out (ACP plan / commands / mode / usage) ---
//
// These events ride on TaskStatusUpdateEvent.metadata via the
// `agents-js/a2a` `wire-kinds` discriminator schema. Their payload
// types reuse the ACP SDK's typed shapes (`PlanEntry`,
// `AvailableCommand`, `Cost`, `SessionModeState`) so the wire
// surface preserves spec-shaped enums and structured values
// (e.g. `Cost = { amount, currency }`, `PlanEntryPriority = "high" |
// "medium" | "low"`) end-to-end. See
// `packages/a2a/src/wire-kinds.ts` for the discriminator + rationale.

/**
 * The agent's structured todo-list. ACP `plan` notifications always
 * carry the FULL set of entries; receivers replace state wholesale.
 */
export interface A2APlanUpdatedEvent {
  type: "plan.updated";
  entries: PlanEntry[];
}

/**
 * The set of slash-commands currently available from the harness.
 * Replaces state wholesale on receipt.
 */
export interface A2AAvailableCommandsUpdatedEvent {
  type: "commands.updated";
  commands: AvailableCommand[];
}

/**
 * Mode transition reported by the harness (e.g. plan→execute, model swap).
 * ACP `current_mode_update` carries only the new `modeId`; the
 * available-modes list lives in session metadata.
 */
export interface A2AModeChangedEvent {
  type: "mode.changed";
  modeId: string;
}

/**
 * Token-budget telemetry. `size` = total context window tokens,
 * `used` = consumed so far, `cost` = structured `Cost` from the SDK
 * (`{ amount, currency }`) preserved verbatim — `null` is a valid
 * harness signal for "no cost", `undefined` means the field was
 * omitted.
 */
export interface A2AUsageUpdatedEvent {
  type: "usage.updated";
  size: number;
  used: number;
  cost?: Cost | null;
}

export type A2AEvent =
  | A2ATargetResolvedEvent
  | A2ASessionUpdatedEvent
  | A2ATurnStartedEvent
  | A2AMessageDeltaEvent
  | A2AMessageCompletedEvent
  | A2AMessageStartEvent
  | A2AMessageEndEvent
  | A2ATaskStatusUpdatedEvent
  | A2ATaskArtifactUpdatedEvent
  | A2ATaskUpdatedEvent
  | A2AStepStartedEvent
  | A2AStepFinishedEvent
  | A2ACustomEvent
  | A2AReasoningStartEvent
  | A2AReasoningMessageStartEvent
  | A2AReasoningMessageContentEvent
  | A2AReasoningMessageEndEvent
  | A2AReasoningMessageChunkEvent
  | A2AReasoningEndEvent
  | A2AReasoningEncryptedEvent
  | A2AToolCallStartEvent
  | A2AToolCallArgsEvent
  | A2AToolCallEndEvent
  | A2APlanUpdatedEvent
  | A2AAvailableCommandsUpdatedEvent
  | A2AModeChangedEvent
  | A2AUsageUpdatedEvent
  | A2ARunStartedEvent
  | A2ARunFinishedEvent
  | A2ARunErrorEvent
  | A2AAbortSendEvent
  | A2AAbortStreamEvent
  | A2ACancellationRequestedEvent
  | A2ACancellationSucceededEvent
  | A2ACancellationFailedEvent
  | A2ARequestSentEvent
  | A2AStreamOpenedEvent
  | A2AStreamFirstEventEvent
  | A2AStreamLastEventEvent
  | A2AStreamIdleEvent
  | A2AStreamClosedEvent
  | A2AErrorEvent
  | A2ADebugRecordEvent;

export type A2AEventListener = (event: A2AEvent) => void;

/**
 * Transport interface for A2A protocol I/O.
 *
 * This is the **Transport** port in the Ports & Adapters architecture.
 * The default implementation is {@link SdkA2ATransport} (HTTP/SSE via the A2A SDK).
 * Implement this interface to use a different transport (WebSocket, in-process, mock).
 *
 * The transport is injected into {@link A2AClientProvider} at construction time.
 * The provider calls these methods without knowing the underlying protocol details.
 */
export interface A2ATransport {
  /** Resolve an agent target input (URL + mode) into a fully resolved target with card and capabilities. */
  resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget>;
  /** Inspect a target for reachability without fully resolving it. Returns probe results and card if available. */
  inspectTarget(input: AgentTargetInput): Promise<TargetInspection>;
  /** Send a message to the agent and return the immediate result (message or task). */
  sendMessage(target: ResolvedAgentTarget, params: MessageSendParams): Promise<A2ASendResult>;
  /** Send a message and return a streaming async generator of events (messages, task updates, artifacts, and AG-UI events). */
  sendMessageStream(
    target: ResolvedAgentTarget,
    params: MessageSendParams,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  >;
  /** Get the current state of a task by ID. */
  getTask(target: ResolvedAgentTarget, params: TaskQueryParams): Promise<Task>;
  /** Cancel a running task by ID. */
  cancelTask(target: ResolvedAgentTarget, params: TaskIdParams): Promise<Task>;
  /** Resubscribe to a task's event stream (for resumable flows). */
  resubscribeTask(
    target: ResolvedAgentTarget,
    params: TaskIdParams,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  >;
  /** Set (create or update) a push notification config for a task. */
  setTaskPushNotificationConfig(
    target: ResolvedAgentTarget,
    params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig>;
  /** Get a specific push notification config for a task. */
  getTaskPushNotificationConfig(
    target: ResolvedAgentTarget,
    params: GetTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig>;
  /** List all push notification configs for a task. */
  listTaskPushNotificationConfigs(
    target: ResolvedAgentTarget,
    params: ListTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig[]>;
  /** Delete a push notification config for a task. */
  deleteTaskPushNotificationConfig(
    target: ResolvedAgentTarget,
    params: DeleteTaskPushNotificationConfigParams,
  ): Promise<void>;
  /** Get the extended agent card with authentication and capability details. */
  getExtendedAgentCard(target: ResolvedAgentTarget): Promise<AgentCard>;
  /** Probe the target endpoints for connectivity (GET card URL, OPTIONS base URL). */
  probe(input: AgentTargetInput): Promise<ProbeResult[]>;
  /** Subscribe to debug records (HTTP requests, probes). Returns an unsubscribe function. */
  subscribeDebug(listener: (record: DebugRecord) => void): () => void;
}
