#!/usr/bin/env bun
/**
 * Generate docs/public/graph.json — package-level dependency graph for the
 * /dependencies page and any agent-parseable consumer.
 *
 * Walks packages/<name>/package.json + apps/<name>/package.json, extracts:
 *   - internal edges (other @agents-js/* deps)
 *   - external deps
 *   - peer deps (external)
 *   - reverse edges (dependents) per package
 *
 * Idempotent. Safe to run from any cwd — paths are resolved from this file.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const OUT = resolve(REPO_ROOT, "docs/public/graph.json");

interface Pkg {
  name: string;
  dir: string;
  private: boolean;
  version: string;
  internal_deps: string[];
  external_deps: string[];
  external_peer: string[];
  exports_count: number;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function listDirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

const pkgs: Pkg[] = [];

for (const scope of ["packages", "apps", "extras", "tests"]) {
  const scopeDir = join(REPO_ROOT, scope);
  for (const name of listDirs(scopeDir)) {
    // tests/ contains test fixtures and shared helpers; only the trial-agent
    // subdir is a real workspace member with its own package.json.
    if (scope === "tests" && name !== "trial-agent") continue;
    const manifestPath = join(scopeDir, name, "package.json");
    let manifest: Record<string, unknown>;
    try {
      manifest = readJson(manifestPath);
    } catch {
      continue;
    }
    const pkgName = (manifest.name as string) ?? `unknown-${name}`;
    const deps = (manifest.dependencies as Record<string, string>) ?? {};
    const peer = (manifest.peerDependencies as Record<string, string>) ?? {};
    const internal = Object.keys(deps).filter((d) => d.startsWith("@agents-js/"));
    const external = Object.keys(deps).filter((d) => !d.startsWith("@agents-js/"));
    pkgs.push({
      name: pkgName,
      dir: `${scope}/${name}`,
      private: Boolean(manifest.private),
      version: (manifest.version as string) ?? "0.0.0",
      internal_deps: internal.sort(),
      external_deps: external.sort(),
      external_peer: Object.keys(peer)
        .filter((d) => !d.startsWith("@agents-js/"))
        .sort(),
      exports_count: 0,
    });
  }
}

const reverseEdges = new Map<string, string[]>();
for (const p of pkgs) reverseEdges.set(p.name, []);
for (const p of pkgs) {
  for (const dep of p.internal_deps) {
    reverseEdges.get(dep)?.push(p.name);
  }
}

const graph = {
  generated_at: new Date().toISOString(),
  package_count: pkgs.length,
  publishable_count: pkgs.filter((p) => !p.private).length,
  packages: pkgs.sort((a, b) => a.name.localeCompare(b.name)),
  reverse_edges: Object.fromEntries(reverseEdges),
};

writeFileSync(OUT, `${JSON.stringify(graph, null, 2)}\n`);
console.log(`wrote ${OUT} — ${pkgs.length} packages (${graph.publishable_count} publishable)`);
