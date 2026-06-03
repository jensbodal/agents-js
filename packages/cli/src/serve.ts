import {
  buildAgentCardBaseUrl,
  type ExecutorHooks,
  formatBindAddress,
  type ServeACPOverA2AHandle,
  type ServeACPOverA2AOptions,
  serveACPOverA2A,
} from "@agents-js/a2a";
import { createAuditEmitter } from "@agents-js/a2a/audit";
import { createA2AMentionMiddleware } from "@agents-js/a2a-client";
import {
  AgentRegistry,
  createSyncEndpointHandler,
  resolveSharedAgentRegistryPath,
  startAutoRegisterHeartbeat,
  startRegistrySync,
} from "@agents-js/a2a-client/node";
import { DEFAULT_INHERITED_ENV_KEYS } from "@agents-js/acp-host";
import {
  type AgentsJsConfigPaths,
  createRuntimeSelectionsFromArgs,
  detectInstalledGatewayRuntimes,
  type GatewayRuntimeProfile,
  type GatewayRuntimeSelection,
  getConfiguredProfile,
  getPrimaryGatewayRuntime,
  listGatewayRuntimeIds,
  loadAgentsJsConfig,
  mergeAgentsJsConfig,
  type ResolvedGatewayRuntime,
  type RuntimeCommandResolver,
  type RuntimeEnvOverrides,
  resolveAndApplyGatewayRuntimes,
  validateGatewayRuntimeProfileName,
  writeAgentsJsConfig,
} from "@agents-js/gateway-runtime";
import { createGatewayBus, wrapAuditEmitterAsBusPublisher } from "@agents-js/host";
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
import {
  acpCommandAndProfileArgs,
  cardNameArg,
  harnessesArg,
  heartbeatArgs,
  hostPortArgs,
  registrySyncArg,
  runtimeLogArgs,
} from "./shared-arg-specs.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

export type { ResolvedServeInputs } from "./serve-config.ts";
export type { PersistMode } from "./serve-prompts.ts";

export interface ServeCommandArgs {
  acpArgsJson?: string;
  acpCommand?: string;
  cardName?: string;
  /**
   * Ordered list of curated harness ids. Populated by `--harness`
   * (repeatable) and `--harnesses` (comma-separated), in argv order.
   * First entry = primary routing target. Single-element array is the
   * single-harness back-compat path. Downstream consumers in this
   * binary collapse to `harnesses[0]`, with byte-identical behavior
   * to the original single-harness invocation form.
   */
  harnesses?: string[];
  heartbeatEnabled?: boolean;
  heartbeatIntervalMs?: number;
  help?: boolean;
  host?: string;
  opencodeDisableExternalPlugins?: boolean;
  profile?: string;
  port?: number;
  registrySync?: boolean;
  runtimeLogLevel?: string;
}

/**
 * Returns true when cross-gateway registry sync should be enabled for
 * this `serve` invocation. Default is **off** — both inbound endpoint
 * mounting and outbound peer fetch are skipped.
 *
 * Enabled when either:
 *   - `--registry-sync` flag is present, or
 *   - `AGENTS_JS_REGISTRY_SYNC` env var is the literal string `"true"`.
 *
 * Anything else (including `"1"`, `"yes"`, etc.) is rejected so the
 * default stays explicit and operators do not enable a network surface
 * by accident through ambiguous truthy coercion.
 */
export function shouldEnableRegistrySync(
  args: Pick<ServeCommandArgs, "registrySync">,
  env: NodeJS.ProcessEnv,
): boolean {
  if (args.registrySync === true) return true;
  return env.AGENTS_JS_REGISTRY_SYNC === "true";
}

/**
 * Resolve host-address heartbeat options (AJS-87) from CLI args + env.
 * Mirrors the {@link shouldEnableRegistrySync} resolution pattern: the
 * CLI flag wins, then the environment variable, then the documented
 * defaults. The env-var enable gate accepts only the literal string
 * `"true"` / `"false"` so an operator does not flip a publication
 * cadence by accident through truthy coercion (`"1"`, `"yes"`, etc.).
 *
 * Interval precedence: `--heartbeat-interval-ms` →
 * `AGENTS_JS_HEARTBEAT_INTERVAL_MS` → `undefined` (which the heartbeat
 * helper resolves to its 60 000 ms default). A negative or
 * non-numeric env var is rejected loudly so a typo cannot silently
 * fall back to the default.
 */
