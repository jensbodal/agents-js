import {
  EventType,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
} from "@ag-ui/core";
import { type AguiBaseEventOptionals, pickAguiBaseOptionals } from "./base.ts";

/**
 * Input shape emitted by agents-js for assistant text streaming.
 *
 * agents-js `message.delta` carries **accumulated** text (each event's `text`
 * contains the full string so far). AG-UI's `TEXT_MESSAGE_CONTENT` carries an
 * **incremental** `delta`. The adapter computes the diff against the previous
 * accumulated value.
 */
export interface AgentsJsMessageDeltaInput extends AguiBaseEventOptionals {
  messageId: string;
  /** Accumulated message text at the time of this event. */
  text: string;
}

/**
 * Map an agents-js accumulated-text message delta to the canonical AG-UI
 * `TEXT_MESSAGE_CONTENT` event with an incremental `delta`.
 *
 * `previousText` is the `text` field from the previous event in the same
 * message stream (or `""` for the first event). The adapter returns the
 * suffix of `input.text` that appears after `previousText`.
 *
 * If `previousText` is not a prefix of `input.text` (e.g., upstream
 * retransmitted or replaced content), the adapter falls back to emitting
 * `input.text` as the delta — callers should treat that as a replace.
 */
export function toAguiTextMessageContent(
  input: AgentsJsMessageDeltaInput,
  previousText = "",
): TextMessageContentEvent {
  const delta = input.text.startsWith(previousText)
    ? input.text.slice(previousText.length)
    : input.text;

  return {
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId: input.messageId,
    delta,
    ...pickAguiBaseOptionals(input),
  };
}

/**
 * Input shape for opening a new AG-UI text message.
 *
 * `role` defaults to `"assistant"` (matching the AG-UI schema default) so
 * agents-js callers — which almost always emit assistant messages — can omit
 * it. The narrow union mirrors the AG-UI `Role` schema's accepted values.
 */
export interface AgentsJsTextMessageStartInput extends AguiBaseEventOptionals {
  messageId: string;
  role?: "developer" | "system" | "assistant" | "user";
  name?: string;
}

export function toAguiTextMessageStart(
  input: AgentsJsTextMessageStartInput,
): TextMessageStartEvent {
  const event: TextMessageStartEvent = {
    type: EventType.TEXT_MESSAGE_START,
    messageId: input.messageId,
    role: input.role ?? "assistant",
    ...pickAguiBaseOptionals(input),
  };
  if (input.name !== undefined) event.name = input.name;
  return event;
}

/**
 * Input shape for closing an open AG-UI text message.
 */
export interface AgentsJsTextMessageEndInput extends AguiBaseEventOptionals {
  messageId: string;
}

export function toAguiTextMessageEnd(input: AgentsJsTextMessageEndInput): TextMessageEndEvent {
  return {
    type: EventType.TEXT_MESSAGE_END,
    messageId: input.messageId,
    ...pickAguiBaseOptionals(input),
  };
}
