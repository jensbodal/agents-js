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

/**
 * Walk the package's `src/` tree, find the named `TypeAliasDeclaration`,
 * resolve it as a `UnionType`, and return the discriminant string-literal
 * values (sorted alphabetically) for the named field.
 *
 * Used to enumerate event-shape catalogs that use the discriminated-union
 * pattern (e.g. `ACPSessionEvent` keyed on `type`). The strict shape check
 * keeps the extractor honest: each union member must be a `TypeLiteralNode`
 * with a property whose `TypeNode` is a `LiteralTypeNode` wrapping a
 * `StringLiteral`. Indirect discriminants (e.g. members that resolve through
 * a separate type alias) throw rather than silently fall through —
 * silent fallthrough corrupts the partial.
 *
 * If a future shape change causes throws, defer the extraction the way
 * `@hostSessionControl` was deferred (page breadcrumb + manifest entry +
 * `_generated/README.md` Deferred extractions entry); do not pile on
 * special cases.
 */
export function getDiscriminatedUnionVariants(
  packageSrcDir: string,
  typeName: string,
  discriminantField: string,
): string[] {
  const project = getProject();
  let foundAlias: ReturnType<ReturnType<Project["addSourceFileAtPath"]>["getTypeAlias"]>;

  for (const filePath of collectTsFiles(packageSrcDir)) {
    const sourceFile = project.addSourceFileAtPath(filePath);
    const candidate = sourceFile.getTypeAlias(typeName);
    if (candidate) {
      foundAlias = candidate;
      // Don't remove the source file yet — we still need to read AST nodes.
      break;
    }
    project.removeSourceFile(sourceFile);
  }

  if (!foundAlias) {
    throw new Error(
      `getDiscriminatedUnionVariants: type alias ${JSON.stringify(typeName)} not found under ${packageSrcDir}.`,
    );
  }

  const typeNode = foundAlias.getTypeNode();
  if (!typeNode || !Node.isUnionTypeNode(typeNode)) {
    throw new Error(
      `getDiscriminatedUnionVariants: ${typeName} resolved to ${typeNode?.getKindName() ?? "undefined"}, expected UnionType.`,
    );
  }

  const variants: string[] = [];
  for (const member of typeNode.getTypeNodes()) {
    if (!Node.isTypeLiteral(member)) {
      throw new Error(
        `getDiscriminatedUnionVariants: ${typeName} union member at ${member.getStart()} is ${member.getKindName()}, expected TypeLiteral.`,
      );
    }
    const property = member.getProperty(discriminantField);
    if (!property) {
      throw new Error(
        `getDiscriminatedUnionVariants: ${typeName} union member at ${member.getStart()} has no '${discriminantField}' property.`,
      );
    }
    const propertyTypeNode = property.getTypeNode();
    if (!propertyTypeNode || !Node.isLiteralTypeNode(propertyTypeNode)) {
      throw new Error(
        `getDiscriminatedUnionVariants: ${typeName} union member at ${member.getStart()} has non-literal '${discriminantField}' type (${propertyTypeNode?.getKindName() ?? "undefined"}).`,
      );
    }
    const literal = propertyTypeNode.getLiteral();
    if (!Node.isStringLiteral(literal)) {
      throw new Error(
        `getDiscriminatedUnionVariants: ${typeName} union member at ${member.getStart()} has non-string-literal '${discriminantField}' value (${literal.getKindName()}).`,
      );
    }
    variants.push(literal.getLiteralValue());
  }

  project.removeSourceFile(foundAlias.getSourceFile());

  return [...new Set(variants)].sort((a, b) => a.localeCompare(b));
}

/**
 * Walk the package's `src/` tree, find the named `InterfaceDeclaration`,
 * and return its property fields as `{ name, signature, optional }` triples
 * **in source declaration order**.
 *
 * Source order rather than alphabetical: interface members are not
 * reordered by tooling (biome's `organize-imports` does not touch
 * interface bodies), so source order is byte-stable for routine refactors.
 * The Port 1b alphabetical rule was written for symbol-list extractors
 * vulnerable to biome reorderings; for fixed interface fields, source order
 * preserves natural lifecycle pairings (e.g. `beforePrompt` next to
 * `afterPrompt`) that alphabetical sort would scramble. A deliberate
 * reorder of the interface IS a real change and should reflect in the
 * partial.
 */
