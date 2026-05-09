import { describe, expect, it } from "bun:test";
import { createDocsIndex, type DocsCorpus } from "./docs-index.ts";

const fixture: DocsCorpus = {
  generatedAt: "2026-04-26T00:00:00Z",
  entries: [
    {
      path: "primitives.md",
      title: "Primitives",
      anchor: "tools",
      heading: "Tools",
      text: "Tools are agent-callable primitives in agents-js.",
    },
    {
      path: "protocols.md",
      title: "Protocols",
      anchor: "acp",
      heading: "ACP",
      text: "ACP is the Agent Client Protocol over JSON-RPC.",
    },
  ],
};

describe("createDocsIndex", () => {
  it("returns matches sorted by score for searchCorpus", () => {
    const idx = createDocsIndex(fixture);
    const hits = idx.searchCorpus({ query: "acp", topK: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.path).toBe("protocols.md");
  });

  it("returns empty hits for an unmatched query", () => {
    const idx = createDocsIndex(fixture);
    expect(idx.searchCorpus({ query: "xyznotapresent" })).toEqual([]);
  });

  it("readCorpusSnippet returns the matching entry by path+anchor", () => {
    const idx = createDocsIndex(fixture);
    const entry = idx.readCorpusSnippet({ path: "protocols.md", anchor: "acp" });
    expect(entry?.heading).toBe("ACP");
  });

  it("readCorpusSnippet returns undefined when the entry is missing", () => {
    const idx = createDocsIndex(fixture);
    expect(idx.readCorpusSnippet({ path: "nope.md" })).toBeUndefined();
  });
});
