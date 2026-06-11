/**
 * Factory for constructing a full gateway (HostA2AExecutor +
 * ACPSessionController + UniversalA2AServer) wired to an arbitrary ACP
 * command, for deterministic end-to-end testing.
 *
 * Unlike the production entry point in `index.ts`, this factory bypasses
 * runtime-profile machinery (claude, opencode, gemini) so tests can spawn
 * a simple mock ACP agent (e.g. `tests/mock-acp-agent.cjs`) via `node`
 * and exercise the real `HostA2AExecutor` code path against it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAgentCard, UniversalA2AServer } from "@agents-js/a2a";
import {
  ACPSessionController,
  createNodeFileAdapters,
  PermissionEngine,
  type PermissionMode,
  PermissionStore,
} from "@agents-js/acp-host";
import { SignJWT } from "jose";
import type { AgentRegistryMap } from "./agent-registry.ts";
import type { MatrixSendArgs, MatrixTool } from "./agents-tool-surface.ts";
import { createAguiFetchHandler } from "./agui-endpoint.ts";
import type { AguiRunCoordinator } from "./agui-run-coordinator.ts";
import { HostA2AExecutor } from "./host-executor.ts";

/**
 * Shared timeout (ms) for the learning-test suites that spawn a real
 * `tests/mock-acp-agent.cjs` subprocess and complete an ACP handshake —
 * slower than the bun:test 5s default. Centralized here so every
 * subprocess-backed example pins the same value.
 */
export const LEARNING_TEST_TIMEOUT_MS = 20_000;

/**
 * Absolute path to the repo-root `tests/mock-acp-agent.cjs` fixture — the
 * JSON-RPC/NDJSON mock ACP agent spawned as a real `node` subprocess by the
 * runtime smokes. Resolved relative to this module so callers in
 * `examples/<x>-smoke/tests/` don't each hard-code a `../../../tests` hop.
 */
export function getMockAgentPath(): string {
  return resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");
}

/**
 * Mint an HS256 JWT the way the gateway-side minter does (jose `SignJWT`).
 * Callers pass their OWN signing key via `overrides.key`; the remaining
 * fields default to sensible smoke values so each test only overrides the
 * dimension it stresses (wrong key, past `exp`, specific scopes, ...).
 *
 * Unifies the previously-duplicated `mintScopedJwt` / `mintJwt` /
 * `mintTestJwt` helpers across the hardening, agents-mcp, and
 * internal-gateway suites.
 */
