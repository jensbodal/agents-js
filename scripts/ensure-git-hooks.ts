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
 * Otherwise set it to `.githooks`; the repository default should not be
 * silently bypassed by stale local hook configuration.
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

  if (gitConfigSet("core.hooksPath", TARGET)) {
    const previous = current === null ? "unset" : `'${current}'`;
    console.log(`[postinstall] git core.hooksPath set to ${TARGET} (was ${previous})`);
  }
}

main();
