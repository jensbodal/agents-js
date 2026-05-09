/**
 * Configurable copy map for workflow surface UI strings.
 *
 * All user-facing text in `workflow-surfaces.ts` is sourced from this map,
 * enabling future i18n support and consumer-level overrides.
 */

/**
 * Type-safe interface for all workflow surface UI copy strings.
 * Consumers may supply a partial override to customize any subset of strings.
 */
export interface WorkflowCopyMap {
  // -- Elicitation target fallback --
  elicitationFallbackLabel: string;

  // -- Queue / follow-up copy --
  singleFollowUpQueued: string;
  followUpsQueued: (count: number) => string;
  queueFallbackBoundary: string;
  queueInterruptHint: string;
  queuePlaceholder: string;

  // -- Tool call status labels --
  toolStatusDone: string;
  toolStatusFailed: string;
  toolStatusRunning: string;
  toolStatusPending: string;

  // -- Tool group summaries --
  toolGroupFailedStillWorking: (failedCount: number) => string;
  toolGroupRunning: string;
  toolGroupFailed: (failedCount: number) => string;
  toolGroupDone: string;
  toolGroupPending: string;
  singleToolFallbackName: string;

  // -- Error descriptions --
  errorSessionFailed: string;
  errorSessionFailedHint: string;
  errorCommandNotStarted: string;
  errorCommandNotStartedHint: string;
  errorTimedOut: string;
  errorTimedOutHint: string;
  errorProcessStopped: string;
  errorProcessStoppedHint: string;
  errorGeneric: string;
  errorGenericHint: string;

  // -- Prompting copy --
  writeGateDetail: (target: string) => string;
  writeGateHelper: (target: string) => string;
  terminalRunningDetail: string;
  terminalRunningDetailQueued: string;
  terminalRunningHelper: string;
  backgroundAgentDetail: string;
  backgroundAgentDetailQueued: string;
  backgroundAgentHelper: string;
  toolFailedStillWorkingDetail: string;
  toolFailedStillWorkingDetailQueued: string;
  toolFailedRecoveryHelper: string;
  singleToolRunning: string;
  multipleToolsRunning: (count: number) => string;
  agentStillWorkingDetail: string;
  agentStillWorkingHelper: string;
  trailingToolFailedDetail: string;
  trailingToolFailedHelper: string;
  toolCallsFinishedDetail: string;
  toolCallsFinishedHelper: string;
  toolFailedAfterDoneDetail: string;
  toolFailedAfterDoneHelper: string;
  agentRespondingDetail: string;
  agentRespondingHelper: string;

  // -- Composer surface labels --
  externalLoadingFallback: string;
  loadingLabel: string;
  loadingPlaceholder: string;
  idleLabel: string;
  idleDetail: string;
  idleHelper: string;
  idlePlaceholder: string;
  startingLabel: string;
  connectingDetail: string;
  connectingPlaceholder: string;
  readyLabel: string;
  readyDetail: string;
  readyHelper: string;
  readyPlaceholder: string;
  restoringLabel: string;
  restoringDetail: string;
  restoringHelper: string;
  restoringPlaceholder: string;
  workingLabel: string;
  needsApprovalLabel: string;
  blockedActionFallback: string;
  permissionPlaceholder: string;
  needsInputLabel: string;
  elicitationHelper: string;
  elicitationPlaceholder: string;
  stoppingLabel: string;
  stoppingSteerDetail: string;
  stoppingSteerHelper: string;
  stoppingSteerPlaceholder: string;
  stoppingDetail: string;
  stoppingHelper: string;
  stoppingPlaceholder: string;
  needsAttentionLabel: string;
  errorPlaceholder: string;
  closedLabel: string;
  closedDetail: string;
  closedHelper: string;
  closedPlaceholder: string;
  defaultPlaceholder: string;

