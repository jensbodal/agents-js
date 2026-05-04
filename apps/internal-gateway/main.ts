import { buildAgentCard, buildAgentCardBaseUrl, UniversalA2AServer } from "@agents-js/a2a";
import {
  autoRegister,
  createSyncEndpointHandler,
  startRegistrySync,
} from "@agents-js/a2a-client/node";
import { createNodeFileAdapters } from "@agents-js/acp-host";
import {
  detectInstalledGatewayRuntimes,
  getGatewayRuntimeDefinition,
  loadAgentsJsConfig,
  type ResolvedGatewayRuntime,
  resolveGatewayRuntimeSelection,
} from "@agents-js/gateway-runtime";
import {
  AguiRunCoordinator,
  applyEnvRuntimeProfile,
  buildRuntimeProfileConfigEnv,
  createAguiFetchHandler,
  createAuditEmitter,
  createGatewaySurfaceBroadcaster,
  createHostSession,
  createStandaloneHostController,
  createWSBridge,
  fetchRuntimeModels,
  type GatewayHostController,
  HostA2AExecutor,
} from "@agents-js/host";
import { createPlaneWebhookFetchHandler } from "@agents-js/plane/mount";
import { type GatewayCliArgs, parseCliArgs } from "./cli-args.ts";
import {
  buildGatewayDiscovery,
  formatGatewayDiscoveryLines,
  resolveGatewayPort,
} from "./discovery.ts";
import { describeGatewayError } from "./error-utils.ts";
import { gatewayConfig } from "./gateway.config.ts";
import { resolveGatewayRuntime } from "./runtimes.ts";

/**
 * Orchestration assembly for the Universal ACP-to-A2A Gateway.
 *
 * `main()` wires the gateway's components together: CLI arg parsing,
 * config loading, runtime resolution, host session creation, A2A server
 * + AG-UI / plane-webhook / registry-sync handlers, the WebSocket bridge,
 * and signal handlers. It does NOT own the process boundary — it returns
 * an exit code and lets a thin caller (`./cli.ts`) handle exit + error
 * formatting.
 *
 * Uses ACPSessionController from @agents-js/acp-host for full permission
 * mediation, write gates, and terminal management. Exposes an independently
 * discovered WebSocket bridge URL for real-time UI integration.
 */

type LoadedAgentsJsConfig = Awaited<ReturnType<typeof loadAgentsJsConfig>>;
type HostSession = Awaited<ReturnType<typeof createHostSession>>;

interface ServerSetup {
  server: Awaited<ReturnType<UniversalA2AServer["start"]>>;
  gatewayCard: ReturnType<typeof buildAgentCard>;
  executor: HostA2AExecutor;
  registrySync: { stop: () => void };
  httpPort: number;
}

interface SetupServerOptions {
  cliArgs: GatewayCliArgs;
  resolvedPort: number;
  runtime: ResolvedGatewayRuntime;
  session: HostSession;
  controllerFactory: (contextId: string) => Promise<GatewayHostController>;
  audit: ReturnType<typeof createAuditEmitter>;
  aguiCoordinator: AguiRunCoordinator;
}

export function buildAvailableRuntimeInfos(
  installedRuntimeIds: readonly string[],
  selectedRuntime: ResolvedGatewayRuntime,
): Array<{ id: string; displayName: string }> {
  const selectedRuntimeId = selectedRuntime.definition.id;
  const availableIds = installedRuntimeIds.includes(selectedRuntimeId)
    ? installedRuntimeIds
    : [selectedRuntimeId, ...installedRuntimeIds];

  return [...new Set(availableIds)].map((id: string) => {
    const def = getGatewayRuntimeDefinition(id);
    return { id: def.id, displayName: def.displayName };
  });
}

/**
 * Compose the gateway's `additionalFetch` chain. Order matters:
 * plane-webhook handlers run first (they self-route on path), AG-UI is
 * the primary browser run surface, and the registry sync endpoint —
 * when enabled — runs last so it never shadows AG-UI's `/agent` route.
 *
 * `syncEndpointHandler` is `null` when registry sync is disabled (the
 * default). In that case the well-known sync URL falls through to the
 * server's own routing and returns 404; the cross-gateway endpoint is
 * not mounted at all.
 *
 * Exported for unit testing — exercising this directly is much cheaper
 * than spinning up a real A2A server.
 */
