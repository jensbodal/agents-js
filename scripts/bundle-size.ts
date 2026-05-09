#!/usr/bin/env bun
import { readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { repoRoot } from "./workspace-config.ts";

interface SizeBudget {
  gzipBytes?: number;
  rawBytes: number;
}

interface SizeTarget {
  budget: SizeBudget;
  label: string;
  resolvePath: () => string;
}

interface SizeResult {
  budget: SizeBudget;
  gzipBytes: number;
  label: string;
  rawBytes: number;
  relativePath: string;
}

const check = process.argv.includes("--check");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--check");
if (unknownArgs.length > 0) {
  console.error(`[bundle-size] Unknown argument(s): ${unknownArgs.join(", ")}`);
  console.error("Usage: bun scripts/bundle-size.ts [--check]");
  process.exit(1);
}

function findLargestFile(dir: string, predicate: (name: string) => boolean): string {
  const entries = readdirSync(dir, { withFileTypes: true });
  let largest: { path: string; size: number } | null = null;

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const candidate = findLargestFile(entryPath, predicate);
      const size = statSync(candidate).size;
      if (!largest || size > largest.size) largest = { path: candidate, size };
      continue;
    }

    if (!entry.isFile() || !predicate(entry.name)) continue;
    const size = statSync(entryPath).size;
    if (!largest || size > largest.size) largest = { path: entryPath, size };
  }

  if (!largest) {
    throw new Error(`No matching files found under ${path.relative(repoRoot, dir)}`);
  }
  return largest.path;
}

const targets: SizeTarget[] = [
  {
    label: "web-ui largest JS asset",
    resolvePath: () =>
      findLargestFile(path.join(repoRoot, "apps/web-ui/dist/assets"), (name) =>
        name.endsWith(".js"),
      ),
    budget: { rawBytes: 660_000, gzipBytes: 165_000 },
  },
  {
    label: "pi-extension bundle",
    resolvePath: () => path.join(repoRoot, "extras/pi-extension/dist/extension.js"),
    budget: { rawBytes: 720_000, gzipBytes: 180_000 },
  },
  {
    label: "validation largest JS chunk",
    resolvePath: () =>
      findLargestFile(path.join(repoRoot, "packages/validation/dist"), (name) =>
        name.endsWith(".mjs"),
      ),
    budget: { rawBytes: 1_150_000, gzipBytes: 130_000 },
  },
  {
    label: "cli npm bin wrapper",
    resolvePath: () => path.join(repoRoot, "packages/cli/dist/bin.mjs"),
    budget: { rawBytes: 1_500, gzipBytes: 800 },
  },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function measure(target: SizeTarget): Promise<SizeResult> {
  const absolutePath = target.resolvePath();
  const data = await readFile(absolutePath);
  return {
    label: target.label,
    relativePath: path.relative(repoRoot, absolutePath),
    rawBytes: data.length,
    gzipBytes: gzipSync(data).length,
    budget: target.budget,
  };
}

function overBudget(result: SizeResult): string[] {
  const failures: string[] = [];
  if (result.rawBytes > result.budget.rawBytes) {
    failures.push(`raw ${formatBytes(result.rawBytes)} > ${formatBytes(result.budget.rawBytes)}`);
  }
  if (result.budget.gzipBytes !== undefined && result.gzipBytes > result.budget.gzipBytes) {
    failures.push(
      `gzip ${formatBytes(result.gzipBytes)} > ${formatBytes(result.budget.gzipBytes)}`,
    );
  }
  return failures;
}

const results = await Promise.all(targets.map(measure));
const failures = results.flatMap((result) => {
  const issues = overBudget(result);
  return issues.map((issue) => `${result.label}: ${issue} (${result.relativePath})`);
});

const labelWidth = Math.max(...results.map((result) => result.label.length));
for (const result of results) {
  console.log(
    `${result.label.padEnd(labelWidth)}  raw ${formatBytes(result.rawBytes).padStart(9)}  gzip ${formatBytes(result.gzipBytes).padStart(9)}  ${result.relativePath}`,
  );
}

if (check && failures.length > 0) {
  console.error("\n[bundle-size:check] Size budget exceeded:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (check) {
  console.log("\n✓ bundle-size:check: all tracked artifacts are within budget.");
}
