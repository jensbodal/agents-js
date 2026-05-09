/**
 * Shared type interfaces for ACP UI components.
 *
 * These unify the various inline interface definitions that were previously
 * duplicated across acp-chat-app.ts, acp-connect-dialog.ts, acp-debug-panel.ts,
 * and acp-transcript.ts.
 */

/** Minimal shape matching TranscriptEntry from @agents-js/a2a-client. */
export interface TranscriptEntryLike {
  id: string;
  role: "user" | "agent";
  text: string;
}

/** Unified agent card shape — covers preview, snapshot, and view uses. */
export interface AgentCardLike {
  name?: string;
  description?: string;
  url?: string;
  protocolVersion?: string;
  capabilities?: {
    streaming?: boolean;
    supportsStreaming?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RuntimeInfoLike {
  id: string;
  displayName: string;
}

export interface ModelInfoLike {
  modelId: string;
  name?: string;
}

export interface SessionModelsLike {
  currentModelId: string;
  availableModels: ModelInfoLike[];
}

export interface TargetInspectionLike {
  status: "idle" | "probing" | "ready" | "unreachable";
  card?: AgentCardLike;
  results?: Array<{
    method: "GET" | "OPTIONS";
    url: string;
    ok: boolean;
    status: number;
    contentType?: string;
    bodySnippet?: string;
  }>;
  error?: string;
}

/** Unified session state shape — covers snapshot and view uses. */
export interface SessionStateLike {
  status?: string;
  sessionId?: string;
  targetInput?: {
    url?: string;
    headers?: Record<string, string>;
    mode?: "auto" | "card" | "base";
  };
  targetInspection?: TargetInspectionLike;
  transcript?: Array<{ id: string; role: string; text: string }>;
  pendingAgentText?: string;
  activeElicitation?: {
    message?: string;
    requestedSchema?: {
      title?: string | null;
      description?: string | null;
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    };
  };
  activeAuth?: {
    authMethods?: Array<{ id: string; name?: string }>;
    message?: string;
  };
  lastError?: string;
  debugRecords?: DebugRecordLike[];
  target?: { card?: AgentCardLike };
  taskState?: string;
  contextId?: string;
  taskId?: string;
  pendingPermission?: PermissionRequestLike | null;
  pendingWriteGate?: WriteGateLike | null;
  permissionMode?: string;
  runtime?: RuntimeInfoLike | null;
  models?: SessionModelsLike | null;
}

/** Minimal shape for permission requests from acp-host. */
export interface PermissionRequestLike {
  toolCall?: {
    title?: string;
    rawInput?: unknown;
  };
  message?: string;
  options?: Array<{
    optionId: string;
    kind: string;
    name?: string;
    description?: string;
  }>;
  /** Scope candidates for user selection, ordered from most specific to broadest. */
  suggestedScopes?: Array<{ level: string; scope: string; label: string }>;
}

/** Minimal shape for write gate pending state. */
export interface WriteGateLike {
  path: string;
  diff: string;
  closestParentFolder: string;
}

/** Model info from the runtime CLI (available before session creation). */
export interface RuntimeModelLike {
  id: string; // full model ID like "opencode/big-pickle"
  name?: string; // display name like "Big Pickle"
  provider?: string; // provider group like "opencode"
}

/** Debug record shape — mirrors DebugRecord from a2a-client types. */
export interface DebugRecordLike {
  requestId: string;
  timestamp: string;
  direction: "outbound" | "inbound";
  kind: "http" | "probe" | "client";
  method: string;
  url: string;
  headers: Record<string, string>;
  status?: number;
  contentType?: string;
  body?: string;
}

/** Plan entry shape matching PlanEntryInfo from acp-host session state. */
export interface PlanEntryLike {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}
