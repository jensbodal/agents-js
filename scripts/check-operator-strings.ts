#!/usr/bin/env bun
/**
 * Operator-specific magic-string deny-list gate.
 *
 * Scans `packages/` and `apps/` for operator-deployment-specific identifiers
 * that should not be hard-coded into product code (use env-driven config or
 * rename instead). Excludes docs, tests, and known-domain type unions.
 *
 * Three classes of checks:
 *   1. Bare-substring deny-list (case-insensitive identifiers in any source).
 *   2. `process.env.<PREFIX>_*` access — operator-deployment env vars should
 *      not be referenced directly by name; route through config helpers.
 *   3. `@<scope>/*` import / specifier paths — packages under operator-owned
 *      scopes must not be imported from product code.
 *
 * GritQL was evaluated for AST-aware matching of (2) and (3) but rejected
 * because `grit check` exits 0 even on `error`-level violations and the
 * `@getgrit/cli` is currently `0.1.0-alpha.*`. Regex passes catch the same
 * surface area for the shapes we care about, with no extra dependency.
 *
 * Exits non-zero on any hit so it can chain into `bun run check`.
 */
import { Glob } from "bun";

const blockedOperatorName = String.fromCharCode(
  100,
  111,
  116,
  45,
  112,
  114,
  111,
  120,
  109,
  111,
  120,
);
const blockedOperatorEnvPrefix = String.fromCharCode(68, 79, 84, 95, 80, 82, 79, 88, 77, 79, 88);

const DENY_LIST = [blockedOperatorName, "pretty-anchor"];
const ENV_PREFIXES = [blockedOperatorEnvPrefix, "PRETTY_ANCHOR"];
const SCOPE_NAMES = [blockedOperatorName, "pretty-anchor"];

const ENV_PATTERN = new RegExp(`process\\.env\\.(${ENV_PREFIXES.join("|")})_[A-Z0-9_]+`);
const SCOPE_PATTERN = new RegExp(`@(${SCOPE_NAMES.join("|")})/`);

const ROOTS = ["packages", "apps"];
const EXCLUDE_PATTERNS = [
  /\.md$/,
  /\.test\.ts$/,
  /\/tests\//,
  /types\.ts$/,
  /node_modules/,
  /\/dist\//,
  /\.git\//,
  /worktrees\//,
];

type Hit = { file: string; line: number; rule: string; preview: string };
const hits: Hit[] = [];

for (const root of ROOTS) {
  const glob = new Glob(`${root}/**/*.{ts,tsx,js,mjs,cjs,json}`);
  for await (const file of glob.scan({ cwd: process.cwd() })) {
    if (EXCLUDE_PATTERNS.some((p) => p.test(file))) continue;
    const text = await Bun.file(file).text();
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const preview = line.trim().slice(0, 120);

      for (const term of DENY_LIST) {
        if (line.includes(term)) {
          hits.push({
            file,
            line: i + 1,
            rule: `substring:${term}`,
            preview,
          });
        }
      }

      const envMatch = line.match(ENV_PATTERN);
      if (envMatch) {
        hits.push({
          file,
          line: i + 1,
          rule: `env:${envMatch[0]}`,
          preview,
        });
      }

      const scopeMatch = line.match(SCOPE_PATTERN);
      if (scopeMatch) {
        hits.push({
          file,
          line: i + 1,
          rule: `scope:@${scopeMatch[1]}/`,
          preview,
        });
      }
    }
  }
}

if (hits.length > 0) {
  console.error(
    `✗ Operator-specific magic strings found (${hits.length} hit${hits.length === 1 ? "" : "s"}):`,
  );
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  [${h.rule}]  ${h.preview}`);
  }
  console.error(
    "\nMove these to env-driven config or rename. See scripts/check-operator-strings.ts deny-list.",
  );
  process.exit(1);
}

console.log(`✓ No operator-specific magic strings in ${ROOTS.join(", ")}`);
