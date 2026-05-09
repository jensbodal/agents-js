import type { PlanEntryLike } from "./acp-types.ts";

export type WorkflowSurfaceSeverity = "neutral" | "info" | "warning" | "error";

export type WorkflowSurfaceComposerMode =
  | "idle"
  | "loading"
  | "ready"
  | "working"
  | "queueing"
  | "steering"
  | "blocked"
  | "stopping"
  | "error";

export type WorkflowSurfaceActivityPhase = "idle" | "running" | "waiting" | "ready" | "error";

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

export type WorkflowSurfaceInterruptKind = "none" | "permission" | "write_gate" | "elicitation";

export interface WorkflowActivityEntryState {
  id: string;
  kind: WorkflowActivityKind;
  label: string;
  detail: string | null;
  status: WorkflowActivityStatus;
  count?: number;
}

export interface WorkflowSurfacePlanState<PlanEntry extends PlanEntryLike = PlanEntryLike> {
  visible: boolean;
  summary: string | null;
  completedCount: number;
  totalCount: number;
  activeCount: number;
  currentEntryIndex: number | null;
  entries: Array<PlanEntry & { index: number; isCurrent: boolean }>;
}

export interface WorkflowSurfaceActivityState {
  visible: boolean;
  phase: WorkflowSurfaceActivityPhase;
  sessionStatus: string | null;
  summary: string | null;
  runningTerminalCount: number;
  backgroundAgentCount: number;
  queuedFollowUpCount: number;
  pendingSteer: boolean;
  items: WorkflowActivityEntryState[];
}

export interface WorkflowSurfaceInterruptActionState {
  enabled: boolean;
  pending: boolean;
  summary: string | null;
}

export interface WorkflowSurfaceInterruptState<Permission = unknown, WriteGate = unknown> {
  blocker: WorkflowSurfaceInterruptKind;
  queue: WorkflowSurfaceInterruptActionState;
  steer: WorkflowSurfaceInterruptActionState;
  cancel: WorkflowSurfaceInterruptActionState;
  queuedFollowUpCount: number;
  clearsQueuedOnSteer: boolean;
  nextActionSummary: string | null;
  pendingPermission?: Permission | null;
  pendingWriteGate?: WriteGate | null;
}

export interface WorkflowSurfaceComposerState {
  mode: WorkflowSurfaceComposerMode;
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

export interface WorkflowSurfaceTranscriptState {
  sessionId: string | null;
  title: string | null;
  hasActiveTurn: boolean;
  hasVisibleText: boolean;
  textChunkCount: number;
  postToolProgressText: string | null;
  recoverableFailureSummary: string | null;
  toolBlock: {
    hasTrailingBlock: boolean;
    summary: string | null;
    statusText: string | null;
    severity: WorkflowSurfaceSeverity;
    totalCount: number;
    runningCount: number;
    failedCount: number;
    completedCount: number;
    pendingCount: number;
  };
}

export interface WorkflowSurfaceContext {
  externalLoadingActive?: boolean;
  externalLoadingMessage?: string | null;
  pendingSteer?: boolean;
  backgroundAgents?: WorkflowActivityEntryState[];
  runningTerminals?: WorkflowActivityEntryState[];
  statusOverride?: {
    detailText: string;
    helperText?: string;
  } | null;
}

export interface WorkflowSurfaceRenderState<
  Permission = unknown,
  WriteGate = unknown,
  PlanEntry extends PlanEntryLike = PlanEntryLike,
> {
  plan_surface: WorkflowSurfacePlanState<PlanEntry>;
  activity_surface: WorkflowSurfaceActivityState;
  interrupt_surface: WorkflowSurfaceInterruptState<Permission, WriteGate>;
  composer_surface: WorkflowSurfaceComposerState;
  transcript_surface: WorkflowSurfaceTranscriptState;
}
