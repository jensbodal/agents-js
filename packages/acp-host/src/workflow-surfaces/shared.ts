import type { PendingElicitation } from "../types/session.ts";
import type {
  WorkflowActivityEntryState,
  WorkflowSessionStateLike,
  WorkflowTurnStateLike,
} from "../types/workflow-surface.ts";
import type { WorkflowCopyMap } from "../workflow-copy.ts";
import { getToolCalls } from "./tool-stats.ts";

export function describeElicitationTarget(
  copy: WorkflowCopyMap,
  request: PendingElicitation["request"] | null | undefined,
): string {
  if (!request) {
    return copy.elicitationFallbackLabel;
  }
  if (request.mode === "form") {
    return request.requestedSchema?.title ?? request.message ?? copy.elicitationFallbackLabel;
  }
  return request.message ?? copy.elicitationFallbackLabel;
}

export function describeQueuedFollowUpBoundary(copy: WorkflowCopyMap, queuedCount: number): string {
  if (queuedCount > 0) {
    const queuedLabel =
      queuedCount === 1 ? copy.singleFollowUpQueued : copy.followUpsQueued(queuedCount);
    return `${queuedLabel} ${copy.queueBoundarySuffix}`;
  }
  return copy.queueFallbackBoundary;
}

export function getPromptQueueCount(state?: WorkflowSessionStateLike | null): number {
  return Array.isArray(state?.promptQueue) ? state.promptQueue.length : 0;
}

export function deriveTerminalEntries(
  turn: WorkflowTurnStateLike | null | undefined,
  explicitEntries: WorkflowActivityEntryState[] | undefined,
): WorkflowActivityEntryState[] {
  const terminalMap = new Map<string, WorkflowActivityEntryState>();

  for (const entry of explicitEntries ?? []) {
    terminalMap.set(entry.id, entry);
  }

  for (const toolCall of getToolCalls(turn)) {
    for (const item of toolCall.richContent ?? []) {
      if (item.type !== "terminal" || !item.terminalId) {
        continue;
      }

      const existing = terminalMap.get(item.terminalId);
      if (existing) {
        if (toolCall.status === "running") {
          existing.status = "active";
          existing.detail = toolCall.name;
        }
        continue;
      }

      terminalMap.set(item.terminalId, {
        id: item.terminalId,
        kind: "terminal",
        label: item.terminalId,
        detail: toolCall.name,
        status: toolCall.status === "running" ? "active" : "done",
      });
    }
  }

  return Array.from(terminalMap.values());
}
