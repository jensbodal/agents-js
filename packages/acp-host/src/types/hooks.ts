import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type { ACPSessionStatus } from "./session.ts";

export interface ToolCallSummary {
  id: string;
  name: string;
  status: "in_progress" | "completed" | "failed";
}

export interface SessionHooks {
  beforePrompt?(
    content: ContentBlock[],
    sessionId: string | null,
  ): Promise<ContentBlock[] | undefined> | ContentBlock[] | undefined;

  afterPrompt?(params: {
    sessionId: string | null;
    promptContent: ContentBlock[];
    textChunks: string[];
    stopReason: string;
    durationMs: number;
    requestId: string;
    userMessageId?: string;
    agentMessageId?: string;
  }): Promise<void> | void;

  beforePermission?(
    request: RequestPermissionRequest,
    sessionId: string | null,
  ): Promise<RequestPermissionRequest | undefined> | RequestPermissionRequest | undefined;

  afterPermission?(
    request: RequestPermissionRequest,
    response: RequestPermissionResponse,
    sessionId: string | null,
    selectedScope?: string,
  ): Promise<void> | void;

  onToolCall?(tool: ToolCallSummary, sessionId: string | null): Promise<void> | void;

  onStatusChange?(from: ACPSessionStatus, to: ACPSessionStatus): Promise<void> | void;
}
