import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { PlanEntryLike, TranscriptToolCallEntryPayload } from "./acp-types.ts";
import type { WorkflowSurfaceRenderState } from "./workflow-surface.ts";

/**
 * Type definitions for the gateway WebSocket bridge protocol.
 *
 * These types mirror the ws-bridge protocol without importing Node code,
 * enabling use in the browser.
 */

// ---------------------------------------------------------------------------
// State types — shared by ws-client and ws-state-mapper
// ---------------------------------------------------------------------------

/** Permission option shape matching @agentclientprotocol/sdk PermissionOption. */
export interface PermissionOptionInfo {
  optionId: string;
  kind: string;
  name?: string;
  description?: string;
}

/**
 * Permission-request shape for display purposes. Mirrors the ACP SDK
 * `ToolCallUpdate` surface (which is what `RequestPermissionRequest.toolCall`
 * actually carries — see `@agentclientprotocol/sdk` `schema/types.gen.d.ts`).
 * The modal can correlate this prompt with the live `ToolCallInfo` entry
 * via `toolCallId`, surface execution state via `status`, render
 * follow-along files (`locations`), terminal output produced by the time
 * the agent asks for follow-up permission (`rawOutput`), the call's
 * icon/treatment (`kind`), and the rich body (`content` — image / diff /
 * terminal variants). The host carries all of these in `ToolCallInfo`
 * since `@agents-js/acp-host` 0.4.0; the WS-bridge mapper forwards them
 * through.
 */
export interface PendingPermissionInfo {
  toolCall?: {
    /** ACP `ToolCallUpdate.toolCallId` — required on the SDK type;
     *  enables UI consumers to correlate a permission prompt with the
     *  corresponding live tool-call entry in `currentTurn.toolCalls`. */
    toolCallId?: string;
    title?: string;
    /** ACP `ToolCallUpdate.status` — current execution state of the
     *  tool call (e.g. `pending`, `in_progress`, `completed`, `failed`).
     *  Widened to string so unknown future statuses flow through. */
    status?: ToolCallStatus | string;
    /** ACP `ToolCallUpdate.kind` (read/edit/execute/...) — widened to
     *  string so unknown future kinds flow through; receivers narrow
     *  against the SDK's `ToolKind` if they want typed handling. */
    kind?: ToolKind | string;
    /** ACP `ToolCallUpdate.locations` — file paths + optional line
     *  numbers the call operates on; enables follow-along clients. */
    locations?: ToolCallLocation[];
    /** Raw input args. Always opaque to the UI. */
    rawInput?: unknown;
    /** Raw output already produced (e.g. terminal output preceding
     *  a permission prompt). Opaque to the UI. */
    rawOutput?: unknown;
    /** Rich body (text / image / audio / resource / diff / terminal). */
    content?: ToolCallContent[];
  };
  message?: string;
  options?: PermissionOptionInfo[];
  suggestedScopes?: Array<{ level: string; scope: string; label: string }>;
}

/** Minimal write-gate shape for display purposes. */
export interface PendingWriteGateInfo {
  path: string;
  diff: string;
  closestParentFolder: string;
}

/**
 * Minimal elicitation request shape for display purposes.
 *
 * Mirrors the non-function fields of `PendingElicitation` on the host side
 * (see `packages/acp-host/src/types/session.ts`). The gateway's JSON
 * serializer strips the `resolve` function and Maps, so only the raw
 * `CreateElicitationRequest` fields survive the wire — this interface
 * captures the shape the browser actually receives.
 */
export interface PendingElicitationInfo {
  /** Human-readable message describing what input is needed. */
  message: string;
  /** Discriminator for form vs URL elicitations. */
  mode?: "form" | "url";
  /** JSON schema describing the form fields (form-mode elicitations). */
  requestedSchema?: Record<string, unknown>;
}

export interface RuntimeInfo {
  id: string;
  displayName: string;
}

export type RuntimeSwitchOrigin = "manual" | "saved_restore";

