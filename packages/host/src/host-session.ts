/**
 * Factory for creating and configuring an ACPSessionController instance
 * as the host session for the internal gateway.
 *
 * Replaces raw spawnACPAgent() with the full ACPSessionController lifecycle,
 * including permission mediation, write gates, and file adapters.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createA2uiToolCallContentHandler,
  type HostSurfaceAdapter,
} from "@agents-js/a2ui-host/acp-host";
import {
  ACPSessionController,
  type ACPSessionState,
  createNodeFileAdapters,
  type HostSessionStorageAdapter,
  PermissionEngine,
  type PermissionMode,
  PermissionStore,
  type ToolCallSummary,
} from "@agents-js/acp-host";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";
import { buildHostRuntimeEnvPolicy } from "./runtime-env-policy.ts";
import {
  E2E_RUNTIME_PROFILE_DATA_HOME_ENV,
  E2E_RUNTIME_PROFILE_STATE_HOME_ENV,
} from "./runtime-profile-env.ts";
import { resolveHostWorkspaceFlag } from "./runtime-workspace-flag.ts";

// Derive PermissionRule type from the engine to avoid direct @agents-js/policy import
type PermissionRules = Parameters<PermissionEngine["loadRules"]>[0];
type PermissionRequest = Parameters<PermissionEngine["createRule"]>[0];
type PermissionResponse = Parameters<ACPSessionController["resolvePermission"]>[0];
type SelectedPermissionScope = Parameters<ACPSessionController["resolvePermission"]>[1];
type NodeFileAdapters = ReturnType<typeof createNodeFileAdapters>;
type SessionListener = Parameters<ACPSessionController["subscribe"]>[0];
type RuntimeSwitchState = {
  sessionId?: string | null;
  status?: string | null;
  promptQueue?: unknown[];
};
type RuntimeSwitchResult = {
  preservedSession: boolean;
  clearedPendingTurn: boolean;
};
type HostSessionRuntimeController = Pick<
  ACPSessionController,
  "getState" | "start" | "setPermissionMode" | "newSession" | "destroy"
> & {
  permissionMode: PermissionMode;
};

export interface HostSessionConfig {
  runtime: ResolvedGatewayRuntime;
  workspacePath: string;
  permissionMode: PermissionMode;
  defaultModel?: string;
  /**
   * Optional A2UI host surface adapter. When provided, surface messages
   * originating from the ACP agent are handed off here; surface events
   * flowing the other direction are translated to AG-UI `CUSTOM` frames
   * by the translator. Default: `undefined` (no surface plumbing).
   */
  surfaceAdapter?: HostSurfaceAdapter;
}

export interface HostSession {
  controller: GatewayHostController;
  permissionEngine: PermissionEngine;
  permissionStore: PermissionStore;
  /**
   * Workspace path the primary controller was started against. Exposed so
   * the Phase-2 per-lane controller factory can spawn siblings with the
   * same workspace / file-adapter surface.
   */
  workspacePath: string;
  switchRuntime(config: { runtime: ResolvedGatewayRuntime; defaultModel?: string }): Promise<{
    preservedSession: boolean;
    clearedPendingTurn: boolean;
  }>;
  destroy(): void;
}

export type GatewayHostController = Pick<
  ACPSessionController,
  | "cancel"
  | "forceReset"
  | "getState"
  | "loadSession"
  | "newSession"
  | "resolveElicitation"
  | "resolvePermission"
  | "resolveWriteGate"
  | "sendPrompt"
  | "setLastError"
  | "setModel"
  | "setPermissionMode"
  | "subscribe"
> & {
  readonly permissionMode: PermissionMode;
};

class StableHostSessionController implements GatewayHostController {
  private activeController: ACPSessionController;
  private listeners = new Set<SessionListener>();
  private unsubscribeActive: (() => void) | null = null;

  constructor(controller: ACPSessionController) {
    this.activeController = controller;
    this.subscribeToActiveController();
  }

  get permissionMode(): PermissionMode {
    return this.activeController.permissionMode;
  }

  swapActiveController(nextController: ACPSessionController): void {
    this.activeController = nextController;
    this.subscribeToActiveController();
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): Readonly<ACPSessionState> {
    return this.activeController.getState();
  }

  newSession(): Promise<string> {
    return this.activeController.newSession();
  }

  loadSession(sessionId: string): Promise<string> {
    return this.activeController.loadSession(sessionId);
  }

