import {
  type ServeACPOverA2AHandle,
  type ServeACPOverA2AOptions,
  serveACPOverA2A,
} from "@agents-js/a2a";
import {
  type CuratedGatewayRuntimeSelection,
  type GatewayRuntimeId,
  listGatewayRuntimeIds,
  type ResolvedGatewayRuntime,
  type RuntimeCommandResolver,
  type RuntimeEnvOverrides,
  resolveAndApplyGatewayRuntime,
} from "@agents-js/gateway-runtime";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { normalizeHost } from "./cli-utils.ts";
import { EXIT_ERROR, EXIT_OK } from "./exit-codes.ts";
import { getCliRuntimeResolutionOptions } from "./runtime-resolution.ts";
import { harnessArg, hostPortArgs, runtimeLogArgs } from "./shared-arg-specs.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

export interface BridgeCommandArgs {
  harness?: string;
  help?: boolean;
  host?: string;
  opencodeDisableExternalPlugins?: boolean;
  port?: number;
  runtimeLogLevel?: string;
}

export interface BridgeCommandDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  runtimeResolver?: RuntimeCommandResolver;
  serveGateway?: (options: ServeACPOverA2AOptions) => Promise<ServeACPOverA2AHandle>;
  waitForShutdown?: (handle: ServeACPOverA2AHandle) => Promise<void>;
}

export interface BridgeCommandResult {
  host: string;
  port: number;
  runtime: ResolvedGatewayRuntime;
  server: ServeACPOverA2AHandle;
}

const setBridgeHelp = (a: BridgeCommandArgs): void => {
  a.help = true;
};

/**
 * Argv-parser spec for `agents-js bridge`. Exposed for the docs
 * governance generator (see {@link ACP_ARG_SPEC} for the same pattern).
 */
export const BRIDGE_ARG_SPEC: ArgSpec<BridgeCommandArgs> = {
  "--help": { kind: "flag", assign: setBridgeHelp, description: "Show this message." },
  "-h": { kind: "flag", assign: setBridgeHelp, description: "Show this message." },
  ...harnessArg<BridgeCommandArgs>(),
  ...hostPortArgs<BridgeCommandArgs>(),
  ...runtimeLogArgs<BridgeCommandArgs>(),
};

export function parseBridgeCommandArgs(argv: string[]): BridgeCommandArgs {
  return parseArgv<BridgeCommandArgs>(argv, BRIDGE_ARG_SPEC, { subcommandName: "bridge" });
}

export function bridgeArgsToRuntimeEnvOverrides(args: BridgeCommandArgs): RuntimeEnvOverrides {
  return {
    disableExternalPlugins: args.opencodeDisableExternalPlugins,
    runtimeLogLevel: args.runtimeLogLevel,
  };
}

function printBridgeUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  const runtimeIds = listGatewayRuntimeIds().join("|");
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — bridge`,
      "",
      "Spawn an ephemeral ACP gateway serving a single harness. The bridge",
      "exposes a one-shot in-memory gateway over A2A and shuts down on SIGINT.",
      "No registry read/write; no config persistence.",
      "",
      "Usage:",
      `  agents-js bridge --harness <${runtimeIds}> [options]`,
      "",
      "Options:",
      `  --harness <${runtimeIds}>   Required. Curated ACP harness.`,
      "  --host <host>                        Bind host for the A2A server (default: 127.0.0.1)",
      "  --port <port>                        Bind port (0 = auto-allocate)",
      "  --runtime-log-level <level>          Runtime log level (debug|info|warn|error|silent)",
      "  --opencode-disable-external-plugins  Append --pure when launching opencode",
      "  --version, -v                        Print version and exit",
      "  --help, -h                           Show this message",
      "",
      "Notes:",
      "  - The bridge does NOT read ~/.agents-js/registry.json or any project config.",
      "  - For persistent gateways with config + profiles, use `agents-js serve`.",
      "  - The bridge shuts down cleanly on SIGINT / SIGTERM (exit code 0).",
    ].join("\n")}\n`,
  );
}

function waitForSignal(handle: ServeACPOverA2AHandle): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      handle.stop();
      resolve();
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

export async function runBridgeCommand(
  argv: string[],
  deps: BridgeCommandDependencies = {},
): Promise<BridgeCommandResult | number> {
  const output = deps.output ?? process.stdout;

  const versionExit = handleVersionFlag(argv, output);
  if (versionExit !== undefined) return versionExit;

  let args: BridgeCommandArgs;
  try {
    args = parseBridgeCommandArgs(argv);
  } catch (error) {
    output.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }

  if (args.help) {
    printBridgeUsage(output);
    return EXIT_OK;
  }

  if (!args.harness) {
    output.write(
      `[agents-js] Missing required --harness. Choose one of: ${listGatewayRuntimeIds().join(", ")}.\n`,
    );
    return EXIT_ERROR;
  }

  const knownRuntimes = listGatewayRuntimeIds();
  if (!(knownRuntimes as readonly string[]).includes(args.harness)) {
    output.write(
      `[agents-js] Unknown runtime "${args.harness}". Supported runtimes: ${knownRuntimes.join(", ")}.\n`,
    );
    return EXIT_ERROR;
  }

  const selection: CuratedGatewayRuntimeSelection = {
    kind: "curated",
    runtime: args.harness as GatewayRuntimeId,
  };

  // Apply CLI-flag overrides to the live env so downstream helpers
  // (resolveRuntimeArgs, etc.) observe them. The shared helper restores the
  // env even when resolution throws. Bridge does not support profiles, so
  // `profileLookup` is omitted.
  let runtime: ResolvedGatewayRuntime;
  try {
    runtime = await resolveAndApplyGatewayRuntime({
      selection,
      envOverrides: bridgeArgsToRuntimeEnvOverrides(args),
      resolver: deps.runtimeResolver,
      runtimeResolution: getCliRuntimeResolutionOptions(),
    });
  } catch (error) {
    output.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_ERROR;
  }

  const host = normalizeHost(args.host);
  const port = args.port ?? 0;
  const serveGateway = deps.serveGateway ?? serveACPOverA2A;

  const server = await serveGateway({
    acp: runtime.acp,
    agentCard: runtime.agentCard,
    host,
    port,
  });

  output.write(
    `[agents-js] bridge serving ${runtime.definition.displayName} on http://${host}:${server.port}\n`,
  );

  const waiter = deps.waitForShutdown ?? waitForSignal;
  await waiter(server);

  // waitForSignal invokes stop() internally; stop() is idempotent on injected
  // test handles. Production default already tore down when the signal fired.
  if (deps.waitForShutdown) {
    server.stop();
  }

  return {
    host,
    port: server.port,
    runtime,
    server,
  };
}
