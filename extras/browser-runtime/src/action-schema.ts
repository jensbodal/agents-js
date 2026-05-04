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
