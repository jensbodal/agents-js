/**
 * Shared type interfaces for ACP UI components.
 *
 * These unify the various inline interface definitions that were previously
 * duplicated across acp-chat-app.ts, acp-connect-dialog.ts, acp-debug-panel.ts,
 * and acp-transcript.ts.
 */

import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

/**
 * Discriminated union for transcript entries. Two variants today:
 *
 *   - **Message**: a user or agent text message (the original
 *     `TranscriptEntry` shape from `agents-js/a2a-client`). Carries
 *     `role: "user" | "agent"` and `text: string`.
 *   - **Tool call**: a completed (or in-flight) tool call rendered
 *     inline by `acp-transcript`. Carries `kind: "tool_call"` and
 *     `toolCall: TranscriptToolCallEntryPayload` mirroring the
 *     `ActiveToolCall` shape from `agents-js/a2a-client`.
 *
 * The `kind` discriminator is optional on message entries so existing
 * callers passing `{ id, role, text }` continue to typecheck without
 * change. New tool-call callers MUST set `kind: "tool_call"`.
 *
 * Hosts merge messages and tool calls into a single timestamp-ordered
 * array; the transcript renders the right component per variant.
 */
export type TranscriptEntryLike = TranscriptMessageEntryLike | TranscriptToolCallEntryLike;

export interface TranscriptMessageEntryLike {
  id: string;
  /** Discriminator. Optional — absent or `"message"` both indicate a
   *  text message. Present so existing `{ id, role, text }` callers
   *  continue to typecheck. */
  kind?: "message";
  role: "user" | "agent";
  text: string;
}

export interface TranscriptToolCallEntryLike {
  id: string;
  kind: "tool_call";
  /** ActiveToolCall-shaped payload. Structurally compatible with
   *  `AcpToolCallDetailData` so consumers can pass it into
   *  `<acp-tool-call-detail>` without a cast. */
  toolCall: TranscriptToolCallEntryPayload;
}

/**
 * `ActiveToolCall`-shaped payload for transcript tool-call entries.
 * Re-uses the SDK's typed shapes (`ToolKind`, `ToolCallContent`,
 * `ToolCallLocation`) so receivers get spec-shaped enums and proper
 * discriminated content variants — not widened `unknown` / `string`.
 *
 * Mirrors `AcpToolCallDetailData` from `acp-tool-call-detail` and is
 * structurally compatible with it: hosts can pass a
 * `TranscriptToolCallEntryPayload` (or any `AcpToolCallDetailData`)
 * straight into the rendering component without a runtime cast.
 *
 * The duplication exists to avoid a circular dependency between
 * `acp-types` (loaded by every component) and
 * `acp-tool-call-detail` (loads `acp-types`).
 */
export interface TranscriptToolCallEntryPayload {
  toolCallId: string;
  toolName: string;
  status: string;
  startedAt?: number;
  toolKind?: ToolKind;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
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
