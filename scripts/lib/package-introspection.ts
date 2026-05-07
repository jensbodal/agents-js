/**
 * Shared package-introspection helpers used by docs-related generators.
 *
 * This module is the SINGLE permitted home for `ts-morph` imports across the
 * `scripts/` tree — `scripts/docs-consistency.ts` enforces this with a grep
 * gate. Keeping the dependency confined here:
 *   - bounds the dep blast radius for renames or upgrades
 *   - lets a future regex-only fallback path live in one file
 *   - matches how `scripts/generate-package-readmes.ts` already organizes
 *     its export-discovery (regex over `index.ts`); this module promotes
 *     those helpers so two generators can share one introspection layer.
 *
 * Exposed surface, today:
 *   - `collectTsFiles`, `readJson`, `extractExportsFromFile` — regex-based
 *     helpers promoted out of `generate-package-readmes.ts` unchanged.
 *   - `getHostSurfaceExports` — ts-morph-based extractor used by
 *     `scripts/docs-reference.ts` for the `@hostSurface` JSDoc surface.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Node, Project, type Statement } from "ts-morph";

// ---------------------------------------------------------------------------
// Types (re-exported for downstream generators)
// ---------------------------------------------------------------------------

export interface PkgJson {
  name: string;
  description?: string;
  version?: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export interface ExportEntry {
  name: string;
  jsdoc: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "other";
  /** Source path the export was discovered in (used for tiebreaking). */
  sourcePath: string;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (regex-only)
// ---------------------------------------------------------------------------

export function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  const entries = readdirSync(dir, { withFileTypes: true })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// JSDoc + export extraction (regex-based)
// ---------------------------------------------------------------------------

export function extractExportsFromFile(filePath: string): ExportEntry[] {
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

// ---------------------------------------------------------------------------
// ts-morph-based extraction (HostSurface)
// ---------------------------------------------------------------------------

let cachedProject: Project | null = null;

function getProject(): Project {
  if (cachedProject) return cachedProject;
  // useInMemoryFileSystem=false; we read from disk. No tsconfig is loaded —
  // we only need syntactic parsing of re-export declarations + their JSDoc
  // tags, not type-checking. Skipping the tsconfig avoids pulling the whole
  // monorepo into the project graph for a one-shot generator run.
  cachedProject = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: false,
  });
  return cachedProject;
}

/**
 * Walk the package's `src/` tree, find every top-level statement whose
 * leading JSDoc carries `@hostSurface`, and return the declared / re-exported
 * names. The names are sorted alphabetically for stable output across
 * filesystem walk orders.
 *
 * Tag-bearing declarations supported:
 *   - `class`, `function`, `interface`, `type` — name comes from the
 *     declaration itself.
 *   - `VariableStatement` (e.g. `export const X = ...`) — names come from
 *     the variable declarations inside.
 *   - `ExportDeclaration` re-exports (e.g. `export { A, type B } from "...";`
 *     or `export { A };`) — names come from the named-export specifiers.
 *
 * Symbols re-exported by an alias (`export { A as B }`) are emitted under
 * the original name; the alias rename is invisible to consumers.
 */
export function getHostSurfaceExports(packageSrcDir: string): string[] {
  const project = getProject();
  const seen = new Set<string>();

  for (const filePath of collectTsFiles(packageSrcDir)) {
    const sourceFile = project.addSourceFileAtPath(filePath);
    for (const stmt of sourceFile.getStatements()) {
      if (!hasHostSurfaceTag(stmt)) continue;
      for (const name of extractDeclarationNames(stmt)) {
        seen.add(name);
      }
    }
    project.removeSourceFile(sourceFile);
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
}

function extractDeclarationNames(stmt: Statement): string[] {
  if (Node.isExportDeclaration(stmt)) {
    return stmt.getNamedExports().map((spec) => spec.getName());
  }
  if (
    Node.isClassDeclaration(stmt) ||
    Node.isFunctionDeclaration(stmt) ||
    Node.isInterfaceDeclaration(stmt) ||
    Node.isTypeAliasDeclaration(stmt) ||
    Node.isEnumDeclaration(stmt)
  ) {
    const name = stmt.getName();
    return name ? [name] : [];
  }
  if (Node.isVariableStatement(stmt)) {
    return stmt
      .getDeclarationList()
      .getDeclarations()
      .map((decl) => decl.getName())
      .filter((name): name is string => Boolean(name));
  }
  return [];
}

// ts-morph's `ExportDeclaration` does not implement `JSDocableNode`, so
// `getJsDocs()` is not available on re-export declarations. The JSDoc text
// surfaces here as a leading comment range instead — we read the raw
// comment text and look for the `@hostSurface` token. This intentionally
// matches both `/** @hostSurface */` and `/** Stable surface ... @hostSurface */`
// styles; richer parsing (tag arguments, multi-tag) can be added later.
function hasHostSurfaceTag(decl: Node): boolean {
  const ranges = decl.getLeadingCommentRanges();
  for (const range of ranges) {
    const text = range.getText();
    if (!text.startsWith("/**")) continue; // only JSDoc-style block comments
    if (/(^|[\s*])@hostSurface(\s|\b)/.test(text)) return true;
  }
  return false;
}
