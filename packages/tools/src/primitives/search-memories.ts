/**
 * searchMemories — read agent memory files under `.agents/<name>/`.
 *
 * "Memory" here = markdown files under any `.agents/<agent-name>/` directory
 * in the given `workspaceRoot`. We walk one level deep: each immediate
 * subdirectory of `.agents/` is treated as an agent, and every `*.md` file
 * inside (recursively) is a candidate source.
 *
 * Returns snippets + provenance per the canonical 5-field Source schema.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { scoreSnippet } from "../router.ts";
import type { FetchContextResult, Snippet, Source } from "../types.ts";

export interface SearchMemoriesOptions {
  workspaceRoot: string;
  query: string;
  limit?: number;
  now?: () => Date;
}

/**
 * Return every markdown path reachable under `.agents/*\/` in the
 * workspace. Unreadable or missing roots yield an empty list.
 */
async function collectMemoryFiles(workspaceRoot: string): Promise<string[]> {
  const agentsDir = join(workspaceRoot, ".agents");
  const files: string[] = [];

  let agentDirs: string[];
  try {
    agentDirs = await readdir(agentsDir);
  } catch {
    return files;
  }

  for (const name of agentDirs) {
    const candidate = join(agentsDir, name);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(candidate);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    await walkForMarkdown(candidate, files);
  }

  return files;
}

async function walkForMarkdown(dir: string, acc: string[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      await walkForMarkdown(full, acc);
    } else if (s.isFile() && name.endsWith(".md")) {
      acc.push(full);
    }
  }
}

/**
 * Pick the best matching line range for a query inside a file's text.
 * Returns a single-snippet slice with +/- 1 line of context.
 */
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
  const excerpt = lines.slice(start, end).join("\n");
  return { text: excerpt, score: bestScore };
}

/**
 * Search markdown memory files under `.agents/<name>/` inside the given
 * workspace root and return the best-matching line range from each file.
 *
 * Every returned source is `source_type: "hub-file"` with
 * `confidence: "responsible"` — agent memory files are treated as the
 * canonical source of truth for whatever the user wrote there.
 *
 * @param opts - Workspace root + query + optional limit and clock seam.
 * @returns A {@link FetchContextResult} with snippets sorted by score.
 */
export async function searchMemories(opts: SearchMemoriesOptions): Promise<FetchContextResult> {
  const now = opts.now ?? (() => new Date());
  const limit = opts.limit ?? 10;
  const retrieved_at = now().toISOString();

  const files = await collectMemoryFiles(opts.workspaceRoot);
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
