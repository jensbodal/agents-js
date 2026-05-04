import type { BaseEvent, RunAgentInput } from "@agents-js/agui-types";
import { EventSchemas, RunAgentInputSchema } from "@agents-js/agui-types";
import { ValidationError } from "./errors.ts";
import type { ValidationResult } from "./result.ts";
import { zodIssuesToValidationIssues } from "./zod-utils.ts";

/**
 * Validate an AG-UI event against the canonical `EventSchemas`
 * discriminated union published by `@ag-ui/core`.
 */
export function validateAguiEvent(event: unknown): ValidationResult<BaseEvent> {
  const parsed = EventSchemas.safeParse(event);
  if (parsed.success) {
    return { valid: true, value: parsed.data as BaseEvent };
  }

  const issues = zodIssuesToValidationIssues(parsed.error);
  return {
    valid: false,
    error: new ValidationError("Invalid AG-UI event", {
      field: issues[0]?.path ?? "type",
      value: event,
      issues,
    }),
  };
}

/**
 * Type guard form of {@link validateAguiEvent}. Useful for narrowing
 * `unknown` values inside stream handlers without allocating a result
 * object.
 */
export function isAguiEvent(event: unknown): event is BaseEvent {
  return EventSchemas.safeParse(event).success;
}

/**
 * Validate a `RunAgentInput` envelope — the payload AG-UI agents accept
 * as their run entrypoint. Wraps `RunAgentInputSchema.safeParse`.
 */
export function validateRunAgentInput(input: unknown): ValidationResult<RunAgentInput> {
  const parsed = RunAgentInputSchema.safeParse(input);
  if (parsed.success) {
    return { valid: true, value: parsed.data as RunAgentInput };
  }

  const issues = zodIssuesToValidationIssues(parsed.error);
  return {
    valid: false,
    error: new ValidationError("Invalid AG-UI RunAgentInput", {
      field: issues[0]?.path ?? "input",
      value: input,
      issues,
    }),
  };
}