  resolvePermission(response: PermissionResponse, selectedScope?: SelectedPermissionScope): void {
    this.activeController.resolvePermission(response, selectedScope);
  }

  resolveWriteGate(result: Parameters<ACPSessionController["resolveWriteGate"]>[0]): void {
    this.activeController.resolveWriteGate(result);
  }

  resolveElicitation(response: Parameters<ACPSessionController["resolveElicitation"]>[0]): void {
    this.activeController.resolveElicitation(response);
  }

  setModel(modelId: Parameters<ACPSessionController["setModel"]>[0]): Promise<void> {
    return this.activeController.setModel(modelId);
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.activeController.setPermissionMode(mode);
  }

  cancel(): Promise<void> {
    return this.activeController.cancel();
  }

  setLastError(error: string | null): void {
    this.activeController.setLastError(error);
  }

  forceReset(): void {
    this.activeController.forceReset();
  }

  sendPrompt(content: Parameters<ACPSessionController["sendPrompt"]>[0]): Promise<void> {
    return this.activeController.sendPrompt(content);
  }

  destroy(): void {
    this.unsubscribeActive?.();
    this.unsubscribeActive = null;
    this.listeners.clear();
    this.activeController.destroy();
  }

  private subscribeToActiveController(): void {
    this.unsubscribeActive?.();
    this.unsubscribeActive = this.activeController.subscribe((event, state) => {
      for (const listener of this.listeners) {
        listener(event, state);
      }
    });
  }
}

function getGlobalRulesFilePath(): string {
  const env = process.env;
  const dataHome =
    env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV] ||
    env.XDG_DATA_HOME ||
    join(homedir(), ".local", "share");
  return join(dataHome, "agents-js", "permission-rules.json");
}

function getLocalRulesFilePath(workspacePath: string): string {
  return join(workspacePath, ".agents-js", "permission-rules.json");
}

