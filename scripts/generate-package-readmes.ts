/**
 * Generate per-package README.md from package.json metadata and JSDoc comments.
 *
 * Usage: bun scripts/generate-package-readmes.ts [--check]
 *
 * - Skips packages with `"private": true`
 * - Skips any existing README that contains the hand-maintained sentinel
 *   `<!-- This README is hand-maintained. -->`
 * - Extracts JSDoc summaries from all .ts files in each package's src/
 * - Splices optional `.readme-note.md` content between API and License sections
 * - Idempotent: running twice produces identical output
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectTsFiles, type PkgJson, readJson } from "./lib/package-introspection.ts";

// ---------------------------------------------------------------------------
// JSDoc + export extraction (regex-based, README-only)
// ---------------------------------------------------------------------------
// This regex parser is the README generator's local export-discovery
// path. It used to live alongside the docs-reference partial extractors
// in `scripts/lib/package-introspection.ts`, but those partial extractors
// have all migrated to ts-morph. Keeping the regex parser here scoped to
// its only consumer keeps the wrapper module pure ts-morph and removes
// the boundary-gate special-casing the parallel parser used to need.

interface ExportEntry {
  name: string;
  jsdoc: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "other";
  /** Source path the export was discovered in (used for tiebreaking). */
  sourcePath: string;
}

function extractExportsFromFile(filePath: string): ExportEntry[] {
  const source = readFileSync(filePath, "utf-8");
  const lines = source.split("\n");
  const entries: ExportEntry[] = [];

  let pendingJsdoc = "";
  let inJsdoc = false;

  for (const [i, line] of lines.entries()) {
    if (line.trimStart().startsWith("/**")) {
      inJsdoc = true;
      const content = line.trim().replace(/^\/\*\*\s?/, "");
      if (line.includes("*/")) {
        inJsdoc = false;
        pendingJsdoc = content.replace(/\s*\*\//, "").trim();
      } else {
        pendingJsdoc = content;
      }
      continue;
    }
    if (inJsdoc) {
      pendingJsdoc +=
        " " +
        line
          .trim()
          .replace(/^\*\s?/, "")
          .replace(/\*\//, "")
          .trim();
      if (line.includes("*/")) {
        inJsdoc = false;
        pendingJsdoc = pendingJsdoc.trim();
      }
      continue;
    }

    if (line.trimStart().startsWith("//") || line.trim() === "") {
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("export ")) {
      const { names, kind } = parseExportLine(trimmed, lines, i);
      const isInternal = /\B@internal\b/.test(pendingJsdoc);
      const jsdocSummary = pendingJsdoc ? cleanJsdocSummary(pendingJsdoc) : "";
      if (!isInternal) {
        for (const name of names) {
          entries.push({ name, jsdoc: jsdocSummary, kind, sourcePath: filePath });
        }
      }
      pendingJsdoc = "";
    } else {
      pendingJsdoc = "";
    }
  }

  return entries;
}

function parseExportLine(
  line: string,
  _lines: string[],
  _lineIdx: number,
): { names: string[]; kind: ExportEntry["kind"] } {
  const rest = line.slice("export ".length);

  const reexportMatch = rest.match(/^\{([^}]+)\}/);
  if (reexportMatch) {
    const names = reexportMatch[1]
      ?.split(",")
      .map((s) =>
        s
          .trim()
          .replace(/\s+as\s+\w+/, "")
          .split(" as ")[0]
          ?.trim(),
      )
      .filter(Boolean);
    return { names, kind: "other" };
  }

  if (rest.startsWith("type ")) {
    const inner = rest.slice("type ".length);
    const typeReexport = inner.match(/^\{([^}]+)\}/);
    if (typeReexport) {
      const names = typeReexport[1]
        ?.split(",")
        .map((s) => s.trim().split(" as ")[0]?.trim())
        .filter(Boolean);
      return { names, kind: "type" };
    }
    const typeName = inner.match(/^(\w+)/);
    if (typeName?.[1]) return { names: [typeName[1]], kind: "type" };
  }

  if (rest.startsWith("interface ")) {
    const name = rest.slice("interface ".length).match(/^(\w+)/);
    if (name?.[1]) return { names: [name[1]], kind: "interface" };
  }

  if (rest.startsWith("class ")) {
    const name = rest.slice("class ".length).match(/^(\w+)/);
    if (name?.[1]) return { names: [name[1]], kind: "class" };
  }

  const funcMatch = rest.match(/^(?:async\s+)?function\s+(\w+)/);
  if (funcMatch?.[1]) return { names: [funcMatch[1]], kind: "function" };

  const varMatch = rest.match(/^(?:const|let|var)\s+(\w+)/);
  if (varMatch?.[1]) return { names: [varMatch[1]], kind: "const" };

  const fallback = rest.match(/^(\w+)/);
  if (fallback?.[1]) {
    const word = fallback[1];
    if (
      word !== "type" &&
      word !== "interface" &&
      word !== "class" &&
      word !== "function" &&
      word !== "const" &&
      word !== "let" &&
      word !== "var" &&
      word !== "async" &&
      word !== "default"
    ) {
      return { names: [word], kind: "other" };
    }
  }

  return { names: [], kind: "other" };
}

