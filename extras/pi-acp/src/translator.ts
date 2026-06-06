import type {
  SessionNotification,
  StopReason,
  ToolCall,
  ToolCallStatus,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import { PI_ASSISTANT_EVENT_TYPES, PI_EVENT_TYPES, type PiRpcMessage } from "./types.ts";

/**
 * Output of one translator step. The translator is the boundary between the
 * Pi event stream and the ACP `session/update` notification stream.
 *
 * An incoming Pi message can produce:
 * - zero or more ACP notifications to forward to the client
 * - an optional `turnComplete` signal carrying the ACP `stopReason`, which
 *   tells the calling session to resolve its outstanding `prompt` request
 */
export interface TranslatorStepResult {
  notifications: SessionNotification[];
  turnComplete?: { stopReason: StopReason };
}

/**
 * Translator state for one ACP session ↔ one Pi process. The translator is
 * stateful because Pi's tool-execution events are discrete per tool call
 * (start / update / end) but ACP needs a `ToolCall` + `ToolCallUpdate` split
 * keyed off an ACP-side toolCallId. We map Pi's tool-execution id (a uuid
 * Pi generates) to the same string on the ACP side.
 */
export class PiToAcpTranslator {
  private readonly sessionId: string;
  private turnActive = false;
  /** Tracks which tool-call ids we have already emitted a `tool_call` for. */
  private readonly startedToolCalls = new Set<string>();
  /**
   * Pi's `text_start` / `text_end` events bracket the contiguous assistant
   * text output for one response. We do not need explicit state here — we
   * forward every `text_delta` as an ACP `agent_message_chunk`, and let the
   * ACP client concatenate by `messageId`.
   */

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /**
   * Transition the translator into "turn active" state. Called when the ACP
   * `prompt` request is dispatched so subsequent Pi events are mapped as
   * in-turn notifications.
   */
  markTurnStarted(): void {
    this.turnActive = true;
    this.startedToolCalls.clear();
  }

  /**
   * Handle one Pi RPC message. Returns ACP notifications to forward and,
   * when the turn has completed, a `turnComplete` signal.
   */
  handleMessage(message: PiRpcMessage): TranslatorStepResult {
    if (message.type === "response") {
      // Responses are consumed by the client's request/response machinery,
      // never translated into ACP updates.
      return { notifications: [] };
    }

    switch (message.type) {
      case PI_EVENT_TYPES.agentStart:
      case PI_EVENT_TYPES.turnStart:
      case PI_EVENT_TYPES.messageStart:
      case PI_EVENT_TYPES.messageEnd:
      case PI_EVENT_TYPES.turnEnd:
        // These are framing events without ACP analogues — Pi's `message_update`
        // events carry the actual streaming payload. Emit nothing; let the
        // stream sort itself.
        return { notifications: [] };

      case PI_EVENT_TYPES.messageUpdate:
        return { notifications: this.handleMessageUpdate(message) };

      case PI_EVENT_TYPES.toolExecutionStart:
        return { notifications: this.handleToolExecutionStart(message) };

      case PI_EVENT_TYPES.toolExecutionUpdate:
        return { notifications: this.handleToolExecutionUpdate(message) };

      case PI_EVENT_TYPES.toolExecutionEnd:
        return { notifications: this.handleToolExecutionEnd(message) };

      case PI_EVENT_TYPES.agentEnd:
        // `agent_end` is Pi's turn-complete signal. Resolve the ACP prompt
        // request with `end_turn`. If cancellation was signaled mid-flight
        // the session wrapper will override this with `cancelled`.
        this.turnActive = false;
        return {
          notifications: [],
          turnComplete: { stopReason: "end_turn" },
        };

      default:
        // Unknown / not-yet-translated event. Drop silently. A future pass
        // may surface a subset (e.g. compaction_*) as `session_info_update`.
        return { notifications: [] };
    }
  }

  /**
   * Return a synthetic `turnComplete` result for callers that want to finalize
   * the turn externally (e.g. on cancellation acknowledgement).
   */
  markTurnCancelled(): TranslatorStepResult {
    this.turnActive = false;
    return {
      notifications: [],
      turnComplete: { stopReason: "cancelled" },
    };
  }

  get isTurnActive(): boolean {
    return this.turnActive;
  }

  // --- private handlers ---

  private handleMessageUpdate(message: Record<string, unknown>): SessionNotification[] {
    const event = message.assistantMessageEvent as
      | { type?: string; delta?: string; contentIndex?: number }
      | undefined;
    if (!event || typeof event.type !== "string") {
      return [];
    }
    const delta = typeof event.delta === "string" ? event.delta : "";
    switch (event.type) {
      case PI_ASSISTANT_EVENT_TYPES.textDelta: {
        if (!delta) return [];
        return [this.buildAgentMessageChunk(delta)];
      }
      case PI_ASSISTANT_EVENT_TYPES.thinkingDelta: {
        if (!delta) return [];
        return [this.buildAgentThoughtChunk(delta)];
      }
      // `text_start`, `text_end`, `thinking_start`, `thinking_end` carry no
      // user-visible content in their own right; ACP consumers reconstruct
      // content from the deltas. Drop.
      default:
        return [];
    }
  }

  private handleToolExecutionStart(message: Record<string, unknown>): SessionNotification[] {
    const id = this.extractToolCallId(message);
    if (!id) return [];
    this.startedToolCalls.add(id);
    const title = this.extractToolCallTitle(message) ?? id;
    const status: ToolCallStatus = "in_progress";
    const toolCall: ToolCall = {
      toolCallId: id,
      title,
      status,
    };
    return [this.wrap({ sessionUpdate: "tool_call", ...toolCall })];
  }

  private handleToolExecutionUpdate(message: Record<string, unknown>): SessionNotification[] {
    const id = this.extractToolCallId(message);
    if (!id) return [];
    // If Pi emitted an update before start (defensive — shouldn't happen, but
    // keep the stream tolerant), synthesize a tool_call first.
    if (!this.startedToolCalls.has(id)) {
      this.startedToolCalls.add(id);
      const title = this.extractToolCallTitle(message) ?? id;
      return [
        this.wrap({
          sessionUpdate: "tool_call",
          toolCallId: id,
          title,
          status: "in_progress",
        } satisfies ToolCall & { sessionUpdate: "tool_call" }),
      ];
    }
    const update: ToolCallUpdate = {
      toolCallId: id,
      status: "in_progress",
    };
    return [this.wrap({ sessionUpdate: "tool_call_update", ...update })];
  }

  private handleToolExecutionEnd(message: Record<string, unknown>): SessionNotification[] {
    const id = this.extractToolCallId(message);
    if (!id) return [];
    const succeeded = this.extractToolCallSuccess(message);
    const status: ToolCallStatus = succeeded ? "completed" : "failed";
    const update: ToolCallUpdate = {
      toolCallId: id,
      status,
    };
    return [this.wrap({ sessionUpdate: "tool_call_update", ...update })];
  }

  private extractToolCallId(message: Record<string, unknown>): string | null {
    // Pi's tool_execution_* events document `toolCallId` (camelCase). Accept
    // the documented name; fall back to a few alternative names so minor
    // upstream churn doesn't silently break translation.
    for (const key of ["toolCallId", "toolCall_id", "id", "callId"]) {
      const value = message[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    // Some upstream variants nest the call under a `toolCall` object.
    const nested = message.toolCall;
    if (nested && typeof nested === "object") {
      const typed = nested as Record<string, unknown>;
      for (const key of ["id", "toolCallId", "callId"]) {
        const value = typed[key];
        if (typeof value === "string" && value.length > 0) {
          return value;
        }
      }
    }
    return null;
  }

  private extractToolCallTitle(message: Record<string, unknown>): string | null {
    for (const key of ["title", "name", "toolName", "tool"]) {
      const value = message[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
    const nested = message.toolCall;
    if (nested && typeof nested === "object") {
      const typed = nested as Record<string, unknown>;
      for (const key of ["title", "name"]) {
        const value = typed[key];
        if (typeof value === "string" && value.length > 0) {
          return value;
        }
      }
    }
    return null;
  }

  private extractToolCallSuccess(message: Record<string, unknown>): boolean {
    if (typeof message.success === "boolean") return message.success;
    if (typeof message.error === "string" && message.error.length > 0) return false;
    const nested = message.result;
    if (nested && typeof nested === "object") {
      const typed = nested as Record<string, unknown>;
      if (typeof typed.success === "boolean") return typed.success;
      if (typeof typed.error === "string" && typed.error.length > 0) return false;
    }
    return true;
  }

  private buildAgentMessageChunk(text: string): SessionNotification {
    return this.wrap({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    });
  }

  private buildAgentThoughtChunk(text: string): SessionNotification {
    return this.wrap({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text },
    });
  }

  private wrap(update: SessionNotification["update"]): SessionNotification {
    return { sessionId: this.sessionId, update };
  }
}
