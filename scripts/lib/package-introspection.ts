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
 *   - `getTaggedExports(packageSrcDir, tag)` — ts-morph-based extractor for
 *     top-level declarations carrying the given JSDoc tag. Returns names
 *     sorted alphabetically.
 *   - `getTaggedClassMethods(packageSrcDir, tag)` — same idea, descends into
 *     class bodies to find method-level tags (e.g. `@hostLifecycle`).
 *   - `getHostSurfaceExports`, `getHostLifecycleMethods`,
 *     `getHostProcessFunctions`, `getHostObservabilityExports` — convenience
 *     wrappers used by `scripts/docs-reference.ts` partials.
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
 * leading JSDoc carries the given tag, and return the declared / re-exported
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
 *
 * `tag` is the JSDoc tag to filter on, including the leading `@` (e.g.
 * `"@hostSurface"`, `"@hostProcess"`, `"@hostObservability"`). Method-level
 * tags like `@hostLifecycle` live inside class bodies and are not visible
 * here — use {@link getTaggedClassMethods} for those.
 */
export function getTaggedExports(packageSrcDir: string, tag: string): string[] {
  const project = getProject();
  const seen = new Set<string>();

  for (const filePath of collectTsFiles(packageSrcDir)) {
    const sourceFile = project.addSourceFileAtPath(filePath);
    for (const stmt of sourceFile.getStatements()) {
      if (!hasTag(stmt, tag)) continue;
      for (const name of extractDeclarationNames(stmt)) {
        seen.add(name);
      }
    }
    project.removeSourceFile(sourceFile);
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Backwards-compatible wrapper for the Port 1b `@hostSurface` extractor.
 * Equivalent to {@link getTaggedExports} with `"@hostSurface"`.
 */
export function getHostSurfaceExports(packageSrcDir: string): string[] {
  return getTaggedExports(packageSrcDir, "@hostSurface");
}

/**
 * Walk the package's `src/` tree, find every method on every class whose
 * leading JSDoc carries the given tag, and return the method names sorted
 * alphabetically.
 *
 * `@hostLifecycle` lives on methods inside `ACPClientController`, not on
 * top-level statements; the top-level walker in {@link getTaggedExports}
 * cannot reach them. This walker descends into every class body and inspects
 * each `MethodDeclaration`'s leading JSDoc.
 *
 * Method names are returned without the owning class name; the partial body
 * carries the class name in its intro line. If multiple classes carry the
 * same tag on a same-named method, the name appears once (deduplicated).
 */
export function getTaggedClassMethods(packageSrcDir: string, tag: string): string[] {
  const project = getProject();
  const seen = new Set<string>();

  for (const filePath of collectTsFiles(packageSrcDir)) {
    const sourceFile = project.addSourceFileAtPath(filePath);
    for (const cls of sourceFile.getClasses()) {
      for (const method of cls.getMethods()) {
        if (!hasTag(method, tag)) continue;
        const name = method.getName();
        if (name) seen.add(name);
      }
    }
    project.removeSourceFile(sourceFile);
  }

  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Convenience wrapper: returns method names tagged `@hostLifecycle` across
 * all classes in `packageSrcDir`. Used by Port 2's lifecycle partial.
 */
export function getHostLifecycleMethods(packageSrcDir: string): string[] {
  return getTaggedClassMethods(packageSrcDir, "@hostLifecycle");
}

/**
 * Convenience wrapper: returns top-level function/class names tagged
 * `@hostProcess` in `packageSrcDir`. Used by Port 2's process-creation
 * partial.
 */
export function getHostProcessFunctions(packageSrcDir: string): string[] {
  return getTaggedExports(packageSrcDir, "@hostProcess");
}

/**
 * Convenience wrapper: returns top-level export names tagged
 * `@hostObservability` in `packageSrcDir`. Used by Port 3's observability
 * surface partial.
 */
export function getHostObservabilityExports(packageSrcDir: string): string[] {
  return getTaggedExports(packageSrcDir, "@hostObservability");
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
// comment text and look for the requested tag token. This intentionally
// matches both `/** @tag */` and `/** Description ... @tag */` styles;
// richer parsing (tag arguments, multi-tag) can be added later.
//
// `tag` includes the leading `@` (e.g. `"@hostSurface"`). The matcher
// requires the tag to be preceded by start-of-string, whitespace, or a `*`
// (the JSDoc continuation marker), and followed by whitespace or end-of-token,
// so a tag like `@hostLife` does not match `@hostLifecycle`.
function hasTag(decl: Node, tag: string): boolean {
  if (!tag.startsWith("@")) {
    throw new Error(`hasTag: tag must start with '@' (got ${JSON.stringify(tag)})`);
  }
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(`(^|[\\s*])${escaped}(\\s|$)`, "m");
  const ranges = decl.getLeadingCommentRanges();
  for (const range of ranges) {
    const text = range.getText();
    if (!text.startsWith("/**")) continue; // only JSDoc-style block comments
    if (matcher.test(text)) return true;
  }
  return false;
}
