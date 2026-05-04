#!/usr/bin/env bun

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getGatewayRuntimeDefinition } from "@agents-js/gateway-runtime";
import { gatewayConfig } from "../apps/internal-gateway/gateway.config.ts";
import { runForeground } from "./process-utils.ts";

type E2EGateOptions = {
  headed: boolean;
  includeRuntimeSwitchSmoke: boolean;
  profile?: string;
  runtime: string;
};

function printUsage(): void {
  console.log(
    [
      "e2e",
      "",
      "Usage:",
      "  bun scripts/e2e.ts [--runtime <id>] [--profile <name>] [--headed] [--include-runtime-switch-smoke]",
      "",
      "Runs the deterministic gate first, then the targeted runtime and live web-ui lanes.",
      "Cross-runtime smoke is opt-in so the default path stays on the checked-in runtime.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): E2EGateOptions {
  let runtime = getGatewayRuntimeDefinition(gatewayConfig.runtime).id;
  let profile: string | undefined;
  let headed = false;
  let includeRuntimeSwitchSmoke = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--runtime":
        if (!next) {
          throw new Error('[e2e] Missing value for "--runtime".');
        }
        runtime = getGatewayRuntimeDefinition(next).id;
        index += 1;
        break;
      case "--profile":
        if (!next) {
          throw new Error('[e2e] Missing value for "--profile".');
        }
        profile = next;
        index += 1;
        break;
      case "--headed":
        headed = true;
        break;
      case "--include-runtime-switch-smoke":
        includeRuntimeSwitchSmoke = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`[e2e] Unknown argument: ${arg}`);
    }
  }

  return { runtime, profile, headed, includeRuntimeSwitchSmoke };
}

async function runStep(label: string, argv: string[]): Promise<void> {
  console.log(`[e2e] ${label}`);
  await runForeground(argv);
}

export function buildDeterministicGateArgv(options: {
  headed: boolean;
  playwrightCacheRoot?: string;
}): string[] {
  const argv = ["bun", "run", "e2e:deterministic"];
  if (options.headed || options.playwrightCacheRoot) {
    argv.push("--");
  }
  if (options.headed) {
    argv.push("--headed");
  }
  if (options.playwrightCacheRoot) {
    argv.push("--playwright-cache-root", options.playwrightCacheRoot);
  }
  return argv;
}

export function buildLiveWebGateArgv(options: {
  headed: boolean;
  includeRuntimeSwitchCheck?: boolean;
  playwrightCacheRoot?: string;
  runtime: string;
}): string[] {
  const argv = ["bun", "run", "e2e:web:live", "--", "--runtime", options.runtime];
  if (options.headed) {
    argv.push("--headed");
  }
  if (options.includeRuntimeSwitchCheck) {
    argv.push("--include-runtime-switch-check");
  }
  if (options.playwrightCacheRoot) {
    argv.push("--playwright-cache-root", options.playwrightCacheRoot);
  }
  return argv;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const playwrightCacheRoot = await mkdtemp(path.join(tmpdir(), "agents-js-playwright-cache-"));

  try {
    await runStep(
      "deterministic gate",
      buildDeterministicGateArgv({
        headed: options.headed,
        playwrightCacheRoot,
      }),
    );

    const runtimeArgv = ["bun", "run", "e2e:runtime", "--", "--runtime", options.runtime];
    if (options.profile) {
      runtimeArgv.push("--profile", options.profile);
    }
    await runStep("runtime gate", runtimeArgv);

    if (options.profile) {
      console.log(
        `[e2e] Note: --profile ${options.profile} applies to e2e:runtime only; e2e:web:live uses bun run dev --runtime ${options.runtime}.`,
      );
    }

    if (options.includeRuntimeSwitchSmoke) {
      await runStep("runtime switch smoke", ["bun", "scripts/runtime-switch-smoke.ts"]);
    }

    await runStep(
      "web-ui live gate",
      buildLiveWebGateArgv({
        headed: options.headed,
        includeRuntimeSwitchCheck: options.includeRuntimeSwitchSmoke,
        playwrightCacheRoot,
        runtime: options.runtime,
      }),
    );
  } finally {
    await rm(playwrightCacheRoot, { recursive: true, force: true }).catch(() => {});
  }
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