  // -- Activity surface labels --
  singleTerminalLabel: string;
  multipleTerminalsLabel: (count: number) => string;
  singleBackgroundAgentLabel: string;
  multipleBackgroundAgentsLabel: (count: number) => string;
  singleQueuedFollowUpLabel: string;
  multipleQueuedFollowUpsLabel: (count: number) => string;
  queuedPromptDetail: string;
  steerPendingLabel: string;
  steerPendingDetail: string;
  permissionRequestLabel: string;
  writeReviewLabel: string;
  inputRequiredLabel: string;

  // -- Transcript surface copy --
  postToolFailedProgress: string;
  postToolFinishedProgress: string;
  recoverableFailure: string;

  // -- Interrupt surface copy --
  steerReplacesQueuedWithPending: string;
  steerSendsAtSafePoint: string;
  queuedFollowUpsWillRun: string;
  approvePermission: string;
  approveWriteReview: string;
  submitElicitation: string;
  steerInterruptSummary: string;
  cancelSummary: string;

  // -- Plan surface copy --
  planProgress: (completed: number, total: number) => string;

  // -- Dynamic placeholder copy --
  dynamicPlaceholderRunning: (toolLabel: string) => string;
  dynamicPlaceholderTerminal: string;
  dynamicPlaceholderBackgroundAgent: string;
  dynamicPlaceholderWriteGate: (target: string) => string;
  dynamicPlaceholderThinking: string;
  dynamicPlaceholderResponding: string;
  dynamicPlaceholderToolsFinished: string;
  dynamicPlaceholderToolsFailing: (running: number, failed: number) => string;

  // -- Remaining interpolated / dynamic copy --
  queueBoundarySuffix: string;
  multiToolSummary: (count: number) => string;
  permissionNeededDetail: (target: string) => string;
  permissionDialogHelper: (target: string) => string;
  permissionContinueHint: string;
  elicitationNeededDetail: (title: string) => string;
  unknownStatusLabel: (status: string) => string;
}

/**
 * Default English copy map used when no overrides are provided.
 */
