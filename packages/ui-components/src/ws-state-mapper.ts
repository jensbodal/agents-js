/**
 * Pure mapping functions that translate raw gateway snapshots/events
 * into typed HostState shapes.
 *
 * These are stateless and free of WebSocket or DOM dependencies,
 * making them directly unit-testable.
 */

import { deriveWorkflowSurfaceState } from "@agents-js/acp-host/workflow-surface";
import type {
  HostState,
  HostTurnSummary,
  ModelInfo,
  PendingElicitationInfo,
  PendingPermissionInfo,
  RuntimeInfo,
  RuntimeModelInfo,
  RuntimeSwitchOrigin,
  RuntimeSwitchState,
  SessionModelsInfo,
} from "./ws-types.ts";

/**
 * Map a raw RequestPermissionRequest object into the minimal
 * PendingPermissionInfo shape expected by the UI components.
 */
export function mapPermissionRequest(raw: Record<string, unknown>): PendingPermissionInfo {
  const result: PendingPermissionInfo = {};

  const toolCall = raw.toolCall as Record<string, unknown> | undefined;
  if (toolCall) {
    result.toolCall = {
      title: typeof toolCall.title === "string" ? toolCall.title : undefined,
      rawInput: toolCall.rawInput,
    };
  }

  if (typeof raw.message === "string") {
    result.message = raw.message;
  }

  const options = raw.options as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(options)) {
    result.options = options.map((opt) => ({
      optionId: String(opt.optionId ?? ""),
      kind: String(opt.kind ?? ""),
      name: typeof opt.name === "string" ? opt.name : undefined,
      description: typeof opt.description === "string" ? opt.description : undefined,
    }));
  }

  const suggestedScopes = raw.suggestedScopes as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(suggestedScopes)) {
    result.suggestedScopes = suggestedScopes
      .map((candidate) => {
        if (
          typeof candidate.scope !== "string" ||
          typeof candidate.label !== "string" ||
          typeof candidate.level !== "string"
        ) {
          return null;
        }
        return {
          level: candidate.level,
          scope: candidate.scope,
          label: candidate.label,
        };
      })
      .filter((candidate) => candidate !== null);
  }

  return result;
}

/**
 * Map a raw `PendingElicitation` (as serialized by the gateway) into
 * the display-only `PendingElicitationInfo` used by the browser. The
 * gateway's JSON serializer strips the `resolve` function, so the raw
 * `request` field is the only surviving content.
 */
export function mapPendingElicitation(raw: unknown): PendingElicitationInfo | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const request = candidate.request as Record<string, unknown> | undefined;
  if (!request) {
    return null;
  }

  if (typeof request.message !== "string") {
    return null;
  }

  const info: PendingElicitationInfo = {
    message: request.message,
  };
  if (request.mode === "form" || request.mode === "url") {
    info.mode = request.mode;
  }
  if (request.requestedSchema && typeof request.requestedSchema === "object") {
    info.requestedSchema = request.requestedSchema as Record<string, unknown>;
  }

  return info;
}

export function mapModels(raw: unknown): SessionModelsInfo | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.currentModelId !== "string") {
    return null;
  }

  const availableModels = Array.isArray(candidate.availableModels)
    ? candidate.availableModels
        .map((model) => {
          if (!model || typeof model !== "object") {
            return null;
          }
          const entry = model as Record<string, unknown>;
          if (typeof entry.modelId !== "string") {
            return null;
          }
          return {
            modelId: entry.modelId,
            name: typeof entry.name === "string" ? entry.name : undefined,
          } satisfies ModelInfo;
        })
        .filter((model) => model !== null)
    : [];

  return {
    currentModelId: candidate.currentModelId,
    availableModels,
  };
}

export function mapRuntimeSwitchState(raw: unknown): RuntimeSwitchState | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate.status !== "string" ||
    typeof candidate.requestedRuntimeId !== "string" ||
    typeof candidate.message !== "string"
  ) {
    return null;
  }

  return {
    status: candidate.status as RuntimeSwitchState["status"],
    requestedRuntimeId: candidate.requestedRuntimeId,
    message: candidate.message,
    origin:
      candidate.origin === "manual" || candidate.origin === "saved_restore"
        ? (candidate.origin as RuntimeSwitchOrigin)
        : undefined,
    preservedSession:
      typeof candidate.preservedSession === "boolean" ? candidate.preservedSession : undefined,
    clearedPendingTurn:
      typeof candidate.clearedPendingTurn === "boolean" ? candidate.clearedPendingTurn : undefined,
  };
}

/**
 * Extract `pendingWriteGate` (a top-level field; the gateway serializer
 * already stripped its `resolve` fn). Returns `null` when the field is
 * missing or malformed.
 */
function extractPendingWriteGate(raw: Record<string, unknown>): HostState["pendingWriteGate"] {
  const wg = raw.pendingWriteGate as Record<string, unknown> | null | undefined;
  if (!wg || typeof wg.path !== "string") {
    return null;
  }
  return {
    path: wg.path as string,
    diff: (wg.diff as string) ?? "",
    closestParentFolder: (wg.closestParentFolder as string) ?? "",
  };
}

