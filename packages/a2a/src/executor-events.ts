import {
  type Message,
  type Part,
  Role,
  type Task,
  type TaskStatus,
  type TaskStatusUpdateEvent,
} from "@a2a-js/sdk";

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Wire-boundary helpers. A2A 1.0 uses protobuf-canonical shapes: parts carry
 * a `content: { $case, value }` union (plus required `filename`/`mediaType`),
 * roles are the `Role` enum, and messages carry `extensions`/`referenceTaskIds`.
 * These builders keep that scaffolding in one place so the executor logic above
 * stays in plain terms.
 */
function textPart(value: string): Part {
  return {
    content: { $case: "text", value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function agentMessage(
  taskId: string,
  contextId: string,
  text: string,
  messageId?: string,
  metadata?: Record<string, unknown>,
): Message {
  return {
    messageId: messageId ?? crypto.randomUUID(),
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    taskId,
    contextId,
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

/**
 * Build a terminal Task snapshot with an agent message in the history.
 * Used for final (completed/failed/rejected/canceled) task publications.
 */
export function buildTerminalTask(
  taskId: string,
  contextId: string,
  userMessage: Message,
  options: {
    messageId?: string;
    metadata?: Record<string, unknown>;
    state: TaskStatus["state"];
    text: string;
  },
): Task {
  const message = agentMessage(
    taskId,
    contextId,
    options.text,
    options.messageId,
    options.metadata,
  );

  return {
    id: taskId,
    contextId,
    status: {
      state: options.state,
      timestamp: nowIso(),
      message,
    },
    artifacts: [],
    history: [userMessage, message],
    metadata: options.metadata,
  };
}

/**
 * Build a TaskStatusUpdateEvent for streaming status changes.
 * Optionally includes a text message in the status.
 *
 * A2A 1.0 dropped the `final` discriminator: stream termination is driven by
 * the task's `TaskState` (terminal states — COMPLETED/FAILED/CANCELED/REJECTED
 * — close the SSE stream; WORKING keeps it open). The non-text agent signals
 * that ride on `metadata` (see `wire-kinds.ts`) are carried unchanged.
 */
export function buildStatusUpdate(
  taskId: string,
  contextId: string,
  options: {
    messageId?: string;
    metadata?: Record<string, unknown>;
    state: TaskStatus["state"];
    text?: string;
  },
): TaskStatusUpdateEvent {
  const message =
    options.text !== undefined
      ? agentMessage(taskId, contextId, options.text, options.messageId)
      : undefined;

  return {
    taskId,
    contextId,
    metadata: options.metadata,
    status: {
      state: options.state,
      timestamp: nowIso(),
      message,
    },
  };
}
