/**
 * Minimal structural typings for the Pi RPC protocol, as emitted by
 * `pi --mode rpc` from `@mariozechner/pi-coding-agent`.
 *
 * The shapes here are intentionally narrow — only the fields this adapter
 * consumes or emits are modeled. Unknown fields are preserved via
 * `Record<string, unknown>` index signatures so we can forward event
 * payloads opaquely when ACP-layer consumers only care about a subset.
 *
 * Protocol source of truth: upstream docs `rpc.md` in the Pi repo and empirical
 * verification against the installed Pi CLI (0.66.x at time of writing).
 */

/**
 * Pi RPC request envelope. Clients (this adapter) send requests on Pi's stdin.
 * The optional `id` enables request/response correlation; Pi echoes it in its
 * `response` message.
 */
export interface PiRpcRequest {
  id?: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Pi RPC response envelope. Emitted by Pi on stdout in reply to a command
 * that included a matching `id`. `success` is always present; `data` carries
 * the command-specific payload (if any); `error` is present when `success`
 * is false.
 */
export interface PiRpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Pi RPC event envelope. Emitted asynchronously on stdout during and around
 * prompt processing. `type` discriminates the event variant; the remaining
 * fields are event-specific.
 */
export interface PiRpcEvent {
  type: string;
  [key: string]: unknown;
}

/** Union of known top-level Pi RPC stdout message shapes. */
export type PiRpcMessage = PiRpcResponse | PiRpcEvent;

export function isPiRpcResponse(msg: PiRpcMessage): msg is PiRpcResponse {
  return msg.type === "response";
}

/**
 * Pi emits these event types during a prompt turn (not an exhaustive list):
 * - `agent_start`, `agent_end` — bracket the whole turn
 * - `turn_start`, `turn_end` — bracket one assistant response (plus tool results)
 * - `message_start`, `message_end` — full-message boundaries (user/assistant)
 * - `message_update` — streaming deltas (text, thinking, toolcalls)
 * - `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
 * - `queue_update`, `compaction_start`, `compaction_end`
 * - `auto_retry_start`, `auto_retry_end`, `extension_error`
 *
 * This adapter only branches on the ones that carry information ACP clients
 * need. Unknown events are logged at trace level and ignored.
 */
export const PI_EVENT_TYPES = {
  agentStart: "agent_start",
  agentEnd: "agent_end",
  turnStart: "turn_start",
  turnEnd: "turn_end",
  messageStart: "message_start",
  messageEnd: "message_end",
  messageUpdate: "message_update",
  toolExecutionStart: "tool_execution_start",
  toolExecutionUpdate: "tool_execution_update",
  toolExecutionEnd: "tool_execution_end",
} as const;

/**
 * Pi's `message_update` events carry an `assistantMessageEvent` sub-envelope
 * with a further-discriminated `type` describing the streaming delta kind.
 * The adapter only needs to route `text_delta` and `thinking_delta`; other
 * sub-types (e.g. `toolcall_delta`) are covered by the dedicated
 * `tool_execution_*` events.
 */
export const PI_ASSISTANT_EVENT_TYPES = {
  textStart: "text_start",
  textDelta: "text_delta",
  textEnd: "text_end",
  thinkingStart: "thinking_start",
  thinkingDelta: "thinking_delta",
  thinkingEnd: "thinking_end",
} as const;
