#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type GatewayRuntimeId,
  getGatewayRuntimeDefinition,
  MOCK_ACP_RUNTIME_ENV,
} from "@agents-js/gateway-runtime";
import { gatewayConfig } from "../apps/internal-gateway/gateway.config.ts";
import { ensureWorkspaceBuildOutputs } from "./build.ts";
import { runCommand } from "./process-utils.ts";
import {
  extractRuntimeE2EProofChecks,
  extractRuntimeE2EResult,
  type RuntimeE2EFailureClassification,
  type RuntimeE2EResultContract,
} from "./runtime-e2e-contract.ts";
import { repoRoot } from "./workspace-config.ts";

type RuntimeE2EOptions = {
  outDir: string;
  profile?: string;
  runtime: GatewayRuntimeId;
};

function printUsage(): void {
  console.log(
    [
      "e2e:runtime",
      "",
      "Usage:",
      "  bun scripts/e2e-runtime.ts [--runtime <id>] [--profile <name>] [--out-dir <path>]",
      "",
      "Runs the real-runtime A2A e2e lane and writes summary artifacts under",
      "output/e2e/runtime/<runtime> by default.",
    ].join("\n"),
  );
}

function fallbackRuntimeClassification(
  status: "malformed" | "missing",
): RuntimeE2EFailureClassification {
  if (status === "malformed") {
    return "gateway-a2a-contract-problem";
  }

  return "gateway-a2a-contract-problem";
}

export function resolveRuntimeE2EOutcome(
  output: string,
  passedProcess: boolean,
): {
  classification: "passed" | RuntimeE2EFailureClassification;
  resultContract: RuntimeE2EResultContract | null;
  resultContractStatus: ReturnType<typeof extractRuntimeE2EResult>["status"];
  resultContractValue: string | null;
} {
  const parsedContract = extractRuntimeE2EResult(output);

  return {
    classification: passedProcess
      ? "passed"
      : parsedContract.status === "ok"
        ? parsedContract.result.classification
        : fallbackRuntimeClassification(parsedContract.status),
    resultContract: parsedContract.status === "ok" ? parsedContract.result : null,
    resultContractStatus: parsedContract.status,
    resultContractValue: parsedContract.status === "malformed" ? parsedContract.value : null,
  };
}

function parseArgs(argv: string[]): RuntimeE2EOptions {
  let runtime = getGatewayRuntimeDefinition(gatewayConfig.runtime).id;
  let profile: string | undefined;
  let outDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    switch (arg) {
      case "--runtime":
        if (!next) {
          throw new Error('[e2e:runtime] Missing value for "--runtime".');
        }
        runtime = getGatewayRuntimeDefinition(next).id;
        index += 1;
        break;
      case "--profile":
        if (!next) {
          throw new Error('[e2e:runtime] Missing value for "--profile".');
        }
        profile = next;
        index += 1;
        break;
      case "--out-dir":
        if (!next) {
          throw new Error('[e2e:runtime] Missing value for "--out-dir".');
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
        throw new Error(`[e2e:runtime] Unknown argument: ${arg}`);
    }
  }

  return {
    runtime,
    profile,
    outDir: outDir ?? path.join(repoRoot, "output/e2e/runtime", runtime),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.outDir, { recursive: true });
  await ensureWorkspaceBuildOutputs();

  const argv = ["bun", "scripts/runtime-e2e.ts", options.runtime];
  if (options.profile) {
    argv.push("--profile", options.profile);
  }

  const startedAt = new Date().toISOString();
  const result = await runCommand(argv, {
    cwd: repoRoot,
    env: options.runtime === "mock-acp" ? { [MOCK_ACP_RUNTIME_ENV]: "1" } : undefined,
    allowFailure: true,
    timeoutMs: 300_000,
  });
  const finishedAt = new Date().toISOString();

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const combinedOutput = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  const outcome = resolveRuntimeE2EOutcome(
    combinedOutput,
    result.code === 0 && result.timedOut !== true,
  );

  const summary = {
    command: "bun run e2e:runtime",
    runtime: options.runtime,
    profile: options.profile ?? null,
    startedAt,
    finishedAt,
    passed: outcome.classification === "passed",
    timedOut: result.timedOut,
    classification: outcome.classification,
    resultContract: outcome.resultContract,
    resultContractStatus: outcome.resultContractStatus,
    resultContractValue: outcome.resultContractValue,
    proofChecks: extractRuntimeE2EProofChecks(combinedOutput),
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
    console.log(`[e2e:runtime] ${options.runtime}: passed (${options.outDir})`);
    return;
  }

  throw new Error(
    `[e2e:runtime] ${options.runtime}: ${outcome.classification}; see ${path.join(options.outDir, "summary.json")}`,
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
