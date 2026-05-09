#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type GatewayRuntimeId,
  getGatewayRuntimeDefinition,
  listGatewayRuntimeIds,
  resolveGatewayRuntime,
} from "@agents-js/gateway-runtime";
import { gatewayConfig } from "../apps/internal-gateway/gateway.config.ts";
import { runCommand } from "./process-utils.ts";
import { repoRoot } from "./workspace-config.ts";

type TsconfigFile = {
  compilerOptions?: {
    baseUrl?: string;
    paths?: Record<string, string[]>;
  };
  extends?: string;
};

function formatOptionalCommandStatus(command: string): string {
  const resolved = Bun.which(command);
  return resolved ? `${command} (${resolved})` : `${command} (not installed)`;
}

async function assertCommandAvailable(command: string): Promise<string> {
  const resolved = Bun.which(command);
  if (!resolved) {
    throw new Error(`[doctor] Required command "${command}" is not available on PATH.`);
  }
  console.log(`[doctor] ${command}: ${resolved}`);
  return resolved;
}

function loadTsconfig(tsconfigPath: string): TsconfigFile {
  return JSON.parse(readFileSync(tsconfigPath, "utf8")) as TsconfigFile;
}

function resolveExtendedTsconfigPath(tsconfigPath: string, extendsValue: string): string {
  if (
    extendsValue.startsWith(".") ||
    extendsValue.startsWith("/") ||
    extendsValue.endsWith(".json")
  ) {
    return path.resolve(path.dirname(tsconfigPath), extendsValue);
  }

  return path.resolve(path.dirname(tsconfigPath), `${extendsValue}.json`);
}

function resolveSourceAliasTarget(tsconfigPath: string, specifier: string): string | null {
  if (!existsSync(tsconfigPath)) {
    return null;
  }

  const tsconfig = loadTsconfig(tsconfigPath);
  const baseUrl = tsconfig.compilerOptions?.baseUrl ?? ".";
  const directTarget = tsconfig.compilerOptions?.paths?.[specifier]?.[0];
  if (directTarget) {
    return path.resolve(path.dirname(tsconfigPath), baseUrl, directTarget);
  }

  if (!tsconfig.extends) {
    return null;
  }

  const extendedPath = resolveExtendedTsconfigPath(tsconfigPath, tsconfig.extends);
  return resolveSourceAliasTarget(extendedPath, specifier);
}

type SourceLinkResolver = (cwd: string, specifier: string) => Promise<string>;

async function resolveRuntimeSpecifier(cwd: string, specifier: string): Promise<string> {
  const result = await runCommand(
    ["bun", "-e", `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`],
    { cwd },
  );
  return result.stdout.trim();
}

export async function assertSourceLinked(
  cwd: string,
  specifier: string,
  options: {
    resolveSpecifier?: SourceLinkResolver;
  } = {},
): Promise<void> {
  const resolveSpecifier = options.resolveSpecifier ?? resolveRuntimeSpecifier;
  let resolved = "";
  let resolutionError: string | null = null;

  try {
    resolved = await resolveSpecifier(cwd, specifier);
  } catch (error) {
    resolutionError = error instanceof Error ? error.message : String(error);
  }

  if (!resolved.includes("/src/")) {
    const aliasTarget = resolveSourceAliasTarget(path.join(cwd, "tsconfig.json"), specifier);
    if (!aliasTarget?.includes("/src/") || !existsSync(aliasTarget)) {
      throw new Error(
        [
          `[doctor] Expected ${specifier} to resolve from source in ${cwd}.`,
          `Received: ${resolved || "<empty>"}`,
          aliasTarget ? `Configured alias target: ${aliasTarget}` : "No source alias target found.",
          resolutionError ? `Runtime resolution error: ${resolutionError}` : "",
        ].join("\n"),
      );
    }

    console.log(
      resolutionError
        ? `[doctor] source-link alias ok: ${specifier} -> ${aliasTarget} (runtime resolve unavailable before build: ${resolutionError})`
        : `[doctor] source-link alias ok: ${specifier} -> ${aliasTarget} (runtime resolve: ${resolved || "<empty>"})`,
    );
    return;
  }

  console.log(`[doctor] source-link ok: ${specifier} -> ${resolved}`);
}

export interface DoctorArgs {
  runtime: GatewayRuntimeId;
}

export function parseDoctorArgs(argv: string[]): DoctorArgs {
  let runtime: GatewayRuntimeId = gatewayConfig.runtime;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--runtime") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('[doctor] Missing value for "--runtime".');
      }
      runtime = getGatewayRuntimeDefinition(next).id as GatewayRuntimeId;
      index += 1;
      continue;
    }

    throw new Error(
      `[doctor] Unknown argument "${arg}". Supported args: --runtime <${listGatewayRuntimeIds().join("|")}>.`,
    );
  }

  return { runtime };
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const args = parseDoctorArgs(argv);
  console.log(`[doctor] bun: ${Bun.version}`);
  await assertCommandAvailable("vp");
  await assertSourceLinked(repoRoot, "@agents-js/cli");
  await assertSourceLinked(`${repoRoot}/apps/internal-gateway`, "@agents-js/gateway-runtime");
  await assertSourceLinked(`${repoRoot}/apps/web-ui`, "@agents-js/a2a-client");

  try {
    const runtime = await resolveGatewayRuntime(args.runtime, {
      workspaceBinRoot: path.join(repoRoot, "apps", "internal-gateway"),
    });
    console.log(`[doctor] selected runtime: ${runtime.definition.id} -> ${runtime.acp.command}`);
  } catch (error) {
    console.log(`[doctor] warning: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`[doctor] optional tmux: ${formatOptionalCommandStatus("tmux")}`);
  console.log(`[doctor] optional overmind: ${formatOptionalCommandStatus("overmind")}`);
  console.log("[doctor] ok");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
