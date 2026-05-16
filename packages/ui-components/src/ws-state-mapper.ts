/**
 * Pure mapping functions that translate raw gateway snapshots/events
 * into typed HostState shapes.
 *
 * These are stateless and free of WebSocket or DOM dependencies,
 * making them directly unit-testable.
 */

import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { deriveWorkflowSurfaceState } from "@agents-js/acp-host/workflow-surface";
import type { TranscriptToolCallEntryPayload } from "./acp-types.ts";
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
    // Forward the full ACP `ToolCallUpdate` surface (Layer C fidelity).
    // Host carries `toolCallId`, `status`, `kind`, `locations`,
    // `rawInput`, `rawOutput`, and `content` on `ToolCallInfo` since
    // acp-host 0.4.0 — truncating here means modals lose the ID needed
    // to correlate against `currentTurn.toolCalls`, the live execution
    // state, follow-along files, raw I/O, and rich bodies (image / diff
    // / terminal) despite the upstream having them.
    //
    // Element-level narrowing on `locations` and `content` is defensive:
    // upstream emitters are type-safe today, but the wire boundary is
    // JSON-parsed and downstream renderers read `loc.path` and
    // `block.type` unguarded. Drop elements that don't match the
    // documented shape so a malformed payload degrades silently rather
    // than crashing the modal.
    result.toolCall = {
      toolCallId: typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined,
      title: typeof toolCall.title === "string" ? toolCall.title : undefined,
      status:
        typeof toolCall.status === "string"
          ? (toolCall.status as ToolCallStatus | string)
          : undefined,
      kind: typeof toolCall.kind === "string" ? (toolCall.kind as ToolKind | string) : undefined,
      locations: Array.isArray(toolCall.locations)
        ? toolCall.locations.filter(
            (loc): loc is ToolCallLocation =>
              typeof loc === "object" &&
              loc !== null &&
              typeof (loc as { path?: unknown }).path === "string",
          )
        : undefined,
      rawInput: toolCall.rawInput,
      rawOutput: toolCall.rawOutput,
      content: Array.isArray(toolCall.content)
        ? toolCall.content.filter(
            (block): block is ToolCallContent =>
              typeof block === "object" &&
              block !== null &&
              typeof (block as { type?: unknown }).type === "string",
          )
        : undefined,
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
 * Translate the host's flattened `ToolCallContentInfo` shape back into
 * the SDK's discriminated `ToolCallContent` union so receivers
 * (`<acp-tool-call-detail>` in particular) get spec-shaped variants.
 *
 * Inverse of `mapToolCallContent` in `packages/acp-host/src/session-state.ts`.
 * Lossy in the same places acp-host already lost data — `terminal`
 * variants only carry `terminalId` (command/exit code/output never
 * survived Layer A); `content` variants only carry `text` (image /
 * audio / resource_link / resource collapsed upstream).
 */
function rehydrateToolCallContent(raw: unknown): ToolCallContent[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((item): ToolCallContent | null => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      switch (entry.type) {
        case "content": {
          // Skip entries that lost their text upstream rather than
          // fabricating an empty `text: ""` block — the detail
          // component would otherwise render a misleading empty box.
          if (typeof entry.text !== "string") return null;
          return { type: "content", content: { type: "text", text: entry.text } };
        }
        case "diff": {
          // `diff` requires both a path and the resulting text. If
          // either is missing the entry is malformed; drop it.
          if (typeof entry.diffPath !== "string" || typeof entry.diffNewText !== "string") {
            return null;
          }
          return {
            type: "diff",
            path: entry.diffPath,
            oldText: typeof entry.diffOldText === "string" ? entry.diffOldText : null,
            newText: entry.diffNewText,
          };
        }
        case "terminal": {
          if (typeof entry.terminalId !== "string") return null;
          return { type: "terminal", terminalId: entry.terminalId };
        }
        default:
          return null;
      }
    })
    .filter((entry): entry is ToolCallContent => entry !== null);
}

