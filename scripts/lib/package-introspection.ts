/**
 * Shared ts-morph-based introspection helpers used by docs-related
 * generators.
 *
 * This module is the SINGLE permitted home for `ts-morph` imports across
 * the `scripts/` tree — `scripts/docs-consistency.ts` enforces this with
 * a grep gate. Keeping the dependency confined here:
 *   - bounds the dep blast radius for renames or upgrades
 *   - keeps a single project / source-file lifecycle policy
 *
 * Exposed surface:
 *   - `collectTsFiles`, `readJson`, `PkgJson` — small filesystem helpers
 *     (no ts-morph); shared with `scripts/generate-package-readmes.ts`.
 *   - `getCLISubcommandFlags(packageSrcDir, subcommandModule, argSpecName)`
 *     — drives `cli-command-table.md`. Resolves a named `ArgSpec`
 *     ObjectLiteralExpression and flattens its factory-spread fragments.
 *   - `getMethodKeyedRegistryEntries(packageSrcDir, mapSymbolName)` —
 *     drives `acp-validated-surface.md`. Reads
 *     `Map<ACPMethod, ACPMethodSchemaInfo>` registries built from a
 *     generated artifacts object.
 *   - `getRuntimeRegistryMatrix(packageSrcDir, registrySymbolName)` —
 *     drives `runtime-matrix.md`. Reads each `createAcpHarness({...})`
 *     argument literal in the registry.
 *
 * Each extractor throws with a precise diagnostic on locked-shape
 * mismatch — silent fallthrough corrupts the partial.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Node, Project } from "ts-morph";

// ---------------------------------------------------------------------------
// Filesystem helpers (no ts-morph)
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
// ts-morph project lifecycle
// ---------------------------------------------------------------------------

let cachedProject: Project | null = null;

function getProject(): Project {
  if (cachedProject) return cachedProject;
  // useInMemoryFileSystem=false; we read from disk. No tsconfig is loaded —
  // we only need syntactic parsing of the relevant declarations, not
  // type-checking. Skipping the tsconfig avoids pulling the whole monorepo
  // into the project graph for a one-shot generator run.
  cachedProject = new Project({
    skipAddingFilesFromTsConfig: true,
    useInMemoryFileSystem: false,
  });
  return cachedProject;
}

// ---------------------------------------------------------------------------
// Shared AST helpers
// ---------------------------------------------------------------------------

/**
 * Strip `as <T>`, `<T>` (TypeAssertion), `satisfies <T>`, and parens from
 * an expression. Object literals carrying `as const satisfies Foo` show
 * up as `AsExpression(SatisfiesExpression(ObjectLiteralExpression))`; the
 * inner shape is what extractors care about, so this helper unwraps both
 * forms in any order and any depth. A `Node | undefined` input returns
 * `undefined` to preserve the caller's branch on missing initializers.
 */
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

// ---------------------------------------------------------------------------
// Method-keyed registry extractor (acp-validated-surface)
// ---------------------------------------------------------------------------

/**
 * Walk the package's `src/` tree, find the named `VariableDeclaration`
 * whose initializer is a call of the form
 * `toSchemaInfoMap(<source>.<key>)`, and return the
 * `(method, schemaName)` pairs derived from the referenced object
 * literal.
 *
 * Used for ACP's `Map<ACPMethod, ACPMethodSchemaInfo>` registries
 * (`acpRequestSchemas`, `acpResponseSchemas`). The Maps are constructed
 * at runtime from a generated artifacts object literal; the extractor
 * resolves that indirection statically by:
 *
 *   1. locating the `const <mapSymbolName> = toSchemaInfoMap(<expr>);`
 *      decl,
 *   2. reading the `PropertyAccessExpression` argument to find both the
 *      identifier (e.g. `acpGeneratedSchemaArtifacts`) and the property
 *      name (`requestSchemas` / `responseSchemas`),
 *   3. resolving that identifier's declaration anywhere under
 *      `packageSrcDir`, walking into the property's
 *      `ObjectLiteralExpression` value, and reading each entry's
 *      `method` + `definitionName` literal strings.
 *
 * Each "unexpected shape" branch throws with a precise error rather than
 * falling through silently — silent fallthrough corrupts the partial.
 *
 * Result is sorted by `method` for stable output.
 */