export function getInterfaceFieldSignatures(
  packageSrcDir: string,
  interfaceName: string,
): Array<{ name: string; signature: string; optional: boolean }> {
  const project = getProject();
  let foundInterface: ReturnType<ReturnType<Project["addSourceFileAtPath"]>["getInterface"]>;

  for (const filePath of collectTsFiles(packageSrcDir)) {
    const sourceFile = project.addSourceFileAtPath(filePath);
    const candidate = sourceFile.getInterface(interfaceName);
    if (candidate) {
      foundInterface = candidate;
      break;
    }
    project.removeSourceFile(sourceFile);
  }

  if (!foundInterface) {
    throw new Error(
      `getInterfaceFieldSignatures: interface ${JSON.stringify(interfaceName)} not found under ${packageSrcDir}.`,
    );
  }

  const fields: Array<{ name: string; signature: string; optional: boolean }> = [];
  for (const member of foundInterface.getMembers()) {
    // Properties (`name: T`) and methods (`name(args): R`) are both surfaced
    // as members; we treat each as a field with its full signature text.
    // Signatures are flattened to a single line so they render cleanly as
    // markdown inline code spans — multi-line ts-morph output breaks bullet
    // formatting otherwise.
    if (Node.isPropertySignature(member)) {
      const typeNode = member.getTypeNode();
      const raw = typeNode ? typeNode.getText() : "unknown";
      fields.push({
        name: member.getName(),
        signature: flattenSignature(raw),
        optional: member.hasQuestionToken(),
      });
    } else if (Node.isMethodSignature(member)) {
      // Reconstruct as a callable type expression: `(params) => returnType`.
      const params = member
        .getParameters()
        .map((p) => p.getText())
        .join(", ");
      const returnTypeNode = member.getReturnTypeNode();
      const returnType = returnTypeNode ? returnTypeNode.getText() : "unknown";
      fields.push({
        name: member.getName(),
        signature: flattenSignature(`(${params}) => ${returnType}`),
        optional: member.hasQuestionToken(),
      });
    }
  }

  project.removeSourceFile(foundInterface.getSourceFile());

  return fields;
}

