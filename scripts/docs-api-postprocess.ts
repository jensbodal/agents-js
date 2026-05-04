#!/usr/bin/env bun

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const apiRoot = path.join(repoRoot, "docs/api");
const sidebarPath = path.join(apiRoot, "typedoc-sidebar.json");
const apiIndexPath = path.join(apiRoot, "index.md");

async function rewriteFile(
  filePath: string,
  transform: (content: string) => string,
): Promise<void> {
  const original = await readFile(filePath, "utf8");
  const updated = transform(original);
  if (updated !== original) {
    await writeFile(filePath, updated, "utf8");
  }
}

// Typedoc's "Defined in:" line is rendered relative to the inferred project
// root, which varies with CWD and which sibling repos/node_modules trees are
// reachable. Examples we've seen emitted: `packages/foo/...`,
// `agents-js/packages/foo/...`, `node_modules/.bun/@lit+...`, and
// `obsidian-acp-plugin/node_modules/.bun/@lit+...`. Strip any prefix before the
// first `packages/` or `node_modules/` segment so committed output is
// CWD-independent and resilient to sibling-project resolution.
function stripDefinedInPrefix(content: string): string {
  // Typedoc's markdown plugin escapes underscores as `\_`, so match both
  // `node_modules` and `node\_modules` forms. Same for `packages` (safe).
  const stripped = content.replace(
    /^(Defined in: )(?:[^\s`]*?\/)?(packages\/|node\\?_modules\/)/gm,
    (_match, prefix, anchor) => `${prefix}${anchor}`,
  );
  // Bun's install layout sometimes resolves through its intermediate symlinks
  // (`node_modules/.bun/<pkg>@<ver>/node_modules/<scope>/...`) and sometimes
  // directly (`node_modules/<scope>/...`). CI and local disk can disagree.
  // Collapse the intermediate form to the direct form so committed docs match
  // CI's generation either way.
  return stripped.replace(
    /(node\\?_modules)\/\.bun\/[^/\s]+\/node\\?_modules\//g,
    (_match, nodeModules) => `${nodeModules}/`,
  );
}

async function walkMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkMarkdown(fullPath);
      if (entry.isFile() && entry.name.endsWith(".md")) return [fullPath];
      return [];
    }),
  );
  return results.flat();
}

async function main(): Promise<void> {
  await rewriteFile(sidebarPath, (content) => content.replaceAll('"/docs/api/', '"/api/'));
  await rewriteFile(apiIndexPath, (content) =>
    content.replace(/^# @agents-js\/root$/m, "# API Reference"),
  );
  const markdownFiles = await walkMarkdown(apiRoot);
  await Promise.all(markdownFiles.map((file) => rewriteFile(file, stripDefinedInPrefix)));
}

await main();