export const defaultWorkflowCopy: WorkflowCopyMap = {
  // -- Elicitation target fallback --
  elicitationFallbackLabel: "the open form",

  // -- Queue / follow-up copy --
  singleFollowUpQueued: "1 follow-up is queued",
  followUpsQueued: (count) => `${count} follow-ups are queued`,
  queueFallbackBoundary: "Any follow-up you queue will run after the current turn finishes.",
  queueInterruptHint:
    "Type to queue another message or use Steer to interrupt and replace queued work.",
  queuePlaceholder:
    "Type to queue a follow-up; it will run after the current turn finishes. Use Steer to interrupt and replace queued work.",

  // -- Tool call status labels --
  toolStatusDone: "Done",
  toolStatusFailed: "Failed",
  toolStatusRunning: "Running",
  toolStatusPending: "Pending",

  // -- Tool group summaries --
  toolGroupFailedStillWorking: (failedCount) => `${failedCount} failed, agent still working`,
  toolGroupRunning: "Running",
  toolGroupFailed: (failedCount) => `${failedCount} failed`,
  toolGroupDone: "Done",
  toolGroupPending: "Pending",
  singleToolFallbackName: "Tool call",

  // -- Error descriptions --
  errorSessionFailed: "The agent session failed.",
  errorSessionFailedHint: "Retry the prompt or start a new session.",
  errorCommandNotStarted: "The agent command could not be started.",
  errorCommandNotStartedHint: "Check the configured agent command in plugin settings, then retry.",
  errorTimedOut: "The agent stopped responding.",
  errorTimedOutHint:
    "Retry the prompt. If it keeps timing out, narrow the task or restart the session.",
  errorProcessStopped: "The agent process stopped unexpectedly.",
  errorProcessStoppedHint: "Retry the prompt or restart the session if the runtime looks unstable.",
  errorGeneric: "The agent session failed.",
  errorGenericHint: "Review the details, then retry or start a new session.",

  // -- Prompting copy --
  writeGateDetail: (target) => `A write review is open for ${target}.`,
  writeGateHelper: (target) => `Review the proposed changes to ${target} before continuing.`,
  terminalRunningDetail: "A terminal command is still running.",
  terminalRunningDetailQueued: "A terminal command is still running.",
  terminalRunningHelper: "A terminal command is running in the current turn.",
  backgroundAgentDetail: "A background agent is still working.",
  backgroundAgentDetailQueued: "A background agent is still working.",
  backgroundAgentHelper: "A background agent is running in the current turn.",
  toolFailedStillWorkingDetail: "A tool failed, but the agent is still working.",
  toolFailedStillWorkingDetailQueued: "A tool failed, but the agent is still working.",
  toolFailedRecoveryHelper: "The agent is recovering from a tool failure.",
  singleToolRunning: "1 tool call is running.",
  multipleToolsRunning: (count) => `${count} tool calls are running.`,
  agentStillWorkingDetail: "Agent is still working.",
  agentStillWorkingHelper: "The agent is using tools right now.",
  trailingToolFailedDetail: "A tool failed, but the agent is still responding.",
  trailingToolFailedHelper: "The last tool step failed, but the agent is still responding.",
  toolCallsFinishedDetail: "Tool calls finished. The agent is still responding.",
  toolCallsFinishedHelper: "The tool work is done. The agent is still responding.",
  toolFailedAfterDoneDetail: "A tool failed, but the agent is still working.",
  toolFailedAfterDoneHelper: "The agent is still working after a tool failure.",
  agentRespondingDetail: "Agent is still responding.",
  agentRespondingHelper: "The agent is responding.",

  // -- Composer surface labels --
  externalLoadingFallback: "Restoring session...",
  loadingLabel: "Loading",
  loadingPlaceholder: "Loading the session…",
  idleLabel: "Idle",
  idleDetail: "Start a session to begin.",
  idleHelper: "",
  idlePlaceholder: "Start a session to begin.",
  startingLabel: "Starting",
  connectingDetail: "Connecting to the agent runtime…",
  connectingPlaceholder: "Connecting to the agent runtime…",
  readyLabel: "Ready",
  readyDetail: "Ready for the next prompt.",
  readyHelper: "",
  readyPlaceholder: "Ask the agent anything… Use @ to reference open files.",
  restoringLabel: "Loading",
  restoringDetail: "Restoring session…",
  restoringHelper: "",
  restoringPlaceholder: "Restoring the selected session…",
  workingLabel: "Working",
  needsApprovalLabel: "Needs Approval",
  blockedActionFallback: "the blocked action",
  permissionPlaceholder: "Choose a permission option to continue the current turn.",
  needsInputLabel: "Needs Input",
  elicitationHelper: "The open input dialog needs your response before the agent can continue.",
  elicitationPlaceholder:
    "Complete the open input dialog to continue. Any follow-up you queue will run after the current turn finishes.",
  stoppingLabel: "Stopping",
  stoppingSteerDetail: "Stopping the current turn so your steer message can run next.",
  stoppingSteerHelper:
    "Stopping the current turn. Your steer message will send as soon as the current turn fully stops.",
  stoppingSteerPlaceholder: "Stopping the current turn so the steer message can run next.",
  stoppingDetail: "Stopping the current turn…",
  stoppingHelper:
    "Stopping the current turn. The next prompt will run after cancellation finishes.",
  stoppingPlaceholder: "Stopping the current turn…",
  needsAttentionLabel: "Needs Attention",
  errorPlaceholder: "Retry the prompt or start a new session.",
  closedLabel: "Closed",
  closedDetail: "This session is closed.",
  closedHelper: "",
  closedPlaceholder: "Start a new session to continue.",
  defaultPlaceholder: "Type a prompt…",

  // -- Activity surface labels --
  singleTerminalLabel: "Running 1 terminal",
  multipleTerminalsLabel: (count) => `Running ${count} terminals`,
  singleBackgroundAgentLabel: "1 background agent",
  multipleBackgroundAgentsLabel: (count) => `${count} background agents`,
  singleQueuedFollowUpLabel: "1 queued follow-up",
  multipleQueuedFollowUpsLabel: (count) => `${count} queued follow-ups`,
  queuedPromptDetail: "Queued prompts run after the current turn finishes.",
  steerPendingLabel: "Steer pending",
  steerPendingDetail: "The current turn is stopping so the steer message can run next.",
  permissionRequestLabel: "Permission request open",
  writeReviewLabel: "Write review open",
  inputRequiredLabel: "Input required",

  // -- Transcript surface copy --
  postToolFailedProgress:
    "A tool failed, but the agent is still thinking through the next response.",
  postToolFinishedProgress:
    "Tool calls finished. The agent is still thinking through the next response.",
  recoverableFailure: "A tool failed, but the agent is still working.",

  // -- Interrupt surface copy --
  steerReplacesQueuedWithPending:
    "The steer message will replace queued follow-ups when the current turn stops.",
  steerSendsAtSafePoint:
    "The steer message will send at the next safe point after the current turn stops.",
  queuedFollowUpsWillRun: "Queued follow-ups will run after the current turn finishes.",
  approvePermission: "Approve or reject the blocked action to continue the current turn.",
  approveWriteReview: "Approve or reject the write review to continue the current turn.",
  submitElicitation: "Submit the requested input to continue the current turn.",
  steerInterruptSummary: "Steer interrupts the current turn and replaces queued work.",
  cancelSummary: "Stop the current turn.",

  // -- Plan surface copy --
  planProgress: (completed, total) => `${completed} out of ${total} tasks completed`,

  // -- Dynamic placeholder copy --
  dynamicPlaceholderRunning: (toolLabel) =>
    `Running: ${toolLabel} — Queue a follow-up or Steer to interrupt.`,
  dynamicPlaceholderTerminal: "Terminal running — Queue a follow-up or Steer to interrupt.",
  dynamicPlaceholderBackgroundAgent:
    "Background agent working — Queue a follow-up or Steer to interrupt.",
  dynamicPlaceholderWriteGate: (target) =>
    `Reviewing: ${target} — Queue a follow-up or Steer to interrupt.`,
  dynamicPlaceholderThinking: "Agent is thinking — Queue a follow-up or Steer to interrupt.",
  dynamicPlaceholderResponding: "Agent is responding — Queue a follow-up or Steer to interrupt.",
  dynamicPlaceholderToolsFinished:
    "Tools finished, agent responding — Queue a follow-up or Steer to interrupt.",
  dynamicPlaceholderToolsFailing: (running, failed) =>
    `Running tools (${running} active, ${failed} failed) — Queue a follow-up or Steer to interrupt.`,

  // -- Remaining interpolated / dynamic copy --
  queueBoundarySuffix: "and will run after the current turn finishes.",
  multiToolSummary: (count) => `${count} tool calls`,
  permissionNeededDetail: (target) => `Approval is needed for ${target}.`,
  permissionDialogHelper: (target) => `A permission dialog is open for ${target}.`,
  permissionContinueHint: "Choose an option to let the agent continue.",
  elicitationNeededDetail: (title) => `Input is needed in ${title}.`,
  unknownStatusLabel: (status) =>
    // `/\b\w/g` matches the first character of every word — title-cases
    // a snake_case identifier (e.g. `tool_finished` → `Tool Finished`).
    status.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
};

/**
 * Resolve a full copy map from optional partial overrides.
 * Missing keys fall back to the default English copy.
 */
export function resolveWorkflowCopy(overrides?: Partial<WorkflowCopyMap>): WorkflowCopyMap {
  if (!overrides) {
    return defaultWorkflowCopy;
  }
  return { ...defaultWorkflowCopy, ...overrides };
}
