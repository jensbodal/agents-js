export type Action =
  | { kind: "answer"; answerDraft: string; confidence?: number }
  | {
      kind: "tool";
      tool: "searchDocs" | "readCodeSnippet";
      args: Record<string, unknown>;
      confidence?: number;
    }
  | { kind: "clarify"; clarifyPrompt: string }
  | { kind: "error"; errorMessage: string };

/**
 * Loop-synthesized history entry recording what a previously invoked tool
 * returned. This is NOT part of the model-emitted `Action` union — the schema
 * the model is constrained against keeps its four oneOf branches — but the
 * meta-agent loop pushes one of these into `prior` after each successful (or
 * failed) tool invocation so the next `decideAction` / `streamAnswer` call has
 * the actual tool result to ground its answer on.
 *
 * `truncated` is set by the loop's truncation pass when the result body was
 * clipped to fit a prompt budget; the adapter renders a `[... truncated]`
 * marker in the user-message context so the model knows the body is not
 * verbatim.
 */
export type ToolResultEntry = {
  kind: "tool-result";
  tool: "searchDocs" | "readCodeSnippet";
  args: Record<string, unknown>;
  result: unknown;
  truncated?: boolean;
};

/**
 * Element type of `prior` as the meta-agent loop assembles it. Widens
 * `Action[]` to also include `ToolResultEntry` so successive iterations
 * see both the calls and their results. The schema-validated `Action` union
 * stays unchanged — `ToolResultEntry` is loop-only, never model-emitted.
 */
export type PriorEntry = Action | ToolResultEntry;

export const ACTION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["kind"],
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "answerDraft"],
      properties: {
        kind: { const: "answer" },
        answerDraft: { type: "string", maxLength: 4000 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "tool", "args"],
      properties: {
        kind: { const: "tool" },
        tool: { type: "string", enum: ["searchDocs", "readCodeSnippet"] },
        args: { type: "object", maxProperties: 8 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "clarifyPrompt"],
      properties: {
        kind: { const: "clarify" },
        clarifyPrompt: { type: "string", maxLength: 1000 },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["kind", "errorMessage"],
      properties: {
        kind: { const: "error" },
        errorMessage: { type: "string", maxLength: 500 },
      },
    },
  ],
} as const;
