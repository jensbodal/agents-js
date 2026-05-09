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

/** Permission mode controlling the host's auto-approve/prompt strategy. */
export type PermissionMode = "yolo" | "plan" | "ask" | "hub";

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
  }));
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
