/**
 * Minimal structural typings for the Droid `stream-json` output format, as
 * emitted by `droid exec --output-format stream-json`.
 *
 * Only the fields this adapter consumes are modeled. Unknown fields are
 * preserved via `Record<string, unknown>` so the translator can forward
 * payloads opaquely when ACP-layer consumers only care about a subset.
 *
 * Protocol target: Droid CLI 0.103.x (empirically verified against the
 * installed binary). The `stream-json` format is a line-delimited JSON
 * event stream; each line is a standalone object. Line delimiter is LF.
 */

/** Top-level Droid event discriminator. One object per NDJSON line. */
export type DroidStreamEvent =
  | DroidSystemEvent
  | DroidMessageEvent
  | DroidReasoningEvent
  | DroidToolCallEvent
  | DroidToolResultEvent
  | DroidCompletionEvent
  | DroidUnknownEvent;

/**
 * Emitted once at the start of a `droid exec` invocation. Carries the
 * resolved cwd, the internal droid session id, the list of tools the
 * selected model was instantiated with, the model name, and the reasoning
 * effort setting. The adapter consumes `session_id` for multi-turn
 * continuity (`--session-id <id>` on the next exec call).
 */
export interface DroidSystemEvent {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  model: string;
  reasoning_effort: string;
  [key: string]: unknown;
}

/**
 * User- or assistant-role text messages. `text` is the full content for this
 * event (not a delta — droid emits one `message` event per fully-formed
 * assistant text chunk, not a token stream). For assistant roles, the text
 * may include `<thinking>...</thinking>` XML wrapping reasoning content
 * when the model is set to expose it; consumers typically strip it.
 */
export interface DroidMessageEvent {
  type: "message";
  role: "user" | "assistant";
  id: string;
  text: string;
  timestamp: number;
  session_id: string;
  [key: string]: unknown;
}

/**
 * Reasoning / chain-of-thought summary events. Droid's current behavior is
 * to emit these *twice* per assistant turn with identical content (a model
 * quirk, observed empirically). The adapter deduplicates by `id` before
 * forwarding as ACP `agent_thought_chunk`.
 */
export interface DroidReasoningEvent {
  type: "reasoning";
  id: string;
  text: string;
  timestamp: number;
  session_id: string;
  [key: string]: unknown;
}

/**
 * Tool-invocation event. `id` is the ACP-compatible tool-call id; droid uses
 * a `tc-<random>` prefix. `toolName` identifies the tool (e.g. `"Execute"`,
 * `"Read"`, `"Edit"`). `parameters` is the raw tool input dict. The
 * `messageId` back-reference ties the call to the assistant message that
 * requested it.
 */
export interface DroidToolCallEvent {
  type: "tool_call";
  id: string;
  messageId: string;
  toolId: string;
  toolName: string;
  parameters: Record<string, unknown>;
  timestamp: number;
  session_id: string;
  [key: string]: unknown;
}

/**
 * Tool-execution result event. `id` matches the corresponding `tool_call`.
 * `isError` flips when droid's sandbox reports a non-zero exit / thrown
 * error. `value` carries the raw string payload (stdout or tool-specific
 * result). Droid emits one `tool_result` per `tool_call`.
 */
export interface DroidToolResultEvent {
  type: "tool_result";
  id: string;
  messageId: string;
  toolId: string;
  isError: boolean;
  value: string;
  timestamp: number;
  session_id: string;
  [key: string]: unknown;
}

/**
 * Emitted at the end of a `droid exec` invocation. `finalText` is the
 * assistant's concluding text; `numTurns` counts model turns within this
 * single exec; `durationMs` is wall-clock; `usage` carries token
 * accounting. The adapter consumes this as the signal that the ACP prompt
 * turn has ended successfully.
 */
export interface DroidCompletionEvent {
  type: "completion";
  finalText: string;
  numTurns: number;
  durationMs: number;
  session_id: string;
  timestamp: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  [key: string]: unknown;
}

/** Forward-compat fallback for events this adapter has not been updated to recognize. */
export interface DroidUnknownEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Known event `type` discriminators. Adapter branches on these; anything
 * else falls through `DroidUnknownEvent` and is dropped silently.
 */
export const DROID_EVENT_TYPES = {
  system: "system",
  message: "message",
  reasoning: "reasoning",
  toolCall: "tool_call",
  toolResult: "tool_result",
  completion: "completion",
} as const;

export function isDroidSystemEvent(event: DroidStreamEvent): event is DroidSystemEvent {
  return event.type === DROID_EVENT_TYPES.system;
}

export function isDroidCompletionEvent(event: DroidStreamEvent): event is DroidCompletionEvent {
  return event.type === DROID_EVENT_TYPES.completion;
}