export function resolveHeartbeatOptions(
  args: Pick<ServeCommandArgs, "heartbeatEnabled" | "heartbeatIntervalMs">,
  env: NodeJS.ProcessEnv,
): { heartbeatEnabled: boolean; heartbeatIntervalMs?: number } {
  let heartbeatEnabled = args.heartbeatEnabled;
  if (heartbeatEnabled === undefined) {
    const raw = env.AGENTS_JS_HEARTBEAT_ENABLED;
    if (raw === "true") heartbeatEnabled = true;
    else if (raw === "false") heartbeatEnabled = false;
    else if (raw !== undefined && raw !== "") {
      throw new Error(
        `[agents-js] Invalid AGENTS_JS_HEARTBEAT_ENABLED "${raw}". Expected literal "true" or "false".`,
      );
    } else {
      heartbeatEnabled = true;
    }
  }

  let heartbeatIntervalMs = args.heartbeatIntervalMs;
  if (heartbeatIntervalMs === undefined) {
    const raw = env.AGENTS_JS_HEARTBEAT_INTERVAL_MS;
    if (raw !== undefined && raw !== "") {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(
          `[agents-js] Invalid AGENTS_JS_HEARTBEAT_INTERVAL_MS "${raw}". Expected a non-negative number.`,
        );
      }
      heartbeatIntervalMs = parsed;
    }
  }

  return heartbeatIntervalMs === undefined
    ? { heartbeatEnabled }
    : { heartbeatEnabled, heartbeatIntervalMs };
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

/**
 * Argv-parser spec for `agents-js serve`. Exposed for the docs
 * governance generator.
 */
export const SERVE_ARG_SPEC: ArgSpec<ServeCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp, description: "Show this message." },
  "-h": { kind: "flag", assign: setHelp, description: "Show this message." },
  ...harnessesArg<ServeCommandArgs>(),
  ...acpCommandAndProfileArgs<ServeCommandArgs>(),
  ...cardNameArg<ServeCommandArgs>(),
  ...hostPortArgs<ServeCommandArgs>(),
  ...runtimeLogArgs<ServeCommandArgs>(),
  ...registrySyncArg<ServeCommandArgs>(),
  ...heartbeatArgs<ServeCommandArgs>(),
};

export function parseServeCommandArgs(argv: string[]): ServeCommandArgs {
  return parseArgv<ServeCommandArgs>(argv, SERVE_ARG_SPEC, { subcommandName: "serve" });
}

export function serveArgsToRuntimeEnvOverrides(args: ServeCommandArgs): RuntimeEnvOverrides {
  return {
    disableExternalPlugins: args.opencodeDisableExternalPlugins,
    runtimeLogLevel: args.runtimeLogLevel,
  };
}

/**
 * Resolve the agent-card name override. Precedence: explicit
 * `--card-name` CLI flag > `AGENTS_JS_CARD_NAME` env > undefined
 * (fall back to the profile-derived default baked into the runtime's
 * agent card). Empty/whitespace-only values are treated as absent.
 */
