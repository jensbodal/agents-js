import { type Message, Role, type Task, TaskState } from "@a2a-js/sdk";
import { extractAcpAuthRequiredMetadata, extractAcpElicitationMetadata } from "./acp-state.ts";
import { applyJsonPatch } from "./json-patch.ts";
import type {
  A2AEvent,
  A2ASessionState,
  ActiveToolCall,
  DebugRecord,
  TranscriptEntry,
} from "./types.ts";
import { randomUuid } from "./uuid.ts";

const TERMINAL_TASK_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

/**
 * Wire-boundary predicate: is this proto {@link TaskState} terminal?
 * Terminal states close the SSE stream and clear the resumable task. Callers
 * pass the raw proto enum from `task.status.state` / `update.status.state`.
 */
export function isTerminalTaskState(state: TaskState | undefined): boolean {
  return state !== undefined && TERMINAL_TASK_STATES.has(state);
}

/**
 * Translate the proto {@link TaskState} enum into the protocol-neutral
 * hyphenated vocabulary that {@link A2ASessionState.taskState} and the session
 * view-model speak (`"input-required"`, `"completed"`, ...). This keeps proto
 * `TaskState` numbers at the wire edge; client-side status logic stays in
 * string terms.
 */
export function taskStateToVocabulary(state: TaskState | undefined): string | undefined {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED:
      return "submitted";
    case TaskState.TASK_STATE_WORKING:
      return "working";
    case TaskState.TASK_STATE_COMPLETED:
      return "completed";
    case TaskState.TASK_STATE_FAILED:
      return "failed";
    case TaskState.TASK_STATE_CANCELED:
      return "canceled";
    case TaskState.TASK_STATE_REJECTED:
      return "rejected";
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return "input-required";
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return "auth-required";
    default:
      return undefined;
  }
}

/**
 * Recursively collect `text` from ACP-shaped content (`{ type: "text", text }`
 * or `{ kind: "text", text }`). Used by the mention middleware to flatten ACP
 * `ContentBlock[]` prompt content — this walks the ACP content shape, NOT A2A
 * proto parts (those use `content.$case === "text"`; see {@link extractMessageText}).
 */
export function collectTextParts(input: unknown, out: string[] = []): string[] {
  if (input === null || input === undefined) {
    return out;
  }
  if (Array.isArray(input)) {
    for (const value of input) {
      collectTextParts(value, out);
    }
    return out;
  }
  if (typeof input !== "object") {
    return out;
  }

  const candidate = input as Record<string, unknown>;
  if (
    (candidate.kind === "text" || candidate.type === "text") &&
    typeof candidate.text === "string"
  ) {
    out.push(candidate.text);
  }

  for (const value of Object.values(candidate)) {
    collectTextParts(value, out);
  }

  return out;
}

export function extractMessageText(message: Partial<Message> | null | undefined): string {
  if (!message?.parts) {
    return "";
  }
  return message.parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

export function extractLatestAgentMessage(task: Task): Message | undefined {
  const history = Array.isArray(task.history) ? task.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index];
    if (candidate?.role === Role.ROLE_AGENT) {
      return candidate;
    }
  }

  const statusMessage = task.status?.message;
  if (statusMessage?.role === Role.ROLE_AGENT) {
    return statusMessage;
  }

  return undefined;
}

export function extractLatestAgentText(task: Task): string {
  return extractMessageText(extractLatestAgentMessage(task));
}

function appendTranscriptEntry(
  transcript: TranscriptEntry[],
  nextEntry: TranscriptEntry,
): TranscriptEntry[] {
  const lastEntry = transcript[transcript.length - 1];
  if (
    lastEntry &&
    lastEntry.role === nextEntry.role &&
    lastEntry.text === nextEntry.text &&
    lastEntry.taskId === nextEntry.taskId &&
    lastEntry.contextId === nextEntry.contextId
  ) {
    return transcript;
  }

  return [...transcript, nextEntry];
}

export function createInitialSessionState(
  overrides: Partial<A2ASessionState> = {},
): A2ASessionState {
  return {
    sessionId: overrides.sessionId ?? randomUuid(),
    target: overrides.target,
    targetInput: overrides.targetInput,
    targetInspection: overrides.targetInspection,
    contextId: overrides.contextId,
    taskId: overrides.taskId,
    transcript: overrides.transcript ?? [],
    status: overrides.status ?? "idle",
    debugRecords: overrides.debugRecords ?? [],
    lastError: overrides.lastError,
    pendingAgentText: overrides.pendingAgentText,
    taskState: overrides.taskState,
    resumableTaskId: overrides.resumableTaskId,
    activeElicitation: overrides.activeElicitation,
    activeAuth: overrides.activeAuth,
    pendingThoughtText: overrides.pendingThoughtText,
    activeToolCalls: overrides.activeToolCalls ?? [],
    completedToolCalls: overrides.completedToolCalls ?? [],
    currentPlan: overrides.currentPlan ?? null,
    availableCommands: overrides.availableCommands ?? [],
    currentMode: overrides.currentMode,
    lastUsage: overrides.lastUsage,
    sessionTitle: overrides.sessionTitle,
    sessionUpdatedAt: overrides.sessionUpdatedAt,
  };
}

