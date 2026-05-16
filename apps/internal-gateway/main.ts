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
  createBusPublishHandler,
  createBusSubscribeHandler,
  createGatewayBus,
  createGatewaySurfaceBroadcaster,
  createHostSession,
  createStandaloneHostController,
  createWSBridge,
  fetchRuntimeModels,
  type GatewayBus,
  type GatewayHostController,
  type HarnessFleetEntry,
  HarnessLaneManager,
  HostA2AExecutor,
  wrapAuditEmitterAsBusPublisher,
} from "@agents-js/host";
import { createPlaneWebhookFetchHandler } from "@agents-js/plane/mount";
import { type GatewayCliArgs, parseCliArgs } from "./cli-args.ts";
import {
  buildGatewayDiscovery,
  formatGatewayDiscoveryLines,
  resolveGatewayPort,
} from "./discovery.ts";
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
  executor: HostA2AExecutor;
  registrySync: { stop: () => void };
  httpPort: number;
}

interface SetupServerOptions {
  cliArgs: GatewayCliArgs;
  resolvedPort: number;
  /**
   * Ordered list of resolved runtimes. AJS-7 PR1 introduces the array
   * form: index 0 is the primary routing target — consumers that need
   * a single runtime (the registry-sync auto-register name, etc.) read
   * `runtimes[0]`. PR2 fans the secondary entries out into the
   * `HarnessLaneManager` lane fleet; the agent card surface they show
   * up on is built outside `setupServer` so the lane manager can
   * pre-populate `capabilities.harnesses` before the server starts
   * serving `/.well-known/agent-card.json`.
   */
  runtimes: readonly ResolvedGatewayRuntime[];
  /**
   * Live agent card reference. Constructed in `main()` and mutated in
   * place by the `HarnessLaneManager` (pre-populates
   * `capabilities.harnesses` at construction; flips `ready` on spawn /
   * exit). The A2A server reads this same object when serving
   * `/.well-known/agent-card.json`, so federated peers see live fleet
   * state without polling the bus.
   */
  gatewayCard: ReturnType<typeof buildAgentCard>;
  session: HostSession;
  controllerFactory: (contextId: string) => Promise<GatewayHostController>;
  audit: ReturnType<typeof createAuditEmitter>;
  bus: GatewayBus;
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
 * Compose the gateway's `additionalFetch` chain. Order matters: bus
 * subscribe/publish endpoints run first (self-route on `/events` and
 * `/admin/publish`), then plane-webhook handlers (self-route on path),
 * then AG-UI as the primary browser run surface, and the registry sync
 * endpoint — when enabled — runs last so it never shadows AG-UI's
 * `/agent` route.
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
  busSubscribeHandler: (req: Request) => Promise<Response | null>;
  busPublishHandler: (req: Request) => Promise<Response | null>;
  syncEndpointHandler: ((req: Request) => Promise<Response | null>) | null;
}): (req: Request) => Promise<Response | null> {
  return async (req: Request): Promise<Response | null> => {
    // Bus endpoints self-route on path (`/events`, `/admin/publish`)
    // and return null otherwise — safe to attempt before AG-UI's
    // `POST /agent`. Subscribe + publish are both gated to
    // trusted-network by the deployment model; the internal-gateway
    // listener is operator-only.
    const busSubscribeResponse = await handlers.busSubscribeHandler(req);
    if (busSubscribeResponse !== null) return busSubscribeResponse;
    const busPublishResponse = await handlers.busPublishHandler(req);
    if (busPublishResponse !== null) return busPublishResponse;
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

/**
 * Resolve the operator-configured harness fleet. Priority order:
 *
 *   1. CLI `--runtime` / `--runtimes` overrides (multi-entry, multi-harness path)
 *   2. Config-file `serve.harness` selection (single entry; may be a richer
 *      `GatewayRuntimeSelection` shape rather than a bare id string)
 *   3. Built-in default (`gatewayConfig.runtime`)
 *
 * Each entry passes through `applyEnvRuntimeProfile` so env-driven runtime
 * profiles override the resolved curated config. Returns a non-empty array
 * — the caller relies on `[0]` being defined.
 */
async function resolveHarnessFleet(opts: {
  cliArgs: GatewayCliArgs;
  loadedConfig: LoadedAgentsJsConfig;
  gatewayConfig: typeof gatewayConfig;
}): Promise<ResolvedGatewayRuntime[]> {
  const { cliArgs, loadedConfig, gatewayConfig } = opts;
  const apply = (runtime: ResolvedGatewayRuntime): ResolvedGatewayRuntime =>
    applyEnvRuntimeProfile(runtime, loadedConfig);

  if (cliArgs.runtimeOverrides.length > 0) {
    return Promise.all(
      cliArgs.runtimeOverrides.map(async (id) => apply(await resolveGatewayRuntime(id))),
    );
  }

  const configHarness = loadedConfig.effectiveConfig.serve?.harness;
  if (configHarness) {
    return [apply(await resolveGatewayRuntimeSelection(configHarness))];
  }

  return [apply(await resolveGatewayRuntime(gatewayConfig.runtime))];
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
  // PR2: agent card is built in `main()` so the `HarnessLaneManager`
  // can pre-populate `capabilities.harnesses` before the server hands
  // it to `UniversalA2AServer`. The card object identity is preserved
  // — the lane manager mutates the same instance the A2A server reads.
  const primaryRuntime = opts.runtimes[0];
  if (primaryRuntime === undefined) {
    throw new Error("[Gateway] SetupServerOptions.runtimes must contain at least one runtime.");
  }
  const gatewayCard = opts.gatewayCard;
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
  const busSubscribeHandler = createBusSubscribeHandler({ bus: opts.bus });
  const busPublishHandler = createBusPublishHandler({ bus: opts.bus });
  const a2aServer = new UniversalA2AServer(executor, gatewayCard, undefined, {
    additionalFetch: composeAdditionalFetch({
      planeWebhookHandler,
      aguiHandler,
      busSubscribeHandler,
      busPublishHandler,
      syncEndpointHandler,
    }),
  });
  const server = await a2aServer.start({
    hostname: opts.cliArgs.hostname,
    port: opts.resolvedPort,
    cors: true,
  });
  const httpPort = server.port ?? opts.resolvedPort;

  const localName = primaryRuntime.agentCard.name ?? "universal-acp-gateway";
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

  return { server, executor, registrySync, httpPort };
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
  /**
   * Lane manager — the WS bridge calls
   * {@link HarnessLaneManager.setPrimaryHarnessId} on a successful
   * runtime switch (per AJS-7 PR3 § Behavior). The bridge does NOT
   * spawn or destroy lane controllers itself; the manager owns that
   * lifecycle.
   */
  laneManager: HarnessLaneManager;
}

/**
 * Pure check: is anything in flight that would be unsafe to interrupt
 * with a primary-routing-target switch?
 *
 * **Scoped down for AJS-7 PR3 multi-harness behavior** — under PR3,
 * existing in-flight A2A tasks / dispatch / lanes / pending-spawns
 * stay bound to their original harness's controller even after the
 * primary flips. Only future sessions route to the new primary. So
 * the cross-harness in-flight signals no longer block a switch — they
 * have no conflict with the new routing target.
 *
 * The single remaining blocker: AG-UI runs. AG-UI is a multi-prompt
 * coordinated flow where every prompt in the run is expected to land
 * on the same controller. Switching the primary mid-AG-UI-run won't
 * actively break the run (existing lanes stay bound), but operator UX
 * is cleaner if the switch is rejected until the AG-UI run completes
 * — otherwise the operator just changed routing target and the next
 * prompt of the active run still goes to the OLD primary, which is
 * surprising.
 *
 * Returns `null` when the switch is allowed, or a human-readable
 * reason when it's rejected.
 *
 * Exported for unit testing — exercising this directly is much
 * cheaper than orchestrating real AG-UI runs.
 */
export function describeRuntimeSwitchBlockingActivity(input: {
  executor: Pick<HostA2AExecutor, "getActivitySnapshot">;
  aguiCoordinator: Pick<AguiRunCoordinator, "isActive" | "activeRunId">;
}): string | null {
  if (input.aguiCoordinator.isActive) {
    return `AG-UI run is active (runId=${input.aguiCoordinator.activeRunId ?? "(unknown)"})`;
  }
  // Cross-harness in-flight work (A2A tasks, dispatch, lanes, pending
  // spawns) does NOT block a primary-target switch under PR3 semantics
  // — those sessions stay bound to their original harness's
  // controller regardless of who's primary. `getActivitySnapshot()`
  // is kept on the executor surface for diagnostics/observability;
  // the call here is intentionally elided.
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
      // AJS-7 PR3: WS-bridge runtime switch is now "switch the primary
      // routing target" — change which configured fleet entry is the
      // default for new sessions. Existing in-flight lane controllers
      // stay bound to whichever harness spawned them; only future
      // `controllerFactory(contextId)` calls route to the new primary.
      //
      // Pre-checks happen BEFORE any state mutation so a rejected
      // switch leaves the gateway in its prior state:
      //   - Target must be in the configured fleet. Dynamic install
      //     of a non-configured runtime is out of v1 scope per AC.
      //   - Cross-harness in-flight work no longer blocks the switch
      //     (per AC § Behavior, `describeRuntimeSwitchBlockingActivity`
      //     is scoped down to the AG-UI invariant only — see its
      //     docstring).
      if (!opts.laneManager.hasHarness(runtimeId)) {
        throw new Error(
          `[Gateway] Runtime switch rejected: "${runtimeId}" is not in the configured fleet (${opts.laneManager
            .getHarnessCapabilityEntries()
            .map((e) => e.id)
            .join(", ")}). Restart the gateway with --runtimes including the target to add it.`,
        );
      }

      const blocking = describeRuntimeSwitchBlockingActivity({
        executor: opts.executor,
        aguiCoordinator: opts.aguiCoordinator,
      });
      if (blocking !== null) {
        throw new Error(`[Gateway] Runtime switch rejected: ${blocking}`);
      }

      if (runtimeId === activeRuntime.definition.id) {
        // No-op switch — operator selected the current primary again.
        return {
          runtime: {
            id: activeRuntime.definition.id,
            displayName: activeRuntime.definition.displayName,
          },
          runtimeModels: activeRuntimeModels,
          defaultModelId: opts.resolvedDefaultModel,
          preservedSession: true,
          clearedPendingTurn: false,
          message: `Runtime is already ${activeRuntime.definition.displayName} (${activeRuntime.definition.id}); no change.`,
        };
      }

      // Pre-flip the model fetch: if `fetchRuntimeModels` rejects, the
      // gateway stays on the OLD primary (no card mutation, no
      // card-changed events published, no local activeRuntime cell
      // update). Only after the async fetch resolves do we commit the
      // switch via `setPrimaryHarnessId`. This preserves the "pre-checks
      // happen before any state mutation" contract documented above.
      const nextRuntime = opts.laneManager.getHarnessRuntime(runtimeId);
      const nextRuntimeCommand = nextRuntime.acp.command ?? nextRuntime.definition.command;
      const nextRuntimeModels = await fetchRuntimeModels(nextRuntimeCommand);

      // Commit. The lane manager mutates `gatewayCard.capabilities.harnesses`
      // in place and publishes `gateway.harness.card-changed` for both
      // affected entries (old primary primary:true→false, new primary
      // primary:false→true).
      const previousRuntime = activeRuntime;
      opts.laneManager.setPrimaryHarnessId(runtimeId);

      activeRuntime = nextRuntime;
      activeRuntimeModels = nextRuntimeModels;
      opts.setActiveRuntime(nextRuntime);

      console.log(
        `[Gateway] Primary routing target switched: ${previousRuntime.definition.id} → ${nextRuntime.definition.id} (${nextRuntime.definition.displayName}). Existing in-flight sessions stay on their bound lane controllers; new sessions route to the new primary.`,
      );

      return {
        runtime: {
          id: nextRuntime.definition.id,
          displayName: nextRuntime.definition.displayName,
        },
        runtimeModels: nextRuntimeModels,
        defaultModelId: opts.resolvedDefaultModel,
        // Under PR3 semantics there's no session swap, so the legacy
        // session-preservation fields are trivially "preserved, nothing
        // cleared." Kept on the wire for back-compat with the WS bridge
        // client surface; consumers can ignore.
        preservedSession: true,
        clearedPendingTurn: false,
        message: `Primary routing target switched to ${nextRuntime.definition.displayName} (${nextRuntime.definition.id}). Future sessions route here; existing in-flight sessions are unaffected.`,
      };
    },
  });
}

