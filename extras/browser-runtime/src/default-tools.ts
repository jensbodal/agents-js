import { createDocsIndex, type DocsCorpus } from "./docs-index.ts";

export interface DefaultToolHandlers {
  searchDocs: (args: Record<string, unknown>) => Promise<unknown>;
  readCodeSnippet: (args: Record<string, unknown>) => Promise<unknown>;
}

export function createDefaultTools(corpus: DocsCorpus): DefaultToolHandlers {
  const index = createDocsIndex(corpus);
  return {
    async searchDocs(args) {
      const query = String(args.query ?? "");
      const topK = typeof args.topK === "number" ? args.topK : 5;
      const hits = index.searchCorpus({ query, topK });
      return { hits };
    },
    async readCodeSnippet(args) {
      const path = String(args.path ?? "");
      const anchor = typeof args.anchor === "string" ? args.anchor : undefined;
      const entry = index.readCorpusSnippet({ path, anchor });
      return entry ?? null;
    },
  };
}
