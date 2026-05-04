/**
 * docs-structure.ts — Flatness gate for the 10-page hand-authored docs.
 *
 * Enforces:
 *  - Exactly 10 `.md` files at `docs/*.md` (hand-authored pages)
 *  - No stray `.md` files in subdirectories except `docs/api/` and `docs/adrs/`
 */

// TODO(docs-structure-stale): EXPECTED_PAGES below is drifted — current top
// level has 11 pages including beta-contract, playground, protocols-primer
// (added) while contribute and roadmap-and-non-goals (listed below) were
// removed. This script is not wired to `bun run check` or CI so the drift
// is invisible. Either update EXPECTED_PAGES and wire it as a gate, or
// delete the script. See backlog item docs-structure-rewire.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const DOCS_DIR = join(import.meta.dir, "..", "docs");

const EXPECTED_PAGES = [
  "index.md",
  "getting-started.md",
  "surfaces.md",
  "primitives.md",
  "harness-guide.md",
  "protocols.md",
  "streaming-and-events.md",
  "observability.md",
  "contribute.md",
  "roadmap-and-non-goals.md",
] as const;

const EXCLUDED_NAMESPACES = ["api", "adrs"];

function fail(msg: string): never {
  console.error(`✗ docs-structure: ${msg}`);
  process.exit(1);
}

// --- Collect top-level .md files ---
const topEntries = readdirSync(DOCS_DIR);
const topMdFiles = topEntries.filter(
  (e) => e.endsWith(".md") && statSync(join(DOCS_DIR, e)).isFile(),
);

// --- Check count ---
const expectedSet = new Set<string>(EXPECTED_PAGES);
const topSet = new Set(topMdFiles);

const missing = [...expectedSet].filter((f) => !topSet.has(f));
const extra = [...topSet].filter((f) => !expectedSet.has(f));

if (missing.length > 0 || extra.length > 0) {
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`Missing: ${missing.join(", ")}`);
  if (extra.length > 0) parts.push(`Extra: ${extra.join(", ")}`);
  fail(`expected exactly ${EXPECTED_PAGES.length} hand-authored pages.\n  ${parts.join("\n  ")}`);
}

if (topMdFiles.length !== EXPECTED_PAGES.length) {
  fail(`expected ${EXPECTED_PAGES.length} pages but found ${topMdFiles.length}`);
}

// --- Check for stray .md files in disallowed subdirectories ---
const strayMdFiles: string[] = [];

const glob = new Glob("**/*.md");
for await (const file of glob.scan({ cwd: DOCS_DIR })) {
  const topDir = file.split("/")[0];
  if (EXCLUDED_NAMESPACES.includes(topDir) || topDir === ".vitepress" || !file.includes("/")) {
    continue;
  }
  strayMdFiles.push(file);
}

if (strayMdFiles.length > 0) {
  fail(`stray .md files in disallowed subdirectories:\n  ${strayMdFiles.join("\n  ")}`);
}

console.log("✓ docs-structure: 10 hand-authored pages, no stray .md files");
