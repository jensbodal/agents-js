import { EventType, type ReasoningEndEvent, type ReasoningStartEvent } from "@ag-ui/core";
import { type AguiBaseEventOptionals, pickAguiBaseOptionals } from "./base.ts";

/**
 * Input shape emitted by agents-js for reasoning lifecycle signals.
 *
 * AG-UI's `REASONING_START` / `REASONING_END` require a `messageId`. agents-js
 * historically has omitted it for reasoning blocks, so the adapters accept an
 * optional id and fall back to a generated one.
 */
export interface AgentsJsReasoningInput extends AguiBaseEventOptionals {
  messageId?: string;
}

/**
 * Generate a reasoning message id. `crypto.randomUUID` is available in every
 * runtime this package supports (`node >= 20.19.0`, `bun >= 1.3.11`).
 */
function generateReasoningMessageId(): string {
  return `reasoning_${crypto.randomUUID()}`;
}

/**
 * Map an agents-js reasoning-start signal to the canonical AG-UI
 * `REASONING_START` event, adding `messageId` if the input did not carry one.
 */
export function toAguiReasoningStart(input: AgentsJsReasoningInput = {}): ReasoningStartEvent {
  return {
    type: EventType.REASONING_START,
    messageId: input.messageId ?? generateReasoningMessageId(),
    ...pickAguiBaseOptionals(input),
  };
}

/**
 * Map an agents-js reasoning-end signal to the canonical AG-UI
 * `REASONING_END` event. `messageId` is required here — the caller is
 * expected to reuse the id returned from `toAguiReasoningStart`.
 */
export function toAguiReasoningEnd(
  input: AgentsJsReasoningInput & { messageId: string },
): ReasoningEndEvent {
  return {
    type: EventType.REASONING_END,
    messageId: input.messageId,
    ...pickAguiBaseOptionals(input),
  };
}
