import type { PendingElicitation, PlanEntryInfo, ToolCallInfo, TurnItem } from "./session.ts";

export type WorkflowSurfaceSeverity = "neutral" | "info" | "warning" | "error";

export type WorkflowComposerMode =
  | "idle"
  | "loading"
  | "ready"
  | "working"
  | "queueing"
  | "steering"
  | "blocked"
  | "stopping"
  | "error";

export type WorkflowActivityPhase = "idle" | "running" | "waiting" | "ready" | "error";

export type WorkflowActivityKind =
  | "terminal"
  | "background_agent"
  | "queued_follow_up"
  | "pending_steer"
  | "permission"
  | "write_gate"
  | "elicitation"
  | "response";

export type WorkflowActivityStatus = "active" | "queued" | "waiting" | "done" | "error";

export type WorkflowInterruptBlocker = "none" | "permission" | "write_gate" | "elicitation";

export interface WorkflowActivityEntryState {
  id: string;
  kind: WorkflowActivityKind;
  label: string;
  detail: string | null;
  status: WorkflowActivityStatus;
  count?: number;
}

export interface WorkflowPlanEntryState extends PlanEntryInfo {
  index: number;
  isCurrent: boolean;
}

export interface PlanSurfaceState {
  visible: boolean;
  summary: string | null;
  completedCount: number;
  totalCount: number;
  activeCount: number;
  currentEntryIndex: number | null;
  entries: WorkflowPlanEntryState[];
}

export interface ActivitySurfaceState {
  visible: boolean;
  phase: WorkflowActivityPhase;
  sessionStatus: string | null;
  summary: string | null;
  runningTerminalCount: number;
  backgroundAgentCount: number;
  queuedFollowUpCount: number;
  pendingSteer: boolean;
  items: WorkflowActivityEntryState[];
}

export interface InterruptActionState {
  enabled: boolean;
  pending: boolean;
  summary: string | null;
}

export interface InterruptSurfaceState {
  blocker: WorkflowInterruptBlocker;
  queue: InterruptActionState;
  steer: InterruptActionState;
  cancel: InterruptActionState;
  queuedFollowUpCount: number;
  clearsQueuedOnSteer: boolean;
  nextActionSummary: string | null;
  pendingPermission?: WorkflowPendingPermissionLike | null;
  pendingWriteGate?: WorkflowPendingWriteGateLike | null;
}

export interface ComposerSurfaceState {
  mode: WorkflowComposerMode;
  label: string;
  detailText: string;
  helperText: string;
  placeholderText: string;
  technicalDetail: string | null;
  severity: WorkflowSurfaceSeverity;
  disabled: boolean;
  canSendImmediately: boolean;
  canQueue: boolean;
  canSteer: boolean;
  canCancel: boolean;
  queuedFollowUpCount: number;
  pendingSteer: boolean;
}

export interface ToolBlockSurfaceState {
  hasTrailingBlock: boolean;
  summary: string | null;
  statusText: string | null;
  severity: WorkflowSurfaceSeverity;
  totalCount: number;
  runningCount: number;
  failedCount: number;
  completedCount: number;
  pendingCount: number;
}

export interface TranscriptSurfaceState {
  sessionId: string | null;
  title: string | null;
  hasActiveTurn: boolean;
  hasVisibleText: boolean;
  textChunkCount: number;
  postToolProgressText: string | null;
  recoverableFailureSummary: string | null;
  toolBlock: ToolBlockSurfaceState;
}

export interface WorkflowSurfaceState {
  plan_surface: PlanSurfaceState;
  activity_surface: ActivitySurfaceState;
  interrupt_surface: InterruptSurfaceState;
  composer_surface: ComposerSurfaceState;
  transcript_surface: TranscriptSurfaceState;
}

export interface WorkflowStatusOverride {
  detailText: string;
  helperText?: string;
}

export interface WorkflowSurfaceContext {
  externalLoadingActive?: boolean;
  externalLoadingMessage?: string | null;
  pendingSteer?: boolean;
  backgroundAgents?: WorkflowActivityEntryState[];
  runningTerminals?: WorkflowActivityEntryState[];
  statusOverride?: WorkflowStatusOverride | null;
}

export interface WorkflowToolCallStats {
  total: number;
  running: number;
  failed: number;
  completed: number;
  pending: number;
}

export interface WorkflowToolCallLike extends Pick<ToolCallInfo, "id" | "name" | "status"> {
  richContent?: Array<{ type?: string; terminalId?: string }>;
}

export interface WorkflowPendingPermissionLike {
  request?: {
    message?: string;
    toolCall?: {
      title?: string;
    };
  };
}

export interface WorkflowPendingWriteGateLike {
  path?: string;
}

export interface WorkflowTurnStateLike {
  textChunks?: string[];
  toolCalls?: Map<string, WorkflowToolCallLike> | Record<string, WorkflowToolCallLike>;
  turnItems?: TurnItem[];
  pendingPermission?: WorkflowPendingPermissionLike | null;
}

export interface WorkflowSessionStateLike {
  status?: string | null;
  sessionId?: string | null;
  sessionTitle?: string | null;
  currentTurn?: WorkflowTurnStateLike | null;
  pendingWriteGate?: WorkflowPendingWriteGateLike | null;
  pendingElicitation?: Pick<PendingElicitation, "request"> | null;
  promptQueue?: unknown[];
  plan?: PlanEntryInfo[] | null;
  lastError?: string | null;
}

export interface WorkflowErrorSummary {
  summary: string;
  actionHint: string;
  technicalDetail: string | null;
}

export interface WorkflowToolGroupSummary {
  summary: string;
  status: string;
  severity: WorkflowSurfaceSeverity;
}
