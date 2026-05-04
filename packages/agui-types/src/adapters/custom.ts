import { type CustomEvent, EventType } from "@ag-ui/core";
import { type AguiBaseEventOptionals, pickAguiBaseOptionals } from "./base.ts";

/**
 * Input shape for emitting an out-of-band `CUSTOM` event.
 *
 * `value` is forwarded verbatim — the AG-UI schema accepts `any`.
 */
export interface AgentsJsCustomInput extends AguiBaseEventOptionals {
  name: string;
  value: unknown;
}

export function toAguiCustom(input: AgentsJsCustomInput): CustomEvent {
  return {
    type: EventType.CUSTOM,
    name: input.name,
    value: input.value,
    ...pickAguiBaseOptionals(input),
  };
}
