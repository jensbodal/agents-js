import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface DocsEntry {
  path: string;
  anchor: string;
}

describe("build-docs-index output", () => {
  it("produces no duplicate (path, anchor) pairs within the same file", () => {
    const out = join(import.meta.dir, "..", "docs", "public", "docs-index.json");
    if (!existsSync(out)) {
      // Skip if the corpus hasn't been built yet (e.g., fresh checkout). Run `bun run docs:index` first.
      console.warn("docs-index.json not found; skipping. Run `bun run docs:index` to generate.");
      return;
    }
    const corpus = JSON.parse(readFileSync(out, "utf8")) as { entries: DocsEntry[] };
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const e of corpus.entries) {
      const key = `${e.path}#${e.anchor}`;
      if (seen.has(key)) dups.push(key);
      seen.add(key);
    }
    expect(dups).toEqual([]);
  });
});