export interface RuntimeSwitchState {
  status: "switching" | "failed" | "runtimeApplied" | "runtimeUnsupported";
  requestedRuntimeId: string;
  message: string;
  origin?: RuntimeSwitchOrigin;
  preservedSession?: boolean;
  clearedPendingTurn?: boolean;
}

export interface HostTurnSummary {
  textChunkCount: number;
  lastTextChunk: string | null;
  toolCallCount: number;
  activeToolCallCount: number;
  failedToolCallCount: number;
  /**
   * Per-call rich payloads for the active turn, structurally compatible
   * with `<acp-tool-call-detail>`'s `data` prop. Built from the host's
   * `currentTurn.toolCalls` map (Layer A — host's `ToolCallInfo`
   * carries `locations` / `rawInput` / `rawOutput`).
   *
   * Mapper-side normalization: `richContent` is rehydrated into the
   * SDK's discriminated `ToolCallContent` union, `locations` are
   * narrowed back to `ToolCallLocation`, host-internal status
   * `"running"` is mapped back to ACP's `"in_progress"`. `rawInput` /
   * `rawOutput` pass through unbounded. ACP doesn't cap their size, but
   * `<acp-tool-call-detail>` only stringifies them lazily on `<details>`
   * expand, so the cost is paid on user demand rather than on every
   * state push. If real-world payloads start blowing past WebSocket
   * frame limits, add truncation in the mapper (with a sentinel marker
   * the UI can show as "[truncated]").
   */
  toolCalls?: TranscriptToolCallEntryPayload[];
}

/** Flat state object pushed to subscribers on every relevant event. */
export interface HostState {
  pendingPermission?: PendingPermissionInfo | null;
  pendingWriteGate?: PendingWriteGateInfo | null;
  pendingElicitation?: PendingElicitationInfo | null;
  runtime?: RuntimeInfo | null;
  availableRuntimes?: RuntimeInfo[] | null;
  permissionMode?: string;
  sessionStatus?: string;
  sessionId?: string | null;
  sessionTitle?: string | null;
  plan?: PlanEntryLike[] | null;
  queueCount?: number | null;
  currentTurn?: HostTurnSummary | null;
  lastError?: string | null;
  runtimeSwitchState?: RuntimeSwitchState | null;
  workflowSurface?: WorkflowSurfaceRenderState | null;
  /**
   * Rendered chat transcript assembled from the gateway's `completedTurns`
   * (user prompt + agent reply per turn). This is the host-bridge source of
   * truth for the chat in AG-UI mode, where the prompt is issued via
   * `POST /agent` and the A2A client controller never observes the turn.
   */
  transcript?: Array<{ id: string; role: string; text: string }> | null;
  /** Streaming agent text for the in-flight turn (`currentTurn.textChunks`). */
  pendingAgentText?: string | null;
}

// ---------------------------------------------------------------------------
// Wire protocol types
// ---------------------------------------------------------------------------

/** Server-to-client messages sent by the ws-bridge. */
export type WSServerMessage =
  | { type: "event"; event: Record<string, unknown> & { type: string }; state: unknown }
  | { type: "state_snapshot"; state: Record<string, unknown> }
  // Payload typed as `unknown` to avoid pulling `@agents-js/a2ui-types`
  // into `ws-types`. The browser's `A2uiHost.applyMessage` validates the
  // shape at the ingress (belt + suspenders; already validated upstream
  // in `packages/acp-host/src/session-updates.ts`).
  | { type: "a2ui_message"; message: unknown };

// ---------------------------------------------------------------------------
// Resolution payload types (sent client → server)
// ---------------------------------------------------------------------------

export interface PermissionResolution {
  response: {
    outcome:
      | {
          outcome: "selected";
          optionId?: string;
        }
      | {
          outcome: "cancelled";
        };
  };
  selectedScope?: string;
}

export interface WriteGateResolution {
  action: string;
  folder?: string;
}

export interface ElicitationResolution {
  action: string;
  content?: Record<string, unknown>;
}

export type HostStateListener = (state: HostState) => void;
