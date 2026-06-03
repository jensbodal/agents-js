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
  PendingElicitationInfo,
  PendingPermissionInfo,
  RuntimeInfo,
  RuntimeSwitchOrigin,
  RuntimeSwitchState,
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
    // JSON-parsed and downstream renderers read `loc.path` /
    // `block.type` unguarded. `rehydrateLocations()` enforces the
    // `{ path: string, line?: number }` contract; `isToolCallContentBlock`
    // validates both the `ToolCallContent` discriminator AND the
    // per-variant required fields (`diff.path` + `diff.newText`,
    // `terminal.terminalId`, `content.content.type`) so a malformed
    // payload like `{ type: "diff" }` is dropped rather than narrowed
    // to a shape with missing required fields.
    const locations = rehydrateLocations(toolCall.locations) ?? undefined;
    const content = Array.isArray(toolCall.content)
      ? toolCall.content.filter(isToolCallContentBlock)
      : undefined;
    result.toolCall = {
      toolCallId: typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : undefined,
      title: typeof toolCall.title === "string" ? toolCall.title : undefined,
      status:
        typeof toolCall.status === "string"
          ? (toolCall.status as ToolCallStatus | string)
          : undefined,
      kind: typeof toolCall.kind === "string" ? (toolCall.kind as ToolKind | string) : undefined,
      locations,
      rawInput: toolCall.rawInput,
      rawOutput: toolCall.rawOutput,
      content,
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
 * Narrow a raw value against the ACP `ToolCallContent` union
 * (`"content" | "diff" | "terminal"`) — validates BOTH the
 * discriminator AND per-variant required fields, so a partial
 * payload like `{ type: "diff" }` is rejected rather than narrowed
 * to a `ToolCallContent` with missing required fields.
 *
 * Used inline by `mapPermissionRequest`; the permission-path content
 * is the raw SDK shape (host-serialized `richContent` uses the
 * separate `rehydrateToolCallContent`).
 */
function isToolCallContentBlock(block: unknown): block is ToolCallContent {
  if (typeof block !== "object" || block === null) return false;
  const entry = block as Record<string, unknown>;
  switch (entry.type) {
    case "content": {
      // `content` variants wrap a nested content block; per spec the
      // nested block carries its own `type` discriminator (text /
      // image / audio / resource_link / resource). We only require
      // the nested object + its `type` field — exact nested shape
      // validation is the renderer's job.
      const nested = entry.content;
      return (
        !!nested &&
        typeof nested === "object" &&
        typeof (nested as { type?: unknown }).type === "string"
      );
    }
    case "diff":
      // `diff` requires `path` + `newText`; `oldText` may be string or null.
      return typeof entry.path === "string" && typeof entry.newText === "string";
    case "terminal":
      return typeof entry.terminalId === "string";
    default:
      return false;
  }
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

/** Join the `text`-typed blocks of an ACP `ContentBlock[]` into a string. */
function contentBlocksToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

/** Join the string entries of a `textChunks` array; ignore non-strings. */
function joinTextChunks(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((chunk): chunk is string => typeof chunk === "string").join("")
    : "";
}

/**
 * Build the rendered transcript from the gateway's `completedTurns`.
 *
 * Each `CompletedTurnSnapshot` carries both the user prompt
 * (`promptContent`) and the agent reply (`textChunks`), so a turn maps to
 * a user entry followed by an agent entry. This is the host-bridge source
 * of truth for the chat transcript: in AG-UI mode the prompt is issued via
 * `POST /agent`, so the A2A client controller — the only *other* producer
 * of `transcript`/`pendingAgentText` — never sees the turn. Without this
 * mapping the chat stays on "Waiting for messages..." regardless of what
 * the runtime produced (DOT-532).
 */
function deriveHostTranscript(raw: Record<string, unknown>): HostState["transcript"] {
  const completed = Array.isArray(raw.completedTurns) ? raw.completedTurns : [];
  const transcript: NonNullable<HostState["transcript"]> = [];
  completed.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const turn = entry as Record<string, unknown>;
    const requestId = typeof turn.requestId === "string" ? turn.requestId : String(index);
    const userText = contentBlocksToText(turn.promptContent);
    if (userText) {
      transcript.push({
        id: typeof turn.userMessageId === "string" ? turn.userMessageId : `${requestId}:user`,
        role: "user",
        text: userText,
      });
    }
    const agentText = joinTextChunks(turn.textChunks);
    if (agentText) {
      transcript.push({
        id: typeof turn.agentMessageId === "string" ? turn.agentMessageId : `${requestId}:agent`,
        role: "agent",
        text: agentText,
      });
    }
  });
  return transcript;
}

/** Streaming agent text for the in-flight turn (`currentTurn.textChunks`). */
function derivePendingAgentText(raw: Record<string, unknown>): string {
  const currentTurn = raw.currentTurn as Record<string, unknown> | null | undefined;
  return currentTurn ? joinTextChunks(currentTurn.textChunks) : "";
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
  next.transcript = deriveHostTranscript(raw);
  next.pendingAgentText = derivePendingAgentText(raw);

  return next;
}