interface ShutdownTargets {
  registrySync: { stop: () => void };
  server: Awaited<ReturnType<UniversalA2AServer["start"]>>;
  wsBridge: ReturnType<typeof createWSBridge>;
  executor: HostA2AExecutor;
  session: HostSession;
  laneManager: HarnessLaneManager;
}

function installSignalHandlers(targets: ShutdownTargets): void {
  const shutdown = async (): Promise<void> => {
    console.log("[Gateway] Shutting down...");
    targets.registrySync.stop();
    targets.server.stop(true);
    targets.wsBridge.stop();
    targets.executor.destroy();
    // Lane manager tears down every spawned lane controller. Exits
    // flow through `onProcessExit` with `crash: false` because each
    // `destroy()` sets the gateway-initiated latch on the underlying
    // `ACPSessionController` before killing its child.
    try {
      await targets.laneManager.destroy();
    } catch (err) {
      console.warn(
        "[Gateway] Lane manager teardown raised (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    }
    targets.session.destroy();
    process.exit();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
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

  // Resolve runtime fleet: CLI --runtime/--runtimes > config files >
  // env var (via gatewayConfig).
  //
  // AJS-7 PR2: `runtimeOverrides` is the ordered list (index 0 =
  // primary). Every entry resolves to a `ResolvedGatewayRuntime` and
  // becomes a `HarnessFleetEntry` in the fleet array. The primary
  // (`fleet[0]`) drives single-runtime consumers — agent-card name,
  // registry-sync auto-register URL, WS bridge initial runtime — while
  // the lane manager owns the fan-out for routing.
  const harnessFleet = await resolveHarnessFleet({ cliArgs, loadedConfig, gatewayConfig });
  // biome-ignore lint/style/noNonNullAssertion: resolveHarnessFleet always returns at least one entry
  const selectedRuntime = harnessFleet[0]!;

  // Detect all installed runtimes for the runtime selector.
  const installedRuntimeIds = await detectInstalledGatewayRuntimes();
  const availableRuntimes = buildAvailableRuntimeInfos(installedRuntimeIds, selectedRuntime);

  // Resolve defaultModel: CLI --default-model > config files > env var (via gatewayConfig)
  const resolvedDefaultModel =
    cliArgs.defaultModel ??
    loadedConfig.effectiveConfig.serve?.defaultModel ??
    gatewayConfig.defaultModel;

  console.log(
    `[Gateway] Primary runtime: ${selectedRuntime.definition.id} (${selectedRuntime.definition.displayName})`,
  );
  if (harnessFleet.length > 1) {
    const secondaryDescriptors = harnessFleet
      .slice(1)
      .map((r) => `${r.definition.id} (${r.definition.displayName})`)
      .join(", ");
    console.log(`[Gateway] Secondary harnesses: ${secondaryDescriptors}`);
  }
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

  // PR2 makes WS-bridge-driven runtime switches throw before any state
  // mutation (see `runtimeSwitchDisabledReason` in `setupWsBridge`), so
  // this hook is unreachable in normal flow. It stays defined as a
  // no-op to satisfy the bridge surface; if it ever DOES execute, the
  // gateway is in a state the AC explicitly defers to PR3.
  const setActiveRuntime = (_runtime: ResolvedGatewayRuntime): void => {};

  // Internal gateway bus — single in-process pub/sub channel that
  // surfaces gateway lifecycle events to operator tooling (external
  // bridges, dashboards, etc.) via the SSE `/events` endpoint mounted
  // below. Trusted-network only; the internal-gateway listener is
  // operator-only per AC v3.
  const bus = createGatewayBus();

  // Internal correlation/audit surface — records lifecycle events for
  // AG-UI runs, A2A tasks, and @@dispatch with stable correlation IDs.
  // The emitter is in-process (ring buffer + console.log) and carries
  // structural metadata only; raw user content never lands here. The
  // wrapper also lifts every recorded event onto the bus as a
  // `gateway.audit.<kind>` event so subscribers see the full lifecycle
  // stream without polling the ring buffer.
  const audit = wrapAuditEmitterAsBusPublisher({ bus, emitter: createAuditEmitter() });

  // AJS-7 PR2: build the live agent card here so the lane manager can
  // pre-populate `capabilities.harnesses` before the A2A server serves
  // it. The card identity is preserved across the call chain — the
  // lane manager and the A2A server hold the same reference.
  const gatewayCard = buildAgentCard(selectedRuntime.agentCard);

  // AJS-7 PR2: build the harness fleet entries and construct the
  // lane manager. The manager owns:
  //   - lazy spawn of per-harness lane controllers (one per harnessId,
  //     multiplexed across contextIds)
  //   - `gateway.harness.{child-spawned,child-exited,card-changed}`
  //     bus publishers
  //   - the `gatewayCard.capabilities.harnesses` agent-card slice
  // Index 0 of `harnessFleet` is the primary; all others are secondaries.
  const harnessFleetEntries: HarnessFleetEntry[] = harnessFleet.map((runtime, index) => ({
    id: runtime.definition.id,
    displayName: runtime.definition.displayName,
    runtime,
    primary: index === 0,
  }));
  // createHostSession (above) already spawned the primary ACP child. If
  // the lane manager constructor throws (duplicate harness id, missing /
  // multiple primaries, empty entries), the CLI entry-point exits and
  // the OS reaps the child — but any embedder that wraps setupServer
  // would leak the child until they kill the parent. Tear the session
  // down explicitly before re-throwing.
  let laneManager: HarnessLaneManager;
  try {
    laneManager = new HarnessLaneManager({
      entries: harnessFleetEntries,
      gatewayCard,
      bus,
      createController: async (entry) =>
        createStandaloneHostController({
          runtime: entry.runtime,
          workspacePath: cliArgs.workspace,
          permissionMode: cliArgs.permissionMode,
          defaultModel: resolvedDefaultModel,
          permissionEngine: session.permissionEngine,
          permissionStore: session.permissionStore,
          fileAdapters: createNodeFileAdapters(cliArgs.workspace),
          surfaceAdapter: surfaceBroadcaster,
        }),
    });
  } catch (err) {
    session.destroy();
    throw err;
  }

  // The A2A executor spawns a dedicated controller per A2A `contextId`
  // via this factory so genuinely independent conversations run in
  // parallel. In PR2 the factory delegates to the lane manager, which
  // resolves the operator-pinned primary harness for v1. Per-request
  // routing override is deferred to v2 (AC open Q2).
  const controllerFactory = async (contextId: string) =>
    laneManager.getOrSpawnLane(laneManager.getPrimaryHarnessId(), contextId);

  // Shared AG-UI run coordinator. Both the AG-UI fetch handler (which
  // acquires/releases the run slot) and the WS bridge's setRuntime
  // gate (which checks isActive) read from this single instance, so
  // a runtime switch attempted mid-AG-UI-run sees the same busy state
  // the second `POST /agent` would see.
  const aguiCoordinator = new AguiRunCoordinator();

  const { server, executor, registrySync, httpPort } = await setupServer({
    cliArgs,
    resolvedPort,
    runtimes: harnessFleet,
    gatewayCard,
    session,
    controllerFactory,
    audit,
    bus,
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
    laneManager,
  });

  const wsPort = wsBridge.server.port ?? 0;
  const discovery = buildGatewayDiscovery(httpPort, wsPort);

  for (const line of formatGatewayDiscoveryLines(discovery)) {
    console.log(line);
  }
  console.log(`[Gateway] A2A server listening on port ${httpPort}`);
  console.log(`[Gateway] WebSocket bridge listening on port ${wsPort}`);

  installSignalHandlers({ registrySync, server, wsBridge, executor, session, laneManager });

  await new Promise<void>(() => {});
  return 0;
}