export function composeAdditionalFetch(handlers: {
  planeWebhookHandler: (req: Request) => Promise<Response | null>;
  aguiHandler: (req: Request) => Promise<Response | null>;
  syncEndpointHandler: ((req: Request) => Promise<Response | null>) | null;
}): (req: Request) => Promise<Response | null> {
  return async (req: Request): Promise<Response | null> => {
    const planeWebhookResponse = await handlers.planeWebhookHandler(req);
    if (planeWebhookResponse !== null) return planeWebhookResponse;
    const aguiResponse = await handlers.aguiHandler(req);
    if (aguiResponse !== null) return aguiResponse;
    if (handlers.syncEndpointHandler !== null) {
      return handlers.syncEndpointHandler(req);
    }
    return null;
  };
}

async function setupServer(opts: SetupServerOptions): Promise<ServerSetup> {
  const executor = new HostA2AExecutor(opts.session.controller, {
    controllerFactory: opts.controllerFactory,
    audit: opts.audit,
  });

  // Create and start the A2A server. Mount the native AG-UI endpoint
  // and (when registry sync is enabled) the registry sync endpoint on
  // the same port via the additionalFetch hook so discovery + CORS
  // stay centralized.
  const gatewayCard = buildAgentCard(opts.runtime.agentCard);
  const aguiHandler = createAguiFetchHandler({
    controller: opts.session.controller,
    audit: opts.audit,
    coordinator: opts.aguiCoordinator,
  });
  const planeWebhookHandler = createPlaneWebhookFetchHandler();
  // Default-off: do NOT mount the cross-gateway sync endpoint unless
  // the operator opted in via --registry-sync / AGENTS_JS_REGISTRY_SYNC.
  // Local autoRegister still runs below so the gateway is discoverable
  // on the local machine without exposing the well-known endpoint.
  const syncEndpointHandler = opts.cliArgs.registrySync
    ? createSyncEndpointHandler({ audit: opts.audit })
    : null;
  const a2aServer = new UniversalA2AServer(executor, gatewayCard, undefined, {
    additionalFetch: composeAdditionalFetch({
      planeWebhookHandler,
      aguiHandler,
      syncEndpointHandler,
    }),
  });
  const server = await a2aServer.start({
    hostname: opts.cliArgs.hostname,
    port: opts.resolvedPort,
    cors: true,
  });
  const httpPort = server.port ?? opts.resolvedPort;

  const localName = opts.runtime.agentCard.name ?? "universal-acp-gateway";
  const localUrl = buildAgentCardBaseUrl(httpPort, opts.cliArgs.hostname);

  let registrySync: { stop: () => void };
  if (opts.cliArgs.registrySync) {
    const syncIntervalMs = process.env.AGENTS_JS_SYNC_INTERVAL_MS
      ? Number(process.env.AGENTS_JS_SYNC_INTERVAL_MS)
      : undefined;
    registrySync = startRegistrySync({
      name: localName,
      url: localUrl,
      intervalMs: syncIntervalMs,
      audit: opts.audit,
    });
    console.log("[Gateway] Registry sync enabled (A2A-only peer payload)");
  } else {
    // Local auto-register only — fire-and-forget, mirrors
    // startRegistrySync's autoRegister call so the local registry has
    // an entry without needing to mount the cross-gateway endpoint.
    void autoRegister({
      name: localName,
      kind: "a2a",
      url: localUrl,
    }).catch((err: unknown) => {
      console.warn(
        "[Gateway] Local auto-registration failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    });
    registrySync = { stop: () => {} };
    console.log(
      "[Gateway] Registry sync disabled (default; pass --registry-sync or set AGENTS_JS_REGISTRY_SYNC=true to enable)",
    );
  }

  return { server, gatewayCard, executor, registrySync, httpPort };
}

interface SetupWsBridgeOptions {
  cliArgs: GatewayCliArgs;
  loadedConfig: LoadedAgentsJsConfig;
  initialRuntime: ResolvedGatewayRuntime;
  initialRuntimeModels: Awaited<ReturnType<typeof fetchRuntimeModels>>;
  availableRuntimes: Array<{ id: string; displayName: string }>;
  resolvedDefaultModel: string | undefined;
  session: HostSession;
  surfaceBroadcaster: ReturnType<typeof createGatewaySurfaceBroadcaster>;
  gatewayCard: ReturnType<typeof buildAgentCard>;
  setActiveRuntime: (runtime: ResolvedGatewayRuntime) => void;
  executor: HostA2AExecutor;
  aguiCoordinator: AguiRunCoordinator;
}

/**
 * Pure check: is any operator-driven work currently in flight that
 * would be unsafe to interrupt with a runtime switch?
 *
 * Returns `null` when the gateway is idle and a switch is allowed,
 * or a human-readable reason string when the switch must be rejected.
 *
 * Exported for unit testing — exercising this directly is much
 * cheaper than orchestrating real A2A tasks + AG-UI runs.
 */
export function describeRuntimeSwitchBlockingActivity(input: {
  executor: Pick<HostA2AExecutor, "getActivitySnapshot">;
  aguiCoordinator: Pick<AguiRunCoordinator, "isActive" | "activeRunId">;
}): string | null {
  if (input.aguiCoordinator.isActive) {
    return `AG-UI run is active (runId=${input.aguiCoordinator.activeRunId ?? "(unknown)"})`;
  }
  const { activeTaskCount, activeDispatchCount, inFlightLaneCount, pendingLaneCount } =
    input.executor.getActivitySnapshot();
  if (activeDispatchCount > 0) {
    return `${activeDispatchCount} @@dispatch task(s) in flight`;
  }
  if (activeTaskCount > 0) {
    return `${activeTaskCount} A2A task(s) in flight`;
  }
  if (inFlightLaneCount > 0) {
    return `${inFlightLaneCount} A2A lane(s) holding an in-flight prompt`;
  }
  if (pendingLaneCount > 0) {
    // TOCTOU close: a controllerFactory call is awaiting and a fresh
    // lane bound to the *current* runtime is about to be registered.
    // Switching now would either lose that lane or bind it to the
    // wrong runtime.
    return `${pendingLaneCount} A2A lane(s) currently being constructed`;
  }
  return null;
}

function setupWsBridge(opts: SetupWsBridgeOptions): ReturnType<typeof createWSBridge> {
  // Tracks current runtime/models so a failed switch can roll back to the
  // last-known-good pair instead of leaving the bridge advertising a
  // partially-applied runtime.
  let activeRuntime = opts.initialRuntime;
  let activeRuntimeModels = opts.initialRuntimeModels;

  return createWSBridge({
    controller: opts.session.controller,
    port: 0,
    runtime: {
      id: opts.initialRuntime.definition.id,
      displayName: opts.initialRuntime.definition.displayName,
    },
    availableRuntimes: opts.availableRuntimes,
    runtimeModels: opts.initialRuntimeModels,
    defaultModelId: opts.resolvedDefaultModel,
    surfaceBroadcaster: opts.surfaceBroadcaster,
    setRuntime: async (runtimeId) => {
      // Reject the switch if any operator-driven work is in flight.
      // Allowing a switch through here would either cut off an
      // in-flight ACP turn mid-stream OR leave a lane controller
      // bound to the outgoing runtime silently handling subsequent work.
      // Both outcomes are footguns; the operator gets a clear
      // "busy" error and can retry once their run finishes.
      const blocking = describeRuntimeSwitchBlockingActivity({
        executor: opts.executor,
        aguiCoordinator: opts.aguiCoordinator,
      });
      if (blocking !== null) {
        throw new Error(`[Gateway] Runtime switch rejected: ${blocking}`);
      }

      const nextRuntime = applyEnvRuntimeProfile(
        await resolveGatewayRuntime(runtimeId),
        opts.loadedConfig,
      );
      const previousRuntime = activeRuntime;
      const previousRuntimeModels = activeRuntimeModels;
      const nextRuntimeCommand = nextRuntime.acp.command ?? nextRuntime.definition.command;
      const nextRuntimeModels = await fetchRuntimeModels(nextRuntimeCommand);

      try {
        const switchResult = await opts.session.switchRuntime({
          runtime: nextRuntime,
          defaultModel: opts.resolvedDefaultModel,
        });
        activeRuntime = nextRuntime;
        activeRuntimeModels = nextRuntimeModels;
        opts.setActiveRuntime(nextRuntime);
        // Evict idle lane controllers so the next prompt against an
        // existing contextId spawns a fresh lane on the new runtime
        // instead of inheriting one bound to the old runtime. Lanes
        // still in flight are skipped — but the gate above should
        // have prevented any from existing here.
        const eviction = opts.executor.destroyIdleLanes();
        if (eviction.evicted > 0 || eviction.skipped > 0) {
          console.log(
            `[Gateway] Post-switch lane eviction: evicted=${eviction.evicted} skipped=${eviction.skipped}`,
          );
        }

        const nextGatewayCard = buildAgentCard(nextRuntime.agentCard);
        nextGatewayCard.url = opts.gatewayCard.url;
        Object.assign(opts.gatewayCard, nextGatewayCard);

        const messageParts = [
          `Runtime switched to ${nextRuntime.definition.displayName} (${nextRuntime.definition.id}).`,
          switchResult.preservedSession
            ? "Started a fresh session automatically."
            : "Session remains disconnected until connect.",
        ];
        if (switchResult.clearedPendingTurn) {
          messageParts.push("In-flight or queued prompts were cleared.");
        }

        console.log(
          `[Gateway] Runtime switched to ${nextRuntime.definition.id} (${nextRuntime.definition.displayName})`,
        );

        return {
          runtime: {
            id: nextRuntime.definition.id,
            displayName: nextRuntime.definition.displayName,
          },
          runtimeModels: nextRuntimeModels,
          defaultModelId: opts.resolvedDefaultModel,
          preservedSession: switchResult.preservedSession,
          clearedPendingTurn: switchResult.clearedPendingTurn,
          message: messageParts.join(" "),
        };
      } catch (error) {
        const switchMessage = describeGatewayError(error);
        console.warn(
          `[Gateway] Runtime switch to ${nextRuntime.definition.id} failed, keeping ${previousRuntime.definition.id} active`,
          switchMessage,
        );

        activeRuntime = previousRuntime;
        activeRuntimeModels = previousRuntimeModels;

        throw new Error(
          `Failed to switch runtime to ${nextRuntime.definition.displayName} (${nextRuntime.definition.id}). Still using ${previousRuntime.definition.displayName} (${previousRuntime.definition.id}).`,
        );
      }
    },
  });
}

interface ShutdownTargets {
  registrySync: { stop: () => void };
  server: Awaited<ReturnType<UniversalA2AServer["start"]>>;
  wsBridge: ReturnType<typeof createWSBridge>;
  executor: HostA2AExecutor;
  session: HostSession;
}

function installSignalHandlers(targets: ShutdownTargets): void {
  const shutdown = (): void => {
    console.log("[Gateway] Shutting down...");
    targets.registrySync.stop();
    targets.server.stop(true);
    targets.wsBridge.stop();
    targets.executor.destroy();
    targets.session.destroy();
    process.exit();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<number> {
  const cliArgs = parseCliArgs(argv, process.env);
  const loadedConfig = await loadAgentsJsConfig({
    cwd: cliArgs.workspace,
    env: buildRuntimeProfileConfigEnv(),
  });

  const resolvedPort = resolveGatewayPort({
    cliPort: cliArgs.port,
    envPort: Bun.env.PORT,
    configPort: loadedConfig.effectiveConfig.serve?.port,
  });

  // Resolve runtime: CLI --runtime > config files > env var (via gatewayConfig)
  const configHarness = loadedConfig.effectiveConfig.serve?.harness;
  const selectedRuntime = applyEnvRuntimeProfile(
    cliArgs.runtimeOverride
      ? await resolveGatewayRuntime(cliArgs.runtimeOverride)
      : configHarness
        ? await resolveGatewayRuntimeSelection(configHarness)
        : await resolveGatewayRuntime(gatewayConfig.runtime),
    loadedConfig,
  );

  // Detect all installed runtimes for the runtime selector.
  const installedRuntimeIds = await detectInstalledGatewayRuntimes();
  const availableRuntimes = buildAvailableRuntimeInfos(installedRuntimeIds, selectedRuntime);

  // Resolve defaultModel: CLI --default-model > config files > env var (via gatewayConfig)
  const resolvedDefaultModel =
    cliArgs.defaultModel ??
    loadedConfig.effectiveConfig.serve?.defaultModel ??
    gatewayConfig.defaultModel;

  console.log(
    `[Gateway] Runtime: ${selectedRuntime.definition.id} (${selectedRuntime.definition.displayName})`,
  );
  console.log(`[Gateway] Executable: ${selectedRuntime.acp.command}`);
  console.log(`[Gateway] Workspace: ${cliArgs.workspace}`);
  console.log(`[Gateway] Permission mode: ${cliArgs.permissionMode}`);
  console.log(
    `[Gateway] Workspace trust: ${cliArgs.trustWorkspace ? "trusted (loading .agents-js/permission-rules.json)" : "untrusted (workspace-local rules ignored; pass --trust-workspace to enable)"}`,
  );
  console.log(`[Gateway] Requested port: ${resolvedPort}`);
  if (resolvedDefaultModel) {
    console.log(`[Gateway] Default model: ${resolvedDefaultModel}`);
  }

  if (cliArgs.check) {
    console.log("[Gateway] Check complete.");
    return 0;
  }

  // Fetch available models from runtime CLI (non-blocking on failure).
  // acp.command is the resolved path; definition.command is the unresolved
  // name (e.g. "opencode") used only as a last-resort fallback.
  const runtimeCommand = selectedRuntime.acp.command ?? selectedRuntime.definition.command;
  const runtimeModels = await fetchRuntimeModels(runtimeCommand);
  if (runtimeModels.length > 0) {
    console.log(`[Gateway] Fetched ${runtimeModels.length} runtime models`);
  } else {
    console.log(
      "[Gateway] No runtime models discovered (model selector will be empty until session)",
    );
  }

  // Create the A2UI surface broadcaster BEFORE the host session so the
  // optional A2UI tool-call content handler can capture it. The WS
  // bridge attaches its fan-out callback later; any early agent-emitted
  // surface messages are buffered on the broadcaster until attach.
  const surfaceBroadcaster = createGatewaySurfaceBroadcaster();

  // Create host session with ACPSessionController.
  const session = await createHostSession({
    runtime: selectedRuntime,
    workspacePath: cliArgs.workspace,
    permissionMode: cliArgs.permissionMode,
    defaultModel: resolvedDefaultModel,
    surfaceAdapter: surfaceBroadcaster,
    trustWorkspace: cliArgs.trustWorkspace,
  });

  // The active-runtime cell is captured by both the controllerFactory and
  // the WS bridge's setRuntime closure. The bridge owns mutation; the
  // factory observes it when spawning lane controllers.
  let activeRuntime = selectedRuntime;
  const setActiveRuntime = (runtime: ResolvedGatewayRuntime): void => {
    activeRuntime = runtime;
  };

  // The A2A executor spawns a dedicated controller per A2A `contextId` via
  // this factory so genuinely independent conversations run in parallel
  // instead of serializing against the primary controller. We share the
  // same surface broadcaster across primary + lane controllers so A2UI
  // surfaces emitted from a lane-backed turn still reach connected
  // browser clients — without this, lane-driven surfaces were silently
  // dropped on the gateway side.
  const controllerFactory = async (contextId: string) => {
    console.log("[Gateway] Spawning lane controller", {
      contextId,
      runtime: activeRuntime.definition.id,
    });
    return createStandaloneHostController({
      runtime: activeRuntime,
      workspacePath: cliArgs.workspace,
      permissionMode: cliArgs.permissionMode,
      defaultModel: resolvedDefaultModel,
      permissionEngine: session.permissionEngine,
      permissionStore: session.permissionStore,
      fileAdapters: createNodeFileAdapters(cliArgs.workspace),
      surfaceAdapter: surfaceBroadcaster,
    });
  };

  // Internal correlation/audit surface — records lifecycle events for
  // AG-UI runs, A2A tasks, and @@dispatch with stable correlation IDs.
  // The emitter is in-process (ring buffer + console.log) and carries
  // structural metadata only; raw user content never lands here.
  const audit = createAuditEmitter();

  // Shared AG-UI run coordinator. Both the AG-UI fetch handler (which
  // acquires/releases the run slot) and the WS bridge's setRuntime
  // gate (which checks isActive) read from this single instance, so
  // a runtime switch attempted mid-AG-UI-run sees the same busy state
  // the second `POST /agent` would see.
  const aguiCoordinator = new AguiRunCoordinator();

  const { server, gatewayCard, executor, registrySync, httpPort } = await setupServer({
    cliArgs,
    resolvedPort,
    runtime: selectedRuntime,
    session,
    controllerFactory,
    audit,
    aguiCoordinator,
  });

  const wsBridge = setupWsBridge({
    cliArgs,
    loadedConfig,
    initialRuntime: selectedRuntime,
    initialRuntimeModels: runtimeModels,
    availableRuntimes,
    resolvedDefaultModel,
    session,
    surfaceBroadcaster,
    gatewayCard,
    setActiveRuntime,
    executor,
    aguiCoordinator,
  });

  const wsPort = wsBridge.server.port ?? 0;
  const discovery = buildGatewayDiscovery(httpPort, wsPort);

  for (const line of formatGatewayDiscoveryLines(discovery)) {
    console.log(line);
  }
  console.log(`[Gateway] A2A server listening on port ${httpPort}`);
  console.log(`[Gateway] WebSocket bridge listening on port ${wsPort}`);

  installSignalHandlers({ registrySync, server, wsBridge, executor, session });

  await new Promise<void>(() => {});
  return 0;
}
