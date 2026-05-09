import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const transpiler = new Bun.Transpiler({ loader: "ts" });

type ScannedImport = { kind: string; path: string };

/** Strip a leading `#!/usr/bin/env bun` shebang — valid at runtime, rejected by the transpiler. */
function stripShebang(source: string): string {
  return source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
}

async function scanImports(filePath: string): Promise<ScannedImport[]> {
  const source = stripShebang(await readFile(filePath, "utf8"));
  return transpiler.scanImports(source) as ScannedImport[];
}

/**
 * Collect every TypeScript file reachable from `entryPath` by following
 * `./*` / `../*` imports (both static `import` statements and dynamic
 * `import()` calls with literal specifiers). Stops at bare specifiers —
 * those are the boundary a bootstrap-clean script cannot cross before
 * `install-deps.ts` populates `node_modules`.
 */
async function collectLocalModuleGraph(entryPath: string): Promise<string[]> {
  const visited = new Set<string>();
  const queue: string[] = [entryPath];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath || visited.has(currentPath)) continue;
    visited.add(currentPath);

    for (const imp of await scanImports(currentPath)) {
      if (!imp.path.startsWith(".")) continue;
      queue.push(path.resolve(path.dirname(currentPath), imp.path));
    }
  }

  return Array.from(visited);
}

/**
 * Return every bare specifier (non-relative, non-node) that `filePath`
 * imports in a way that requires runtime resolution. Covers both static
 * `import` statements and dynamic `import()` calls with literal
 * specifiers — anything that needs `node_modules` populated to succeed
 * at parse/execute time. Type-only imports are correctly excluded
 * because the transpiler erases them.
 */
async function collectRuntimeBareImports(filePath: string): Promise<string[]> {
  const bare = new Set<string>();
  for (const imp of await scanImports(filePath)) {
    if (imp.path.startsWith(".")) continue;
    if (imp.path.startsWith("node:")) continue;
    bare.add(imp.path);
  }
  return Array.from(bare);
}

describe("bootstrap invariants", () => {
  test("scripts/setup.ts static module graph does not depend on workspace packages", async () => {
    // setup.ts runs install-deps.ts to populate node_modules. Anything it
    // statically (or dynamically with a literal specifier) imports from the
    // local module graph must be resolvable before node_modules exists on a
    // cold checkout — otherwise Bun fails at parse time, before setup.ts
    // can even start the install step.
    const entry = path.join(repoRoot, "scripts", "setup.ts");
    const graph = await collectLocalModuleGraph(entry);

    const offenders: Array<{ file: string; imports: string[] }> = [];
    for (const filePath of graph) {
      const bareImports = await collectRuntimeBareImports(filePath);
      const workspaceImports = bareImports.filter((i) => i.startsWith("@agents-js/"));
      if (workspaceImports.length > 0) {
        offenders.push({
          file: path.relative(repoRoot, filePath),
          imports: workspaceImports,
        });
      }
    }

    if (offenders.length > 0) {
      const report = offenders
        .map((o) => `  ${o.file}: imports ${o.imports.join(", ")}`)
        .join("\n");
      throw new Error(
        `setup.ts's module graph pulls in workspace packages that won't be\n` +
          `resolvable on a cold CI checkout (before install-deps.ts runs):\n${report}\n\n` +
          `Fix by moving the import inside a subprocess spawned after install-deps.ts,\n` +
          `or inlining the needed functionality directly in setup.ts.`,
      );
    }

    expect(graph.length).toBeGreaterThanOrEqual(2);
  });
});
