import { describe, expect, it } from "bun:test";
import { createToolRegistry, type LocalToolRegistry } from "./tool-registry.ts";

describe("createToolRegistry", () => {
  it("invokes the matching handler", async () => {
    const registry: LocalToolRegistry = createToolRegistry({
      searchDocs: async (args) => ({ hits: [String(args.query)] }),
      readCodeSnippet: async () => ({ snippet: "ok" }),
    });
    const result = await registry.invoke("searchDocs", { query: "acp" });
    expect(result).toEqual({ hits: ["acp"] });
  });

  it("rejects unknown tool name", async () => {
    const registry = createToolRegistry({
      searchDocs: async () => ({ hits: [] }),
      readCodeSnippet: async () => ({ snippet: "" }),
    });
    // biome-ignore lint/suspicious/noExplicitAny: testing rejection of unknown tool name at runtime
    await expect(registry.invoke("nope" as any, {})).rejects.toThrow(/unknown tool/i);
  });

  it("propagates handler errors", async () => {
    const registry = createToolRegistry({
      searchDocs: async () => {
        throw new Error("indexed-out");
      },
      readCodeSnippet: async () => ({ snippet: "" }),
    });
    await expect(registry.invoke("searchDocs", {})).rejects.toThrow("indexed-out");
  });
});
