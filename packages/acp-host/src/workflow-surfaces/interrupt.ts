import type {
  WorkflowInterruptBlocker,
  WorkflowSessionStateLike,
  WorkflowSurfaceContext,
} from "../types/workflow-surface.ts";
import type { WorkflowCopyMap } from "../workflow-copy.ts";
import { describeQueuedFollowUpBoundary, getPromptQueueCount } from "./shared.ts";

export function deriveInterruptSurface(
  copy: WorkflowCopyMap,
  state: WorkflowSessionStateLike | null | undefined,
  context: WorkflowSurfaceContext,
) {
  const status = state?.status ?? "idle";
  const queuedCount = getPromptQueueCount(state);
  const promptingLike =
    status === "prompting" ||
    status === "waiting_permission" ||
    status === "waiting_elicitation" ||
    status === "cancelling";
  const blocker: WorkflowInterruptBlocker =
    status === "waiting_permission"
      ? "permission"
      : state?.pendingWriteGate?.path
        ? "write_gate"
        : status === "waiting_elicitation"
          ? "elicitation"
          : "none";

  const nextActionSummary = context.pendingSteer
    ? queuedCount > 0
      ? copy.steerReplacesQueuedWithPending
      : copy.steerSendsAtSafePoint
    : queuedCount > 0
      ? copy.queuedFollowUpsWillRun
      : blocker === "permission"
        ? copy.approvePermission
        : blocker === "write_gate"
          ? copy.approveWriteReview
          : blocker === "elicitation"
            ? copy.submitElicitation
            : null;

  return {
    blocker,
    queue: {
      enabled: promptingLike,
      pending: queuedCount > 0,
      summary: promptingLike ? describeQueuedFollowUpBoundary(copy, queuedCount) : null,
    },
    steer: {
      enabled: promptingLike && status !== "cancelling",
      pending: !!context.pendingSteer,
      summary: promptingLike ? copy.steerInterruptSummary : null,
    },
    cancel: {
      enabled: promptingLike,
      pending: status === "cancelling",
      summary: promptingLike ? copy.cancelSummary : null,
    },
    queuedFollowUpCount: queuedCount,
    clearsQueuedOnSteer: true,
    nextActionSummary,
    pendingPermission: state?.currentTurn?.pendingPermission ?? null,
    pendingWriteGate: state?.pendingWriteGate ?? null,
  };
}