function loadPersistedRules(workspacePath: string): PermissionRules {
  let globalRules: PermissionRules = [];
  let localRules: PermissionRules = [];

  const globalPath = getGlobalRulesFilePath();
  try {
    if (existsSync(globalPath)) {
      globalRules = JSON.parse(readFileSync(globalPath, "utf-8")) as PermissionRules;
    }
  } catch (err) {
    console.error(
      `[Gateway] Failed to load global permission rules from ${globalPath}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  const localPath = getLocalRulesFilePath(workspacePath);
  try {
    if (existsSync(localPath)) {
      // SECURITY NOTICE: A full implementation should prompt the user to trust the workspace
      // before loading local permission rules to prevent malicious clone attacks.
      // This will be handled in a future UI update.
      localRules = JSON.parse(readFileSync(localPath, "utf-8")) as PermissionRules;
    }
  } catch (err) {
    console.error(
      `[Gateway] Failed to load local permission rules from ${localPath}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // More specific workspace-local rules must win over global fallbacks because
  // the permission engine evaluates rules in order and stops on first match.
  return [...localRules, ...globalRules];
}

function createSaveCallback(workspacePath: string): (rules: PermissionRules) => Promise<void> {
  const globalPath = getGlobalRulesFilePath();
  const localPath = getLocalRulesFilePath(workspacePath);

  return async (rules: PermissionRules) => {
    // Separate rules: those with workspacePath "*" or "global" are global, others are local to this workspace.
    const globalRules = rules.filter(
      (r) => r.workspacePath === "*" || r.workspacePath === "global",
    );
    const localRules = rules.filter((r) => r.workspacePath !== "*" && r.workspacePath !== "global");

    try {
      if (globalRules.length > 0 || existsSync(globalPath)) {
        mkdirSync(dirname(globalPath), { recursive: true });
        writeFileSync(globalPath, JSON.stringify(globalRules, null, 2), "utf-8");
      }
    } catch (err) {
      console.error(
        `[Gateway] Failed to save global permission rules:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    try {
      if (localRules.length > 0 || existsSync(localPath)) {
        mkdirSync(dirname(localPath), { recursive: true });
        writeFileSync(localPath, JSON.stringify(localRules, null, 2), "utf-8");
      }
    } catch (err) {
      console.error(
        `[Gateway] Failed to save local permission rules:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
}

function getSessionFilePath(workspacePath: string, sessionId: string): string {
  const hash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 12);
  const env = process.env;
  const stateHome =
    env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV] ||
    env.XDG_STATE_HOME ||
    join(homedir(), ".local", "state");
  return join(stateHome, "agents-js", "sessions", hash, `${sessionId}.json`);
}

function createDiskBackedSessionStorage(workspacePath: string): HostSessionStorageAdapter {
  return {
    async saveSession(sessionId: string, state: ACPSessionState): Promise<void> {
      try {
        const filePath = getSessionFilePath(workspacePath, sessionId);
        const dir = dirname(filePath);
        mkdirSync(dir, { recursive: true });

        const serialized = JSON.stringify(
          state,
          (_key, value) => {
            if (value instanceof Map) return Object.fromEntries(value);
            if (value instanceof Set) return Array.from(value);
            if (typeof value === "function") return undefined;
            return value;
          },
          2,
        );

        writeFileSync(filePath, serialized, "utf-8");
      } catch (err) {
        console.error(
          `[Gateway] Failed to save session ${sessionId} to disk:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    },

    async loadSession(sessionId: string): Promise<ACPSessionState | null> {
      try {
        const filePath = getSessionFilePath(workspacePath, sessionId);
        if (existsSync(filePath)) {
          const raw = readFileSync(filePath, "utf-8");
          const state = JSON.parse(raw);

          // Revive Sets
          if (state.currentTurn?.approvedToolCallIds) {
            state.currentTurn.approvedToolCallIds = new Set(state.currentTurn.approvedToolCallIds);
          }
          if (Array.isArray(state.completedTurns)) {
            for (const turn of state.completedTurns) {
              if (turn.currentTurn?.approvedToolCallIds) {
                turn.currentTurn.approvedToolCallIds = new Set(
                  turn.currentTurn.approvedToolCallIds,
                );
              }
            }
          }

          return state as ACPSessionState;
        }
      } catch (err) {
        console.error(
          `[Gateway] Failed to load session ${sessionId} from disk:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      return null;
    },
  };
}

function deriveRememberedPermissionRule(
  request: PermissionRequest,
  response: PermissionResponse,
  agentName: string,
  workspacePath: string,
  permissionEngine: PermissionEngine,
  selectedScope?: SelectedPermissionScope,
) {
  const selectedOptionId =
    response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;
  const selectedOption = request.options?.find((option) => option.optionId === selectedOptionId);
  const optionKind = selectedOption?.kind ?? null;

  if (!optionKind?.endsWith("_always")) {
    return null;
  }

  const outcome = optionKind.startsWith("reject") ? "reject" : "allow";

  return permissionEngine.createRule(
    request,
    agentName,
    workspacePath,
    outcome,
    "persistent",
    outcome === "allow" ? selectedOptionId : undefined,
    selectedScope,
  );
}

function buildStartConfig(
  runtime: ResolvedGatewayRuntime,
  workspacePath: string,
  defaultModel: string | undefined,
  fileAdapters: NodeFileAdapters,
  permissionEngine: PermissionEngine,
  permissionStore: PermissionStore,
  surfaceAdapter?: HostSurfaceAdapter,
) {
  return {
    toolCallContentHandlers: [createA2uiToolCallContentHandler({ surfaceAdapter })],
    agentConfig: {
      name: runtime.definition.displayName,
      command: runtime.acp.command ?? runtime.definition.command,
      args: runtime.acp.args ?? runtime.definition.args,
      env: runtime.acp.env ?? {},
      authHints: [],
      workspacePolicy: "workspace-root-only" as const,
      workspaceFlag: resolveHostWorkspaceFlag(runtime),
      defaultModel,
      // External runtimes need real HOME for credential/config access
      // (e.g., ~/.config/opencode/, ~/.claude/)
      allowRealHome: true,
      // Propagate opt-in auto-recovery flag from the runtime spec to the
      // session controller's agent config. Seeded `true` for opencode in
      // packages/gateway-runtime/src/runtimes.ts so the controller can
      // detect the ZWSP-prefixed default-agent JSON-RPC error and retry
      // with `--pure`. Non-opencode runtimes leave this undefined.
      autoRecoverOpencodeDefaultAgent: runtime.acp.autoRecoverOpencodeDefaultAgent,
    },
    workspacePath,
    fileAdapters,
    permissionEngine,
    permissionStore,
    envPolicy: buildHostRuntimeEnvPolicy(runtime),
    sessionStorage: createDiskBackedSessionStorage(workspacePath),
    clientInfo: { name: "agents-js-gateway", version: "0.1.0" },
    hooks: {
      // IMPORTANT: Do NOT install a @mention dispatch middleware here.
      //
      // The gateway is a remote *agent* (a proxy wrapping an ACP runtime), not
      // a host. Mention middleware belongs at the host layer (e.g. the Obsidian
      // plugin), where the user's original prompt is being built. By the time
      // a prompt reaches the gateway via A2A, any @mentions have already been
      // processed (or intentionally passed through as literal text) by the
      // originating host.
      //
      // Installing `createMentionMiddleware()` here caused a self-dispatch
      // deadlock: when the gateway received a prompt containing `@gateway`, its
      // own middleware tried to resolve and dispatch to `@gateway`, which loads
      // the registry and fetches `http://127.0.0.1:9200/.well-known/agent-card.json`
      // — the gateway itself. Since the gateway was busy handling the original
      // request, the self-fetch hung until the 10s fetchCard timeout fired.
      //
      // Hosts that actually need @mention dispatch on received prompts can
      // compose their own hooks via a custom createHostSession wrapper.
      afterPermission: (
        request: PermissionRequest,
        response: PermissionResponse,
        _sessionId: string | null,
        selectedScope?: SelectedPermissionScope,
      ) => {
        const rule = deriveRememberedPermissionRule(
          request,
          response,
          runtime.definition.displayName,
          workspacePath,
          permissionEngine,
          selectedScope,
        );
        if (!rule) {
          return;
        }

        permissionEngine.addRule(rule);
        permissionStore.addRule(rule);
      },
      onToolCall: (tool: ToolCallSummary, _sessionId: string | null) => {
        console.log(`[Gateway] Tool: ${tool.name} [${tool.status}] (${tool.id})`);
      },
      afterPrompt: (result: { stopReason: unknown; durationMs: unknown }) => {
        console.log("[Gateway] Prompt completed", {
          stopReason: result.stopReason,
          durationMs: result.durationMs,
        });
      },
      onStatusChange: (prev: unknown, next: unknown) => {
        console.log(`[Gateway] Status: ${String(prev)} -> ${String(next)}`);
      },
    },
  };
}

function deriveRuntimeSwitchResult(state: RuntimeSwitchState): RuntimeSwitchResult {
  return {
    preservedSession: Boolean(state.sessionId),
    clearedPendingTurn:
      state.status === "prompting" ||
      state.status === "cancelling" ||
      (Array.isArray(state.promptQueue) && state.promptQueue.length > 0),
  };
}

async function createStartedRuntimeController(config: {
  runtime: ResolvedGatewayRuntime;
  workspacePath: string;
  defaultModel?: string;
  fileAdapters: NodeFileAdapters;
  permissionEngine: PermissionEngine;
  permissionStore: PermissionStore;
  permissionMode: PermissionMode;
  surfaceAdapter?: HostSurfaceAdapter;
}): Promise<ACPSessionController> {
  const {
    runtime,
    workspacePath,
    defaultModel,
    fileAdapters,
    permissionEngine,
    permissionStore,
    permissionMode,
    surfaceAdapter,
  } = config;
  const controller = new ACPSessionController();
  const startConfig = buildStartConfig(
    runtime,
    workspacePath,
    defaultModel,
    fileAdapters,
    permissionEngine,
    permissionStore,
    surfaceAdapter,
  );

  await controller.start(startConfig);
  await controller.setPermissionMode(permissionMode);

  return controller;
}

export async function switchHostSessionRuntime(config: {
  activeController: HostSessionRuntimeController;
  replaceActiveController(controller: HostSessionRuntimeController): void;
  createController(config: {
    runtime: ResolvedGatewayRuntime;
    permissionMode: PermissionMode;
    defaultModel?: string;
  }): Promise<HostSessionRuntimeController>;
  runtime: ResolvedGatewayRuntime;
  defaultModel?: string;
}): Promise<RuntimeSwitchResult> {
  const { activeController, replaceActiveController, createController, runtime, defaultModel } =
    config;
  const result = deriveRuntimeSwitchResult(activeController.getState() as RuntimeSwitchState);
  const permissionMode = activeController.permissionMode;
  let validationController: HostSessionRuntimeController | null = null;
  let nextActiveController: HostSessionRuntimeController | null = null;

  try {
    validationController = await createController({
      runtime,
      permissionMode,
      defaultModel,
    });
    if (result.preservedSession) {
      await validationController.newSession();
    }

    nextActiveController = validationController;
    validationController = null;

    replaceActiveController(nextActiveController);
    activeController.destroy();

    return result;
  } catch (error) {
    validationController?.destroy();
    nextActiveController?.destroy();
    throw error;
  }
}

/**
 * Spawn a standalone `GatewayHostController` detached from any `HostSession`.
 *
 * Used by `HostA2AExecutor`'s Phase-2 controller factory: every distinct
 * A2A `contextId` gets its own freshly-started controller (and underlying
 * ACP process), so concurrent independent prompts no longer serialize
 * against a single shared controller.
 *
 * Callers own the returned controller's lifecycle and must call `destroy()`
 * — `HostA2AExecutor` handles that on lane eviction / executor shutdown.
 *
 * Passes the same `runtime`, `workspacePath`, file adapters, permission
 * engine/store, and permission mode as the primary host session, so the
 * spawned controller shares identical policy and authentication surface.
 * Surface adapters are NOT shared by default — per-lane controllers fall
 * through to the primary host session's surface broadcaster only if the
 * caller threads one in explicitly. Today the surface-broadcaster lives on
 * the primary controller only (plan §6b, option (a)); the lane-spawned
 * controllers do not fan out surface messages to WS/AG-UI clients.
 */
export async function createStandaloneHostController(config: {
  runtime: ResolvedGatewayRuntime;
  workspacePath: string;
  permissionMode: PermissionMode;
  defaultModel?: string;
  permissionEngine: PermissionEngine;
  permissionStore: PermissionStore;
  fileAdapters: NodeFileAdapters;
  surfaceAdapter?: HostSurfaceAdapter;
}): Promise<GatewayHostController> {
  const controller = await createStartedRuntimeController({
    runtime: config.runtime,
    workspacePath: config.workspacePath,
    defaultModel: config.defaultModel,
    fileAdapters: config.fileAdapters,
    permissionEngine: config.permissionEngine,
    permissionStore: config.permissionStore,
    permissionMode: config.permissionMode,
    ...(config.surfaceAdapter ? { surfaceAdapter: config.surfaceAdapter } : {}),
  });
  // `ACPSessionController` already satisfies the `GatewayHostController`
  // structural shape — no StableHostSessionController wrapper needed here
  // because lane controllers do not participate in runtime hot-swap.
  return controller;
}

export async function createHostSession(config: HostSessionConfig): Promise<HostSession> {
  const { runtime, workspacePath, permissionMode, defaultModel, surfaceAdapter } = config;

  // Create permission engine and store
  const permissionEngine = new PermissionEngine();
  const permissionStore = new PermissionStore();

  // Load persisted rules
  const persistedRules = loadPersistedRules(workspacePath);
  permissionEngine.loadRules(persistedRules);
  permissionStore.init(persistedRules, createSaveCallback(workspacePath));

  // Create file adapters
  const fileAdapters = createNodeFileAdapters(workspacePath);

  // Create the initial runtime controller and wrap it in a stable facade so
  // bridge/executor subscribers survive runtime swaps.
  let activeController = await createStartedRuntimeController({
    runtime,
    workspacePath,
    defaultModel,
    fileAdapters,
    permissionEngine,
    permissionStore,
    permissionMode,
    surfaceAdapter,
  });
  const controller = new StableHostSessionController(activeController);

  console.log("[Gateway] Host session started");

  return {
    controller,
    permissionEngine,
    permissionStore,
    workspacePath,
    async switchRuntime(nextConfig) {
      const result = await switchHostSessionRuntime({
        activeController,
        replaceActiveController(nextController) {
          activeController = nextController as ACPSessionController;
          controller.swapActiveController(activeController);
        },
        createController: ({ runtime, permissionMode, defaultModel }) =>
          createStartedRuntimeController({
            runtime,
            workspacePath,
            defaultModel,
            fileAdapters,
            permissionEngine,
            permissionStore,
            permissionMode,
            surfaceAdapter,
          }),
        runtime: nextConfig.runtime,
        defaultModel: nextConfig.defaultModel,
      });

      console.log(`[Gateway] Host session switched to runtime ${nextConfig.runtime.definition.id}`);

      return result;
    },
    destroy() {
      controller.destroy();
      console.log("[Gateway] Host session destroyed");
    },
  };
}

export const __testing = {
  createDiskBackedSessionStorage,
  deriveRememberedPermissionRule,
  deriveRuntimeSwitchResult,
  getGlobalRulesFilePath,
  getSessionFilePath,
  loadPersistedRules,
};