/**
 * Coerce a JSON-roundtripped `ToolCallLocation[]` back to the SDK shape.
 * The wire form is structurally identical (`path` + optional `line`);
 * this helper just narrows `unknown` after the JSON parse.
 */
function rehydrateLocations(raw: unknown): ToolCallLocation[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((item): ToolCallLocation | null => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      if (typeof entry.path !== "string") return null;
      const line = typeof entry.line === "number" ? entry.line : undefined;
      return line === undefined ? { path: entry.path } : { path: entry.path, line };
    })
    .filter((entry): entry is ToolCallLocation => entry !== null);
}

/**
 * Map a single host-side `ToolCallInfo` (post-JSON-roundtrip from the
 * WS bridge) into a `TranscriptToolCallEntryPayload` — the same shape
 * `<acp-tool-call-detail>` consumes.
 *
 * `rawInput` / `rawOutput` are passed through verbatim; see the
 * `HostTurnSummary.toolCalls` JSDoc for the truncation rationale.
 */
function mapToolCallEntry(id: string, input: unknown): TranscriptToolCallEntryPayload | null {
  // `typeof null === "object"` — guard against null / non-object
  // values so a malformed wire payload (e.g. `{ "tc-1": null }`)
  // doesn't crash the mapper when we read field accessors below.
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  const status = typeof raw.status === "string" ? raw.status : null;
  const name = typeof raw.name === "string" ? raw.name : null;
  if (!status || !name) return null;

  // acp-host's `mapToolCallStatus` translates ACP `in_progress` →
  // host `running` for internal use. <acp-tool-call-detail> styles
  // ACP-shaped statuses (`data-status="in_progress"`), so invert the
  // mapping at the boundary so in-flight calls render with the
  // intended progress badge instead of an unstyled `running` chip.
  const acpStatus = status === "running" ? "in_progress" : status;

  const entry: TranscriptToolCallEntryPayload = {
    toolCallId: typeof raw.id === "string" ? raw.id : id,
    toolName: name,
    status: acpStatus,
  };

  if (typeof raw.kind === "string") {
    entry.toolKind = raw.kind as ToolKind;
  }

  const content = rehydrateToolCallContent(raw.richContent);
  if (content !== null) entry.content = content;

  const locations = rehydrateLocations(raw.locations);
  if (locations !== null) entry.locations = locations;

  if ("rawInput" in raw) entry.rawInput = raw.rawInput;
  if ("rawOutput" in raw) entry.rawOutput = raw.rawOutput;

  return entry;
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

  // Narrow to `Record<string, unknown>` rather than asserting object
  // values everywhere — the wire payload can include nulls / primitives
  // per the defensive guard in `mapToolCallEntry`. Keeping the value
  // type as `unknown` forces every field access below to runtime-check.
  const rawToolCalls =
    currentTurn.toolCalls && typeof currentTurn.toolCalls === "object"
      ? (currentTurn.toolCalls as Record<string, unknown>)
      : {};
  const toolCallEntries = Object.entries(rawToolCalls);
  const toolCalls = toolCallEntries.map(([, value]) => value);
  const isToolCallStatus = (value: unknown, status: string) =>
    !!value && typeof value === "object" && (value as { status?: unknown }).status === status;
  const activeToolCallCount = toolCalls.filter(
    (tc) => isToolCallStatus(tc, "pending") || isToolCallStatus(tc, "running"),
  ).length;
  const failedToolCallCount = toolCalls.filter((tc) => isToolCallStatus(tc, "failed")).length;

  const richToolCalls = toolCallEntries
    .map(([id, value]) => mapToolCallEntry(id, value))
    .filter((entry): entry is TranscriptToolCallEntryPayload => entry !== null);

  return {
    textChunkCount: textChunks.length,
    lastTextChunk: textChunks.at(-1) ?? null,
    toolCallCount: toolCalls.length,
    activeToolCallCount,
    failedToolCallCount,
    ...(richToolCalls.length > 0 ? { toolCalls: richToolCalls } : {}),
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
