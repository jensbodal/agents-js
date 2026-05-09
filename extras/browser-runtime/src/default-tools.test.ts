import { describe, expect, it } from "bun:test";
import { createDefaultTools } from "./default-tools.ts";
import type { DocsCorpus } from "./docs-index.ts";

const corpus: DocsCorpus = {
  generatedAt: "2026-04-26T00:00:00Z",
  entries: [
    {
      path: "primitives.md",
      title: "P",
      anchor: "tools",
      heading: "Tools",
      text: "Tools are primitives.",
    },
  ],
};

describe("createDefaultTools", () => {
  it("searchDocs returns hits", async () => {
    const tools = createDefaultTools(corpus);
    const result = (await tools.searchDocs({ query: "tools" })) as { hits: unknown[] };
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it("readCodeSnippet returns the entry", async () => {
    const tools = createDefaultTools(corpus);
    const result = (await tools.readCodeSnippet({ path: "primitives.md", anchor: "tools" })) as {
      heading: string;
    };
    expect(result.heading).toBe("Tools");
  });

  it("readCodeSnippet returns null for missing entry", async () => {
    const tools = createDefaultTools(corpus);
    const result = await tools.readCodeSnippet({ path: "missing.md" });
    expect(result).toBeNull();
  });
});