export async function mintTestJwt(
  overrides: {
    sub?: string;
    scopes?: readonly string[];
    cid?: string;
    iss?: string;
    aud?: string;
    expSecondsFromNow?: number;
    key?: Uint8Array;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    scopes: overrides.scopes ?? ["matrix.send_message", "matrix.read"],
    cid: overrides.cid ?? "cid-test-001",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(overrides.sub ?? "smoke-agent")
    .setIssuer(overrides.iss ?? "test-gateway")
    .setAudience(overrides.aud ?? "agents-js-mcp")
    .setIssuedAt(now)
    .setExpirationTime(now + (overrides.expSecondsFromNow ?? 900))
    .sign(overrides.key ?? new TextEncoder().encode("test-signing-key-32bytes-or-more"));
}

/**
 * Recording {@link MatrixTool} double — captures every `send` call in
 * `calls` and returns a synthetic `event_id`. The agents-MCP dispatcher
 * requires a Matrix sender even on inbox-only paths; tests assert on
 * `calls` to prove (or disprove) that a target reached Matrix.
 */
export function makeRecordingMatrixTool(): MatrixTool & { calls: MatrixSendArgs[] } {
  const calls: MatrixSendArgs[] = [];
  return {
    calls,
    async send(args) {
      calls.push(args);
      return { event_id: `$evt-${calls.length}` };
    },
  };
}

/** Return shape for {@link createMockAcpController}. */
export interface MockAcpControllerHandle {
  /** A started controller backed by a real mock-ACP subprocess. */
  controller: ACPSessionController;
  /** The temp workspace created for the controller. */
  workspacePath: string;
  /** Destroy the controller (kills the subprocess) and remove the workspace. */
  cleanup(): Promise<void>;
}

/**
 * Build a started {@link ACPSessionController} wired to the repo-root mock
 * ACP agent, packaging the temp-workspace + Node file adapters + empty
 * permission engine/store + `start()` + permission-mode steps the runtime
 * smokes all repeat in `beforeEach`. The only axis the smokes differ on is
 * `permissionMode` ("default" lets gates fire and round-trip; "bypassPermissions"
 * auto-resolves them).
 *
 * `cleanup()` destroys the controller (killing the subprocess so the runner
 * does not hang on teardown) and removes the temp workspace. Callers holding
 * additional resources (a bridge/client) must tear those down BEFORE calling
 * `cleanup()`.
 */
export async function createMockAcpController(
  opts: { name?: string; permissionMode?: PermissionMode; mockAgentPath?: string } = {},
): Promise<MockAcpControllerHandle> {
  const name = opts.name ?? "mock-acp-controller";
  const mockAgentPath = opts.mockAgentPath ?? getMockAgentPath();
  const workspacePath = await mkdtemp(join(tmpdir(), `${name}-`));
  const controller = new ACPSessionController();
  await controller.start({
    agentConfig: {
      name,
      command: "node",
      args: [mockAgentPath],
      env: {},
      authHints: [],
      workspacePolicy: "workspace-root-only",
      // The mock resolves `node` from the real PATH, so the spawn must not
      // run under a sandboxed home (mirrors createGatewayTestServer).
      allowRealHome: true,
    },
    workspacePath,
    fileAdapters: createNodeFileAdapters(workspacePath),
    permissionEngine: new PermissionEngine(),
    permissionStore: new PermissionStore(),
    clientInfo: { name, version: "0.1.0" },
  });
  await controller.setPermissionMode(opts.permissionMode ?? "bypassPermissions");

  return {
    controller,
    workspacePath,
    async cleanup() {
      controller.destroy();
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

/**
 * Poll `predicate` until it holds or the timeout elapses, throwing on
 * timeout. The generic async poller the live-state smokes use to wait for
 * a bridge snapshot / gate event to propagate.
 */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  stepMs = 10,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await Bun.sleep(stepMs);
  }
}

export interface GatewayTestServerOptions {
  /** Command to spawn for the ACP agent (e.g. "node") */
  acpCommand: string;
  /** Args to pass to the ACP command (e.g. ["tests/mock-acp-agent.cjs"]) */
  acpArgs: string[];
  /** Env for the ACP process */
  acpEnv?: Record<string, string>;
  /** Workspace path (default: tmp dir) */
  workspacePath?: string;
  /** Permission mode (default: "bypassPermissions" for test ergonomics) */
  permissionMode?: PermissionMode;
  /** Port to listen on (default: 0 = OS-assigned) */
  port?: number;
  /**
   * Optional dispatch registry to wire into the `HostA2AExecutor`. When set,
   * `@@agent-name` directives in incoming prompts resolve against this map
   * rather than the disk-backed registry at `~/.agents-js/registry.json`.
   * Enables integration tests to exercise the ACP-kind dispatch path against
   * the mock ACP agent fixture.
   */
  dispatchRegistry?: AgentRegistryMap;
  /**
   * When `true`, wire a per-contextId controller factory into the executor
   * so distinct A2A `contextId`s each get their own freshly-spawned
   * `ACPSessionController` (true parallel execution). Mirrors how
   * `apps/internal-gateway/main.ts` wires the factory in production.
   * Defaults to `false` so most tests still exercise the shared-controller
   * code path.
   */
  enablePerLaneControllers?: boolean;
  /**
   * When `true`, mount the native AG-UI endpoint (`POST /agent`) on the
   * same port via the server's `additionalFetch` hook, wired to the
   * factory-owned controller. Mirrors how `apps/internal-gateway/main.ts`
   * composes the AG-UI handler into the gateway. Defaults to `false` so
   * existing callers keep a pure A2A server with no AG-UI surface.
   */
  mountAguiEndpoint?: boolean;
  /**
   * Optional run coordinator for the mounted AG-UI endpoint. Only used
   * when `mountAguiEndpoint` is `true`. Pass an explicit instance to
   * inspect or share the single-active-run gate; otherwise the endpoint
   * creates its own fresh coordinator.
   */
  aguiCoordinator?: AguiRunCoordinator;
}

export interface GatewayTestServerHandle {
  /** Base URL for the A2A server (e.g. "http://127.0.0.1:51234") */
  url: string;
  /** The actual port the server is listening on */
  port: number;
  /** Shut down the server, kill the ACP process, destroy the controller */
  stop(): Promise<void>;
}

/**
 * Construct a running gateway test server bound to the given ACP command.
 *
 * This assembles the same three layers as the production gateway:
 *   1. `ACPSessionController` with Node file adapters + empty permission
 *      engine/store (no disk persistence, no hooks).
 *   2. `HostA2AExecutor` wrapping the controller (the real production class).
 *   3. `UniversalA2AServer` wrapping the executor with a minimal agent card.
 *
 * Returns a handle that exposes the bound URL/port and a `stop()` cleanup
 * routine. Any temp workspace directory created by this factory is removed
 * on `stop()`; caller-provided `workspacePath` is left alone.
 */
export async function createGatewayTestServer(
  options: GatewayTestServerOptions,
): Promise<GatewayTestServerHandle> {
  const permissionMode: PermissionMode = options.permissionMode ?? "bypassPermissions";
  const port = options.port ?? 0;

  // Create a temp workspace only when the caller did not supply one.
  let workspacePath: string;
  let ownedWorkspace = false;
  if (options.workspacePath) {
    workspacePath = options.workspacePath;
  } else {
    workspacePath = await mkdtemp(join(tmpdir(), "gateway-test-server-"));
    ownedWorkspace = true;
  }

  // Minimal in-memory permission engine + store. We intentionally skip
  // PermissionStore.init() (no persistence) — the store still behaves as an
  // empty in-memory container, and the engine runs with no loaded rules.
  const permissionEngine = new PermissionEngine();
  const permissionStore = new PermissionStore();

  const fileAdapters = createNodeFileAdapters(workspacePath);

  const controller = new ACPSessionController();
  // Controllers spawned by the optional per-lane controller factory. Held
  // so teardown can destroy them alongside the primary.
  const laneControllers: ACPSessionController[] = [];

  // Shared best-effort teardown. Used by both the early-exit error paths
  // (start/listen failures before we return a handle) and the stop() routine
  // on the returned handle.
  const teardown = async (server?: { stop: (force: boolean) => void }): Promise<void> => {
    if (server) {
      try {
        server.stop(true);
      } catch {
        // ignore
      }
    }
    try {
      controller.destroy();
    } catch {
      // ignore
    }
    // Tear down any lane controllers spawned via the Phase-2 factory.
    for (const laneController of laneControllers) {
      try {
        laneController.destroy();
      } catch {
        // ignore
      }
    }
    if (ownedWorkspace) {
      await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    }
  };

  try {
    await controller.start({
      agentConfig: {
        name: "gateway-test",
        command: options.acpCommand,
        args: options.acpArgs,
        env: options.acpEnv ?? {},
        authHints: [],
        workspacePolicy: "workspace-root-only",
        allowRealHome: true,
      },
      workspacePath,
      fileAdapters,
      permissionEngine,
      permissionStore,
      clientInfo: { name: "gateway-test", version: "0.1.0" },
    });
    await controller.setPermissionMode(permissionMode);
  } catch (err) {
    await teardown();
    throw err;
  }

  // The controller satisfies the GatewayHostController shape structurally,
  // so the executor can accept it directly without the StableHostSessionController
  // facade that only matters for runtime-swap scenarios.
  const controllerFactory = options.enablePerLaneControllers
    ? async () => {
        const laneController = new ACPSessionController();
        await laneController.start({
          agentConfig: {
            name: "gateway-test-lane",
            command: options.acpCommand,
            args: options.acpArgs,
            env: options.acpEnv ?? {},
            authHints: [],
            workspacePolicy: "workspace-root-only" as const,
            allowRealHome: true,
          },
          workspacePath,
          fileAdapters,
          permissionEngine,
          permissionStore,
          clientInfo: { name: "gateway-test-lane", version: "0.1.0" },
        });
        await laneController.setPermissionMode(permissionMode);
        laneControllers.push(laneController);
        return laneController;
      }
    : undefined;
  const executor = new HostA2AExecutor(controller, {
    ...(options.dispatchRegistry ? { dispatchRegistry: options.dispatchRegistry } : {}),
    ...(controllerFactory ? { controllerFactory } : {}),
    dispatchWorkspacePath: workspacePath,
  });

  const agentCard = buildAgentCard({
    name: "gateway-test",
    description: "Test gateway",
    capabilities: { extensions: [], "text-to-text": {} },
  });

  // Optionally mount the native AG-UI endpoint against the factory-owned
  // controller, so callers can exercise the real SSE run surface
  // (RUN_STARTED → interior → RUN_FINISHED) and the single-active-run gate
  // end-to-end against the mock ACP agent.
  const additionalFetch = options.mountAguiEndpoint
    ? createAguiFetchHandler({
        controller,
        ...(options.aguiCoordinator ? { coordinator: options.aguiCoordinator } : {}),
      })
    : undefined;

  const a2aServer = new UniversalA2AServer(
    executor,
    agentCard,
    undefined,
    additionalFetch ? { additionalFetch } : undefined,
  );
  let server: Awaited<ReturnType<UniversalA2AServer["start"]>>;
  try {
    server = await a2aServer.start({ port, cors: true });
  } catch (err) {
    await teardown();
    throw err;
  }

  const boundPort = server.port ?? port;
  const url = `http://127.0.0.1:${boundPort}`;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      executor.destroy();
    } catch {
      // ignore
    }
    await teardown(server);
  };

  return {
    url,
    port: boundPort,
    stop,
  };
}
