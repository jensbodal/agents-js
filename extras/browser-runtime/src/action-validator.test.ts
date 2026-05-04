import { describe, expect, it } from "bun:test";
import { coerceAction, validateAction } from "./action-validator.ts";

describe("validateAction", () => {
  it("accepts a well-formed answer", () => {
    const result = validateAction({ kind: "answer", answerDraft: "hello" });
    expect(result.valid).toBe(true);
    expect(result.data?.kind).toBe("answer");
  });

  it("accepts a well-formed tool call", () => {
    const result = validateAction({ kind: "tool", tool: "searchDocs", args: { query: "acp" } });
    expect(result.valid).toBe(true);
  });

  it("rejects unknown tool name", () => {
    const result = validateAction({ kind: "tool", tool: "rm-rf", args: {} });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects answer without answerDraft", () => {
    const result = validateAction({ kind: "answer" });
    expect(result.valid).toBe(false);
  });

  it("rejects cross-variant payload (answer with tool field)", () => {
    // This is the runtime correctness test for the oneOf restructuring.
    const result = validateAction({
      kind: "answer",
      answerDraft: "x",
      tool: "searchDocs",
      args: {},
    });
    expect(result.valid).toBe(false);
  });

  it("rejects additionalProperties on the answer variant", () => {
    const result = validateAction({ kind: "answer", answerDraft: "x", evil: true });
    expect(result.valid).toBe(false);
  });
});

describe("coerceAction", () => {
  it("strips a markdown JSON fence", () => {
    const raw = '```json\n{"kind":"answer","answerDraft":"hi"}\n```';
    const coerced = coerceAction(raw);
    expect(coerced.valid).toBe(true);
    expect(coerced.data?.kind).toBe("answer");
  });

  it("strips leading prose before the JSON", () => {
    const raw = 'Sure, here is the answer:\n{"kind":"answer","answerDraft":"hi"}';
    const coerced = coerceAction(raw);
    expect(coerced.valid).toBe(true);
  });

  it("returns valid=false on unparseable input", () => {
    const coerced = coerceAction("not json at all");
    expect(coerced.valid).toBe(false);
    expect(coerced.errors[0]?.path).toBe("$");
  });
});
