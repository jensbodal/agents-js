import { describe, expect, it } from "bun:test";
import { ACTION_SCHEMA, type Action } from "./action-schema.ts";

describe("ACTION_SCHEMA", () => {
  it("declares 2020-12 dialect", () => {
    expect(ACTION_SCHEMA.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("requires kind discriminator", () => {
    expect(ACTION_SCHEMA.required).toContain("kind");
  });

  it("each oneOf variant forbids additional properties", () => {
    for (const variant of ACTION_SCHEMA.oneOf) {
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("limits tool enum to the v1 tool surface", () => {
    const toolVariant = ACTION_SCHEMA.oneOf.find(
      // biome-ignore lint/suspicious/noExplicitAny: schema literal access pattern
      (v: any) => v.properties?.kind?.const === "tool",
      // biome-ignore lint/suspicious/noExplicitAny: schema literal access pattern
    ) as any;
    expect(toolVariant.properties.tool.enum).toEqual(["searchDocs", "readCodeSnippet"]);
  });

  it("type Action covers the four kinds", () => {
    const a: Action = { kind: "answer", answerDraft: "hi" };
    const b: Action = { kind: "tool", tool: "searchDocs", args: { query: "q" } };
    const c: Action = { kind: "clarify", clarifyPrompt: "what?" };
    const d: Action = { kind: "error", errorMessage: "boom" };
    expect([a.kind, b.kind, c.kind, d.kind]).toEqual(["answer", "tool", "clarify", "error"]);
  });

  it("rejects cross-variant payload keys (e.g., tool field on an answer)", () => {
    // The TS type already forbids this, but the runtime schema must reject too.
    // We check structurally: each oneOf variant only declares its own keys.
    const answerVariant = ACTION_SCHEMA.oneOf.find(
      // biome-ignore lint/suspicious/noExplicitAny: schema literal access pattern
      (v: any) => v.properties?.kind?.const === "answer",
      // biome-ignore lint/suspicious/noExplicitAny: schema literal access pattern
    ) as any;
    expect(Object.keys(answerVariant.properties)).toEqual(["kind", "answerDraft", "confidence"]);
    // tool and args must NOT be properties of the answer variant.
    expect(answerVariant.properties.tool).toBeUndefined();
    expect(answerVariant.properties.args).toBeUndefined();
  });

  it("each variant declares its kind via const, not enum", () => {
    for (const variant of ACTION_SCHEMA.oneOf) {
      // biome-ignore lint/suspicious/noExplicitAny: schema literal access pattern
      const kindProp = (variant as any).properties.kind;
      expect(typeof kindProp.const).toBe("string");
      expect(["answer", "tool", "clarify", "error"]).toContain(kindProp.const);
    }
  });

  it("oneOf has exactly four variants", () => {
    expect(ACTION_SCHEMA.oneOf.length).toBe(4);
  });
});