export function resolveCardNameOverride(
  args: Pick<ServeCommandArgs, "cardName">,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const candidate = args.cardName ?? env.AGENTS_JS_CARD_NAME;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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
      `  --harness <${listGatewayRuntimeIds().join("|")}|custom>  Select a curated harness. Repeatable: --harness <id> --harness <id> declares a fleet (first = primary).`,
      "  --harnesses <id1,id2,...>           Comma-separated harness fleet (first = primary). Equivalent to repeating --harness.",
      "                                       Note: this standalone binary resolves only the primary harness; secondary entries are parsed but not routed.",
      "                                       For multi-harness fleet routing (per-session lane controllers + WS-bridge runtime-switch), use the internal-gateway binary instead.",
      "  --acp-command <command>             Custom ACP command (requires --harness custom or no --harness; mutually exclusive with curated harnesses)",
      "  --acp-args-json <json>              JSON array of custom ACP args (only valid with --acp-command)",
      "  --profile <name>                    Optional named profile for curated runtimes (not supported with --harness custom)",
      "  --card-name <name>                  Override the agent-card name (default: <runtime>[-<profile>]-acp-gateway). Env: AGENTS_JS_CARD_NAME.",
      "  --host <host>                       Bind host for the A2A server (default: 127.0.0.1)",
      "  --port <port>                       Bind port (0 = auto-allocate)",
      "  --runtime-log-level <level>         Runtime log level (debug|info|warn|error|silent)",
      "  --opencode-disable-external-plugins Append --pure when launching opencode",
      "  --registry-sync                     Enable cross-gateway peer registry sync (default: off; A2A-only payload)",
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
  registryPath: string,
  audit: ReturnType<typeof createAuditEmitter>,
): Promise<ExecutorHooks | undefined> {
  const registry = new AgentRegistry({ configPath: registryPath });
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
    audit,
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
  // The multi-harness fanout (HarnessLaneManager) is wired into
  // `apps/internal-gateway/main.ts`, NOT this standalone CLI binary.
  // The flag side accepts `harnesses: string[]` so both binaries share
  // arg-parsing surface, but this entry point still resolves only the
  // primary. Backporting the lane manager to `packages/cli/src/serve.ts`
  // is a separate follow-up.
  const argSelections = createRuntimeSelectionsFromArgs(args);
  if ((args.harnesses?.length ?? 0) > 1) {
    output.write(
      `[agents-js] ${args.harnesses?.length ?? 0} harnesses configured (${args.harnesses?.join(", ")}). This standalone CLI uses only the primary ("${args.harnesses?.[0]}"); for multi-harness fleet routing run the internal-gateway binary instead.\n`,
    );
  }
  const argSelection = argSelections?.[0];
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
  // Plumb the multi-runtime data structure through
  // `resolveAndApplyGatewayRuntimes` (plural). This binary still
  // resolves only the primary (single selection wrapped in a one-entry
  // array); the per-secondary-harness selections + spawns happen in
  // the internal-gateway binary. Downstream code collapses back to
  // the primary via `getPrimaryGatewayRuntime` so the existing
  // single-runtime data flow is byte-identical to the original form.
  const runtimes: readonly ResolvedGatewayRuntime[] = await resolveAndApplyGatewayRuntimes({
    selections: [resolvedInputs.runtimeSelection],
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
  const primaryRuntime: ResolvedGatewayRuntime = getPrimaryGatewayRuntime(runtimes);
  const env = dependencies.env ?? process.env;
  const cardNameOverride = resolveCardNameOverride(args, env);
  const runtime: ResolvedGatewayRuntime = cardNameOverride
    ? {
        ...primaryRuntime,
        agentCard: { ...primaryRuntime.agentCard, name: cardNameOverride },
      }
    : primaryRuntime;
  const registryPath = resolveSharedAgentRegistryPath({ env: dependencies.env });
  // In-process gateway bus — every recorded audit event is also
  // published on this bus via the wrapper below. The public-facing
  // CLI gateway does NOT mount the bus subscribe/publish HTTP
  // endpoints (they're trusted-network only by design); subscribers
  // are limited to in-process listeners. The internal-gateway
  // listener mounts the HTTP endpoints for operator tooling.
  const bus = createGatewayBus();
  const audit = wrapAuditEmitterAsBusPublisher({
    bus,
    emitter: createAuditEmitter({
      logger: {
        log(message, meta) {
          output.write(`${message} ${JSON.stringify(meta)}\n`);
        },
      },
    }),
  });
  const hooks = await detectA2AMentionHooks(output, registryPath, audit);
  const serveGateway = dependencies.serveGateway ?? serveACPOverA2A;
  const registrySyncEnabled = shouldEnableRegistrySync(args, env);

  // Default-off: no inbound sync endpoint, no outbound peer pull.
  // Local auto-registration still runs unconditionally below so the
  // gateway is discoverable on the local machine.
  const syncEndpointHandler = registrySyncEnabled
    ? createSyncEndpointHandler({ configPath: registryPath, audit })
    : undefined;

  // Compose the spawn-env whitelist: standard inherited keys (PATH,
  // HOME, LANG, etc.) plus the resolved runtime's declared
  // `authEnvKeys`. Without this list, `spawnACPAgent` falls back to
  // inheriting the full `process.env` and credentials for unrelated
  // runtimes leak into the spawned ACP child. Deduplicate via a Set
  // because a runtime is allowed to redeclare a key already present
  // in the inherited defaults.
  const runtimeAuthKeys = runtime.definition.authEnvKeys ?? [];
  const inheritedEnvKeys = [...new Set([...DEFAULT_INHERITED_ENV_KEYS, ...runtimeAuthKeys])];

  const server = await serveGateway({
    acp: { ...runtime.acp, inheritedEnvKeys },
    agentCard: runtime.agentCard,
    hooks,
    host: resolvedInputs.host,
    port: resolvedInputs.port,
    ...(syncEndpointHandler ? { additionalFetch: syncEndpointHandler } : {}),
  });

  let registrySync: { stop: () => void } | null = null;
  const localUrl = buildAgentCardBaseUrl(server.port, resolvedInputs.host);
  const localName = runtime.agentCard.name ?? "agents-js";
  const heartbeatOptions = resolveHeartbeatOptions(args, env);
  if (registrySyncEnabled) {
    const syncIntervalMs = env.AGENTS_JS_SYNC_INTERVAL_MS
      ? Number(env.AGENTS_JS_SYNC_INTERVAL_MS)
      : undefined;
    registrySync = startRegistrySync({
      name: localName,
      url: localUrl,
      configPath: registryPath,
      intervalMs: syncIntervalMs,
      audit,
      ...heartbeatOptions,
    });
    output.write("[agents-js] Registry sync enabled (A2A-only peer payload)\n");
  } else {
    // Sync disabled — still publish locally, and (AJS-87) heartbeat the
    // (name, url) record so peers polling our well-known endpoint on the
    // next sync interval observe a fresh `registered_at` after a DHCP
    // roam. `startAutoRegisterHeartbeat` runs the initial registration
    // on its first tick (delay 0); when heartbeatEnabled === false the
    // helper still fires once then never reschedules.
    registrySync = startAutoRegisterHeartbeat({
      name: localName,
      url: localUrl,
      configPath: registryPath,
      intervalMs: heartbeatOptions.heartbeatEnabled ? heartbeatOptions.heartbeatIntervalMs : 0,
    });
    output.write(
      "[agents-js] Registry sync disabled (default; pass --registry-sync or set AGENTS_JS_REGISTRY_SYNC=true to enable)\n",
    );
  }
  const originalStop = server.stop.bind(server);
  server.stop = () => {
    registrySync?.stop();
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
