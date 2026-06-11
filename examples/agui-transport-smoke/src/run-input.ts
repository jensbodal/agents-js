/**
 * Build a minimal valid `RunAgentInput` for `POST /agent`.
 *
 * The endpoint validates the body with the AG-UI core schema before
 * acquiring the run slot, so every field the schema requires must be
 * present — a malformed body would 400 before ever reaching the
 * single-active-run gate this smoke exercises.
 */
import type { RunAgentInput } from "@agents-js/agui-types";

export function buildRunAgentInput(
  text: string,
  overrides: Partial<RunAgentInput> = {},
): RunAgentInput {
  return {
    threadId: "smoke-thread",
    runId: crypto.randomUUID(),
    state: {},
    messages: [{ id: crypto.randomUUID(), role: "user", content: text }],
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  } as RunAgentInput;
}
