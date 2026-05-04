#!/usr/bin/env bun

import path from "node:path";
import {
  detectInstalledGatewayRuntimes,
  type GatewayRuntimeId,
  MOCK_ACP_RUNTIME_ENV,
} from "@agents-js/gateway-runtime";
import { runForeground } from "./process-utils.ts";
import { repoRoot } from "./workspace-config.ts";

type DeterministicGateOptions = {
  headed: boolean;
  playwrightCacheRoot?: string;
};

function printUsage(): void {
  console.log(
    [
      "e2e:deterministic",
      "",
      "Usage:",
      "  bun scripts/e2e-deterministic.ts [--headed] [--playwright-cache-root <path>]",
      "",
      "Runs the deterministic repo gate: check, test, docs:build, e2e:gateway,",
      "then the real-runtime A2A gate. By default (including CI) the gate runs",
      "against the in-repo mock-acp runtime so no live binary is required.",
      "Set AGENTS_JS_REAL_RUNTIME=1 to use a live opencode or claude-agent-acp",
      "binary instead (falls back to a WARNING if no runtime is detected).",
      "",
      "NOTE: browser:smoke is NOT part of this gate. It's retained as",
      "`bun run browser:smoke` for local use, but the happy-dom component",
      "suite in packages/ui-components/tests already covers the same",
      "assertions without requiring a real Chromium (which was introducing",
      "recurring flakes from Playwright CDN + OS-lib + version-skew issues).",
      "",
      "The --headed and --playwright-cache-root flags are accepted for",
      "backwards compatibility with scripts/e2e.ts's buildDeterministicGateArgv",
      "but are no-ops now that browser:smoke isn't called from here.",
    ].join("\n"),
  );
}

/**
 * Loud, greppable skip marker for the real-runtime gate. CI logs must be
 * searchable for "SKIPPED" so operators can spot missing runtimes without
 * reading every line.
 */
const REAL_RUNTIME_SKIP_MARKER =
  "[e2e:deterministic] dev-runtime smoke gate SKIPPED " +
  "— install opencode (https://opencode.ai) or ensure @zed-industries/claude-agent-acp " +
  "is workspace-installed to enable this gate.";

const REAL_RUNTIME_PREFERENCE: readonly GatewayRuntimeId[] = ["opencode", "claude"];

async function pickRealRuntimeGateTarget(): Promise<GatewayRuntimeId | undefined> {
  // Walk the apps/internal-gateway workspace bin so claude-agent-acp resolves
  // via the workspace install layout, matching how `bun run e2e:runtime`
  // invokes `resolveGatewayRuntime` at runtime.
  const workspaceBinRoot = path.join(repoRoot, "apps", "internal-gateway");

  const installed = await detectInstalledGatewayRuntimes({ workspaceBinRoot });
  for (const candidate of REAL_RUNTIME_PREFERENCE) {
    if (installed.includes(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseArgs(argv: string[]): DeterministicGateOptions {
  let headed = false;
  let playwrightCacheRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--headed") {
      headed = true;
      continue;
    }
    if (arg === "--playwright-cache-root") {
      if (!next) {
        throw new Error('[e2e:deterministic] Missing value for "--playwright-cache-root".');
      }
      playwrightCacheRoot = next;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`[e2e:deterministic] Unknown argument: ${arg}`);
  }

  return { headed, playwrightCacheRoot };
}

export function buildDeterministicWebMockArgv(options: DeterministicGateOptions): string[] {
  const webMockArgv = ["bun", "run", "browser:smoke"];
  if (options.headed || options.playwrightCacheRoot) {
    webMockArgv.push("--");
  }
  if (options.headed) {
    webMockArgv.push("--headed");
  }
  if (options.playwrightCacheRoot) {
    webMockArgv.push("--playwright-cache-root", options.playwrightCacheRoot);
  }

  return webMockArgv;
}

async function runStep(
  label: string,
  argv: string[],
  options: { env?: Record<string, string> } = {},
): Promise<void> {
  console.log(`[e2e:deterministic] ${label}`);
  await runForeground(argv, options);
}

async function main(): Promise<void> {
  parseArgs(process.argv.slice(2));

  await runStep("check", ["bun", "run", "check"]);
  await runStep("test", ["bun", "run", "test"]);
  await runStep("docs:build", ["bun", "run", "docs:build"]);
  await runStep("e2e:gateway", ["bun", "run", "e2e:gateway"]);
  // browser:smoke intentionally NOT in the gate — see printUsage() for rationale.

  // When AGENTS_JS_REAL_RUNTIME=1 (explicit local-dev opt-in), use a live binary.
  // Otherwise (including CI), use the mock-acp runtime so the gate always runs.
  const useRealRuntime = process.env.AGENTS_JS_REAL_RUNTIME === "1";

  if (useRealRuntime) {
    const runtimeTarget = await pickRealRuntimeGateTarget();
    if (!runtimeTarget) {
      console.warn("");
      console.warn("================================================================");
      console.warn(`WARNING: ${REAL_RUNTIME_SKIP_MARKER}`);
      console.warn("================================================================");
      console.warn("");
      return;
    }
    await runStep(`e2e:runtime (${runtimeTarget})`, [
      "bun",
      "run",
      "e2e:runtime",
      "--",
      "--runtime",
      runtimeTarget,
    ]);
    return;
  }

  // Default path (CI and local dev without explicit real-runtime opt-in):
  // exercise the full real-runtime gate against the deterministic mock.
  await runStep(
    "e2e:runtime (mock-acp)",
    ["bun", "run", "e2e:runtime", "--", "--runtime", "mock-acp"],
    {
      env: { [MOCK_ACP_RUNTIME_ENV]: "1" },
    },
  );
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
