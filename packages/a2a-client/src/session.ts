import type { Message, Task } from "@a2a-js/sdk";
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

const TERMINAL_TASK_STATES = new Set(["completed", "failed", "canceled", "rejected", "unknown"]);

export function isTerminalTaskState(state: string): boolean {
  return TERMINAL_TASK_STATES.has(state);
}

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
  if (!message) {
    return "";
  }
  return collectTextParts(message.parts ?? [])
    .join("\n")
    .trim();
}

export function extractLatestAgentMessage(task: Task): Message | undefined {
  const history = Array.isArray(task.history) ? task.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const candidate = history[index];
    if (candidate?.role === "agent") {
      return candidate;
    }
  }

  const statusMessage = task.status?.message;
  if (statusMessage?.role === "agent") {
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
        taskState: event.task?.status.state,
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
      const text = extractMessageText(event.update.status.message);
      const metadata = event.update.metadata;
      const activeElicitation = extractAcpElicitationMetadata(metadata);
      const activeAuth = extractAcpAuthRequiredMetadata(metadata);

      return {
        ...state,
        status: computeSessionStatusFromTaskState(event.update.status.state, !!event.update.final),
        contextId: event.update.contextId ?? state.contextId,
        taskId: event.update.taskId ?? state.taskId,
        resumableTaskId: event.update.final
          ? undefined
          : (event.update.taskId ?? state.resumableTaskId),
        taskState: event.update.status.state,
        activeElicitation,
        activeAuth,
        pendingAgentText: text ? text : event.update.final ? undefined : state.pendingAgentText,
      };
    }
    case "task.artifact.updated":
      return {
        ...state,
        contextId: event.update.contextId ?? state.contextId,
        taskId: event.update.taskId ?? state.taskId,
        resumableTaskId: event.update.taskId ?? state.resumableTaskId,
      };
    case "task.updated":
      return {
        ...state,
        status: computeSessionStatusFromTaskState(
          event.task.status.state,
          isTerminalTaskState(event.task.status.state),
        ),
        contextId: event.task.contextId ?? state.contextId,
        taskId: event.task.id ?? state.taskId,
        resumableTaskId: isTerminalTaskState(event.task.status.state)
          ? undefined
          : (event.task.id ?? state.resumableTaskId),
        taskState: event.task.status.state,
        activeElicitation: extractAcpElicitationMetadata(event.task.metadata),
        activeAuth: extractAcpAuthRequiredMetadata(event.task.metadata),
        pendingAgentText: isTerminalTaskState(event.task.status.state)
          ? undefined
          : extractMessageText(event.task.status.message) || state.pendingAgentText,
      };
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
        status: "in_progress",
        startedAt,
      };
      // De-dup against the rare case where a harness re-emits the same
      // toolCallId (translator-level idempotency keeps this from happening
      // for well-behaved harnesses, but defensive at the reducer layer).
      const filtered = state.activeToolCalls.filter((c) => c.toolCallId !== event.toolCallId);
      return { ...state, activeToolCalls: [...filtered, next] };
    }
    case "tool_call.args":
      // Argument streaming is rendered separately if the harness supplies
      // it; reducer state tracks high-level lifecycle only.
      return state;
    case "tool_call.end": {
      const matched = state.activeToolCalls.find((c) => c.toolCallId === event.toolCallId);
      const remaining = state.activeToolCalls.filter((c) => c.toolCallId !== event.toolCallId);
      const finalized: ActiveToolCall | null = matched
        ? { ...matched, status: event.status ?? "completed" }
        : {
            // Synthesize an entry if `tool_call.start` was missed (some
            // harnesses skip intermediate updates) so the transcript
            // history still records the call.
            toolCallId: event.toolCallId,
            toolName: "",
            status: event.status ?? "completed",
            startedAt: Date.now(),
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
  }
}
