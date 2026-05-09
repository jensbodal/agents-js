export interface AgentTool {
  name: string;
  description: string;
}

/**
 * Progress updates forwarded to the Pi host during a `callTool` call.
 *
 * - `streaming` / `progress` — textual status, used by Pi's stdio progress UI.
 * - `a2ui` — pass-through of an A2UI `surface_event` that the gateway emitted
 *   on the A2A event bus as a CUSTOM event named `agents-js.a2ui.surface_event`
 *   (see `@agents-js/a2ui-types` `A2UI_SURFACE_EVENT_NAME`). Pi itself has no
 *   native renderer for A2UI surfaces; the forward is intended for downstream
 *   consumers (e.g. a Pi plugin) that do. The `event` payload is left as
 *   `unknown` on purpose: this layer only relays, it does not interpret.
 */
export type ProgressUpdate =
  | { type: "streaming"; text: string }
  | { type: "progress"; text: string }
  | { type: "a2ui"; surfaceId: string; event: unknown };

export type ProgressCallback = (update: ProgressUpdate) => void;

export interface AgentBridge {
  initialize(): Promise<void>;
  listTools(): Promise<AgentTool[]>;
  callTool(name: string, message: string, onProgress?: ProgressCallback): Promise<string>;
  destroy(): Promise<void>;
}

/**
 * Minimal structural type for the Pi extension host API.
 *
 * Pi does not publish TypeScript declarations, so we model only the surface
 * we actually depend on (`on` and `registerTool`). Event and context payloads
 * are intentionally `unknown` — callers must narrow before use.
 */
export interface PiHost {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>): void;
  registerTool(tool: PiToolRegistration): void;
  sendMessage?(message: PiCustomMessage, options?: PiSendMessageOptions): void | Promise<void>;
  sendUserMessage?(
    content: string | PiContentBlock[],
    options?: PiSendUserMessageOptions,
  ): void | Promise<void>;
}

export type PiContentBlock =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export interface PiCustomMessage {
  customType: string;
  content: string;
  display?: boolean;
  details?: Record<string, unknown>;
}

export interface PiSendMessageOptions {
  deliverAs?: "steer" | "followUp" | "nextTurn";
  triggerTurn?: boolean;
}

export interface PiSendUserMessageOptions {
  deliverAs?: "steer" | "followUp";
}

/**
 * Shape of the update object Pi's `onUpdate` callback accepts. Pi tolerates
 * unknown fields at runtime, so we widen to `{ type: string; [k: string]: unknown }`
 * and drop what would otherwise need an `as unknown as` cast when adapting our richer
 * {@link ProgressUpdate} union into this channel.
 */
export type PiOnUpdate = (update: { type: string; [key: string]: unknown }) => void;

export interface PiToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: { message: string },
    signal: AbortSignal,
    onUpdate: PiOnUpdate | undefined,
    ctx: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
}

/**
 * Adapter: wrap Pi's loose {@link PiOnUpdate} (that accepts any object with
 * a `type`) so it can slot into our strongly-typed {@link ProgressCallback}
 * without a cast. No-op when Pi did not supply one.
 */
export function adaptPiOnUpdate(onUpdate: PiOnUpdate | undefined): ProgressCallback | undefined {
  if (!onUpdate) return undefined;
  return (update: ProgressUpdate) => onUpdate(update);
}

/**
 * Shape of the Pi `context` event payload that we narrow to when injecting
 * a system message. Pi is expected to accept mutations to `messages` in place.
 */
export interface PiContextEvent {
  messages?: Array<{ role: string; content: string }>;
}
