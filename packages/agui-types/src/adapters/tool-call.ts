import {
  EventType,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallStartEvent,
} from "@ag-ui/core";
import { type AguiBaseEventOptionals, pickAguiBaseOptionals } from "./base.ts";

/**
 * Input shape emitted by agents-js when streaming tool-call argument chunks.
 *
 * agents-js uses `argsChunk`; AG-UI's canonical `TOOL_CALL_ARGS` event uses
 * `delta`. The mapping is pure-rename.
 */
export interface AgentsJsToolCallArgsInput extends AguiBaseEventOptionals {
  toolCallId: string;
  argsChunk: string;
}

export function toAguiToolCallArgs(input: AgentsJsToolCallArgsInput): ToolCallArgsEvent {
  return {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: input.toolCallId,
    delta: input.argsChunk,
    ...pickAguiBaseOptionals(input),
  };
}

/**
 * Input shape for opening a new AG-UI tool call.
 *
 * Field name `toolCallName` matches the AG-UI schema verbatim. Stream-builder
 * callers using a different convention (e.g., `toolName`) translate at the
 * call site, not here, so this adapter is a one-to-one mapping.
 */
export interface AgentsJsToolCallStartInput extends AguiBaseEventOptionals {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

export function toAguiToolCallStart(input: AgentsJsToolCallStartInput): ToolCallStartEvent {
  const event: ToolCallStartEvent = {
    type: EventType.TOOL_CALL_START,
    toolCallId: input.toolCallId,
    toolCallName: input.toolCallName,
    ...pickAguiBaseOptionals(input),
  };
  if (input.parentMessageId !== undefined) event.parentMessageId = input.parentMessageId;
  return event;
}

/**
 * Input shape for closing an open AG-UI tool call.
 */
export interface AgentsJsToolCallEndInput extends AguiBaseEventOptionals {
  toolCallId: string;
}

export function toAguiToolCallEnd(input: AgentsJsToolCallEndInput): ToolCallEndEvent {
  return {
    type: EventType.TOOL_CALL_END,
    toolCallId: input.toolCallId,
    ...pickAguiBaseOptionals(input),
  };
}
