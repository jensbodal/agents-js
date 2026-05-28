#!/usr/bin/env bun
/**
 * Size-budget gate for the publishable bundles + apps/web-ui assets.
 *
 * Defaults:
 * - Display mode (no flags): measure + print every target.
 * - `--check` mode: enforce budgets; fail with exit 1 on over-budget.
 *
 * **Missing-artifact tolerance** (worktree contributor workflow):
 *
 * A fresh `git worktree add` has no `dist/` populated until the user
 * runs `bun run build` (or `bun run setup --ci`). Before this fix, the
 * script crashed with `ENOENT` from `readdirSync`/`readFile` before
 * any budget logic ran, regardless of mode — turning `mise run ci` on
 * a fresh worktree into an opaque trace instead of an actionable
 * "build first" hint.
 *
 * Now: missing artifacts produce a `skipped` result with the missing
 * path + an actionable hint. Display mode prints the skip line and
 * exits 0. `--check` mode prints a clear summary listing the skipped
 * targets + the suggested `bun run build` and exits 0 — release CI
 * (which builds before check) still measures every target; the only
 * thing this change does is convert a crash into a soft-skip for the
 * fresh-worktree contributor path.
 *
 * To enforce that artifacts MUST exist (for release CI pipelines or
 * pre-release gates), pass `--require-built`. With that flag, missing
 * artifacts fail with exit 1 and a list of paths that need to be
 * generated.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
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

interface MeasuredResult {
  readonly kind: "measured";
  budget: SizeBudget;
  gzipBytes: number;
  label: string;
  rawBytes: number;
  relativePath: string;
}

interface SkippedResult {
  readonly kind: "skipped";
  readonly label: string;
  readonly missingPath: string;
  readonly reason: string;
}

type SizeResult = MeasuredResult | SkippedResult;

const args = process.argv.slice(2);
const check = args.includes("--check");
const requireBuilt = args.includes("--require-built");
const unknownArgs = args.filter((arg) => arg !== "--check" && arg !== "--require-built");
if (unknownArgs.length > 0) {
  console.error(`[bundle-size] Unknown argument(s): ${unknownArgs.join(", ")}`);
  console.error("Usage: bun scripts/bundle-size.ts [--check] [--require-built]");
  process.exit(1);
}

class MissingArtifactError extends Error {
  readonly missingPath: string;
  constructor(missingPath: string) {
    super(`missing artifact: ${missingPath}`);
    this.name = "MissingArtifactError";
    this.missingPath = missingPath;
  }
}

function findLargestFile(dir: string, predicate: (name: string) => boolean): string {
  if (!existsSync(dir)) {
    throw new MissingArtifactError(path.relative(repoRoot, dir));
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  let largest: { path: string; size: number } | null = null;

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      try {
        const candidate = findLargestFile(entryPath, predicate);
        const size = statSync(candidate).size;
        if (!largest || size > largest.size) largest = { path: candidate, size };
      } catch (err) {
        if (err instanceof MissingArtifactError) continue;
        throw err;
      }
      continue;
    }

    if (!entry.isFile() || !predicate(entry.name)) continue;
    const size = statSync(entryPath).size;
    if (!largest || size > largest.size) largest = { path: entryPath, size };
  }

  if (!largest) {
    throw new MissingArtifactError(path.relative(repoRoot, dir));
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
    resolvePath: () => {
      const p = path.join(repoRoot, "extras/pi-extension/dist/extension.js");
      if (!existsSync(p)) throw new MissingArtifactError(path.relative(repoRoot, p));
      return p;
    },
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
    resolvePath: () => {
      const p = path.join(repoRoot, "packages/cli/dist/bin.mjs");
      if (!existsSync(p)) throw new MissingArtifactError(path.relative(repoRoot, p));
      return p;
    },
    budget: { rawBytes: 1_500, gzipBytes: 800 },
  },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

async function measure(target: SizeTarget): Promise<SizeResult> {
  let absolutePath: string;
  try {
    absolutePath = target.resolvePath();
  } catch (err) {
    if (err instanceof MissingArtifactError) {
      return {
        kind: "skipped",
        label: target.label,
        missingPath: err.missingPath,
        reason: "artifact not built (run `bun run build` to populate)",
      };
    }
    throw err;
  }
  const data = await readFile(absolutePath);
  return {
    kind: "measured",
    label: target.label,
    relativePath: path.relative(repoRoot, absolutePath),
    rawBytes: data.length,
    gzipBytes: gzipSync(data).length,
    budget: target.budget,
  };
}

function overBudget(result: MeasuredResult): string[] {
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
const measured = results.filter((r): r is MeasuredResult => r.kind === "measured");
const skipped = results.filter((r): r is SkippedResult => r.kind === "skipped");
const failures = measured.flatMap((result) => {
  const issues = overBudget(result);
  return issues.map((issue) => `${result.label}: ${issue} (${result.relativePath})`);
});

const labelWidth = Math.max(...results.map((result) => result.label.length));
for (const result of results) {
  if (result.kind === "measured") {
    console.log(
      `${result.label.padEnd(labelWidth)}  raw ${formatBytes(result.rawBytes).padStart(9)}  gzip ${formatBytes(result.gzipBytes).padStart(9)}  ${result.relativePath}`,
    );
  } else {
    console.log(
      `${result.label.padEnd(labelWidth)}  skipped — ${result.reason} (${result.missingPath})`,
    );
  }
}

if (skipped.length > 0 && requireBuilt) {
  console.error("\n[bundle-size] --require-built: missing artifacts:");
  for (const s of skipped) console.error(`- ${s.label}: ${s.missingPath}`);
  console.error("Run `bun run build` to generate them, then re-run.");
  process.exit(1);
}

if (check && failures.length > 0) {
  console.error("\n[bundle-size:check] Size budget exceeded:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

if (check) {
  if (skipped.length > 0) {
    console.log(
      `\n⚠ bundle-size:check: ${measured.length} artifact(s) within budget; ${skipped.length} skipped (not built). Run \`bun run build\` to enable full size check, or pass --require-built to enforce.`,
    );
  } else {
    console.log("\n✓ bundle-size:check: all tracked artifacts are within budget.");
  }
}
