import {
  buildAgentCardBaseUrl,
  type ExecutorHooks,
  formatBindAddress,
  type ServeACPOverA2AHandle,
  type ServeACPOverA2AOptions,
  serveACPOverA2A,
} from "@agents-js/a2a";
import { createA2AMentionMiddleware } from "@agents-js/a2a-client";
import {
  AgentRegistry,
  createSyncEndpointHandler,
  startRegistrySync,
} from "@agents-js/a2a-client/node";
import {
  type AgentsJsConfigPaths,
  createRuntimeSelectionFromArgs,
  detectInstalledGatewayRuntimes,
  type GatewayRuntimeProfile,
  type GatewayRuntimeSelection,
  getConfiguredProfile,
  listGatewayRuntimeIds,
  loadAgentsJsConfig,
  mergeAgentsJsConfig,
  type ResolvedGatewayRuntime,
  type RuntimeCommandResolver,
  type RuntimeEnvOverrides,
  resolveAndApplyGatewayRuntime,
  validateGatewayRuntimeProfileName,
  writeAgentsJsConfig,
} from "@agents-js/gateway-runtime";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { normalizeHost, parsePort } from "./cli-utils.ts";
import { EXIT_OK } from "./exit-codes.ts";
import { createTerminalPromptSession, type PromptSession } from "./prompts.ts";
import { getCliRuntimeResolutionOptions } from "./runtime-resolution.ts";
import { persistServeInputs, type ResolvedServeInputs } from "./serve-config.ts";
import {
  isInteractiveTerminal,
  type PersistMode,
  promptForPersistMode,
  promptForRuntimeSelection,
} from "./serve-prompts.ts";
import { hostPortArgs, runtimeLogArgs, runtimeSelectArgs } from "./shared-arg-specs.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

export type { ResolvedServeInputs } from "./serve-config.ts";
export type { PersistMode } from "./serve-prompts.ts";

export interface ServeCommandArgs {
  acpArgsJson?: string;
  acpCommand?: string;
  defaultModel?: string;
  harness?: string;
  help?: boolean;
  host?: string;
  opencodeDisableExternalPlugins?: boolean;
  profile?: string;
  port?: number;
  runtimeLogLevel?: string;
}

export interface ServeCommandResult {
  configPaths: AgentsJsConfigPaths;
  host: string;
  persistedConfigPath?: string;
  port: number;
  runtime: ResolvedGatewayRuntime;
  server: ServeACPOverA2AHandle;
}

export interface ServeCommandDependencies {
  createPromptSession?: () => PromptSession;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  runtimeResolver?: RuntimeCommandResolver;
  serveGateway?: (options: ServeACPOverA2AOptions) => Promise<ServeACPOverA2AHandle>;
}

const setHelp = (a: ServeCommandArgs): void => {
  a.help = true;
};

const SERVE_ARG_SPEC: ArgSpec<ServeCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp },
  "-h": { kind: "flag", assign: setHelp },
  ...runtimeSelectArgs<ServeCommandArgs>(),
  ...hostPortArgs<ServeCommandArgs>(),
  ...runtimeLogArgs<ServeCommandArgs>(),
};

export function parseServeCommandArgs(argv: string[]): ServeCommandArgs {
  return parseArgv<ServeCommandArgs>(argv, SERVE_ARG_SPEC, { subcommandName: "serve" });
}

export function serveArgsToRuntimeEnvOverrides(args: ServeCommandArgs): RuntimeEnvOverrides {
  return {
    disableExternalPlugins: args.opencodeDisableExternalPlugins,
    runtimeLogLevel: args.runtimeLogLevel,
    defaultModel: args.defaultModel,
  };
}

function printServeUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — serve`,
      "",
      "Usage:",
      "  agents-js serve [options]",
      "",
      "Options:",
      `  --harness <${listGatewayRuntimeIds().join("|")}|custom>  Select a curated harness or enter custom mode`,
      "  --acp-command <command>             Custom ACP command (requires --harness custom or no --harness; mutually exclusive with curated harnesses)",
      "  --acp-args-json <json>              JSON array of custom ACP args (only valid with --acp-command)",
      "  --profile <name>                    Optional named profile for curated runtimes (not supported with --harness custom)",
      "  --host <host>                       Bind host for the A2A server (default: 127.0.0.1)",
      "  --port <port>                       Bind port (0 = auto-allocate)",
      "  --runtime-log-level <level>         Runtime log level (debug|info|warn|error|silent)",
      "  --opencode-disable-external-plugins Append --pure when launching opencode",
      "  --default-model <id>                Default model id (AJS_DEFAULT_MODEL override)",
      "  --version, -v                       Print version and exit",
      "  --help, -h                          Show this message",
      "",
      "Config:",
      "  User defaults:    ~/.config/agents-js/config.json",
      "  Project override: .agents-js/config.json",
      "  Example template: .agents-js/config.example.json",
      "",
      "When required inputs are missing, agents-js falls back to an interactive terminal wizard.",
    ].join("\n")}\n`,
  );
}

