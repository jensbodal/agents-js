import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const packagesDir = path.join(repoRoot, "packages");

// Matches `export * from "@some-scope/some-package"` OR `export * from "@some-scope/some-package/subpath"`.
// Does NOT match in-package relative re-exports (`export * from "./foo.ts"`).
// Captures the scoped specifier so we can classify first-party (@agents-js/*) vs external.
const WILDCARD_CROSS_PACKAGE_EXPORT = /^\s*export\s*\*\s*from\s*['"](@[^'"./][^'"]*)['"]/m;

// Matches `import * as NS from "@agents-js/..."` — wildcard-namespace imports against first-party packages.
// We only forbid against first-party (@agents-js) namespace imports because the trap only applies to packages
// whose surface we own: if @agents-js/X renames a symbol to @agents-js/Y, a wildcard namespace import silently
// skips the symbol without a type error.
const WILDCARD_NAMESPACE_IMPORT_FIRST_PARTY =
  /^\s*import\s*\*\s*as\s+\w+\s*from\s*['"]@agents-js\/[^'"]+['"]/m;

// Allowlisted external-facade packages. These packages intentionally re-export another ecosystem's types
// (AG-UI, A2UI) as a stable @agents-js/* surface for our consumers. The rule is: first-party packages
// must not wildcard-re-export from OTHER first-party packages — cross-external re-exports are fine because
// we control neither side of the facade.
const EXTERNAL_FACADE_EXPORTS = new Set<string>([
  "@ag-ui/core",
  "@a2ui/web_core/v0_9",
  "@a2ui/web_core/v0_9/basic_catalog",
]);

async function listPackageIndexFiles(): Promise<string[]> {
  const entries = await readdir(packagesDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const indexPath = path.join(packagesDir, entry.name, "src", "index.ts");
    try {
      await readFile(indexPath, "utf8");
      files.push(indexPath);
    } catch {
      // Not all packages have src/index.ts; skip silently.
    }
  }
  return files.sort();
}

async function listAllPackageSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const srcDir = path.join(packagesDir, entry.name, "src");
    await collectTsFiles(srcDir, files);
  }
  return files.sort();
}

async function collectTsFiles(dir: string, out: string[]): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTsFiles(full, out);
    } else if (
      entry.isFile() &&
      /\.(?:[cm]?ts|tsx)$/.test(entry.name) &&
      !/\.(?:test|spec)\./.test(entry.name)
    ) {
      out.push(full);
    }
  }
}

/**
 * Scans a file for lines matching `export * from "<specifier>"` that point at a scoped package
 * (NOT a relative path). Returns the offending specifiers, filtered to disallow only first-party
 * @agents-js/* targets — external facades in EXTERNAL_FACADE_EXPORTS are permitted.
 */
function findForbiddenWildcardReExports(content: string): string[] {
  const violations: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const match = line.match(WILDCARD_CROSS_PACKAGE_EXPORT);
    if (!match) continue;
    const specifier = match[1];
    if (specifier === undefined) continue;
    // Permit external facades.
    if (EXTERNAL_FACADE_EXPORTS.has(specifier)) continue;
    // Enforce against any other scoped package (most importantly @agents-js/*).
    violations.push(specifier);
  }
  return violations;
}

function findForbiddenNamespaceImports(content: string): string[] {
  const violations: string[] = [];
  const lines = content.split("\n");
  for (const line of lines) {
    const match = line.match(WILDCARD_NAMESPACE_IMPORT_FIRST_PARTY);
    if (!match) continue;
    violations.push(line.trim());
  }
  return violations;
}

describe("package barrel imports", () => {
  // Regression test ensures the barrel scanner catches the drift class that
  // motivated the rule: symbols silently re-exported from another first-party
  // surface can keep stale downstream imports type-checking after the owning
  // surface changes. A deliberately-staged violation string is scanned here
  // -- NOT written to a real package file -- to confirm the detector fires.
  test('regression: scanner detects `export * from "@agents-js/policy"` at package boundary', () => {
    const deliberateViolation = 'export * from "@agents-js/policy";\n';
    const violations = findForbiddenWildcardReExports(deliberateViolation);
    expect(violations).toEqual(["@agents-js/policy"]);
  });

  test("regression: scanner permits in-package relative re-exports", () => {
    const permitted = 'export * from "./frontmatter.ts";\n';
    const violations = findForbiddenWildcardReExports(permitted);
    expect(violations).toEqual([]);
  });

  test("regression: scanner permits external-facade re-exports", () => {
    const facade =
      'export * from "@ag-ui/core";\nexport * from "@a2ui/web_core/v0_9";\nexport * from "@a2ui/web_core/v0_9/basic_catalog";\n';
    const violations = findForbiddenWildcardReExports(facade);
    expect(violations).toEqual([]);
  });

  test("regression: scanner catches first-party namespace import", () => {
    const deliberate = 'import * as Host from "@agents-js/acp-host";\n';
    const violations = findForbiddenNamespaceImports(deliberate);
    expect(violations.length).toBe(1);
  });

  test("no package src/index.ts wildcard-re-exports another first-party package", async () => {
    const indexFiles = await listPackageIndexFiles();
    const offenders: Array<{ file: string; specifiers: string[] }> = [];
    for (const file of indexFiles) {
      const content = await readFile(file, "utf8");
      const specifiers = findForbiddenWildcardReExports(content);
      if (specifiers.length > 0) {
        offenders.push({ file: path.relative(repoRoot, file), specifiers });
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no package src/** file uses wildcard namespace import against @agents-js/*", async () => {
    const sourceFiles = await listAllPackageSourceFiles();
    const offenders: Array<{ file: string; lines: string[] }> = [];
    for (const file of sourceFiles) {
      const content = await readFile(file, "utf8");
      const lines = findForbiddenNamespaceImports(content);
      if (lines.length > 0) {
        offenders.push({ file: path.relative(repoRoot, file), lines });
      }
    }
    expect(offenders).toEqual([]);
  });
});
