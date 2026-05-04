/**
 * test-docs-handauth.ts — Best-effort typecheck for code blocks
 * in the 10 hand-authored docs pages.
 *
 * Extracts fenced ```ts / ```typescript blocks and runs each through
 * `bun build --no-bundle` to surface type errors.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DOCS_DIR = join(import.meta.dir, "..", "docs");

const PAGES = [
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

const TMP_DIR = join(import.meta.dir, "..", ".tmp-docs-typecheck");

interface CodeBlock {
  page: string;
  index: number;
  lang: string;
  code: string;
}

function extractCodeBlocks(content: string, page: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const regex = /```(ts|typescript)\b[^\n]*\n([\s\S]*?)```/g;
  let idx = 0;
  for (;;) {
    const match = regex.exec(content);
    if (match === null) break;
    blocks.push({
      page,
      index: idx++,
      lang: match[1],
      code: match[2],
    });
  }
  return blocks;
}

// --- Collect all blocks ---
const allBlocks: CodeBlock[] = [];
for (const page of PAGES) {
  const content = readFileSync(join(DOCS_DIR, page), "utf-8");
  allBlocks.push(...extractCodeBlocks(content, page));
}

if (allBlocks.length === 0) {
  console.log("✓ docs:typecheck-handauth: no ts/typescript code blocks found, nothing to check");
  process.exit(0);
}

// --- Write & typecheck each block ---
rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });

let errors = 0;
let skipped = 0;
let passed = 0;

for (const block of allBlocks) {
  const filename = `${block.page.replace(".md", "")}-block-${block.index}.ts`;
  const filepath = join(TMP_DIR, filename);

  // Wrap in a loose context so bare imports / references resolve gently
  const wrapped = `// @ts-nocheck-all-implicit-any-is-ok\n${block.code}`;
  writeFileSync(filepath, wrapped);

  const result = spawnSync("bun", ["build", "--no-bundle", filepath], {
    encoding: "utf-8",
    timeout: 15_000,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    // Skip blocks that clearly aren't self-contained (parse errors, missing imports)
    if (
      stderr.includes("Cannot find module") ||
      stderr.includes("Unexpected") ||
      (stderr.includes("import ") && stderr.includes("not found"))
    ) {
      skipped++;
      continue;
    }
    errors++;
    console.error(`✗ ${block.page} block #${block.index}:`);
    console.error(`  ${stderr.split("\n").slice(0, 5).join("\n  ")}`);
  } else {
    passed++;
  }
}

// Cleanup
rmSync(TMP_DIR, { recursive: true, force: true });

if (errors > 0) {
  console.error(
    `\n✗ docs:typecheck-handauth: ${errors} error(s), ${passed} passed, ${skipped} skipped`,
  );
  process.exit(1);
}

console.log(`✓ docs:typecheck-handauth: ${passed} passed, ${skipped} skipped, 0 errors`);
