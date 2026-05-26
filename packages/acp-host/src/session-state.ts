/**
 * Session state creation and snapshot utilities.
 *
 * Pure functions with no side effects -- used by ACPSessionController
 * to initialise and reset state, and to snapshot completed turns.
 */
import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";
import type {
  ACPSessionState,
  CompletedToolCallSnapshot,
  CompletedTurnSnapshot,
  PlanEntryInfo,
  ToolCallContentInfo,
  ToolCallInfo,
  TurnState,
} from "./types/session.ts";

/**
 * Permission mode controlling the host's auto-approve/prompt strategy.
 *
 * Canonical vocabulary aligned with ACP / Claude Code semantics:
 * - `default` — prompt user for every gated action (read-auto, write-prompt).
 *   Aliased from legacy `"ask"` via {@link normalizePermissionMode}.
 * - `acceptEdits` — auto-approve edit operations without prompting.
 * - `plan` — agent enters plan mode (reads auto-approve, agent emits plan blocks).
 * - `bypassPermissions` — skip permission gating entirely (auto-approve all).
 *   Aliased from legacy `"yolo"` via {@link normalizePermissionMode}.
 * - `unattendedGateway` — auto-approve every operation whose tool-call
 *   classifies to a KNOWN {@link import("@agents-js/policy").OperationClass}
 *   member, and fail-closed (cancel) on any unknown / `tool.<name>` fallback.
 *   Intended for gateway-driven sessions where no human is on the prompt path
 *   but a tighter blast radius than `bypassPermissions` is required. The
 *   precise per-class auto-approve matrix is intentionally minimal in v1
 *   (auto-approve all KNOWN, fail-closed on UNKNOWN); tightening that matrix
 *   is a follow-up PR. Accepts both kebab CLI form `"unattended-gateway"` and
 *   canonical camelCase `"unattendedGateway"`.
 *
 * Folder-scoped auto-approve (the legacy `"hub"` mode's documented intent) is
 * driven separately by {@link ACPSessionState.hubPath} and the
 * {@link session-file-adapters.requestWriteGateApproval} write-gate path
 * check — it is independent of the mode flag, so the legacy `"hub"` mode
 * normalizes to `"default"` (ask-via-hub semantics; the folder auto-approve
 * survives via `hubPath`).
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "plan"
  | "bypassPermissions"
  | "unattendedGateway";

/**
 * Legacy permission-mode strings retained for one release cycle for
 * back-compat. Inputs at public boundaries (ws-bridge JSON messages,
 * embedder API calls) are run through {@link normalizePermissionMode}
 * before reaching the internal pipeline.
 *
 * @deprecated Use the canonical {@link PermissionMode} vocabulary instead.
 */
export type LegacyPermissionMode = "yolo" | "plan" | "ask" | "hub";

/**
 * Normalize a permission-mode string from any vintage to the canonical
 * {@link PermissionMode}. Maps legacy strings:
 * - `"ask"` → `"default"`
 * - `"yolo"` → `"bypassPermissions"`
 * - `"hub"` → `"default"` (ask-via-hub; folder auto-approve flows via
 *   {@link ACPSessionState.hubPath}, not the mode flag)
 * - `"plan"` → `"plan"` (unchanged)
 *
 * Canonical strings pass through unchanged. Unknown strings fall back
 * to `"default"` with a one-time `console.warn`.
 */
let _legacyWarned = false;
export function normalizePermissionMode(
  mode: PermissionMode | LegacyPermissionMode | string,
): PermissionMode {
  switch (mode) {
    case "default":
    case "acceptEdits":
    case "plan":
    case "bypassPermissions":
    case "unattendedGateway":
      return mode;
    case "unattended-gateway":
      return "unattendedGateway";
    case "ask":
      if (!_legacyWarned) {
        _legacyWarned = true;
        console.warn(
          '[agents-js] PermissionMode "ask" is deprecated; use "default". ' +
            "Legacy aliases will be removed in the next breaking release.",
        );
      }
      return "default";
    case "yolo":
      if (!_legacyWarned) {
        _legacyWarned = true;
        console.warn(
          '[agents-js] PermissionMode "yolo" is deprecated; use "bypassPermissions". ' +
            "Legacy aliases will be removed in the next breaking release.",
        );
      }
      return "bypassPermissions";
    case "hub":
      if (!_legacyWarned) {
        _legacyWarned = true;
        console.warn(
          '[agents-js] PermissionMode "hub" is deprecated; use "default" ' +
            "(folder-scoped auto-approve flows via hubPath, not the mode flag). " +
            "Legacy aliases will be removed in the next breaking release.",
        );
      }
      return "default";
    default:
      console.warn(`[agents-js] Unknown PermissionMode "${mode}"; falling back to "default".`);
      return "default";
  }
}

