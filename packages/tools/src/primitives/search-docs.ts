/**
 * searchDocs — grep-based search across the hub vault.
 *
 * "Hub vault" = the canonical docs root at
 * `/Users/jensbodal/workspace/syncthing/lifestone_ios/hub/`. Tests point
 * `hubRoot` at a fixture directory instead; no path is hardcoded inside
 * the primitive.
 *
 * We walk the tree, read every `*.md` file, score per-line, and return
 * the top-N matching snippets with full provenance.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { scoreSnippet } from "../router.ts";
import type { FetchContextResult, Snippet, Source } from "../types.ts";

export interface SearchDocsOptions {
  hubRoot: string;
  query: string;
  limit?: number;
  now?: () => Date;
}

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  ".obsidian",
  ".trash",
  "dist",
  "out",
  "_attachments",
]);

async function collectDocFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files);
  return files;
}

async function walk(dir: string, acc: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR_NAMES.has(name)) continue;
    const full = join(dir, name);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walk(full, acc);
    } else if (s.isFile() && name.endsWith(".md")) {
      acc.push(full);
    }
  }
}

function extractBestSnippet(text: string, query: string): { text: string; score: number } | null {
  const lines = text.split("\n");
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const score = scoreSnippet(lines[i] ?? "", query);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) {
    return null;
  }
  const start = Math.max(0, bestIdx - 1);
  const end = Math.min(lines.length, bestIdx + 2);
  return { text: lines.slice(start, end).join("\n"), score: bestScore };
}

/**
 * Grep-style search across markdown files under the given hub-vault root,
 * returning the best-matching line range from each file.
 *
 * Skips `node_modules`, `.git`, `.obsidian`, `.trash`, `dist`, `out`, and
 * `_attachments` directories. Every returned source is
 * `source_type: "hub-file"` with `confidence: "responsible"` — the hub
 * vault is authoritative for whatever docs live there.
 *
 * @param opts - Hub root + query + optional limit and clock seam.
 * @returns A {@link FetchContextResult} with snippets sorted by score.
 */
export async function searchDocs(opts: SearchDocsOptions): Promise<FetchContextResult> {
  const now = opts.now ?? (() => new Date());
  const limit = opts.limit ?? 10;
  const retrieved_at = now().toISOString();

  const files = await collectDocFiles(opts.hubRoot);
  const snippets: Snippet[] = [];
  const sources: Source[] = [];

  for (const path of files) {
    let contents: string;
    let mtime: Date;
    try {
      const [text, s] = await Promise.all([readFile(path, "utf8"), stat(path)]);
      contents = text;
      mtime = s.mtime;
    } catch {
      continue;
    }

    const match = extractBestSnippet(contents, opts.query);
    if (!match) continue;

    const source_index = sources.length;
    sources.push({
      source_type: "hub-file",
      source_ref: path,
      observed_at: mtime.toISOString(),
      retrieved_at,
      confidence: "responsible",
    });
    snippets.push({ text: match.text, source_index, score: match.score });
  }

  snippets.sort((a, b) => b.score - a.score);
  return { snippets: snippets.slice(0, limit), sources };
}
