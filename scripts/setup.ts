#!/usr/bin/env bun

import { runForeground } from "./process-utils.ts";

interface SetupArgs {
  doctorArgs: string[];
  installArgs: string[];
}

async function ensureGitHooksPath(): Promise<void> {
  console.log("[setup] git config core.hooksPath .githooks");
  await runForeground(["git", "config", "core.hooksPath", ".githooks"]);
}

function splitSetupArgs(argv: string[]): SetupArgs {
  const doctorArgs: string[] = [];
  const installArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--ci":
      case "--frozen-lockfile":
        installArgs.push(arg);
        break;
      case "--runtime": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error('[setup] Missing value for "--runtime".');
        }
        doctorArgs.push(arg, next);
        index += 1;
        break;
      }
      default:
        throw new Error(
          `[setup] Unknown argument "${arg}". Supported args: --ci, --frozen-lockfile, --runtime <runtime>.`,
        );
    }
  }

  return { doctorArgs, installArgs };
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const args = splitSetupArgs(argv);
  // Do NOT statically import from ./doctor.ts here. doctor.ts's module graph
  // pulls in `@agents-js/gateway-runtime` (a workspace package), which isn't
  // resolvable on a cold CI checkout until `install-deps.ts` has run. We
  // invoke doctor in a subprocess so setup.ts stays
  // bootstrap-clean (its entire static import set is either node:* or
  // script-local files).
  await ensureGitHooksPath();
  // Forward install-only args to install-deps so callers can pass
  // --frozen-lockfile / --ci and get a strict-lockfile-required install. Per
  // Jens's 2026-04-27 directive, lockfile sync is enforced — CI passes --ci so
  // a stale lock fails the build instead of silently regenerating.
  await runForeground(["bun", "scripts/install-deps.ts", ...args.installArgs]);
  await runForeground(["bun", "scripts/doctor.ts", ...args.doctorArgs]);
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
