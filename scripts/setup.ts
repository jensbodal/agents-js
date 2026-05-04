#!/usr/bin/env bun

import { runForeground } from "./process-utils.ts";

async function ensureGitHooksPath(): Promise<void> {
  console.log("[setup] git config core.hooksPath .githooks");
  await runForeground(["git", "config", "core.hooksPath", ".githooks"]);
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  // Do NOT statically import from ./doctor.ts here. doctor.ts's module graph
  // pulls in `@agents-js/gateway-runtime` (a workspace package), which isn't
  // resolvable on a cold CI checkout until `install-deps.ts` has run. We
  // forward argv to the doctor subprocess instead so setup.ts stays
  // bootstrap-clean (its entire static import set is either node:* or
  // script-local files).
  await ensureGitHooksPath();
  // Forward argv to install-deps so callers can pass --frozen-lockfile / --ci
  // and get a strict-lockfile-required install. Per Jens's 2026-04-27
  // directive, lockfile sync is enforced — CI passes --frozen-lockfile so
  // a stale lock fails the build instead of silently regenerating.
  await runForeground(["bun", "scripts/install-deps.ts", ...argv]);
  await runForeground(["bun", "scripts/doctor.ts", ...argv]);
  await runForeground(["bun", "scripts/build.ts"]);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
