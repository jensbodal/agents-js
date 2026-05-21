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
import { join } from "node:path";
import { buildAgentCard, UniversalA2AServer } from "@agents-js/a2a";
import {
  ACPSessionController,
  createNodeFileAdapters,
  PermissionEngine,
  type PermissionMode,
  PermissionStore,
} from "@agents-js/acp-host";
import type { AgentRegistryMap } from "./agent-registry.ts";
import { HostA2AExecutor } from "./host-executor.ts";

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
    capabilities: { "text-to-text": {} },
  });

  const a2aServer = new UniversalA2AServer(executor, agentCard);
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
