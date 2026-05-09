export interface DocsEntry {
  path: string;
  title: string;
  anchor: string;
  heading: string;
  text: string;
}

export interface DocsCorpus {
  generatedAt: string;
  entries: DocsEntry[];
}

export interface DocsIndex {
  searchCorpus(args: { query: string; topK?: number }): Array<DocsEntry & { score: number }>;
  readCorpusSnippet(args: { path: string; anchor?: string }): DocsEntry | undefined;
}

function score(entry: DocsEntry, query: string): number {
  const q = query.toLowerCase();
  if (!q) return 0;
  let s = 0;
  if (entry.heading.toLowerCase().includes(q)) s += 5;
  if (entry.title.toLowerCase().includes(q)) s += 3;
  const occ = entry.text.toLowerCase().split(q).length - 1;
  s += occ;
  return s;
}

export function createDocsIndex(corpus: DocsCorpus): DocsIndex {
  return {
    searchCorpus({ query, topK = 5 }) {
      return corpus.entries
        .map((e) => ({ ...e, score: score(e, query) }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
    readCorpusSnippet({ path, anchor }) {
      return corpus.entries.find((e) => e.path === path && (!anchor || e.anchor === anchor));
    },
  };
}
