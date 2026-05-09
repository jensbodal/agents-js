import type {
  ComposerSurfaceState,
  WorkflowActivityEntryState,
  WorkflowSessionStateLike,
  WorkflowSurfaceContext,
} from "../types/workflow-surface.ts";
import type { WorkflowCopyMap } from "../workflow-copy.ts";
import { deriveTerminalEntries, describeElicitationTarget, getPromptQueueCount } from "./shared.ts";

export function deriveActivitySurface(
  copy: WorkflowCopyMap,
  state: WorkflowSessionStateLike | null | undefined,
  context: WorkflowSurfaceContext,
  composerSurface: ComposerSurfaceState,
) {
  const queuedCount = getPromptQueueCount(state);
  const terminals = deriveTerminalEntries(state?.currentTurn, context.runningTerminals);
  const runningTerminals = terminals.filter((entry) => entry.status === "active");
  const backgroundAgents = context.backgroundAgents ?? [];
  const items: WorkflowActivityEntryState[] = [];

  if (runningTerminals.length > 0) {
    items.push({
      id: "running-terminals",
      kind: "terminal",
      label:
        runningTerminals.length === 1
          ? copy.singleTerminalLabel
          : copy.multipleTerminalsLabel(runningTerminals.length),
      detail: runningTerminals.map((entry) => entry.label).join(", "),
      status: "active",
      count: runningTerminals.length,
    });
  }

  if (backgroundAgents.length > 0) {
    items.push({
      id: "background-agents",
      kind: "background_agent",
      label:
        backgroundAgents.length === 1
          ? copy.singleBackgroundAgentLabel
          : copy.multipleBackgroundAgentsLabel(backgroundAgents.length),
      detail: backgroundAgents.map((entry) => entry.label).join(", "),
      status: backgroundAgents.some((entry) => entry.status === "error") ? "error" : "active",
      count: backgroundAgents.length,
    });
  }

  if (queuedCount > 0) {
    items.push({
      id: "queued-follow-ups",
      kind: "queued_follow_up",
      label:
        queuedCount === 1
          ? copy.singleQueuedFollowUpLabel
          : copy.multipleQueuedFollowUpsLabel(queuedCount),
      detail: copy.queuedPromptDetail,
      status: "queued",
      count: queuedCount,
    });
  }

  if (context.pendingSteer) {
    items.push({
      id: "pending-steer",
      kind: "pending_steer",
      label: copy.steerPendingLabel,
      detail: copy.steerPendingDetail,
      status: "queued",
    });
  }

  if (state?.status === "waiting_permission") {
    items.push({
      id: "pending-permission",
      kind: "permission",
      label: copy.permissionRequestLabel,
      detail: state.currentTurn?.pendingPermission?.request?.toolCall?.title ?? null,
      status: "waiting",
    });
  }

  if (state?.pendingWriteGate?.path) {
    items.push({
      id: "pending-write-gate",
      kind: "write_gate",
      label: copy.writeReviewLabel,
      detail: state.pendingWriteGate.path,
      status: "waiting",
    });
  }

  if (state?.status === "waiting_elicitation") {
    items.push({
      id: "pending-elicitation",
      kind: "elicitation",
      label: copy.inputRequiredLabel,
      detail: describeElicitationTarget(copy, state.pendingElicitation?.request),
      status: "waiting",
    });
  }

  if (composerSurface.detailText) {
    items.push({
      id: "response-summary",
      kind: "response",
      label: composerSurface.label,
      detail: composerSurface.detailText,
      status:
        composerSurface.severity === "error"
          ? "error"
          : composerSurface.mode === "ready" || composerSurface.mode === "idle"
            ? "done"
            : composerSurface.mode === "blocked"
              ? "waiting"
              : "active",
    });
  }

  let phase: "idle" | "running" | "waiting" | "ready" | "error" = "idle";
  if (composerSurface.severity === "error") {
    phase = "error";
  } else if (state?.status === "waiting_permission" || state?.status === "waiting_elicitation") {
    phase = "waiting";
  } else if (
    state?.status === "prompting" ||
    state?.status === "cancelling" ||
    queuedCount > 0 ||
    context.pendingSteer
  ) {
    phase = "running";
  } else if (state?.status === "ready") {
    phase = "ready";
  }

  return {
    visible: items.length > 0,
    phase,
    sessionStatus: state?.status ?? null,
    summary: composerSurface.detailText || null,
    runningTerminalCount: runningTerminals.length,
    backgroundAgentCount: backgroundAgents.length,
    queuedFollowUpCount: queuedCount,
    pendingSteer: !!context.pendingSteer,
    items,
  };
}
