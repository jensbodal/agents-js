import type {
  ComposerSurfaceState,
  WorkflowSessionStateLike,
  WorkflowSurfaceContext,
  WorkflowSurfaceSeverity,
} from "../types/workflow-surface.ts";
import type { WorkflowCopyMap } from "../workflow-copy.ts";
import { describeWorkflowError } from "./error-summary.ts";
import {
  deriveTerminalEntries,
  describeElicitationTarget,
  describeQueuedFollowUpBoundary,
  getPromptQueueCount,
} from "./shared.ts";
import {
  collectToolCallStats,
  describeRunningTools,
  getToolCalls,
  getTrailingToolBlockStats,
} from "./tool-stats.ts";

function getPromptingCopy(
  copy: WorkflowCopyMap,
  state: WorkflowSessionStateLike | null | undefined,
  context: WorkflowSurfaceContext,
): {
  detailText: string;
  helperText: string;
  placeholderText: string;
  severity: WorkflowSurfaceSeverity;
} {
  const currentTurn = state?.currentTurn;
  const stats = collectToolCallStats(getToolCalls(currentTurn));
  const queuedCount = getPromptQueueCount(state);
  const trailingToolStats = getTrailingToolBlockStats(currentTurn);
  const runningTerminals = deriveTerminalEntries(currentTurn, context.runningTerminals).filter(
    (entry) => entry.status === "active",
  );
  const activeBackgroundAgents = (context.backgroundAgents ?? []).filter(
    (entry) => entry.status === "active" || entry.status === "queued",
  );
  const queuedBoundaryCopy = describeQueuedFollowUpBoundary(copy, queuedCount);
  const writeGateTarget = state?.pendingWriteGate?.path ?? null;

  if (writeGateTarget) {
    return {
      detailText: `${copy.writeGateDetail(writeGateTarget)} ${queuedBoundaryCopy}`,
      helperText: `${copy.writeGateHelper(writeGateTarget)} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: copy.dynamicPlaceholderWriteGate(writeGateTarget),
      severity: "warning",
    };
  }

  if (runningTerminals.length > 0) {
    return {
      detailText:
        queuedCount > 0
          ? `${copy.terminalRunningDetailQueued} ${queuedBoundaryCopy}`
          : copy.terminalRunningDetail,
      helperText: `${copy.terminalRunningHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: copy.dynamicPlaceholderTerminal,
      severity: "info",
    };
  }

  if (activeBackgroundAgents.length > 0) {
    return {
      detailText:
        queuedCount > 0
          ? `${copy.backgroundAgentDetailQueued} ${queuedBoundaryCopy}`
          : copy.backgroundAgentDetail,
      helperText: `${copy.backgroundAgentHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: copy.dynamicPlaceholderBackgroundAgent,
      severity: "info",
    };
  }

  if (stats.running > 0 && stats.failed > 0) {
    return {
      detailText:
        queuedCount > 0
          ? `${copy.toolFailedStillWorkingDetailQueued} ${queuedBoundaryCopy}`
          : copy.toolFailedStillWorkingDetail,
      helperText: `${copy.toolFailedRecoveryHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: copy.dynamicPlaceholderToolsFailing(stats.running, stats.failed),
      severity: "warning",
    };
  }

  if (stats.running > 0) {
    const toolLabel =
      stats.running === 1 ? copy.singleToolRunning : copy.multipleToolsRunning(stats.running);
    const runningToolNames = describeRunningTools(currentTurn);
    return {
      detailText:
        queuedCount > 0
          ? `${copy.agentStillWorkingDetail} ${toolLabel} ${queuedBoundaryCopy}`
          : `${copy.agentStillWorkingDetail} ${toolLabel}`,
      helperText: `${copy.agentStillWorkingHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: runningToolNames
        ? copy.dynamicPlaceholderRunning(runningToolNames)
        : copy.dynamicPlaceholderThinking,
      severity: "info",
    };
  }

  if (queuedCount > 0) {
    return {
      detailText: `${copy.agentStillWorkingDetail} ${queuedBoundaryCopy}`,
      helperText: `${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: copy.dynamicPlaceholderThinking,
      severity: "info",
    };
  }

  if (trailingToolStats.total > 0 && trailingToolStats.failed > 0) {
    return {
      detailText: copy.trailingToolFailedDetail,
      helperText: `${copy.trailingToolFailedHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: copy.dynamicPlaceholderToolsFinished,
      severity: "warning",
    };
  }

  if (trailingToolStats.total > 0) {
    return {
      detailText: copy.toolCallsFinishedDetail,
      helperText: `${copy.toolCallsFinishedHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: copy.dynamicPlaceholderToolsFinished,
      severity: "info",
    };
  }

  if (stats.failed > 0) {
    return {
      detailText: copy.toolFailedAfterDoneDetail,
      helperText: `${copy.toolFailedAfterDoneHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
      placeholderText: copy.dynamicPlaceholderToolsFinished,
      severity: "warning",
    };
  }

  return {
    detailText: copy.agentRespondingDetail,
    helperText: `${copy.agentRespondingHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
    placeholderText: copy.dynamicPlaceholderResponding,
    severity: "info",
  };
}

export function deriveComposerSurface(
  copy: WorkflowCopyMap,
  state: WorkflowSessionStateLike | null | undefined,
  context: WorkflowSurfaceContext,
): ComposerSurfaceState {
  if (context.externalLoadingActive) {
    const detailText = context.externalLoadingMessage ?? copy.externalLoadingFallback;
    return {
      mode: "loading" as const,
      label: copy.loadingLabel,
      detailText,
      helperText: "",
      placeholderText: copy.loadingPlaceholder,
      technicalDetail: null,
      severity: "info" as const,
      disabled: true,
      canSendImmediately: false,
      canQueue: false,
      canSteer: false,
      canCancel: false,
      queuedFollowUpCount: getPromptQueueCount(state),
      pendingSteer: !!context.pendingSteer,
    };
  }

  const status = state?.status ?? "idle";
  const queuedCount = getPromptQueueCount(state);
  const pendingSteer = !!context.pendingSteer;
  const promptingLike =
    status === "prompting" ||
    status === "waiting_permission" ||
    status === "waiting_elicitation" ||
    status === "cancelling";

  let base: ComposerSurfaceState;

  switch (status) {
    case "idle":
      base = {
        mode: "idle",
        label: copy.idleLabel,
        detailText: copy.idleDetail,
        helperText: copy.idleHelper,
        placeholderText: copy.idlePlaceholder,
        technicalDetail: null,
        severity: "neutral",
        disabled: true,
        canSendImmediately: false,
        canQueue: false,
        canSteer: false,
        canCancel: false,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    case "initializing":
      base = {
        mode: "loading",
        label: copy.startingLabel,
        detailText: copy.connectingDetail,
        helperText: "",
        placeholderText: copy.connectingPlaceholder,
        technicalDetail: null,
        severity: "info",
        disabled: true,
        canSendImmediately: false,
        canQueue: false,
        canSteer: false,
        canCancel: false,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    case "ready":
      base = {
        mode: "ready",
        label: copy.readyLabel,
        detailText: copy.readyDetail,
        helperText: copy.readyHelper,
        placeholderText: copy.readyPlaceholder,
        technicalDetail: null,
        severity: "neutral",
        disabled: false,
        canSendImmediately: true,
        canQueue: false,
        canSteer: false,
        canCancel: false,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    case "loading":
      base = {
        mode: "loading",
        label: copy.restoringLabel,
        detailText: copy.restoringDetail,
        helperText: copy.restoringHelper,
        placeholderText: copy.restoringPlaceholder,
        technicalDetail: null,
        severity: "info",
        disabled: true,
        canSendImmediately: false,
        canQueue: false,
        canSteer: false,
        canCancel: false,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    case "prompting": {
      const promptingCopy = getPromptingCopy(copy, state, context);
      base = {
        mode: pendingSteer ? "steering" : queuedCount > 0 ? "queueing" : "working",
        label: copy.workingLabel,
        detailText: promptingCopy.detailText,
        helperText: promptingCopy.helperText,
        placeholderText: promptingCopy.placeholderText,
        technicalDetail: null,
        severity: promptingCopy.severity,
        disabled: false,
        canSendImmediately: false,
        canQueue: true,
        canSteer: true,
        canCancel: true,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    }
    case "waiting_permission": {
      const target =
        state?.currentTurn?.pendingPermission?.request?.toolCall?.title ??
        copy.blockedActionFallback;
      const queuedBoundaryCopy = describeQueuedFollowUpBoundary(copy, queuedCount);
      base = {
        mode: "blocked",
        label: copy.needsApprovalLabel,
        detailText: `${copy.permissionNeededDetail(target)} ${queuedBoundaryCopy}`,
        helperText: `${copy.permissionDialogHelper(target)} ${queuedBoundaryCopy} ${copy.queueInterruptHint} ${copy.permissionContinueHint}`,
        placeholderText: copy.permissionPlaceholder,
        technicalDetail: null,
        severity: "warning",
        disabled: false,
        canSendImmediately: false,
        canQueue: true,
        canSteer: true,
        canCancel: true,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    }
    case "waiting_elicitation": {
      const title = describeElicitationTarget(copy, state?.pendingElicitation?.request);
      const queuedBoundaryCopy = describeQueuedFollowUpBoundary(copy, queuedCount);
      base = {
        mode: "blocked",
        label: copy.needsInputLabel,
        detailText: `${copy.elicitationNeededDetail(title)} ${queuedBoundaryCopy}`,
        helperText: `${copy.elicitationHelper} ${queuedBoundaryCopy} ${copy.queueInterruptHint}`,
        placeholderText: copy.elicitationPlaceholder,
        technicalDetail: null,
        severity: "warning",
        disabled: false,
        canSendImmediately: false,
        canQueue: true,
        canSteer: true,
        canCancel: true,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    }
    case "cancelling":
      base = {
        mode: pendingSteer ? "steering" : "stopping",
        label: copy.stoppingLabel,
        detailText: pendingSteer ? copy.stoppingSteerDetail : copy.stoppingDetail,
        helperText: pendingSteer ? copy.stoppingSteerHelper : copy.stoppingHelper,
        placeholderText: pendingSteer ? copy.stoppingSteerPlaceholder : copy.stoppingPlaceholder,
        technicalDetail: null,
        severity: "info",
        disabled: false,
        canSendImmediately: false,
        canQueue: true,
        canSteer: false,
        canCancel: true,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    case "error": {
      const errorDisplay = describeWorkflowError(state?.lastError ?? null, copy);
      base = {
        mode: "error",
        label: copy.needsAttentionLabel,
        detailText: `${errorDisplay.summary} ${errorDisplay.actionHint}`,
        helperText: `${errorDisplay.summary} ${errorDisplay.actionHint}`,
        placeholderText: copy.errorPlaceholder,
        technicalDetail: errorDisplay.technicalDetail,
        severity: "error",
        disabled: false,
        canSendImmediately: false,
        canQueue: false,
        canSteer: false,
        canCancel: false,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    }
    case "closed":
      base = {
        mode: "idle",
        label: copy.closedLabel,
        detailText: copy.closedDetail,
        helperText: copy.closedHelper,
        placeholderText: copy.closedPlaceholder,
        technicalDetail: null,
        severity: "neutral",
        disabled: true,
        canSendImmediately: false,
        canQueue: false,
        canSteer: false,
        canCancel: false,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
    default:
      base = {
        mode: promptingLike ? "working" : "idle",
        label: copy.unknownStatusLabel(status),
        detailText: "",
        helperText: "",
        placeholderText: copy.defaultPlaceholder,
        technicalDetail: null,
        severity: "neutral",
        disabled: !promptingLike,
        canSendImmediately: false,
        canQueue: promptingLike,
        canSteer: promptingLike,
        canCancel: promptingLike,
        queuedFollowUpCount: queuedCount,
        pendingSteer,
      };
      break;
  }

  if (context.statusOverride) {
    return {
      ...base,
      detailText: context.statusOverride.detailText,
      helperText: context.statusOverride.helperText ?? context.statusOverride.detailText,
    };
  }

  return base;
}
