import { describe, expect, test } from "bun:test";
import { routeFetchContext, scoreSnippet, scoreTool, tokenize } from "../src/router.ts";
import type { ToolDefinition } from "../src/types.ts";

describe("tokenize", () => {
  test("lowercases and splits on non-word chars", () => {
    expect(tokenize("Hello, World! ACP-host")).toEqual(["hello", "world", "acp", "host"]);
  });

  test("drops tokens shorter than 2 chars", () => {
    expect(tokenize("a b cd ef")).toEqual(["cd", "ef"]);
  });

  test("returns empty array for empty / whitespace input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("routeFetchContext", () => {
  test("returns explicit hint when caller provides one", () => {
    expect(routeFetchContext("whatever", "prefer-memories")).toBe("prefer-memories");
    expect(routeFetchContext("whatever", "prefer-docs")).toBe("prefer-docs");
    expect(routeFetchContext("whatever", "both")).toBe("both");
  });

  test("routes memory-biased queries to prefer-memories", () => {
    expect(routeFetchContext("what was the prior decision we remembered")).toBe("prefer-memories");
    expect(routeFetchContext("what rule was set last session")).toBe("prefer-memories");
  });

  test("routes docs-biased queries to prefer-docs", () => {
    expect(routeFetchContext("how to configure the gateway per the spec")).toBe("prefer-docs");
    expect(routeFetchContext("architecture guide from the docs root")).toBe("prefer-docs");
  });

  test("defaults to both when signals tie or are absent", () => {
    expect(routeFetchContext("tell me something useful")).toBe("both");
    expect(routeFetchContext("rule and spec both matter here")).toBe("both");
  });
});

describe("scoreTool", () => {
  const tool: ToolDefinition = {
    name: "searchDocs",
    description: "Search markdown documentation in the hub vault",
    keywords: ["docs", "search", "hub", "vault"],
    invoke: async () => ({}),
  };

  test("scores name token match (+3)", () => {
    // name appears in query as a whole token (lowercased)
    expect(scoreTool(tool, "please use searchdocs")).toBeGreaterThanOrEqual(3);
  });

  test("scores keyword hits (+2 each)", () => {
    const s = scoreTool(tool, "search hub vault");
    // three keyword hits + description overlap ("search", "hub", "vault" in desc)
    expect(s).toBeGreaterThanOrEqual(6);
  });

  test("scores description overlap (+1 each)", () => {
    // only description overlap, no keywords
    const bare: ToolDefinition = {
      name: "z",
      description: "alpha beta gamma",
      invoke: async () => ({}),
    };
    expect(scoreTool(bare, "alpha beta")).toBe(2);
  });

  test("returns 0 on empty query", () => {
    expect(scoreTool(tool, "")).toBe(0);
  });

  test("returns 0 on miss", () => {
    expect(scoreTool(tool, "completely unrelated xyz")).toBe(0);
  });
});

describe("scoreSnippet", () => {
  test("counts matching tokens", () => {
    expect(scoreSnippet("the quick brown fox", "quick fox")).toBe(2);
  });

  test("returns 0 on empty query", () => {
    expect(scoreSnippet("anything", "")).toBe(0);
  });

  test("is case-insensitive", () => {
    expect(scoreSnippet("Hello WORLD", "hello world")).toBe(2);
  });
});
