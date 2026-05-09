import { EventType, type RunErrorEvent, type RunFinishedEvent } from "@ag-ui/core";
import { type AguiBaseEventOptionals, pickAguiBaseOptionals } from "./base.ts";

/**
 * Input shape for signalling a successful run completion.
 *
 * `result` is forwarded verbatim when supplied; callers omit it for runs whose
 * outcome is conveyed only through the preceding event stream.
 */
export interface AgentsJsRunFinishedInput extends AguiBaseEventOptionals {
  threadId: string;
  runId: string;
  result?: unknown;
}

export function toAguiRunFinished(input: AgentsJsRunFinishedInput): RunFinishedEvent {
  const event: RunFinishedEvent = {
    type: EventType.RUN_FINISHED,
    threadId: input.threadId,
    runId: input.runId,
    ...pickAguiBaseOptionals(input),
  };
  if (input.result !== undefined) event.result = input.result;
  return event;
}

/**
 * Input shape for signalling a run-level error.
 */
export interface AgentsJsRunErrorInput extends AguiBaseEventOptionals {
  message: string;
  code?: string;
}

export function toAguiRunError(input: AgentsJsRunErrorInput): RunErrorEvent {
  const event: RunErrorEvent = {
    type: EventType.RUN_ERROR,
    message: input.message,
    ...pickAguiBaseOptionals(input),
  };
  if (input.code !== undefined) event.code = input.code;
  return event;
}
