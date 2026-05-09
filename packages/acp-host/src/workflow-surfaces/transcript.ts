import type { TurnItem } from "../types/session.ts";
import type {
  WorkflowSessionStateLike,
  WorkflowSurfaceSeverity,
  WorkflowToolCallLike,
} from "../types/workflow-surface.ts";
import type { WorkflowCopyMap } from "../workflow-copy.ts";
import {
  collectToolCallStats,
  getToolCallById,
  getToolCalls,
  getTrailingToolBlockStats,
  summarizeToolGroup,
} from "./tool-stats.ts";

export function deriveTranscriptSurface(
  copy: WorkflowCopyMap,
  state: WorkflowSessionStateLike | null | undefined,
) {
  const currentTurn = state?.currentTurn;
  const toolCalls = getToolCalls(currentTurn);
  const trailingStats = getTrailingToolBlockStats(currentTurn);
  const trailingItems: WorkflowToolCallLike[] = [];

  if (currentTurn?.turnItems?.length) {
    for (let index = currentTurn.turnItems.length - 1; index >= 0; index -= 1) {
      const item = currentTurn.turnItems[index] as TurnItem | undefined;
      if (!item) {
        continue;
      }
      if (item.type === "text") {
        break;
      }
      const toolCall = getToolCallById(currentTurn, item.id);
      if (toolCall) {
        trailingItems.unshift(toolCall);
      }
    }
  }

  const toolBlockSummary =
    trailingItems.length > 0
      ? summarizeToolGroup(trailingItems, copy)
      : {
          summary: null,
          status: null,
          severity: "neutral" as WorkflowSurfaceSeverity,
        };

  const postToolProgressText =
    state?.status !== "prompting" ||
    trailingStats.total === 0 ||
    trailingStats.running > 0 ||
    trailingStats.pending > 0
      ? null
      : trailingStats.failed > 0
        ? copy.postToolFailedProgress
        : copy.postToolFinishedProgress;

  const overallStats = collectToolCallStats(toolCalls);
  const recoverableFailureSummary =
    state?.status === "prompting" && (overallStats.failed > 0 || trailingStats.failed > 0)
      ? copy.recoverableFailure
      : null;

  return {
    sessionId: state?.sessionId ?? null,
    title: state?.sessionTitle ?? null,
    hasActiveTurn: !!currentTurn,
    hasVisibleText: (currentTurn?.textChunks?.length ?? 0) > 0,
    textChunkCount: currentTurn?.textChunks?.length ?? 0,
    postToolProgressText,
    recoverableFailureSummary,
    toolBlock: {
      hasTrailingBlock: trailingStats.total > 0,
      summary: toolBlockSummary.summary,
      statusText: toolBlockSummary.status,
      severity: toolBlockSummary.severity,
      totalCount: trailingStats.total,
      runningCount: trailingStats.running,
      failedCount: trailingStats.failed,
      completedCount: trailingStats.completed,
      pendingCount: trailingStats.pending,
    },
  };
}
