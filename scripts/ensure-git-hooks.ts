#!/usr/bin/env bun
/**
 * Postinstall bootstrap: enables in-tree git hooks at `.githooks/`.
 *
 * Idempotent. Runs on every `bun install` so fresh clones + new
 * worktrees get the pre-push/pre-commit gates automatically without
 * an explicit `bun run setup` step.
 *
 * The hooks live in `.githooks/`. The `scripts/setup.ts` doctor flow
 * does the same thing on full setup; this postinstall ensures the
 * minimum (hooks enabled) happens even when developers skip `bun run setup`.
 *
 * If `core.hooksPath` is already set to `.githooks`, no-op + quiet exit.
 * If it's set to a different value, log a warning but don't overwrite —
 * the developer may have intentionally customized.
 */

import { spawnSync } from "node:child_process";

function gitConfigRead(key: string): string | null {
  const result = spawnSync("git", ["config", "--local", "--get", key], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.toString().trim();
}

function gitConfigSet(key: string, value: string): boolean {
  const result = spawnSync("git", ["config", "--local", key, value], {
    stdio: "inherit",
  });
  return result.status === 0;
}

function main(): void {
  const TARGET = ".githooks";
  const current = gitConfigRead("core.hooksPath");

  if (current === TARGET) {
    // Already set, no-op.
    return;
  }

  if (current !== null && current !== TARGET) {
    console.warn(
      `[postinstall] git core.hooksPath is set to '${current}', expected '${TARGET}'. Skipping auto-config — set manually via 'git config --local core.hooksPath ${TARGET}' if you want the in-tree hooks.`,
    );
    return;
  }

  // Unset — enable our in-tree hooks.
  if (gitConfigSet("core.hooksPath", TARGET)) {
    console.log(`[postinstall] git core.hooksPath enabled at ${TARGET}`);
  }
}

main();
