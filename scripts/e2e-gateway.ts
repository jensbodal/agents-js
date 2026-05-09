#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./process-utils.ts";
import { repoRoot } from "./workspace-config.ts";

type GatewayE2EOptions = {
  outDir: string;
};

function printUsage(): void {
  console.log(
    [
      "e2e:gateway",
      "",
      "Usage:",
      "  bun scripts/e2e-gateway.ts [--out-dir <path>]",
      "",
      "Runs the mock-backed internal gateway transport proof and writes",
      "summary artifacts under output/e2e/gateway by default.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): GatewayE2EOptions {
  let outDir = path.join(repoRoot, "output/e2e/gateway");

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--out-dir":
        if (!next) {
          throw new Error('[e2e:gateway] Missing value for "--out-dir".');
        }
        outDir = path.resolve(repoRoot, next);
        index += 1;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`[e2e:gateway] Unknown argument: ${arg}`);
    }
  }

  return { outDir };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });

  const result = await runCommand(["bun", "scripts/gateway-smoke.ts"], {
    cwd: repoRoot,
    allowFailure: true,
    timeoutMs: 120_000,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const summary = {
    command: "bun run e2e:gateway",
    passed: result.code === 0 && result.timedOut !== true,
    timedOut: result.timedOut,
    outputFiles: {
      stdout: "stdout.log",
      stderr: "stderr.log",
    },
  };

  await Promise.all([
    writeFile(path.join(options.outDir, "stdout.log"), result.stdout),
    writeFile(path.join(options.outDir, "stderr.log"), result.stderr),
    writeFile(path.join(options.outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`),
  ]);

  if (summary.passed) {
    console.log(`[e2e:gateway] passed (${options.outDir})`);
    return;
  }

  throw new Error(`[e2e:gateway] failed; see ${path.join(options.outDir, "summary.json")}`);
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
