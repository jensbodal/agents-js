import type { WorkflowErrorSummary } from "../types/workflow-surface.ts";
import { defaultWorkflowCopy, type WorkflowCopyMap } from "../workflow-copy.ts";

export function describeWorkflowError(
  lastError: string | null | undefined,
  copy: WorkflowCopyMap = defaultWorkflowCopy,
): WorkflowErrorSummary {
  if (!lastError) {
    return {
      summary: copy.errorSessionFailed,
      actionHint: copy.errorSessionFailedHint,
      technicalDetail: null,
    };
  }

  const normalized = lastError.toLowerCase();
  if (
    normalized.includes("command not found") ||
    normalized.includes("enoent") ||
    normalized.includes("not on path")
  ) {
    return {
      summary: copy.errorCommandNotStarted,
      actionHint: copy.errorCommandNotStartedHint,
      technicalDetail: lastError,
    };
  }

  if (normalized.includes("timed out")) {
    return {
      summary: copy.errorTimedOut,
      actionHint: copy.errorTimedOutHint,
      technicalDetail: lastError,
    };
  }

  if (normalized.includes("exited unexpectedly") || normalized.includes("exit code")) {
    return {
      summary: copy.errorProcessStopped,
      actionHint: copy.errorProcessStoppedHint,
      technicalDetail: lastError,
    };
  }

  return {
    summary: copy.errorGeneric,
    actionHint: copy.errorGenericHint,
    technicalDetail: lastError,
  };
}
