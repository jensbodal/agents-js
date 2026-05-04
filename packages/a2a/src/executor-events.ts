import type { Message, Task, TaskStatus, TaskStatusUpdateEvent } from "@a2a-js/sdk";

export function nowIso(): string {
  return new Date().toISOString();
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
  const agentMessage: Message = {
    kind: "message",
    role: "agent",
    messageId: options.messageId ?? crypto.randomUUID(),
    parts: [{ kind: "text", text: options.text }],
    taskId,
    contextId,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };

  return {
    kind: "task",
    id: taskId,
    contextId,
    status: {
      state: options.state,
      timestamp: nowIso(),
      message: agentMessage,
    },
    history: [userMessage, agentMessage],
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

/**
 * Build a TaskStatusUpdateEvent for streaming status changes.
 * Optionally includes a text message in the status.
 */
export function buildStatusUpdate(
  taskId: string,
  contextId: string,
  options: {
    final: boolean;
    messageId?: string;
    metadata?: Record<string, unknown>;
    state: TaskStatus["state"];
    text?: string;
  },
): TaskStatusUpdateEvent {
  const message =
    options.text !== undefined
      ? {
          kind: "message" as const,
          role: "agent" as const,
          messageId: options.messageId ?? crypto.randomUUID(),
          parts: [{ kind: "text" as const, text: options.text }],
          taskId,
          contextId,
        }
      : undefined;

  return {
    kind: "status-update",
    taskId,
    contextId,
    ...(options.metadata ? { metadata: options.metadata } : {}),
    status: {
      state: options.state,
      timestamp: nowIso(),
      ...(message ? { message } : {}),
    },
    final: options.final,
  };
}
