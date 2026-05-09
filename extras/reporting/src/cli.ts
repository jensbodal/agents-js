#!/usr/bin/env bun
import { resolve } from "node:path";
import { generateReport } from "./orchestrator.ts";

interface ParsedArgs {
  repoRoot: string;
  outDir?: string;
  model?: "gpt-5.3-codex-spark";
  maxConcurrency?: number;
  profileId?: "generic" | "agents-js";
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    printHelp();
    return;
  }

  const parsed = parseArgs(process.argv.slice(2));
  const result = await generateReport({
    repoRoot: parsed.repoRoot,
    outDir: parsed.outDir,
    model: parsed.model,
    maxConcurrency: parsed.maxConcurrency,
    profileId: parsed.profileId,
  });

  console.log(`Report generated at ${result.reportDir}`);
  console.log(`- Findings: ${result.findingsPath}`);
  console.log(`- Canvas: ${result.canvasPath}`);
  console.log(`- Evidence: ${result.evidencePath}`);
  console.log(`- Sources: ${result.sourcesPath}`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    repoRoot: process.cwd(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--repo": {
        parsed.repoRoot = resolve(consumeValue(argv, ++i, "--repo"));
        break;
      }
      case "--out": {
        parsed.outDir = consumeValue(argv, ++i, "--out");
        break;
      }
      case "--model": {
        const model = consumeValue(argv, ++i, "--model");
        if (model !== "gpt-5.3-codex-spark") {
          throw new Error(`Unsupported model ${model}. Use gpt-5.3-codex-spark.`);
        }
        parsed.model = model;
        break;
      }
      case "--max-concurrency": {
        const raw = consumeValue(argv, ++i, "--max-concurrency");
        const numeric = Number(raw);
        if (!Number.isInteger(numeric) || numeric < 1) {
          throw new Error("--max-concurrency must be a positive integer");
        }
        parsed.maxConcurrency = numeric;
        break;
      }
      case "--profile": {
        const value = consumeValue(argv, ++i, "--profile");
        if (value !== "generic" && value !== "agents-js") {
          throw new Error("--profile must be either generic or agents-js");
        }
        parsed.profileId = value;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return parsed;
}

function consumeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(
    `agents-report\n\nUsage:\n  bun packages/reporting/src/cli.ts [options]\n\nOptions:\n  --repo <path>               Repository root (default: current dir)\n  --out <path>                Output directory root (default: _dot/reports)\n  --model <name>              Model (must be gpt-5.3-codex-spark)\n  --max-concurrency <n>       Worker concurrency (default: 4)\n  --profile <generic|agents-js>  Optional profile override\n  --help                      Show help\n`,
  );
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