function cleanJsdocSummary(raw: string): string {
  let cleaned = raw
    .replace(/@param\s+\S+\s*/g, "")
    .replace(/@returns?\s*/g, "")
    .replace(/@example\s*/g, "")
    .replace(/@deprecated\s*/g, "")
    .replace(/@throws\s*/g, "")
    .replace(/@see\s*/g, "")
    .replace(/@internal\s*/g, "")
    .replace(/@\w+\s*/g, "")
    .replace(/\s*\/\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > 200) {
    cleaned = `${cleaned.slice(0, 197)}...`;
  }

  return cleaned;
}

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES_DIR = join(ROOT, "packages");

// ---------------------------------------------------------------------------
// README generation
// ---------------------------------------------------------------------------

function generateReadme(pkg: PkgJson, exports: ExportEntry[], readmeNote: string | null): string {
  const packageName = pkg.name;
  const description = pkg.description ?? "";

  const deps = Object.keys(pkg.dependencies ?? {});
  const peerDeps = Object.keys(pkg.peerDependencies ?? {});

  // Group exports by kind
  const byKind: Record<string, ExportEntry[]> = {};
  for (const entry of exports) {
    const bucket = byKind[entry.kind] ?? [];
    bucket.push(entry);
    byKind[entry.kind] = bucket;
  }

  // Build API section
  let apiSection = "";
  const kindOrder: ExportEntry["kind"][] = [
    "class",
    "function",
    "interface",
    "type",
    "const",
    "other",
  ];
  const kindLabels: Record<string, string> = {
    class: "Classes",
    function: "Functions",
    interface: "Interfaces",
    type: "Types",
    const: "Constants",
    other: "Exports",
  };

  for (const kind of kindOrder) {
    const items = byKind[kind];
    if (!items || items.length === 0) continue;

    // Sort each bucket by symbol name so emit order is stable across
    // filesystems and walk orders.
    items.sort((a, b) => a.name.localeCompare(b.name));

    apiSection += `\n### ${kindLabels[kind] ?? kind}\n\n`;
    for (const item of items) {
      if (item.jsdoc) {
        apiSection += `- **\`${item.name}\`** — ${item.jsdoc}\n`;
      } else {
        apiSection += `- **\`${item.name}\`**\n`;
      }
    }
  }

  if (!apiSection) {
    apiSection = "\n_No documented exports found in source JSDoc._\n";
  }

  // Deps section
  let depsSection = "";
  if (deps.length > 0 || peerDeps.length > 0) {
    depsSection += "\n## Dependencies\n\n";
    if (deps.length > 0) {
      depsSection += `${deps.map((d) => `- \`${d}\``).join("\n")}\n`;
    }
    if (peerDeps.length > 0) {
      if (deps.length > 0) depsSection += "\n";
      depsSection += "### Peer Dependencies\n\n";
      depsSection += `${peerDeps.map((d) => `- \`${d}\``).join("\n")}\n`;
    }
  }

  const parts = [
    `# ${packageName}`,
    "",
    `> ${description}`,
    "",
    "## Installation",
    "",
    "```sh",
    `bun add ${packageName}`,
    "```",
    "",
    "## API",
    "",
    "<!-- Auto-generated from JSDoc -->",
    apiSection.trimEnd(),
  ];

  if (readmeNote) {
    parts.push("", readmeNote.trimEnd());
  }

  parts.push(
    "",
    "## License",
    "",
    "MIT",
    "",
    "<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->",
    "",
  );

  if (depsSection) {
    const licenseIdx = parts.lastIndexOf("## License");
    if (licenseIdx >= 0) {
      parts.splice(licenseIdx, 0, depsSection.trimEnd(), "");
    }
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const pkgDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

let generated = 0;
let skipped = 0;
let stale = 0;
const checkOnly = process.argv.includes("--check");

for (const dirName of pkgDirs) {
  const pkgDir = join(PACKAGES_DIR, dirName);
  const pkgJsonPath = join(pkgDir, "package.json");

  if (!existsSync(pkgJsonPath)) {
    console.log(`⏭  ${dirName}: no package.json, skipping`);
    skipped++;
    continue;
  }

  const pkg = readJson<PkgJson>(pkgJsonPath);
  if (!pkg?.name) {
    console.log(`⏭  ${dirName}: invalid package.json, skipping`);
    skipped++;
    continue;
  }

  if (pkg.private) {
    console.log(`⏭  ${dirName}: private package, skipping`);
    skipped++;
    continue;
  }

  const readmePath = join(pkgDir, "README.md");

  // Honor the hand-maintained sentinel: a README that explicitly opts out
  // of regeneration is left untouched. Substring match so trailing
  // punctuation/wording can drift without breaking the opt-out.
  if (
    existsSync(readmePath) &&
    readFileSync(readmePath, "utf-8").includes("This README is hand-maintained.")
  ) {
    console.log(`⏭  ${dirName}: hand-maintained README, skipping`);
    skipped++;
    continue;
  }

  const srcDir = join(pkgDir, "src");
  const tsFiles = collectTsFiles(srcDir);

  const allExports: ExportEntry[] = [];
  for (const file of tsFiles) {
    allExports.push(...extractExportsFromFile(file));
  }

  // Deduplicate by name with a deterministic, walk-order-independent tiebreaker.
  // Ranking criteria (earlier criterion dominates; ties fall through):
  //   1. Concrete kind (function/class/interface/type/const) beats "other".
  //      Bare `export { foo } from "./..."` re-exports surface as "other".
  //   2. Non-barrel files beat barrels (`index.ts`). Module-level JSDoc on a
  //      barrel can leak into the first re-export's summary; the original
  //      declaration carries the authoritative JSDoc.
  //   3. Entries with a JSDoc summary beat entries without one.
  //   4. Lexicographically smaller source path (final stable tiebreaker).
  const isBarrel = (p: string): boolean => p.endsWith("/index.ts") || p.endsWith("\\index.ts");
  const compareEntries = (a: ExportEntry, b: ExportEntry): number => {
    const kindRank = (k: ExportEntry["kind"]): number => (k === "other" ? 1 : 0);
    const k = kindRank(a.kind) - kindRank(b.kind);
    if (k !== 0) return k;
    const ba = (isBarrel(a.sourcePath) ? 1 : 0) - (isBarrel(b.sourcePath) ? 1 : 0);
    if (ba !== 0) return ba;
    const j = (a.jsdoc ? 0 : 1) - (b.jsdoc ? 0 : 1);
    if (j !== 0) return j;
    return a.sourcePath.localeCompare(b.sourcePath);
  };
  const bestByName = new Map<string, ExportEntry>();
  for (const entry of allExports) {
    const prev = bestByName.get(entry.name);
    if (!prev || compareEntries(entry, prev) < 0) {
      bestByName.set(entry.name, entry);
    }
  }
  // Emit a stable winners list. Downstream regroups by kind and sorts each
  // bucket by name, so walk order does not affect final output.
  const uniqueExports: ExportEntry[] = Array.from(bestByName.values());

  const readmeNotePath = join(pkgDir, ".readme-note.md");
  const readmeNote = existsSync(readmeNotePath) ? readFileSync(readmeNotePath, "utf-8") : null;

  const readme = generateReadme(pkg, uniqueExports, readmeNote);
  if (checkOnly) {
    const current = existsSync(readmePath) ? readFileSync(readmePath, "utf-8") : "";
    if (current !== readme) {
      console.error(`✗ ${pkg.name}: README is stale; run bun run docs:readmes`);
      stale++;
    } else {
      console.log(`✓ ${pkg.name}: README current (${uniqueExports.length} exports)`);
    }
    continue;
  }

  writeFileSync(readmePath, readme, "utf-8");

  console.log(`✅ ${pkg.name}: README generated (${uniqueExports.length} exports)`);
  generated++;
}

if (checkOnly && stale > 0) {
  console.error(`\n${stale} package README(s) are stale.`);
  process.exit(1);
}

console.log(`\nDone. ${generated} READMEs generated, ${skipped} packages skipped.`);
