import type { TurnItem } from "../types/session.ts";
import type {
  WorkflowToolCallLike,
  WorkflowToolCallStats,
  WorkflowToolGroupSummary,
  WorkflowTurnStateLike,
} from "../types/workflow-surface.ts";
import { defaultWorkflowCopy, type WorkflowCopyMap } from "../workflow-copy.ts";

export function emptyToolCallStats(): WorkflowToolCallStats {
  return {
    total: 0,
    running: 0,
    failed: 0,
    completed: 0,
    pending: 0,
  };
}

export function getToolCalls(turn?: WorkflowTurnStateLike | null): WorkflowToolCallLike[] {
  const toolCalls = turn?.toolCalls;
  if (!toolCalls) {
    return [];
  }
  if (toolCalls instanceof Map) {
    return Array.from(toolCalls.values());
  }
  return Object.values(toolCalls).filter(
    (value): value is WorkflowToolCallLike =>
      value != null && typeof value === "object" && typeof value.id === "string",
  );
}

export function getToolCallById(
  turn: WorkflowTurnStateLike | null | undefined,
  id: string,
): WorkflowToolCallLike | null {
  if (!turn?.toolCalls) {
    return null;
  }
  if (turn.toolCalls instanceof Map) {
    return turn.toolCalls.get(id) ?? null;
  }
  return turn.toolCalls[id] ?? null;
}

export function describeRunningTools(
  currentTurn: WorkflowTurnStateLike | null | undefined,
  maxNames = 2,
): string {
  const toolCalls = getToolCalls(currentTurn);
  const running = toolCalls.filter((tc) => tc.status === "running");
  if (running.length === 0) return "";
  const names = running.slice(0, maxNames).map((tc) => tc.name || "tool");
  if (running.length > maxNames) {
    return `${names.join(", ")} (+${running.length - maxNames} more)`;
  }
  return names.join(", ");
}

export function collectToolCallStats(
  toolCalls: Iterable<WorkflowToolCallLike>,
): WorkflowToolCallStats {
  const stats = emptyToolCallStats();
  for (const toolCall of toolCalls) {
    stats.total += 1;
    switch (toolCall.status) {
      case "running":
        stats.running += 1;
        break;
      case "failed":
        stats.failed += 1;
        break;
      case "completed":
        stats.completed += 1;
        break;
      default:
        stats.pending += 1;
        break;
    }
  }
  return stats;
}

export function formatToolCallStatus(
  status: WorkflowToolCallLike["status"],
  copy: WorkflowCopyMap = defaultWorkflowCopy,
): string {
  switch (status) {
    case "completed":
      return copy.toolStatusDone;
    case "failed":
      return copy.toolStatusFailed;
    case "running":
      return copy.toolStatusRunning;
    default:
      return copy.toolStatusPending;
  }
}

export function getTrailingToolBlockStats(
  turn: WorkflowTurnStateLike | null | undefined,
): WorkflowToolCallStats {
  if (!turn?.turnItems?.length) {
    return emptyToolCallStats();
  }

  const trailingToolCalls: WorkflowToolCallLike[] = [];
  for (let index = turn.turnItems.length - 1; index >= 0; index -= 1) {
    const item = turn.turnItems[index] as TurnItem | undefined;
    if (!item) {
      continue;
    }
    if (item.type === "text") {
      break;
    }
    const toolCall = getToolCallById(turn, item.id);
    if (toolCall) {
      trailingToolCalls.unshift(toolCall);
    }
  }

  return collectToolCallStats(trailingToolCalls);
}

export function summarizeToolGroup(
  toolCalls: WorkflowToolCallLike[],
  copy: WorkflowCopyMap = defaultWorkflowCopy,
): WorkflowToolGroupSummary {
  const stats = collectToolCallStats(toolCalls);
  const firstTool = toolCalls[0];
  const summary =
    stats.total === 1
      ? (firstTool?.name ?? copy.singleToolFallbackName)
      : copy.multiToolSummary(stats.total);

  if (stats.running > 0 && stats.failed > 0) {
    return {
      summary,
      status: copy.toolGroupFailedStillWorking(stats.failed),
      severity: "warning",
    };
  }
  if (stats.running > 0) {
    return {
      summary,
      status: copy.toolGroupRunning,
      severity: "info",
    };
  }
  if (stats.failed > 0) {
    return {
      summary,
      status: copy.toolGroupFailed(stats.failed),
      severity: "warning",
    };
  }
  if (stats.completed > 0 && stats.completed === stats.total) {
    return {
      summary,
      status: copy.toolGroupDone,
      severity: "neutral",
    };
  }
  return {
    summary,
    status: copy.toolGroupPending,
    severity: "neutral",
  };
}
