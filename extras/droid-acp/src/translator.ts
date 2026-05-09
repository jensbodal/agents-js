import type {
  ContentBlock,
  PromptRequest,
  SessionNotification,
  StopReason,
  ToolCall,
  ToolCallStatus,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { DroidStreamEvent } from "./types.ts";
import { DROID_EVENT_TYPES } from "./types.ts";

/**
 * Output of one translator step. An incoming Droid event can produce:
 * - zero or more ACP notifications to forward to the client
 * - an optional `turnComplete` signal carrying the ACP `stopReason`, which
 *   tells the calling session to resolve its outstanding `prompt` request
 * - an optional `droidSessionId` captured from `system/init` so the next
 *   turn in the same ACP session can pass `--session-id` back to droid
 */
export interface DroidTranslatorStepResult {
  notifications: SessionNotification[];
  turnComplete?: { stopReason: StopReason };
  droidSessionId?: string;
}

/**
 * Concatenate textual content from an ACP `PromptRequest` for forwarding as
 * a single positional prompt argv to `droid exec`. Non-text content blocks
 * (images, resources) are either serialized as a URI placeholder or dropped.
 */
export function promptRequestToDroidPrompt(request: PromptRequest): string {
  const parts: string[] = [];
  for (const block of request.prompt) {
    const textPart = extractTextFromContentBlock(block);
    if (textPart) {
      parts.push(textPart);
    }
  }
  return parts.join("");
}

function extractTextFromContentBlock(block: ContentBlock): string | null {
  if (block && typeof block === "object" && "type" in block) {
    const typed = block as { type: string; text?: string };
    if (typed.type === "text" && typeof typed.text === "string") {
      return typed.text;
    }
    if (typed.type === "resource_link") {
      const uri = (block as { uri?: string }).uri;
      return uri ? `<${uri}>` : null;
    }
  }
  return null;
}

/**
 * Stateful translator for one ACP prompt turn. Constructed fresh per turn
 * because each `droid exec` invocation is independent and carries its own
 * assistant-message and reasoning ids.
 *
 * Droid's `stream-json` quirks this handles:
 *
 * 1. Reasoning events are emitted *twice* per assistant turn with identical
 *    `id` and `text`. The translator deduplicates by `id` and only forwards
 *    the first occurrence as an `agent_thought_chunk`.
 * 2. Assistant `message` events carry full text (not a token stream), often
 *    prefixed with `<thinking>...</thinking>` XML when the model exposes
 *    reasoning inline. The translator strips the thinking block before
 *    emitting `agent_message_chunk`; reasoning arrives separately via
 *    `reasoning` events and should not be duplicated through the message
 *    channel.
 * 3. `system/init` carries droid's internal `session_id`. The translator
 *    surfaces it via `droidSessionId` on the step result so the owning
 *    session can capture it for multi-turn continuity.
 */
export class DroidToAcpTranslator {
  private readonly acpSessionId: string;
  private turnActive = false;
  private readonly startedToolCalls = new Set<string>();
  private readonly seenReasoningIds = new Set<string>();

  constructor(acpSessionId: string) {
    this.acpSessionId = acpSessionId;
  }

  markTurnStarted(): void {
    this.turnActive = true;
    this.startedToolCalls.clear();
    this.seenReasoningIds.clear();
  }

  /**
   * Externally mark the current turn as cancelled. Returns a synthetic
   * `turnComplete` with `stopReason: "cancelled"` so the owning session can
   * resolve its prompt promise immediately.
   */
  markTurnCancelled(): DroidTranslatorStepResult {
    this.turnActive = false;
    return {
      notifications: [],
      turnComplete: { stopReason: "cancelled" },
    };
  }

  get isTurnActive(): boolean {
    return this.turnActive;
  }

  handleEvent(event: DroidStreamEvent): DroidTranslatorStepResult {
    switch (event.type) {
      case DROID_EVENT_TYPES.system:
        return this.handleSystem(event);
      case DROID_EVENT_TYPES.message:
        return this.handleMessage(event);
      case DROID_EVENT_TYPES.reasoning:
        return this.handleReasoning(event);
      case DROID_EVENT_TYPES.toolCall:
        return { notifications: this.handleToolCall(event) };
      case DROID_EVENT_TYPES.toolResult:
        return { notifications: this.handleToolResult(event) };
      case DROID_EVENT_TYPES.completion:
        this.turnActive = false;
        return {
          notifications: [],
          turnComplete: { stopReason: "end_turn" },
        };
      default:
        return { notifications: [] };
    }
  }

  // --- private handlers ---

  private handleSystem(event: DroidStreamEvent): DroidTranslatorStepResult {
    const typed = event as { subtype?: string; session_id?: string };
    if (typed.subtype === "init" && typeof typed.session_id === "string") {
      return { notifications: [], droidSessionId: typed.session_id };
    }
    return { notifications: [] };
  }

  private handleMessage(event: DroidStreamEvent): DroidTranslatorStepResult {
    const typed = event as { role?: string; text?: string };
    // Only forward assistant messages. User-role events echo the prompt we
    // already sent and carry no new information for the ACP client.
    if (typed.role !== "assistant" || typeof typed.text !== "string") {
      return { notifications: [] };
    }
    const stripped = stripInlineThinking(typed.text);
    if (stripped.length === 0) {
      return { notifications: [] };
    }
    return {
      notifications: [this.buildAgentMessageChunk(stripped)],
    };
  }

  private handleReasoning(event: DroidStreamEvent): DroidTranslatorStepResult {
    const typed = event as { id?: string; text?: string };
    if (typeof typed.text !== "string" || typed.text.length === 0) {
      return { notifications: [] };
    }
    // Droid emits duplicate reasoning events per turn; dedupe by id so the
    // ACP client sees exactly one thought chunk per reasoning payload.
    if (typeof typed.id === "string") {
      if (this.seenReasoningIds.has(typed.id)) {
        return { notifications: [] };
      }
      this.seenReasoningIds.add(typed.id);
    }
    return {
      notifications: [this.buildAgentThoughtChunk(typed.text)],
    };
  }

  private handleToolCall(event: DroidStreamEvent): SessionNotification[] {
    const typed = event as {
      id?: string;
      toolName?: string;
      parameters?: Record<string, unknown>;
    };
    if (typeof typed.id !== "string" || typed.id.length === 0) {
      return [];
    }
    this.startedToolCalls.add(typed.id);
    const title =
      typeof typed.toolName === "string" && typed.toolName.length > 0 ? typed.toolName : typed.id;
    const status: ToolCallStatus = "in_progress";
    const toolCall: ToolCall = {
      toolCallId: typed.id,
      title,
      status,
    };
    return [this.wrap({ sessionUpdate: "tool_call", ...toolCall })];
  }

  private handleToolResult(event: DroidStreamEvent): SessionNotification[] {
    const typed = event as { id?: string; isError?: boolean };
    if (typeof typed.id !== "string" || typed.id.length === 0) {
      return [];
    }
    // Defensive: if the result arrives before the call (shouldn't happen),
    // synthesize an in_progress tool_call first so ACP clients always see
    // the start/update pair.
    const synthesized: SessionNotification[] = [];
    if (!this.startedToolCalls.has(typed.id)) {
      this.startedToolCalls.add(typed.id);
      synthesized.push(
        this.wrap({
          sessionUpdate: "tool_call",
          toolCallId: typed.id,
          title: typed.id,
          status: "in_progress",
        } satisfies ToolCall & { sessionUpdate: "tool_call" }),
      );
    }
    const status: ToolCallStatus = typed.isError === true ? "failed" : "completed";
    const update: ToolCallUpdate = {
      toolCallId: typed.id,
      status,
    };
    synthesized.push(this.wrap({ sessionUpdate: "tool_call_update", ...update }));
    return synthesized;
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
    return { sessionId: this.acpSessionId, update };
  }
}

/**
 * Strip `<thinking>...</thinking>` XML blocks from an assistant message.
 * Droid tends to prefix assistant output with an inline thinking block that
 * duplicates the content already streamed through `reasoning` events; ACP
 * clients render both channels separately, so the duplication is visible
 * noise. Exported for testing.
 */
/**
 * Matches a `<thinking>…</thinking>` block (non-greedy across newlines)
 * plus any trailing whitespace. Regex is appropriate here because the
 * tolerant non-greedy match across newlines is awkward to express with
 * `indexOf`/`slice` without rewriting the same logic by hand.
 */
const THINKING_BLOCK_PATTERN = /<thinking>[\s\S]*?<\/thinking>\s*/g;

export function stripInlineThinking(text: string): string {
  const cleaned = text.replace(THINKING_BLOCK_PATTERN, "");
  return cleaned.trim();
}