/**
 * Detect the shared agent registry and, if it contains agents, return
 * an {@link ExecutorHooks} object with A2A mention middleware wired as
 * the `beforePrompt` hook. Returns `undefined` when the registry is
 * missing or empty so callers can skip hook injection entirely.
 */
async function detectA2AMentionHooks(
  output: Pick<NodeJS.WriteStream, "write">,
): Promise<ExecutorHooks | undefined> {
  const registry = new AgentRegistry();
  let agents: Awaited<ReturnType<AgentRegistry["list"]>>;

  try {
    agents = await registry.list();
  } catch {
    // Registry file doesn't exist or is malformed — skip silently.
    return undefined;
  }

  if (agents.length === 0) {
    return undefined;
  }

  output.write(
    `[agents-js] A2A mention middleware enabled for ${agents.length} registered agent(s): ${agents.map((a) => a.name).join(", ")}\n`,
  );

  const beforePrompt = createA2AMentionMiddleware({
    registry,
    onUnknownAgent({ agentName }) {
      output.write(`[agents-js] @${agentName} mention ignored — agent not found in registry\n`);
    },
    onDispatchError({ agentName, error }) {
      output.write(
        `[agents-js] @${agentName} dispatch failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    },
  });

  return { beforePrompt };
}

function ensureProfileSupportedSelection(
  runtimeSelection: GatewayRuntimeSelection | undefined,
  profileName: string,
): asserts runtimeSelection is Extract<GatewayRuntimeSelection, { kind: "curated" }> {
  if (!runtimeSelection) {
    throw new Error(
      `[agents-js] --profile ${profileName} requires an explicit curated --harness or a saved curated harness.`,
    );
  }

  if (runtimeSelection.kind !== "curated") {
    throw new Error("[agents-js] --profile is only supported with curated harnesses.");
  }
}

async function resolveServeInputs(
  args: ServeCommandArgs,
  dependencies: ServeCommandDependencies = {},
): Promise<ResolvedServeInputs> {
  const runtimeResolution = getCliRuntimeResolutionOptions();
  const loadedConfig = await loadAgentsJsConfig({
    cwd: dependencies.cwd,
    env: dependencies.env,
  });
  const userConfig = loadedConfig.userConfig;
  let projectConfig = loadedConfig.projectConfig;
  const output = dependencies.output ?? process.stdout;
  const configServe = loadedConfig.effectiveConfig.serve;
  // Use the user+project merge (without base defaults) to decide whether to prompt.
  const explicitServe = mergeAgentsJsConfig(userConfig, projectConfig).serve;
  const argSelection = createRuntimeSelectionFromArgs(args);
  const selectionPolicy = configServe?.selectionPolicy ?? "prefer-saved";
  const shouldPromptForHarness =
    !argSelection && (selectionPolicy === "ask-each-time" || !explicitServe?.harness);

  let runtimeSelection = argSelection ?? configServe?.harness;
  let host = args.host ?? configServe?.host;
  let port = args.port ?? configServe?.port ?? 0;
  let persistMode: PersistMode = "none";
  let selectedProfileDefinition: GatewayRuntimeProfile | undefined;

  if (args.profile) {
    // Check against explicit selection (args or user/project config) — not the defaults layer.
    const explicitSelection = argSelection ?? explicitServe?.harness;
    ensureProfileSupportedSelection(explicitSelection, args.profile);
    runtimeSelection = {
      ...explicitSelection,
      profile: validateGatewayRuntimeProfileName(args.profile),
    };
  }

  if (shouldPromptForHarness || (!host && isInteractiveTerminal())) {
    if (!isInteractiveTerminal() && !dependencies.createPromptSession) {
      throw new Error(
        "[agents-js] Missing serve inputs and no interactive terminal is available. Provide flags or a config file.",
      );
    }

    const prompt = (dependencies.createPromptSession ?? (() => createTerminalPromptSession()))();

    try {
      if (shouldPromptForHarness || !runtimeSelection) {
        const detectedRuntimeIds = await detectInstalledGatewayRuntimes({
          ...runtimeResolution,
          resolver: dependencies.runtimeResolver,
        });
        runtimeSelection = await promptForRuntimeSelection(prompt, detectedRuntimeIds);
      }

      host = await prompt.input("Bind host", normalizeHost(host));
      const portInput = await prompt.input(
        "Port (leave blank or 0 for auto-allocation)",
        port === 0 ? "" : String(port),
      );
      port = portInput.trim() === "" ? 0 : parsePort(portInput.trim());
      persistMode = await promptForPersistMode(prompt);
    } finally {
      prompt.close();
    }
  }

  if (!runtimeSelection) {
    throw new Error(
      "[agents-js] No harness selected. Provide --harness/--acp-command, add a config file, or run interactively.",
    );
  }

  if (runtimeSelection.kind === "curated" && runtimeSelection.profile) {
    const configuredProfile = getConfiguredProfile(runtimeSelection.profile, {
      configPaths: loadedConfig.paths,
      projectConfig,
      userConfig,
    });

    if (configuredProfile && configuredProfile.profile.runtime !== runtimeSelection.runtime) {
      throw new Error(
        `[agents-js] Runtime profile "${runtimeSelection.profile}" targets "${configuredProfile.profile.runtime}" but the selected harness is "${runtimeSelection.runtime}".`,
      );
    }

    if (!configuredProfile) {
      selectedProfileDefinition = {
        runtime: runtimeSelection.runtime,
      };
      projectConfig = mergeAgentsJsConfig(projectConfig, {
        profiles: {
          [runtimeSelection.profile]: selectedProfileDefinition,
        },
      });
      await writeAgentsJsConfig(loadedConfig.paths.projectConfigPath, projectConfig);
      output.write(
        `[agents-js] Created runtime profile "${runtimeSelection.profile}" in ${loadedConfig.paths.projectConfigPath}\n`,
      );
    } else {
      selectedProfileDefinition = configuredProfile.profile;
    }
  }

  if (
    persistMode === "project" &&
    runtimeSelection.kind === "curated" &&
    runtimeSelection.profile &&
    selectedProfileDefinition
  ) {
    projectConfig = mergeAgentsJsConfig(projectConfig, {
      profiles: {
        [runtimeSelection.profile]: selectedProfileDefinition,
      },
    });
  }

  const resolvedInputs = {
    configPaths: loadedConfig.paths,
    host: normalizeHost(host),
    persistMode,
    port,
    projectConfig,
    runtimeSelection,
    userConfig,
  } satisfies ResolvedServeInputs;

  await persistServeInputs(resolvedInputs, output);

  return resolvedInputs;
}

export async function runServeCommand(
  argv: string[],
  dependencies: ServeCommandDependencies = {},
): Promise<ServeCommandResult | number> {
  const output = dependencies.output ?? process.stdout;

  const versionExit = handleVersionFlag(argv, output);
  if (versionExit !== undefined) return versionExit;

  const args = parseServeCommandArgs(argv);

  if (args.help) {
    printServeUsage(output);
    return EXIT_OK;
  }

  const resolvedInputs = await resolveServeInputs(args, dependencies);

  // Apply CLI-flag overrides to the live env so downstream helpers
  // (resolveRuntimeArgs, internal-gateway config loader) observe them, then
  // resolve the runtime and apply its configured profile (created/validated
  // earlier in `resolveServeInputs`). Precedence: CLI flag > pre-existing
  // env > default. `onMissingProfile: "throw"` enforces the invariant that
  // resolveServeInputs already wrote the profile into project config.
  const runtime: ResolvedGatewayRuntime = await resolveAndApplyGatewayRuntime({
    selection: resolvedInputs.runtimeSelection,
    envOverrides: serveArgsToRuntimeEnvOverrides(args),
    resolver: dependencies.runtimeResolver,
    runtimeResolution: getCliRuntimeResolutionOptions(),
    profileLookup: {
      configPaths: resolvedInputs.configPaths,
      projectConfig: resolvedInputs.projectConfig,
      userConfig: resolvedInputs.userConfig,
    },
    onMissingProfile: "throw",
  });
  const hooks = await detectA2AMentionHooks(output);
  const serveGateway = dependencies.serveGateway ?? serveACPOverA2A;
  const syncEndpointHandler = createSyncEndpointHandler();
  const server = await serveGateway({
    acp: runtime.acp,
    agentCard: runtime.agentCard,
    hooks,
    host: resolvedInputs.host,
    port: resolvedInputs.port,
    additionalFetch: syncEndpointHandler,
  });

  // Phase 1 + 2: auto-register this gateway and start periodic peer sync.
  const syncIntervalMs = process.env.AGENTS_JS_SYNC_INTERVAL_MS
    ? Number(process.env.AGENTS_JS_SYNC_INTERVAL_MS)
    : undefined;
  const registrySync = startRegistrySync({
    name: runtime.agentCard.name ?? "agents-js",
    url: buildAgentCardBaseUrl(server.port, resolvedInputs.host),
    intervalMs: syncIntervalMs,
  });
  const originalStop = server.stop.bind(server);
  server.stop = () => {
    registrySync.stop();
    originalStop();
  };

  output.write(
    `[agents-js] Serving ${runtime.definition.displayName} on ${formatBindAddress(
      server.port,
      resolvedInputs.host,
    )}\n`,
  );
  output.write(
    `[agents-js] Agent card: ${buildAgentCardBaseUrl(
      server.port,
      resolvedInputs.host,
    )}/.well-known/agent-card.json\n`,
  );
  output.write("[agents-js] Lower-level dev entrypoint remains apps/internal-gateway/cli.ts\n");

  return {
    configPaths: resolvedInputs.configPaths,
    host: resolvedInputs.host,
    persistedConfigPath:
      resolvedInputs.persistMode === "user"
        ? resolvedInputs.configPaths.userConfigPath
        : resolvedInputs.persistMode === "project"
          ? resolvedInputs.configPaths.projectConfigPath
          : resolvedInputs.persistMode === "ask-each-time"
            ? resolvedInputs.configPaths.userConfigPath
            : undefined,
    port: server.port,
    runtime,
    server,
  };
}
