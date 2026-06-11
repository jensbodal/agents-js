#!/usr/bin/env bun
/**
 * Run a named script (e.g. `test` or `typecheck`) across every example
 * workspace that defines it, in deterministic order, failing fast.
 *
 * Replaces the hand-maintained `&&` chains in the root `test:examples`
 * and `typecheck:examples` scripts: every new example PR otherwise had to
 * edit those lists, a guaranteed merge-conflict factory. Here the set is
 * derived by scanning `examples/<dir>/package.json` for a `scripts.<name>`
 * entry, so adding an example with a `test`/`typecheck` script is enough
 * to enrol it — no root edit, no conflict.
 *
 * Examples without a `package.json` (e.g. `agent-zero`) or without the
 * requested script are skipped. The derived list is printed before any
 * run so a reviewer can confirm it matches the prior enumeration.
 *
 * Usage: `bun scripts/run-example-scripts.ts <script-name>`
 * Exits non-zero on the first example whose script fails.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const EXAMPLES_DIR = resolve(REPO_ROOT, "examples");

const scriptName = process.argv[2];
if (!scriptName) {
  console.error("[run-example-scripts] missing <script-name> argument");
  console.error("usage: bun scripts/run-example-scripts.ts <test|typecheck>");
  process.exit(2);
}

/** Example dirs that define `scripts.<scriptName>`, in sorted order. */
function deriveExamples(name: string): string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(EXAMPLES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgPath = join(EXAMPLES_DIR, entry.name, "package.json");
    if (!existsSync(pkgPath)) {
      continue;
    }
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch (error) {
      console.error(`[run-example-scripts] unreadable ${pkgPath}: ${String(error)}`);
      process.exit(2);
    }
    if (pkg.scripts?.[name]) {
      matches.push(entry.name);
    }
  }
  return matches.sort();
}

const examples = deriveExamples(scriptName);

console.log(
  `[run-example-scripts] derived ${examples.length} example(s) with a "${scriptName}" script:`,
);
for (const name of examples) {
  console.log(`  - ${name}`);
}

for (const name of examples) {
  const cwd = join(EXAMPLES_DIR, name);
  console.log(`\n[run-example-scripts] ${name}: bun run ${scriptName}`);
  const result = spawnSync("bun", ["run", "--cwd", cwd, scriptName], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(
      `[run-example-scripts] FAILED: ${name} "${scriptName}" exited with ${
        result.status ?? `signal ${result.signal}`
      }`,
    );
    process.exit(result.status ?? 1);
  }
}

console.log(`\n[run-example-scripts] all ${examples.length} example "${scriptName}" run(s) passed`);