export function getMethodKeyedRegistryEntries(
  packageSrcDir: string,
  mapSymbolName: string,
): Array<{ method: string; schemaName: string }> {
  const project = getProject();
  const sourceFiles = collectTsFiles(packageSrcDir).map((p) => project.addSourceFileAtPath(p));
  try {
    let mapDecl: ReturnType<ReturnType<Project["addSourceFileAtPath"]>["getVariableDeclaration"]>;
    for (const sf of sourceFiles) {
      const candidate = sf.getVariableDeclaration(mapSymbolName);
      if (candidate) {
        mapDecl = candidate;
        break;
      }
    }
    if (!mapDecl) {
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

    let sourceDecl: ReturnType<
      ReturnType<Project["addSourceFileAtPath"]>["getVariableDeclaration"]
    >;
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
      const method = readStringLiteralProperty(
        entryValue,
        "method",
        `${sourceName}.${propertyName}`,
      );
      const schemaName = readStringLiteralProperty(
        entryValue,
        "definitionName",
        `${sourceName}.${propertyName}`,
      );
      entries.push({ method, schemaName });
    }

    return entries.sort((a, b) => a.method.localeCompare(b.method));
  } finally {
    for (const sf of sourceFiles) project.removeSourceFile(sf);
  }
}

// ---------------------------------------------------------------------------
// CLI subcommand extractor (cli-command-table)
// ---------------------------------------------------------------------------

/**
 * Description of a single CLI flag emitted by
 * {@link getCLISubcommandFlags}. `description` falls back to `""` when an
 * `ArgEntry` literal omits its optional `description` property (the
 * parser type allows it). `valueExample` is only populated for
 * `kind: "value"` entries that supply one.
 */
export interface CLISubcommandFlag {
  flag: string;
  kind: "flag" | "value";
  description: string;
  valueExample?: string;
}

/**
 * Walk the named `ArgSpec` constant inside
 * `${packageSrcDir}/${subcommandModule}.ts`, resolve each spread fragment
 * by following the `import` graph back to its declaring module's factory
 * function, and return the union of flag entries. Output is sorted
 * alphabetically by flag name; flag-name collisions across spreads are
 * deduplicated (the first definition wins so explicit per-subcommand
 * entries shadow factory defaults — same shape `parseArgv` consumes at
 * runtime).
 *
 * Two-hop resolution covers the parser pattern used by the cli package:
 * each `<SUBCOMMAND>_ARG_SPEC` is built from inline literals plus a small
 * set of factory spreads (e.g. `...hostPortArgs<T>()`). The extractor
 * only reaches the factory's returned `ObjectLiteralExpression`; deeper
 * spreads (`runtimeSelectArgs` spreads `harnessArg`) are followed
 * recursively.
 *
 * Throws with a precise diagnostic if any of the locked-shape invariants
 * are violated — silent fallthrough corrupts the partial.
 */