/**
 * Extract the pending permission request that lives at
 * `currentTurn.pendingPermission.request`. Returns `null` when no request
 * is pending.
 */
function extractPendingPermission(raw: Record<string, unknown>): HostState["pendingPermission"] {
  const turn = raw.currentTurn as Record<string, unknown> | null | undefined;
  if (!turn) return null;
  const pp = turn.pendingPermission as Record<string, unknown> | null | undefined;
  if (!pp) return null;
  const req = pp.request as Record<string, unknown> | undefined;
  if (!req) return null;
  return mapPermissionRequest(req);
}

/** Extract the active runtime metadata. Returns `null` when not present. */
function extractRuntime(raw: Record<string, unknown>): HostState["runtime"] {
  const runtime = raw.runtime as Record<string, unknown> | null | undefined;
  if (!runtime || typeof runtime.id !== "string" || typeof runtime.displayName !== "string") {
    return null;
  }
  return {
    id: runtime.id,
    displayName: runtime.displayName,
  };
}

/**
 * Summarize `currentTurn` into the lightweight `HostTurnSummary` the
 * UI consumes. Returns `null` when the snapshot has no current turn.
 */
function extractCurrentTurnSummary(raw: Record<string, unknown>): HostState["currentTurn"] {
  const currentTurn = raw.currentTurn as Record<string, unknown> | null | undefined;
  if (!currentTurn) return null;

  const textChunks = Array.isArray(currentTurn.textChunks)
    ? currentTurn.textChunks.filter((value): value is string => typeof value === "string")
    : [];

  const rawToolCalls =
    currentTurn.toolCalls && typeof currentTurn.toolCalls === "object"
      ? (currentTurn.toolCalls as Record<string, Record<string, unknown>>)
      : {};
  const toolCalls = Object.values(rawToolCalls);
  const activeToolCallCount = toolCalls.filter((toolCall) => {
    const status = toolCall?.status;
    return status === "pending" || status === "running";
  }).length;
  const failedToolCallCount = toolCalls.filter((toolCall) => toolCall?.status === "failed").length;

  return {
    textChunkCount: textChunks.length,
    lastTextChunk: textChunks.at(-1) ?? null,
    toolCallCount: toolCalls.length,
    activeToolCallCount,
    failedToolCallCount,
  } satisfies HostTurnSummary;
}

/**
 * Extract host-relevant fields from a full ACPSessionState snapshot.
 *
 * The snapshot arrives as the serialized ACPSessionState. The pending
 * permission lives at `currentTurn.pendingPermission.request` while
 * `pendingWriteGate` is a top-level field (minus its `resolve` fn,
 * which was stripped by the gateway's serializer).
 *
 * This is a flat assembly over per-field extractors — keep new fields in
 * dedicated helpers rather than inlining their parse/validate logic here.
 */
export function mapSnapshot(raw: Record<string, unknown>): HostState {
  const next: HostState = {};

  if (typeof raw.status === "string") {
    next.sessionStatus = raw.status;
  }

  next.pendingElicitation = mapPendingElicitation(raw.pendingElicitation);
  next.pendingWriteGate = extractPendingWriteGate(raw);
  next.pendingPermission = extractPendingPermission(raw);

  // permissionMode — injected by ws-bridge after set_permission_mode ack
  if (typeof raw.permissionMode === "string") {
    next.permissionMode = raw.permissionMode;
  }

  next.runtime = extractRuntime(raw);
  next.models = mapModels(raw.models);
  next.runtimeModels = Array.isArray(raw.runtimeModels)
    ? (raw.runtimeModels as RuntimeModelInfo[])
    : null;
  next.defaultModelId = typeof raw.defaultModelId === "string" ? raw.defaultModelId : null;
  next.availableRuntimes = Array.isArray(raw.availableRuntimes)
    ? (raw.availableRuntimes as RuntimeInfo[])
    : null;
  next.runtimeSwitchState = mapRuntimeSwitchState(raw.runtimeSwitchState);

  // lastError — propagated from ACPSessionController state
  next.lastError = typeof raw.lastError === "string" ? raw.lastError : null;

  // Session identity and metadata
  if (typeof raw.sessionId === "string") {
    next.sessionId = raw.sessionId;
  }
  if (typeof raw.sessionTitle === "string") {
    next.sessionTitle = raw.sessionTitle;
  }

  // Plan entries
  if (Array.isArray(raw.plan)) {
    next.plan = raw.plan as NonNullable<typeof next.plan>;
  }

  next.queueCount = Array.isArray(raw.promptQueue) ? raw.promptQueue.length : 0;
  next.currentTurn = extractCurrentTurnSummary(raw);
  next.workflowSurface = deriveWorkflowSurfaceState(raw);

  return next;
}
