#!/usr/bin/env bun

import { rm } from "node:fs/promises";
import { runForeground } from "./process-utils.ts";

const maxAttempts = 3;

function useFrozenLockfile(argv: string[]): boolean {
  return argv.includes("--frozen-lockfile") || argv.includes("--ci");
}

async function installDependencies(argv: string[]): Promise<void> {
  const frozenLockfile = useFrozenLockfile(argv);
  // Use `bun install --frozen-lockfile` (validates, fails on drift) instead
  // of `bun ci` (deletes node_modules first and has produced opaque runner
  // failures).
  // Both are documented as equivalent in bun 1.x, but `bun install
  // --frozen-lockfile` matches what the pre-push hook uses, so we get one
  // consistent install behavior across local + CI surfaces.
  const installCommand = frozenLockfile
    ? ["bun", "install", "--frozen-lockfile"]
    : ["bun", "install"];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await runForeground(installCommand);
      return;
    } catch (error) {
      if (attempt === maxAttempts) {
        throw error;
      }

      console.warn(`[install-deps] attempt ${attempt} failed; clearing Bun cache and retrying...`);
      try {
        await runForeground(["bun", "pm", "cache", "rm"]);
      } catch (cacheError) {
        console.warn(`[install-deps] bun pm cache rm failed: ${String(cacheError)}`);
      }

      await rm("node_modules", { force: true, recursive: true });
      await Bun.sleep(2_000);
    }
  }
}

if (import.meta.main) {
  try {
    await installDependencies(Bun.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