export function getCLISubcommandFlags(
  packageSrcDir: string,
  subcommandModule: string,
  argSpecName: string,
): CLISubcommandFlag[] {
  const project = getProject();
  const targetPath = join(packageSrcDir, `${subcommandModule}.ts`);
  if (!existsSync(targetPath)) {
    throw new Error(
      `getCLISubcommandFlags: source module ${JSON.stringify(targetPath)} does not exist.`,
    );
  }

  const sourceFile = project.addSourceFileAtPath(targetPath);
  try {
    const decl = sourceFile.getVariableDeclaration(argSpecName);
    if (!decl) {
      throw new Error(
        `getCLISubcommandFlags: variable ${JSON.stringify(argSpecName)} not found in ${targetPath}.`,
      );
    }
    const initializer = decl.getInitializer();
    if (!initializer || !Node.isObjectLiteralExpression(initializer)) {
      throw new Error(
        `getCLISubcommandFlags: ${argSpecName} in ${targetPath} initializer is ${initializer?.getKindName() ?? "undefined"}, expected ObjectLiteralExpression.`,
      );
    }

    const seen = new Map<string, CLISubcommandFlag>();
    const fragment = collectArgSpecFlags(initializer, sourceFile, project, packageSrcDir);
    for (const flag of fragment) {
      if (!seen.has(flag.flag)) seen.set(flag.flag, flag);
    }

    return [...seen.values()].sort((a, b) => a.flag.localeCompare(b.flag));
  } finally {
    project.removeSourceFile(sourceFile);
  }
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
 * {@link CLISubcommandFlag}. `description` and `valueExample` are
 * optional by parser contract; both default to "" / undefined when
 * absent.
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
 * Follow an imported factory identifier (e.g. `hostPortArgs`) back to
 * its declaring module within `packageSrcDir`, locate the function
 * declaration, and return its single returned ObjectLiteralExpression.
 * Throws if the factory is not local or its body shape is unexpected.
 */
function resolveFactoryReturnLiteral(
  factoryName: string,
  fromFile: ReturnType<Project["addSourceFileAtPath"]>,
  _project: Project,
): {
  literal: Node;
  sourceFile: ReturnType<Project["addSourceFileAtPath"]>;
} {
  // Same-file lookup: factories may declare and reference each other in
  // the same module (e.g. `runtimeSelectArgs` spreads `harnessArg` both
  // declared in `shared-arg-specs.ts`). Check for an in-file function
  // declaration before walking imports.
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
      const fnName = named.getName();
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

// ---------------------------------------------------------------------------
// Runtime registry extractor (runtime-matrix)
// ---------------------------------------------------------------------------

/**
 * Single matrix row emitted by {@link getRuntimeRegistryMatrix}.
 * `command` and `install` are surfaced when the registry entry carries
 * them so the generator can render concise rows; auth and resolveArgs
 * hooks are not exposed here (they belong on a separate, sibling
 * extraction if needed).
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
 * aliases, and emit one row per entry. The registry shape understood
 * here is the one in `packages/gateway-runtime/src/runtimes-registry.ts`:
 * an object literal whose keys are runtime ids and whose values are
 * `createAcpHarness({ id, displayName, description, command?, args?, install? })`
 * call expressions. The extractor reads the `displayName`,
 * `description`, `command`, and (when provided) `install.installHint`
 * literals.
 *
 * Throws with a precise diagnostic if the shape diverges — silent
 * fallthrough corrupts the partial.
 */
export function getRuntimeRegistryMatrix(
  packageSrcDir: string,
  registrySymbolName: string,
): RuntimeRegistryRow[] {
  const project = getProject();
  const opened: ReturnType<Project["addSourceFileAtPath"]>[] = [];
  try {
    let aliasInitializer: Node | undefined;
    let aliasSourceFile: ReturnType<Project["addSourceFileAtPath"]> | undefined;

    for (const filePath of collectTsFiles(packageSrcDir)) {
      const sourceFile = project.addSourceFileAtPath(filePath);
      opened.push(sourceFile);
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
    }

    if (!aliasInitializer || !aliasSourceFile) {
      throw new Error(
        `getRuntimeRegistryMatrix: variable ${JSON.stringify(registrySymbolName)} not found under ${packageSrcDir}.`,
      );
    }

    // The exported registry is `Readonly<Record<…>>` — typically aliasing
    // a local `as const` object literal. Follow one identifier hop if the
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

    return rows.sort((a, b) => a.id.localeCompare(b.id));
  } finally {
    for (const sf of opened) project.removeSourceFile(sf);
  }
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