/** Compute session status from a task's state and whether the task is final/terminal. */
function computeSessionStatusFromTaskState(
  taskState: string,
  isFinal: boolean,
): A2ASessionState["status"] {
  if (taskState === "input-required") {
    return "input_required";
  }
  if (taskState === "auth-required") {
    return "auth_required";
  }
  if (isFinal) {
    return "completed";
  }
  return "waiting";
}

function appendDebugRecord(records: DebugRecord[], record: DebugRecord): DebugRecord[] {
  if (records.length >= 200) {
    return [...records.slice(-199), record];
  }
  return [...records, record];
}

export function reduceA2ASessionState(state: A2ASessionState, event: A2AEvent): A2ASessionState {
  switch (event.type) {
    case "target.resolved":
      return {
        ...state,
        target: event.target,
        status: "connected",
        lastError: undefined,
      };
    case "turn.started":
      return {
        ...state,
        status: "sending",
        // Reset per-turn agent-event state so a new turn starts clean.
        // Tool calls in flight at the boundary are dropped (harness
        // is responsible for terminating them before turn switch).
        pendingThoughtText: undefined,
        activeToolCalls: [],
        transcript: event.suppressTranscriptEntry
          ? state.transcript
          : appendTranscriptEntry(state.transcript, {
              id: randomUuid(),
              role: "user",
              text: event.text,
              contextId: event.contextId ?? state.contextId,
              taskId: event.taskId ?? state.taskId,
            }),
      };
    case "message.delta":
      return {
        ...state,
        status: "waiting",
        pendingAgentText: event.text,
        // First visible response token = thinking phase complete.
        // Clearing here drives the TUI's active-action line back to
        // either an active tool call (if one is still running) or
        // empty (if not) — matches the standard "current action"
        // pattern (Claude Code, Codex CLI).
        pendingThoughtText: undefined,
        contextId: event.contextId ?? state.contextId,
        taskId: event.taskId ?? state.taskId,
        resumableTaskId: event.taskId ?? state.resumableTaskId,
        activeElicitation: undefined,
        activeAuth: undefined,
        taskState: "working",
      };
    case "message.completed":
      return {
        ...state,
        status: "connected",
        pendingAgentText: undefined,
        contextId: event.contextId ?? state.contextId,
        taskId: event.task ? (event.taskId ?? state.taskId) : undefined,
        resumableTaskId: undefined,
        activeElicitation: undefined,
        activeAuth: undefined,
        taskState: taskStateToVocabulary(event.task?.status?.state),
        transcript: appendTranscriptEntry(state.transcript, {
          id: randomUuid(),
          role: "agent",
          text: event.text,
          messageId: event.message?.messageId,
          contextId: event.contextId ?? state.contextId,
          taskId: event.task ? (event.taskId ?? state.taskId) : undefined,
        }),
      };
    case "task.status.updated": {
      const text = extractMessageText(event.update.status?.message);
      const metadata = event.update.metadata;
      const activeElicitation = extractAcpElicitationMetadata(metadata);
      const activeAuth = extractAcpAuthRequiredMetadata(metadata);
      // A2A 1.0 dropped `final`; terminal state drives termination.
      const isFinal = isTerminalTaskState(event.update.status?.state);

      return {
        ...state,
        status: computeSessionStatusFromTaskState(
          taskStateToVocabulary(event.update.status?.state) ?? "",
          isFinal,
        ),
        contextId: event.update.contextId ?? state.contextId,
        taskId: event.update.taskId ?? state.taskId,
        resumableTaskId: isFinal ? undefined : (event.update.taskId ?? state.resumableTaskId),
        taskState: taskStateToVocabulary(event.update.status?.state),
        activeElicitation,
        activeAuth,
        pendingAgentText: text ? text : isFinal ? undefined : state.pendingAgentText,
      };
    }
    case "task.artifact.updated":
      return {
        ...state,
        contextId: event.update.contextId ?? state.contextId,
        taskId: event.update.taskId ?? state.taskId,
        resumableTaskId: event.update.taskId ?? state.resumableTaskId,
      };
    case "task.updated": {
      const taskState = event.task.status?.state;
      const isFinal = isTerminalTaskState(taskState);
      return {
        ...state,
        status: computeSessionStatusFromTaskState(taskStateToVocabulary(taskState) ?? "", isFinal),
        contextId: event.task.contextId ?? state.contextId,
        taskId: event.task.id ?? state.taskId,
        resumableTaskId: isFinal ? undefined : (event.task.id ?? state.resumableTaskId),
        taskState: taskStateToVocabulary(taskState),
        activeElicitation: extractAcpElicitationMetadata(event.task.metadata),
        activeAuth: extractAcpAuthRequiredMetadata(event.task.metadata),
        pendingAgentText: isFinal
          ? undefined
          : extractMessageText(event.task.status?.message) || state.pendingAgentText,
      };
    }
    case "debug.record":
      return {
        ...state,
        debugRecords: appendDebugRecord(state.debugRecords, event.record),
      };
    case "error":
      return {
        ...state,
        status: "error",
        pendingAgentText: undefined,
        lastError: event.error,
        activeElicitation: undefined,
        activeAuth: undefined,
        resumableTaskId: undefined,
        taskId: undefined,
        taskState: undefined,
      };
    case "message.start":
      return {
        ...state,
        status: "waiting",
      };
    case "message.end":
      return {
        ...state,
        status: "connected",
        pendingAgentText: undefined,
      };
    case "step.started":
      return state;
    case "step.finished":
      return state;
    case "session.updated":
      if (event.delta) {
        if (event.delta.length === 0) {
          return state;
        }
        try {
          return applyJsonPatch(state, event.delta);
        } catch (error) {
          console.warn(
            "Failed to apply JSON Patch delta in session.updated; returning previous state:",
            error instanceof Error ? error.message : error,
          );
          return state;
        }
      }
      return event.state;
    case "custom":
      return state;
    case "run.started":
    case "run.finished":
    case "run.error":
      return state;
    case "abort.send":
    case "abort.stream":
      // Aborts are user-driven cancellations distinct from transport errors.
      // Reset turn-in-flight state but do NOT populate `lastError` —
      // consumers can render a "canceled" state from the event itself.
      return {
        ...state,
        status: "connected",
        pendingAgentText: undefined,
        // Preserve resumableTaskId / activeElicitation / activeAuth — abort
        // does not invalidate the underlying server-side task, only the
        // client's wait for it.
      };
    case "cancellation.requested":
      // UI signal only — provider has not yet heard back from transport.
      return state;
    case "cancellation.succeeded":
      // The corresponding `task.updated` event with state="canceled" already
      // updated session state via the protocol path; nothing to add here.
      return state;
    case "cancellation.failed":
      // Surface the underlying transport message so UI can render
      // "remote cancel failed" without inspecting separate `error` events.
      return {
        ...state,
        lastError: event.error,
      };
    case "request.sent":
    case "stream.opened":
    case "stream.first_event":
    case "stream.last_event":
    case "stream.idle":
    case "stream.closed":
      // Pure diagnostic lifecycle events. For lifecycle consumers:
      // "Lifecycle events should not create transcript entries" and
      // "Debug/lifecycle events should not be confused with protocol task
      // events" — the reducer leaves session state untouched; consumers
      // that care render directly off the event stream.
      return state;
    case "reasoning.message.chunk": {
      const previous = state.pendingThoughtText ?? "";
      return {
        ...state,
        pendingThoughtText: previous + event.text,
      };
    }
    case "reasoning.start":
    case "reasoning.message.start":
    case "reasoning.message.content":
    case "reasoning.message.end":
    case "reasoning.end":
    case "reasoning.encrypted":
      // Lifecycle / non-incremental reasoning events — `reasoning.message.chunk`
      // already drives the active accumulator. Leaving these as no-ops keeps
      // the reducer focused on the streaming-text contract.
      return state;
    case "tool_call.start": {
      const startedAt = Date.now();
      const next: ActiveToolCall = {
        toolCallId: event.toolCallId,
        toolName: event.toolCallName,
        // Use the harness-reported initial status when present; some
        // harnesses emit `pending` to mark a queued-but-not-executing
        // call. Fall back to `in_progress` only when status is
        // unspecified.
        status: event.status ?? "in_progress",
        startedAt,
        ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
        ...(event.content !== undefined ? { content: event.content } : {}),
        ...(event.locations !== undefined ? { locations: event.locations } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
      };
      // De-dup against the rare case where a harness re-emits the same
      // toolCallId (translator-level idempotency keeps this from happening
      // for well-behaved harnesses, but defensive at the reducer layer).
      const filtered = state.activeToolCalls.filter((c) => c.toolCallId !== event.toolCallId);
      return { ...state, activeToolCalls: [...filtered, next] };
    }
    case "tool_call.progress": {
      // Mid-call update — merge over the existing ActiveToolCall by
      // toolCallId. `undefined` on the event preserves prior; a value
      // (including `null` for content/locations as "explicit clear"
      // per ACP spec) replaces. Use `!== undefined` rather than `in`
      // membership so accidentally-undefined props from spreads don't
      // overwrite state.
      const existing = state.activeToolCalls.find((c) => c.toolCallId === event.toolCallId);
      if (!existing) {
        // Progress without a prior start — synthesize so the call shows
        // up. Most harnesses emit start first, but this keeps the TUI
        // robust if updates arrive out of order.
        const synthesized: ActiveToolCall = {
          toolCallId: event.toolCallId,
          toolName: "",
          status: event.status ?? "in_progress",
          startedAt: Date.now(),
          ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
          ...(event.content !== undefined ? { content: event.content } : {}),
          ...(event.locations !== undefined ? { locations: event.locations } : {}),
          ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
          ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
        };
        return { ...state, activeToolCalls: [...state.activeToolCalls, synthesized] };
      }
      const merged: ActiveToolCall = {
        ...existing,
        ...(event.status !== undefined ? { status: event.status } : {}),
        ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
        ...(event.content !== undefined ? { content: event.content } : {}),
        ...(event.locations !== undefined ? { locations: event.locations } : {}),
        ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
        ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
      };
      return {
        ...state,
        activeToolCalls: state.activeToolCalls.map((c) =>
          c.toolCallId === event.toolCallId ? merged : c,
        ),
      };
    }
    case "tool_call.args":
      // Argument streaming is rendered separately if the harness supplies
      // it; reducer state tracks high-level lifecycle only.
      return state;
    case "tool_call.end": {
      const matched = state.activeToolCalls.find((c) => c.toolCallId === event.toolCallId);
      const remaining = state.activeToolCalls.filter((c) => c.toolCallId !== event.toolCallId);
      // Merge the terminal payload over the prior state so the
      // completed entry carries all fields the harness has reported
      // across start → progress → end.
      const finalized: ActiveToolCall | null = matched
        ? {
            ...matched,
            status: event.status ?? "completed",
            ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
            ...(event.content !== undefined ? { content: event.content } : {}),
            ...(event.locations !== undefined ? { locations: event.locations } : {}),
            ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
            ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
          }
        : {
            // Synthesize an entry if `tool_call.start` was missed (some
            // harnesses skip intermediate updates) so the transcript
            // history still records the call.
            toolCallId: event.toolCallId,
            toolName: "",
            status: event.status ?? "completed",
            startedAt: Date.now(),
            ...(event.toolKind !== undefined ? { toolKind: event.toolKind } : {}),
            ...(event.content !== undefined ? { content: event.content } : {}),
            ...(event.locations !== undefined ? { locations: event.locations } : {}),
            ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
            ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
          };
      return {
        ...state,
        activeToolCalls: remaining,
        completedToolCalls: finalized
          ? [...state.completedToolCalls, finalized]
          : state.completedToolCalls,
      };
    }
    case "plan.updated":
      return { ...state, currentPlan: event.entries };
    case "commands.updated":
      return { ...state, availableCommands: event.commands };
    case "mode.changed":
      return {
        ...state,
        currentMode: { modeId: event.modeId },
      };
    case "usage.updated":
      return {
        ...state,
        lastUsage: {
          size: event.size,
          used: event.used,
          ...(event.cost !== undefined ? { cost: event.cost } : {}),
        },
      };
    case "session.info.updated": {
      // Three-state per field: `undefined` (or omitted) = preserve
      // prior; null = explicit clear (kept as null in state so the
      // TUI can distinguish "agent withdrew the title" from
      // "never had one"); string = replacement.
      //
      // Use `!== undefined` rather than `in` membership: an event
      // constructed via spread / partial merge can carry
      // `{ title: undefined }`, which `in` would treat as present
      // and overwrite state. The protocol semantic for `undefined`
      // is "no change", so dropping it here keeps construction
      // ergonomics aligned with the wire spec.
      const next = { ...state };
      if (event.title !== undefined) {
        next.sessionTitle = event.title;
      }
      if (event.updatedAt !== undefined) {
        next.sessionUpdatedAt = event.updatedAt;
      }
      return next;
    }
  }
}
