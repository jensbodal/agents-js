import type {
  AgentCapabilities,
  AvailableCommand,
  ContentBlock,
  Cost,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModelState,
  SessionModeState,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export type ACPSessionStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "loading"
  | "prompting"
  | "waiting_permission"
  | "waiting_elicitation"
  | "cancelling"
  | "error"
  | "closed";

export interface ACPSessionState {
  sessionId: string | null;
  status: ACPSessionStatus;
  agentName: string | null;
  agentCapabilities: AgentCapabilities | null;
  currentTurn: TurnState | null;
  /** Completed turns accumulated locally for the active host session */
  completedTurns: CompletedTurnSnapshot[];
  lastError: string | null;
  pendingWriteGate: PendingWriteGate | null;
  /** Pending elicitation request from the agent, waiting for host resolution */
  pendingElicitation: PendingElicitation | null;
  /** Plan entries from the agent (replaced wholesale on each plan update) */
  plan: PlanEntryInfo[] | null;
  /** Session metadata from session_info_update */
  sessionTitle: string | null;
  sessionUpdatedAt: string | null;
  /** Persisted local label for this session */
  localLabel: string | null;
  /** Queued prompts to send after the current turn completes */
  promptQueue: ContentBlock[][];
  /** Available session modes and current mode, if supported by the agent. */
  modes: SessionModeState | null;
  /** Available models and current model. @experimental -- not yet stable in ACP spec. */
  models: SessionModelState | null;
  /** Whether the agent explicitly advertised modes in its session response. */
  modesAdvertisedByAgent: boolean;
  /** Whether runtime mode sync succeeded for permission gating (ask/hub modes). */
  permissionGatingActive: boolean;
  /** Hub directory path (workspace-relative), or null if not set. Mirrors hubDirectoryPath for state consumers. */
  hubPath: string | null;
  /** Available slash commands from the agent, updated via available_commands_update notifications. */
  availableCommands: AvailableCommand[] | null;
  /** Token usage and cost data from the agent, updated via usage_update notifications. */
  usage: { size: number; used: number; cost?: Cost | null } | null;
}

/** Ordered item in a turn -- preserves interleaving of text and tool calls */
export type TurnItem = { type: "text"; startIndex: number } | { type: "tool_call"; id: string };

export interface CompletedToolCallSnapshot {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  content?: string;
  kind?: string;
  richContent?: ToolCallContentInfo[];
}

export interface CompletedTurnSnapshot {
  requestId: string;
  completedAt: number;
  durationMs: number;
  stopReason: string;
  promptContent: ContentBlock[];
  userMessageId?: string;
  agentMessageId?: string;
  textChunks: string[];
  turnItems: TurnItem[];
  toolCalls: CompletedToolCallSnapshot[];
  planAtCompletion: PlanEntryInfo[] | null;
}

export interface TurnState {
  /** Effective user message ID for the current turn, when known */
  userMessageId?: string;
  /** First valid agent message ID observed for the current turn, when known */
  agentMessageId?: string;
  /** Accumulated text chunks from the agent */
  textChunks: string[];
  /** Tool call updates keyed by tool call ID */
  toolCalls: Map<string, ToolCallInfo>;
  /** Ordered sequence of text blocks and tool calls for rendering */
  turnItems: TurnItem[];
  /** Whether a permission request is pending */
  pendingPermission: PendingPermission | null;
  /** Tool call IDs that have been approved via requestPermission */
  approvedToolCallIds: Set<string>;
  /** Tool call IDs for which a tool_call_start event has been emitted (prevents double-emission) */
  emittedStartToolCallIds: Set<string>;
  /** Tool call IDs for which a tool_call_end event has been emitted (prevents double-emission) */
  emittedEndToolCallIds: Set<string>;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  content?: string;
  kind?: string;
  richContent?: ToolCallContentInfo[];
}

export interface PlanEntryInfo {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

export interface ToolCallContentInfo {
  type: "content" | "diff" | "terminal";
  text?: string;
  diffPath?: string;
  diffOldText?: string;
  diffNewText?: string;
  terminalId?: string;
}

export interface PendingPermission {
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
}

export interface PendingElicitation {
  request: CreateElicitationRequest;
  resolve: (response: CreateElicitationResponse) => void;
}

export interface PendingWriteGate {
  path: string;
  diff: string;
  closestParentFolder: string;
  resolve: (result: WriteGateResolution) => void;
}

/** Resolution returned by the write-gate modal UI. */
export type WriteGateResolution =
  | { action: "approve" }
  | { action: "reject" }
  | { action: "allow_folder"; folder: string };

// Discriminated union of events emitted by the session controller
export type ACPSessionEvent =
  | { type: "status_changed"; status: ACPSessionStatus }
  | { type: "session_created"; sessionId: string }
  | { type: "session_loaded"; sessionId: string }
  | { type: "session_closed" }
  | { type: "session_forked"; sessionId: string; parentSessionId: string }
  | { type: "session_resumed"; sessionId: string }
  | { type: "session_update"; notification: SessionNotification }
  | { type: "permission_requested"; request: RequestPermissionRequest }
  | { type: "permission_resolved"; cancelled: boolean; selectedScope?: string }
  | { type: "elicitation_requested"; request: CreateElicitationRequest }
  | { type: "elicitation_resolved"; action: CreateElicitationResponse["action"] }
  | { type: "write_gate_requested"; path: string; diff: string; closestParentFolder: string }
  | { type: "write_gate_resolved"; approved: boolean }
  | { type: "writable_folder_added"; folder: string }
  | { type: "turn_completed"; stopReason: string }
  | { type: "plan_updated"; entries: PlanEntryInfo[] }
  | { type: "session_info_updated"; title: string | null; updatedAt: string | null }
  | { type: "queue_changed"; count: number }
  | { type: "mode_changed"; modeId: string; modes: SessionModeState }
  | { type: "model_changed"; modelId: string; models: SessionModelState }
  | { type: "ungated_write_detected"; toolCallId: string; title: string; kind: string | undefined }
  | { type: "permission_gating_status"; active: boolean; reason: string }
  | { type: "config_option_changed"; configId: string; value: boolean | string }
  | { type: "logged_out" }
  | { type: "available_commands_updated"; commands: AvailableCommand[] }
  | { type: "usage_updated"; size: number; used: number; cost?: Cost | null }
  | {
      type: "tool_call_start";
      toolCallId: string;
      toolCallName: string;
      parentMessageId?: string;
    }
  | { type: "tool_call_end"; toolCallId: string }
  | {
      /**
       * User-driven event originating from an A2UI surface (click, form
       * submit, etc.). A2UI v0.9 does not standardize the back-channel
       * payload shape, so `event` is intentionally opaque — hosts and
       * agents negotiate the shape out-of-band.
       */
      type: "surface_event";
      surfaceId: string;
      event: unknown;
    }
  | { type: "error"; message: string };
