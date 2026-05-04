/**
 * fetchContext — Shape 1 coordinator.
 *
 * Picks memory primitives based on query-shape heuristics, runs them
 * (in parallel when routing to `"both"`), merges their FetchContextResult
 * outputs, and returns a ranked + cited top-N.
 *
 * `workspaceRoot` and `hubRoot` are the only inputs primitives need beyond
 * the query. Both are overridable for tests / non-default layouts.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { searchDocs } from "./primitives/search-docs.ts";
import { searchMemories } from "./primitives/search-memories.ts";
import { routeFetchContext } from "./router.ts";
import type {
  FetchContextHint,
  FetchContextOptions,
  FetchContextResult,
  Snippet,
  Source,
} from "./types.ts";

const DEFAULT_HUB_ROOT = join(homedir(), "workspace", "syncthing", "lifestone_ios", "hub");

/**
 * Grounded memory-recall coordinator (Shape 1).
 *
 * Picks memory primitives based on query-shape heuristics, runs them
 * (in parallel when the router picks `"both"`), merges their
 * `FetchContextResult` outputs, prunes orphan sources, and returns a
 * ranked top-N with full 5-field provenance on every source.
 *
 * Callers override `workspaceRoot` / `hubRoot` when running under test
 * fixtures; both default to the canonical local-dev layout.
 *
 * @param query - Free-text query string.
 * @param options - Optional routing hint, fixture roots, limit, and a
 * clock seam for deterministic test timestamps.
 * @returns Snippets ranked by keyword-score descending + a back-indexed
 * `sources` array with 5-field provenance per source.
 */
export async function fetchContext(
  query: string,
  options: FetchContextOptions = {},
): Promise<FetchContextResult> {
  const hint = routeFetchContext(query, options.hint);
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const hubRoot = options.hubRoot ?? DEFAULT_HUB_ROOT;
  const limit = options.limit ?? 10;
  const now = options.now;

  const results = await runPrimitives({ hint, query, workspaceRoot, hubRoot, now });
  return mergeResults(results, limit);
}

interface RunArgs {
  hint: FetchContextHint;
  query: string;
  workspaceRoot: string;
  hubRoot: string;
  now?: () => Date;
}

async function runPrimitives(args: RunArgs): Promise<FetchContextResult[]> {
  const memoriesP = () =>
    searchMemories({ workspaceRoot: args.workspaceRoot, query: args.query, now: args.now });
  const docsP = () => searchDocs({ hubRoot: args.hubRoot, query: args.query, now: args.now });

  switch (args.hint) {
    case "prefer-memories":
      return Promise.all([memoriesP(), docsP()]);
    case "prefer-docs":
      return Promise.all([docsP(), memoriesP()]);
    case "both":
      return Promise.all([memoriesP(), docsP()]);
  }
}

/**
 * Merge multiple primitive results, re-indexing snippets' `source_index` to
 * point at the merged sources array. Sort snippets by score desc and slice
 * to `limit`; prune unreferenced sources so consumers don't see orphans.
 */
function mergeResults(results: FetchContextResult[], limit: number): FetchContextResult {
  const snippets: Snippet[] = [];
  const sources: Source[] = [];

  for (const r of results) {
    const offset = sources.length;
    for (const s of r.sources) {
      sources.push(s);
    }
    for (const sn of r.snippets) {
      snippets.push({
        text: sn.text,
        source_index: sn.source_index + offset,
        score: sn.score,
      });
    }
  }

  snippets.sort((a, b) => b.score - a.score);
  const top = snippets.slice(0, limit);

  // Prune unreferenced sources + remap indices to keep the result compact.
  const usedIndices = new Set(top.map((s) => s.source_index));
  const indexMap = new Map<number, number>();
  const prunedSources: Source[] = [];
  for (let i = 0; i < sources.length; i += 1) {
    if (usedIndices.has(i)) {
      indexMap.set(i, prunedSources.length);
      const src = sources[i];
      if (src) prunedSources.push(src);
    }
  }
  const remapped = top.map((s) => ({
    text: s.text,
    source_index: indexMap.get(s.source_index) ?? 0,
    score: s.score,
  }));

  return { snippets: remapped, sources: prunedSources };
}