// Flatten a TypeScript type signature for inline-code rendering. ts-morph
// preserves the source text including embedded newlines and indentation —
// fine for `getText()` consumers but breaks markdown bullets when emitted
// as a `\`code span\``. Collapses any run of whitespace to a single space
// and strips leading/trailing whitespace.
function flattenSignature(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Walk the package's `src/` tree, find the named `VariableDeclaration` whose
 * initializer is a call of the form `toSchemaInfoMap(<source>.<key>)`, and
 * return the `(method, schemaName)` pairs derived from the referenced object
 * literal.
 *
 * Used for ACP's `Map<ACPMethod, ACPMethodSchemaInfo>` registries
 * (`acpRequestSchemas`, `acpResponseSchemas`). The Maps are constructed at
 * runtime from a generated artifacts object literal; the extractor resolves
 * that indirection statically by:
 *
 *   1. locating the `const <mapSymbolName> = toSchemaInfoMap(<expr>);` decl,
 *   2. reading the `PropertyAccessExpression` argument to find both the
 *      identifier (e.g. `acpGeneratedSchemaArtifacts`) and the property name
 *      (`requestSchemas` / `responseSchemas`),
 *   3. resolving that identifier's declaration anywhere under
 *      `packageSrcDir`, walking into the property's `ObjectLiteralExpression`
 *      value, and reading each entry's `method` + `definitionName` literal
 *      strings.
 *
 * Each "unexpected shape" branch throws with a precise error rather than
 * falling through silently — silent fallthrough corrupts the partial. If a
 * future shape change causes throws, defer the extraction the way
 * `@hostSessionControl` was deferred (page breadcrumb + manifest entry +
 * `_generated/README.md` Deferred extractions entry).
 *
 * Result is sorted by `method` for stable output.
 */
export function getMethodKeyedRegistryEntries(
  packageSrcDir: string,
  mapSymbolName: string,
): Array<{ method: string; schemaName: string }> {
  const project = getProject();
  const sourceFiles = collectTsFiles(packageSrcDir).map((p) => project.addSourceFileAtPath(p));

  let mapDecl: ReturnType<ReturnType<Project["addSourceFileAtPath"]>["getVariableDeclaration"]>;
  for (const sf of sourceFiles) {
    const candidate = sf.getVariableDeclaration(mapSymbolName);
    if (candidate) {
      mapDecl = candidate;
      break;
    }
  }
  if (!mapDecl) {
    for (const sf of sourceFiles) project.removeSourceFile(sf);
    throw new Error(
      `getMethodKeyedRegistryEntries: variable ${JSON.stringify(mapSymbolName)} not found under ${packageSrcDir}.`,
    );
  }

  const initializer = mapDecl.getInitializer();
  if (!initializer || !Node.isCallExpression(initializer)) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${mapSymbolName} initializer is ${initializer?.getKindName() ?? "undefined"}, expected CallExpression.`,
    );
  }

  const args = initializer.getArguments();
  if (args.length !== 1) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${mapSymbolName} call has ${args.length} arguments, expected 1.`,
    );
  }
  const arg = args[0];
  if (!Node.isPropertyAccessExpression(arg)) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${mapSymbolName} argument is ${arg.getKindName()}, expected PropertyAccessExpression of the form <object>.<property>.`,
    );
  }

  const sourceIdent = arg.getExpression();
  if (!Node.isIdentifier(sourceIdent)) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${mapSymbolName} argument's object expression is ${sourceIdent.getKindName()}, expected Identifier.`,
    );
  }
  const sourceName = sourceIdent.getText();
  const propertyName = arg.getName();

  let sourceDecl: ReturnType<ReturnType<Project["addSourceFileAtPath"]>["getVariableDeclaration"]>;
  for (const sf of sourceFiles) {
    const candidate = sf.getVariableDeclaration(sourceName);
    if (candidate) {
      sourceDecl = candidate;
      break;
    }
  }
  if (!sourceDecl) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${mapSymbolName} references identifier ${JSON.stringify(sourceName)}, but no matching VariableDeclaration was found under ${packageSrcDir}.`,
    );
  }

  const sourceInitRaw = sourceDecl.getInitializer();
  const sourceInit = unwrapAssertions(sourceInitRaw);
  if (!sourceInit || !Node.isObjectLiteralExpression(sourceInit)) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${sourceName} initializer (after unwrapping as/satisfies) is ${sourceInit?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
    );
  }

  const sourceProp = sourceInit.getProperty(propertyName);
  if (!sourceProp) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${sourceName} has no property ${JSON.stringify(propertyName)}.`,
    );
  }
  if (!Node.isPropertyAssignment(sourceProp)) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${sourceName}.${propertyName} is ${sourceProp.getKindName()}, expected PropertyAssignment.`,
    );
  }
  const propValue = unwrapAssertions(sourceProp.getInitializer());
  if (!propValue || !Node.isObjectLiteralExpression(propValue)) {
    throw new Error(
      `getMethodKeyedRegistryEntries: ${sourceName}.${propertyName} value (after unwrapping as/satisfies) is ${propValue?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
    );
  }

  const entries: Array<{ method: string; schemaName: string }> = [];
  for (const entry of propValue.getProperties()) {
    if (!Node.isPropertyAssignment(entry)) {
      throw new Error(
        `getMethodKeyedRegistryEntries: ${sourceName}.${propertyName} contains a ${entry.getKindName()} entry at ${entry.getStart()}, expected PropertyAssignment.`,
      );
    }
    const entryValue = entry.getInitializer();
    if (!entryValue || !Node.isObjectLiteralExpression(entryValue)) {
      throw new Error(
        `getMethodKeyedRegistryEntries: ${sourceName}.${propertyName} entry value is ${entryValue?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
      );
    }
    const method = readStringLiteralProperty(entryValue, "method", `${sourceName}.${propertyName}`);
    const schemaName = readStringLiteralProperty(
      entryValue,
      "definitionName",
      `${sourceName}.${propertyName}`,
    );
    entries.push({ method, schemaName });
  }

  for (const sf of sourceFiles) project.removeSourceFile(sf);

  return entries.sort((a, b) => a.method.localeCompare(b.method));
}

// Strip `as <T>`, `<T>` (TypeAssertion), and `satisfies <T>` wrappers from an
// expression. Object literals carrying `as const satisfies Foo` show up as
// `AsExpression(SatisfiesExpression(ObjectLiteralExpression))`; the inner
// shape is what extractors care about, so this helper unwraps both forms in
// any order and any depth. A `Node | undefined` input returns `undefined` to
// preserve the caller's branch on missing initializers.
function unwrapAssertions(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    current &&
    (Node.isAsExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isTypeAssertion(current) ||
      Node.isParenthesizedExpression(current))
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * Walk the package's `src/` tree, find the named `VariableStatement` whose
 * initializer is a flat `ObjectLiteralExpression`, and return one entry per
 * top-level property: `{ name, kind }`, where `kind` is `"validator"` if the
 * property name ends with `Validator` and `"schema"` otherwise (the A2A
 * registry uses both shapes today; future entries that match neither
 * convention would still be classified `"schema"`).
 *
 * Used for A2A's flat schema constants in `a2aValidationSchemas` (see
 * `packages/validation/src/a2a.ts`). The shape is a plain object literal
 * with shorthand property assignments referring to imported schema bindings;
 * each entry's name IS the schema/validator export.
 *
 * Each "unexpected shape" branch throws with a precise error — silent
 * fallthrough corrupts the partial. Result is sorted alphabetically by
 * `name` for stable output.
 */
export function getFlatValidationSchemaExports(
  packageSrcDir: string,
  exportSymbolName: string,
): Array<{ name: string; kind: "schema" | "validator" }> {
  const project = getProject();
  const sourceFiles = collectTsFiles(packageSrcDir).map((p) => project.addSourceFileAtPath(p));

  let decl: ReturnType<ReturnType<Project["addSourceFileAtPath"]>["getVariableDeclaration"]>;
  for (const sf of sourceFiles) {
    const candidate = sf.getVariableDeclaration(exportSymbolName);
    if (candidate) {
      decl = candidate;
      break;
    }
  }
  if (!decl) {
    for (const sf of sourceFiles) project.removeSourceFile(sf);
    throw new Error(
      `getFlatValidationSchemaExports: variable ${JSON.stringify(exportSymbolName)} not found under ${packageSrcDir}.`,
    );
  }

  const init = unwrapAssertions(decl.getInitializer());
  if (!init || !Node.isObjectLiteralExpression(init)) {
    throw new Error(
      `getFlatValidationSchemaExports: ${exportSymbolName} initializer (after unwrapping as/satisfies) is ${init?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
    );
  }

  const entries: Array<{ name: string; kind: "schema" | "validator" }> = [];
  for (const property of init.getProperties()) {
    let name: string | undefined;
    if (Node.isShorthandPropertyAssignment(property)) {
      name = property.getName();
    } else if (Node.isPropertyAssignment(property)) {
      const nameNode = property.getNameNode();
      if (Node.isIdentifier(nameNode)) {
        name = nameNode.getText();
      } else if (Node.isStringLiteral(nameNode)) {
        name = nameNode.getLiteralValue();
      } else {
        throw new Error(
          `getFlatValidationSchemaExports: ${exportSymbolName} property at ${property.getStart()} has non-identifier non-string-literal name node ${nameNode.getKindName()}.`,
        );
      }
    } else {
      throw new Error(
        `getFlatValidationSchemaExports: ${exportSymbolName} contains a ${property.getKindName()} entry at ${property.getStart()}, expected ShorthandPropertyAssignment or PropertyAssignment.`,
      );
    }
    if (!name) {
      throw new Error(
        `getFlatValidationSchemaExports: ${exportSymbolName} property at ${property.getStart()} produced an empty name.`,
      );
    }
    const kind: "schema" | "validator" = name.endsWith("Validator") ? "validator" : "schema";
    entries.push({ name, kind });
  }

  if (entries.length === 0) {
    throw new Error(
      `getFlatValidationSchemaExports: ${exportSymbolName} has no entries. Either populate it or remove the partial.`,
    );
  }

  for (const sf of sourceFiles) project.removeSourceFile(sf);

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function readStringLiteralProperty(
  obj: import("ts-morph").ObjectLiteralExpression,
  key: string,
  context: string,
): string {
  const prop = obj.getProperty(key);
  if (!prop) {
    throw new Error(
      `readStringLiteralProperty: ${context} entry has no '${key}' property at ${obj.getStart()}.`,
    );
  }
  if (!Node.isPropertyAssignment(prop)) {
    throw new Error(
      `readStringLiteralProperty: ${context} entry '${key}' is ${prop.getKindName()}, expected PropertyAssignment.`,
    );
  }
  const init = prop.getInitializer();
  if (!init || !Node.isStringLiteral(init)) {
    throw new Error(
      `readStringLiteralProperty: ${context} entry '${key}' value is ${init?.getKindName() ?? "undefined"}, expected StringLiteral.`,
    );
  }
  return init.getLiteralValue();
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

// ---------------------------------------------------------------------------
// Port 5 — CLI subcommand + runtime-registry extractors
// ---------------------------------------------------------------------------

/**
 * Description of a single CLI flag emitted by {@link getCLISubcommandFlags}.
 * `description` falls back to `""` when an `ArgEntry` literal omits its
 * optional `description` property (the parser type allows it). `valueExample`
 * is only populated for `kind: "value"` entries that supply one.
 */
export interface CLISubcommandFlag {
  flag: string;
  kind: "flag" | "value";
  description: string;
  valueExample?: string;
}

/**
 * Walk every `@hostCliSubcommand`-tagged `ArgSpec` constant inside
 * `${packageSrcDir}/${subcommandModule}.ts`, resolve each spread fragment by
 * following the `import` graph back to its declaring module's factory
 * function, and return the union of flag entries. Output is sorted
 * alphabetically by flag name; flag-name collisions across spreads are
 * deduplicated (the first definition wins so explicit per-subcommand entries
 * shadow factory defaults — same shape `parseArgv` consumes at runtime).
 *
 * Two-hop resolution covers the parser pattern used by the cli package:
 * each `<SUBCOMMAND>_ARG_SPEC` is built from inline literals plus a small
 * set of factory spreads (e.g. `...hostPortArgs<T>()`). The extractor only
 * reaches the factory's returned `ObjectLiteralExpression`; deeper spreads
 * (`runtimeSelectArgs` spreads `harnessArg`) are followed recursively.
 *
 * Throws with a precise diagnostic if any of the locked-shape invariants
 * are violated — silent fallthrough corrupts the partial.
 */
export function getCLISubcommandFlags(
  packageSrcDir: string,
  subcommandModule: string,
): CLISubcommandFlag[] {
  const project = getProject();
  const targetPath = join(packageSrcDir, `${subcommandModule}.ts`);
  if (!existsSync(targetPath)) {
    throw new Error(
      `getCLISubcommandFlags: source module ${JSON.stringify(targetPath)} does not exist.`,
    );
  }

  const sourceFile = project.addSourceFileAtPath(targetPath);
  const taggedSpecs: Array<{ name: string; literal: Node }> = [];

  for (const stmt of sourceFile.getStatements()) {
    if (!Node.isVariableStatement(stmt)) continue;
    if (!hasTag(stmt, "@hostCliSubcommand")) continue;
    const decls = stmt.getDeclarationList().getDeclarations();
    for (const decl of decls) {
      const initializer = decl.getInitializer();
      if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
        throw new Error(
          `getCLISubcommandFlags: ${decl.getName()} in ${targetPath} is tagged @hostCliSubcommand but its initializer is ${initializer?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
        );
      }
      taggedSpecs.push({ name: decl.getName(), literal: initializer });
    }
  }

  if (taggedSpecs.length === 0) {
    throw new Error(
      `getCLISubcommandFlags: no @hostCliSubcommand declarations found in ${targetPath}.`,
    );
  }

  const seen = new Map<string, CLISubcommandFlag>();
  for (const spec of taggedSpecs) {
    if (!Node.isObjectLiteralExpression(spec.literal)) continue;
    const fragment = collectArgSpecFlags(spec.literal, sourceFile, project, packageSrcDir);
    for (const flag of fragment) {
      if (!seen.has(flag.flag)) seen.set(flag.flag, flag);
    }
  }

  project.removeSourceFile(sourceFile);

  return [...seen.values()].sort((a, b) => a.flag.localeCompare(b.flag));
}

/**
 * Walk the members of an `ArgSpec` ObjectLiteralExpression, flattening
 * `...factory()` spreads by importing the factory's source and recursing
 * into its returned ObjectLiteralExpression.
 */
function collectArgSpecFlags(
  literal: Node,
  fromFile: ReturnType<Project["addSourceFileAtPath"]>,
  project: Project,
  packageSrcDir: string,
): CLISubcommandFlag[] {
  if (!Node.isObjectLiteralExpression(literal)) {
    throw new Error(
      `collectArgSpecFlags: expected ObjectLiteralExpression, got ${literal.getKindName()}.`,
    );
  }

  const out: CLISubcommandFlag[] = [];
  for (const property of literal.getProperties()) {
    if (Node.isPropertyAssignment(property)) {
      const nameNode = property.getNameNode();
      // Flag keys are written as string literals (`"--harness"`) or
      // computed from a constant; only string-literal keys are supported
      // because the runtime parser indexes the spec by literal flag tokens.
      let flagName: string | undefined;
      if (Node.isStringLiteral(nameNode)) {
        flagName = nameNode.getLiteralValue();
      } else if (Node.isNoSubstitutionTemplateLiteral(nameNode)) {
        flagName = nameNode.getLiteralValue();
      } else {
        throw new Error(
          `collectArgSpecFlags: ArgSpec key at ${nameNode.getStart()} is ${nameNode.getKindName()}, expected string literal.`,
        );
      }
      const valueNode = property.getInitializer();
      if (!valueNode || !Node.isObjectLiteralExpression(valueNode)) {
        throw new Error(
          `collectArgSpecFlags: ArgSpec entry for ${JSON.stringify(flagName)} at ${property.getStart()} is ${valueNode?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
        );
      }
      out.push(parseArgEntryLiteral(flagName, valueNode));
      continue;
    }

    if (Node.isSpreadAssignment(property)) {
      const expr = property.getExpression();
      if (!Node.isCallExpression(expr)) {
        throw new Error(
          `collectArgSpecFlags: spread expression at ${expr.getStart()} is ${expr.getKindName()}, expected CallExpression (e.g. \`...harnessArg<T>()\`).`,
        );
      }
      const callee = expr.getExpression();
      let factoryName: string | undefined;
      if (Node.isIdentifier(callee)) {
        factoryName = callee.getText();
      } else {
        throw new Error(
          `collectArgSpecFlags: spread callee at ${callee.getStart()} is ${callee.getKindName()}, expected Identifier.`,
        );
      }
      const factoryLiteral = resolveFactoryReturnLiteral(factoryName, fromFile, project);
      // Recurse so factories that themselves spread other factories
      // (e.g. runtimeSelectArgs spreads harnessArg) flatten correctly.
      out.push(
        ...collectArgSpecFlags(
          factoryLiteral.literal,
          factoryLiteral.sourceFile,
          project,
          packageSrcDir,
        ),
      );
      // The factory's source file is owned by the recursion; the outer
      // walker keeps the top-level spec file so we must NOT remove it
      // here. Recursion's own removal happens after its loop.
      continue;
    }

    if (Node.isShorthandPropertyAssignment(property)) {
      throw new Error(
        `collectArgSpecFlags: ArgSpec literal contains shorthand property at ${property.getStart()}; expected explicit \`"--flag": { ... }\` form.`,
      );
    }

    throw new Error(
      `collectArgSpecFlags: unexpected property kind ${property.getKindName()} at ${property.getStart()}.`,
    );
  }

  return out;
}

/**
 * Read a single ArgEntry ObjectLiteralExpression and project it into a
 * {@link CLISubcommandFlag}. `description` and `valueExample` are optional
 * by parser contract; both default to "" / undefined when absent.
 */
function parseArgEntryLiteral(flagName: string, literal: Node): CLISubcommandFlag {
  if (!Node.isObjectLiteralExpression(literal)) {
    throw new Error(
      `parseArgEntryLiteral: expected ObjectLiteralExpression for ${flagName}, got ${literal.getKindName()}.`,
    );
  }

  let kind: "flag" | "value" | undefined;
  let description = "";
  let valueExample: string | undefined;

  for (const property of literal.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    const propName = property.getName();
    const init = property.getInitializer();
    if (!init) continue;

    if (propName === "kind") {
      if (!Node.isStringLiteral(init)) {
        throw new Error(
          `parseArgEntryLiteral: ${flagName}.kind is ${init.getKindName()}, expected string literal.`,
        );
      }
      const v = init.getLiteralValue();
      if (v !== "flag" && v !== "value") {
        throw new Error(
          `parseArgEntryLiteral: ${flagName}.kind = ${JSON.stringify(v)}, expected "flag" or "value".`,
        );
      }
      kind = v;
    } else if (propName === "description") {
      if (!Node.isStringLiteral(init) && !Node.isNoSubstitutionTemplateLiteral(init)) {
        throw new Error(
          `parseArgEntryLiteral: ${flagName}.description is ${init.getKindName()}, expected string literal.`,
        );
      }
      description = init.getLiteralValue();
    } else if (propName === "valueExample") {
      if (!Node.isStringLiteral(init) && !Node.isNoSubstitutionTemplateLiteral(init)) {
        throw new Error(
          `parseArgEntryLiteral: ${flagName}.valueExample is ${init.getKindName()}, expected string literal.`,
        );
      }
      valueExample = init.getLiteralValue();
    }
    // assign callbacks are not surfaced — they're behavior, not docs.
  }

  if (!kind) {
    throw new Error(
      `parseArgEntryLiteral: ${flagName} has no kind property; expected "flag" or "value".`,
    );
  }

  const result: CLISubcommandFlag = { flag: flagName, kind, description };
  if (valueExample !== undefined) result.valueExample = valueExample;
  return result;
}

/**
 * Follow an imported factory identifier (e.g. `hostPortArgs`) back to its
 * declaring module within `packageSrcDir`, locate the function declaration,
 * and return its single returned ObjectLiteralExpression. Throws if the
 * factory is not local or its body shape is unexpected.
 */
function resolveFactoryReturnLiteral(
  factoryName: string,
  fromFile: ReturnType<Project["addSourceFileAtPath"]>,
  _project: Project,
): {
  literal: Node;
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>;
} {
  // Same-file lookup: factories may declare and reference each other in the
  // same module (e.g. `runtimeSelectArgs` spreads `harnessArg` both declared
  // in `shared-arg-specs.ts`). Check for an in-file function declaration
  // before walking imports.
  const localFn = fromFile.getFunction(factoryName);
  if (localFn) {
    const body = localFn.getBody();
    if (!body || !Node.isBlock(body)) {
      throw new Error(
        `resolveFactoryReturnLiteral: factory ${factoryName} in ${fromFile.getFilePath()} has no block body.`,
      );
    }
    const ret = body.getStatements().find((s) => Node.isReturnStatement(s));
    if (!ret || !Node.isReturnStatement(ret)) {
      throw new Error(
        `resolveFactoryReturnLiteral: factory ${factoryName} in ${fromFile.getFilePath()} has no return statement.`,
      );
    }
    const expr = ret.getExpression();
    if (!expr || !Node.isObjectLiteralExpression(expr)) {
      throw new Error(
        `resolveFactoryReturnLiteral: factory ${factoryName} in ${fromFile.getFilePath()} returns ${expr?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
      );
    }
    return { literal: expr, sourceFile: fromFile };
  }

  // ts-morph resolves through import declarations via getImportDeclarations.
  for (const importDecl of fromFile.getImportDeclarations()) {
    for (const named of importDecl.getNamedImports()) {
      const localName = named.getAliasNode()?.getText() ?? named.getName();
      if (localName !== factoryName) continue;
      const moduleSourceFile = importDecl.getModuleSpecifierSourceFile();
      if (!moduleSourceFile) {
        throw new Error(
          `resolveFactoryReturnLiteral: import for ${factoryName} from ${importDecl.getModuleSpecifierValue()} did not resolve to a source file.`,
        );
      }
      const fnName = named.getName(); // origin name in target module
      const fn = moduleSourceFile.getFunction(fnName);
      if (!fn) {
        throw new Error(
          `resolveFactoryReturnLiteral: factory ${fnName} not found in ${moduleSourceFile.getFilePath()}.`,
        );
      }
      const body = fn.getBody();
      if (!body || !Node.isBlock(body)) {
        throw new Error(`resolveFactoryReturnLiteral: factory ${fnName} has no block body.`);
      }
      const ret = body.getStatements().find((s) => Node.isReturnStatement(s));
      if (!ret || !Node.isReturnStatement(ret)) {
        throw new Error(`resolveFactoryReturnLiteral: factory ${fnName} has no return statement.`);
      }
      const expr = ret.getExpression();
      if (!expr || !Node.isObjectLiteralExpression(expr)) {
        throw new Error(
          `resolveFactoryReturnLiteral: factory ${fnName} returns ${expr?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
        );
      }
      return { literal: expr, sourceFile: moduleSourceFile };
    }
  }

  throw new Error(
    `resolveFactoryReturnLiteral: factory ${factoryName} could not be resolved through imports of ${fromFile.getFilePath()}.`,
  );
}

/**
 * Single matrix row emitted by {@link getRuntimeRegistryMatrix}. `command`
 * and `install` are surfaced when the registry entry carries them so the
 * generator can render concise rows; auth and resolveArgs hooks are not
 * exposed here (they belong on a separate, sibling extraction if needed).
 */
export interface RuntimeRegistryRow {
  id: string;
  displayName: string;
  description: string;
  command?: string;
  install?: string;
}

/**
 * Walk `${packageSrcDir}` for the named registry symbol (e.g.
 * `GATEWAY_RUNTIME_REGISTRY`), follow it back to the literal Record it
 * aliases, and emit one row per entry. The registry shape understood here
 * is the one in `packages/gateway-runtime/src/runtimes-registry.ts`:
 * an object literal whose keys are runtime ids and whose values are
 * `createAcpHarness({ id, displayName, description, command?, args?, install? })`
 * call expressions. The extractor reads the `displayName`, `description`,
 * `command`, and (when provided) `install.installHint` literals.
 *
 * Throws with a precise diagnostic if the shape diverges — silent
 * fallthrough corrupts the partial.
 */
export function getRuntimeRegistryMatrix(
  packageSrcDir: string,
  registrySymbolName: string,
): RuntimeRegistryRow[] {
  const project = getProject();
  let aliasInitializer: Node | undefined;
  let aliasSourceFile: ReturnType<Project["addSourceFileAtPath"]> | undefined;

  for (const filePath of collectTsFiles(packageSrcDir)) {
    const sourceFile = project.addSourceFileAtPath(filePath);
    const variable = sourceFile.getVariableDeclaration(registrySymbolName);
    if (variable) {
      const init = variable.getInitializer();
      if (!init) {
        throw new Error(
          `getRuntimeRegistryMatrix: ${registrySymbolName} in ${filePath} has no initializer.`,
        );
      }
      aliasInitializer = init;
      aliasSourceFile = sourceFile;
      break;
    }
    project.removeSourceFile(sourceFile);
  }

  if (!aliasInitializer || !aliasSourceFile) {
    throw new Error(
      `getRuntimeRegistryMatrix: variable ${JSON.stringify(registrySymbolName)} not found under ${packageSrcDir}.`,
    );
  }

  // The exported registry is `Readonly<Record<…>>` — typically aliasing a
  // local `as const` object literal. Follow one identifier hop if the
  // initializer is just a reference.
  let literal: Node = aliasInitializer;
  if (Node.isAsExpression(literal)) literal = literal.getExpression();
  if (Node.isSatisfiesExpression(literal)) literal = literal.getExpression();
  if (Node.isAsExpression(literal)) literal = literal.getExpression();
  if (Node.isIdentifier(literal)) {
    const ref = aliasSourceFile.getVariableDeclaration(literal.getText());
    if (!ref) {
      throw new Error(
        `getRuntimeRegistryMatrix: ${registrySymbolName} aliases ${literal.getText()} but no local declaration found in ${aliasSourceFile.getFilePath()}.`,
      );
    }
    let refInit = ref.getInitializer();
    if (!refInit) {
      throw new Error(
        `getRuntimeRegistryMatrix: alias target ${literal.getText()} has no initializer.`,
      );
    }
    if (Node.isAsExpression(refInit)) refInit = refInit.getExpression();
    if (Node.isSatisfiesExpression(refInit)) refInit = refInit.getExpression();
    if (Node.isAsExpression(refInit)) refInit = refInit.getExpression();
    literal = refInit;
  }

  if (!Node.isObjectLiteralExpression(literal)) {
    throw new Error(
      `getRuntimeRegistryMatrix: ${registrySymbolName} initializer resolved to ${literal.getKindName()}, expected ObjectLiteralExpression.`,
    );
  }

  const rows: RuntimeRegistryRow[] = [];
  for (const property of literal.getProperties()) {
    if (!Node.isPropertyAssignment(property)) {
      throw new Error(
        `getRuntimeRegistryMatrix: ${registrySymbolName} entry at ${property.getStart()} is ${property.getKindName()}, expected PropertyAssignment.`,
      );
    }
    const keyNode = property.getNameNode();
    let id: string;
    if (Node.isIdentifier(keyNode)) {
      id = keyNode.getText();
    } else if (Node.isStringLiteral(keyNode) || Node.isNoSubstitutionTemplateLiteral(keyNode)) {
      id = keyNode.getLiteralValue();
    } else {
      throw new Error(
        `getRuntimeRegistryMatrix: ${registrySymbolName} key at ${keyNode.getStart()} is ${keyNode.getKindName()}, expected Identifier or StringLiteral.`,
      );
    }
    const init = property.getInitializer();
    if (!init || !Node.isCallExpression(init)) {
      throw new Error(
        `getRuntimeRegistryMatrix: ${registrySymbolName}.${id} initializer is ${init?.getKindName() ?? "undefined"}, expected CallExpression.`,
      );
    }
    const args = init.getArguments();
    if (args.length === 0 || !Node.isObjectLiteralExpression(args[0])) {
      throw new Error(
        `getRuntimeRegistryMatrix: ${registrySymbolName}.${id} factory call has no ObjectLiteralExpression argument.`,
      );
    }
    rows.push(parseRuntimeFactoryArg(id, args[0]));
  }

  if (rows.length === 0) {
    throw new Error(`getRuntimeRegistryMatrix: ${registrySymbolName} has no entries.`);
  }

  project.removeSourceFile(aliasSourceFile);

  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

function parseRuntimeFactoryArg(id: string, literal: Node): RuntimeRegistryRow {
  if (!Node.isObjectLiteralExpression(literal)) {
    throw new Error(
      `parseRuntimeFactoryArg: expected ObjectLiteralExpression for ${id}, got ${literal.getKindName()}.`,
    );
  }

  let displayName: string | undefined;
  let description: string | undefined;
  let command: string | undefined;
  let installHint: string | undefined;

  for (const property of literal.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    const propName = property.getName();
    const init = property.getInitializer();
    if (!init) continue;

    if (propName === "displayName") {
      if (!Node.isStringLiteral(init) && !Node.isNoSubstitutionTemplateLiteral(init)) {
        throw new Error(
          `parseRuntimeFactoryArg: ${id}.displayName is ${init.getKindName()}, expected string literal.`,
        );
      }
      displayName = init.getLiteralValue();
    } else if (propName === "description") {
      if (!Node.isStringLiteral(init) && !Node.isNoSubstitutionTemplateLiteral(init)) {
        throw new Error(
          `parseRuntimeFactoryArg: ${id}.description is ${init.getKindName()}, expected string literal.`,
        );
      }
      description = init.getLiteralValue();
    } else if (propName === "command") {
      if (!Node.isStringLiteral(init) && !Node.isNoSubstitutionTemplateLiteral(init)) {
        throw new Error(
          `parseRuntimeFactoryArg: ${id}.command is ${init.getKindName()}, expected string literal.`,
        );
      }
      command = init.getLiteralValue();
    } else if (propName === "install") {
      if (!Node.isObjectLiteralExpression(init)) {
        throw new Error(
          `parseRuntimeFactoryArg: ${id}.install is ${init.getKindName()}, expected ObjectLiteralExpression.`,
        );
      }
      for (const inner of init.getProperties()) {
        if (!Node.isPropertyAssignment(inner)) continue;
        if (inner.getName() !== "installHint") continue;
        const innerInit = inner.getInitializer();
        if (
          innerInit &&
          (Node.isStringLiteral(innerInit) || Node.isNoSubstitutionTemplateLiteral(innerInit))
        ) {
          installHint = innerInit.getLiteralValue();
        }
      }
    }
  }

  if (!displayName) {
    throw new Error(`parseRuntimeFactoryArg: ${id} missing required displayName property.`);
  }
  if (!description) {
    throw new Error(`parseRuntimeFactoryArg: ${id} missing required description property.`);
  }

  const row: RuntimeRegistryRow = { id, displayName, description };
  if (command !== undefined) row.command = command;
  if (installHint !== undefined) row.install = installHint;
  return row;
}