export function createInitialState(): ACPSessionState {
  return {
    sessionId: null,
    status: "idle",
    agentName: null,
    agentCapabilities: null,
    currentTurn: null,
    completedTurns: [],
    lastError: null,
    pendingWriteGate: null,
    pendingElicitation: null,
    promptQueue: [],
    plan: null,
    sessionTitle: null,
    sessionUpdatedAt: null,
    localLabel: null,
    modes: null,
    models: null,
    modesAdvertisedByAgent: false,
    permissionGatingActive: true,
    hubPath: null,
    availableCommands: null,
    usage: null,
  };
}

export function createTurnState(): TurnState {
  return {
    textChunks: [],
    toolCalls: new Map(),
    turnItems: [],
    pendingPermission: null,
    approvedToolCallIds: new Set(),
    emittedStartToolCallIds: new Set(),
    emittedEndToolCallIds: new Set(),
  };
}

export function getValidMessageId(messageId: unknown): string | undefined {
  return typeof messageId === "string" && messageId.length > 0 ? messageId : undefined;
}

export function clonePromptContent(content: ContentBlock[]): ContentBlock[] {
  return structuredClone(content);
}

export function clonePlanEntries(entries: PlanEntryInfo[] | null): PlanEntryInfo[] | null {
  return entries ? structuredClone(entries) : null;
}

export function cloneTurnItems(turnItems: TurnState["turnItems"]): TurnState["turnItems"] {
  return turnItems.map((item) => ({ ...item }));
}

export function snapshotToolCalls(
  toolCalls: Map<string, ToolCallInfo>,
): CompletedToolCallSnapshot[] {
  return [...toolCalls.values()].map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    status: toolCall.status,
    content: toolCall.content,
    kind: toolCall.kind,
    richContent: toolCall.richContent ? structuredClone(toolCall.richContent) : undefined,
    // Forward the rich ACP fields onto the completed snapshot so
    // post-turn consumers (transcript history, replay) see what the
    // harness reported. Deep-clone every reference field so the
    // snapshot is decoupled from later mutations of the live
    // `ToolCallInfo`. `rawInput` / `rawOutput` are `unknown` and may
    // hold arbitrary objects (file contents, structured tool output);
    // `cloneRawValue` handles the cases `structuredClone` can't (DOM
    // nodes, functions, BigInt — though tools shouldn't return any
    // of those, defensive belt-and-suspenders).
    ...(toolCall.locations !== undefined ? { locations: structuredClone(toolCall.locations) } : {}),
    ...(toolCall.rawInput !== undefined ? { rawInput: cloneRawValue(toolCall.rawInput) } : {}),
    ...(toolCall.rawOutput !== undefined ? { rawOutput: cloneRawValue(toolCall.rawOutput) } : {}),
  }));
}

/**
 * Best-effort deep clone for `rawInput` / `rawOutput`. Tries
 * `structuredClone` first; falls back to JSON round-trip for the
 * narrow case where the value contains JSON-serializable data but
 * something `structuredClone` rejects (e.g. tagged template literal
 * objects). Final fallback is a reference passthrough — at that
 * point the snapshot's immutability is best-effort and consumers
 * SHOULD treat raw values as read-only regardless.
 */
function cloneRawValue(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value;
    }
  }
}

export function buildCompletedTurnSnapshot(params: {
  requestId: string;
  completedAt: number;
  durationMs: number;
  stopReason: string;
  promptContent: ContentBlock[];
  currentTurn: TurnState;
  planAtCompletion: PlanEntryInfo[] | null;
}): CompletedTurnSnapshot {
  return {
    requestId: params.requestId,
    completedAt: params.completedAt,
    durationMs: params.durationMs,
    stopReason: params.stopReason,
    promptContent: clonePromptContent(params.promptContent),
    userMessageId: params.currentTurn.userMessageId,
    agentMessageId: params.currentTurn.agentMessageId,
    textChunks: [...params.currentTurn.textChunks],
    turnItems: cloneTurnItems(params.currentTurn.turnItems),
    toolCalls: snapshotToolCalls(params.currentTurn.toolCalls),
    planAtCompletion: clonePlanEntries(params.planAtCompletion),
  };
}

export function mapToolCallStatus(status: string | undefined | null): ToolCallInfo["status"] {
  switch (status) {
    case "in_progress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export function mapToolCallContent(content: ToolCallContent[]): ToolCallContentInfo[] {
  return content.map((item): ToolCallContentInfo => {
    switch (item.type) {
      case "content": {
        const block = item.content;
        const text = block.type === "text" ? block.text : undefined;
        return { type: "content", text };
      }
      case "diff":
        return {
          type: "diff",
          diffPath: item.path,
          diffOldText: item.oldText ?? undefined,
          diffNewText: item.newText,
        };
      case "terminal":
        return {
          type: "terminal",
          terminalId: item.terminalId,
        };
      default:
        return { type: "content" };
    }
  });
}
