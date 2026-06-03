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
  type ProcessExitInfo,
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
  /**
   * Optional A2UI host surface adapter. When provided, surface messages
   * originating from the ACP agent are handed off here; surface events
   * flowing the other direction are translated to AG-UI `CUSTOM` frames
   * by the translator. Default: `undefined` (no surface plumbing).
   */
  surfaceAdapter?: HostSurfaceAdapter;
  /**
   * Whether the operator has trusted the current workspace. When `false`
   * (default), `.agents-js/permission-rules.json` in the workspace root
   * is ignored on load and never written on save — global rules are the
   * only persistent surface. Operators opt in via `--trust-workspace` /
   * `AGENTS_JS_TRUST_WORKSPACE=true`.
   *
   * **Default: `false`**, so a freshly cloned repo cannot ride its own
   * permission rules into the host engine.
   */
  trustWorkspace?: boolean;
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
  switchRuntime(config: { runtime: ResolvedGatewayRuntime }): Promise<{
    preservedSession: boolean;
    clearedPendingTurn: boolean;
  }>;
  destroy(): void;
}

export type GatewayHostController = Pick<
  ACPSessionController,
  | "cancel"
  | "destroy"
  | "forceReset"
  | "getChildPid"
  | "getState"
  | "loadSession"
  | "newSession"
  | "onProcessExit"
  | "resolveElicitation"
  | "resolvePermission"
  | "resolveWriteGate"
  | "sendPrompt"
  | "sendSurfaceEvent"
  | "setLastError"
  | "setPermissionMode"
  | "subscribe"
> & {
  readonly permissionMode: PermissionMode;
};

class StableHostSessionController implements GatewayHostController {
  private activeController: ACPSessionController;
  private listeners = new Set<SessionListener>();
  private unsubscribeActive: (() => void) | null = null;
  /**
   * Process-exit handlers registered through this stable facade.
   * Re-bound to each `activeController` on swap so a switchRuntime()
   * doesn't silently strand observers on the old controller.
   * The Map's value is the active-controller-side unsubscribe handle,
   * refreshed every time `subscribeProcessExitToActiveController()` runs.
   */
  private processExitHandlers = new Map<(info: ProcessExitInfo) => void, () => void>();

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
    // For each forwarded onProcessExit handler: bind to the new
    // controller (additive). Do NOT unsubscribe from the outgoing
    // controller — its synchronous dispose() schedules an exit event
    // on a later tick, and the handler must remain bound there to
    // observe it. Otherwise consumers subscribed through the stable
    // facade silently miss the gateway-initiated exit of the controller
    // being switched out. The old controller is short-lived after the
    // swap (single exit event then garbage collected), so the
    // doubled binding doesn't leak.
    //
    // `processExitHandlers.set` records the NEW controller's
    // unsubscribe handle, overwriting the old. The caller-driven
    // unsubscribe via the returned handle from `onProcessExit()` will
    // therefore unbind from the current (new) controller only —
    // acceptable because at that point the old controller has either
    // already fired its exit or is on its way to doing so.
    for (const handler of this.processExitHandlers.keys()) {
      const unsubscribe = nextController.onProcessExit(handler);
      this.processExitHandlers.set(handler, unsubscribe);
    }
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

  sendSurfaceEvent(surfaceId: string, event: unknown): void {
    this.activeController.sendSurfaceEvent(surfaceId, event);
  }

  getChildPid(): number | undefined {
    return this.activeController.getChildPid();
  }

  onProcessExit(handler: (info: ProcessExitInfo) => void): () => void {
    // Bind to the current active controller and track so we can re-bind
    // on swap. Without this forwarding, `swapActiveController()` would
    // strand the handler on the old controller and it would never
    // observe exits from the replacement.
    const unsubscribe = this.activeController.onProcessExit(handler);
    this.processExitHandlers.set(handler, unsubscribe);
    return () => {
      const current = this.processExitHandlers.get(handler);
      if (current) {
        try {
          current();
        } catch {
          // best-effort
        }
        this.processExitHandlers.delete(handler);
      }
    };
  }

  destroy(): void {
    this.unsubscribeActive?.();
    this.unsubscribeActive = null;
    this.listeners.clear();
    // Intentionally do NOT invoke the forwarded `unsubscribe()` handles
    // here — that would remove the underlying handler from
    // `ACPSessionController.processExitHandlers`, and Node delivers the
    // child `exit` event on a later tick after `dispose()` returns. The
    // forwarded handler must remain registered on the underlying
    // controller to observe that exit. We do clear our local tracking
    // map because this stable facade itself is going away; callers who
    // unsubscribe explicitly already removed themselves.
    this.processExitHandlers.clear();
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

/**
 * Load permission rules from the global path, and — only when the
 * operator has explicitly trusted the current workspace — also from
 * `.agents-js/permission-rules.json` in the workspace root.
 *
 * Workspace-local rules are powerful: a rule that grants `allow` for a
 * destructive tool can ride into a freshly cloned repo. Loading them
 * unconditionally turned `git clone` into an implicit-trust boundary.
 * Pass `trustWorkspace: true` only when the operator has set
 * `--trust-workspace` (or `AGENTS_JS_TRUST_WORKSPACE=true`).
 */
function loadPersistedRules(workspacePath: string, trustWorkspace: boolean): PermissionRules {
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

  if (trustWorkspace) {
    const localPath = getLocalRulesFilePath(workspacePath);
    try {
      if (existsSync(localPath)) {
        localRules = JSON.parse(readFileSync(localPath, "utf-8")) as PermissionRules;
      }
    } catch (err) {
      console.error(
        `[Gateway] Failed to load local permission rules from ${localPath}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // More specific workspace-local rules must win over global fallbacks because
  // the permission engine evaluates rules in order and stops on first match.
  return [...localRules, ...globalRules];
}

/**
 * Build the rule-persistence callback. Global rules always persist;
 * workspace-scoped rules only persist when the workspace is trusted.
 *
 * When `trustWorkspace=false`, any rule whose `workspacePath` is not
 * `"*"`/`"global"` is dropped from the save call: the rule still applies
 * for the current session (the engine has it in memory), but it does
 * not survive across sessions. This matches the load-side gate: an
 * untrusted workspace contributes nothing to the on-disk rule set.
 */
function createSaveCallback(
  workspacePath: string,
  trustWorkspace: boolean,
): (rules: PermissionRules) => Promise<void> {
  const globalPath = getGlobalRulesFilePath();
  const localPath = getLocalRulesFilePath(workspacePath);

  return async (rules: PermissionRules) => {
    // Separate rules: those with workspacePath "*" or "global" are global, others are local to this workspace.
    const globalRules = rules.filter(
      (r) => r.workspacePath === "*" || r.workspacePath === "global",
    );
    const localRules = trustWorkspace
      ? rules.filter((r) => r.workspacePath !== "*" && r.workspacePath !== "global")
      : [];

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

    if (!trustWorkspace) {
      // Untrusted workspace: never write the local rules file. We do
      // not even touch existing files — operators who later opt in
      // with --trust-workspace expect their previous local rules to
      // still be there.
      return;
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
  fileAdapters: NodeFileAdapters;
  permissionEngine: PermissionEngine;
  permissionStore: PermissionStore;
  permissionMode: PermissionMode;
  surfaceAdapter?: HostSurfaceAdapter;
}): Promise<ACPSessionController> {
  const {
    runtime,
    workspacePath,
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
  }): Promise<HostSessionRuntimeController>;
  runtime: ResolvedGatewayRuntime;
}): Promise<RuntimeSwitchResult> {
  const { activeController, replaceActiveController, createController, runtime } = config;
  const result = deriveRuntimeSwitchResult(activeController.getState() as RuntimeSwitchState);
  const permissionMode = activeController.permissionMode;
  let validationController: HostSessionRuntimeController | null = null;
  let nextActiveController: HostSessionRuntimeController | null = null;

  try {
    validationController = await createController({
      runtime,
      permissionMode,
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
 * engine/store, permission mode, and (when supplied) surface adapter as
 * the primary host session, so the spawned controller shares identical
 * policy, authentication, and surface-broadcast surface. Callers who
 * own a shared `surfaceAdapter` SHOULD pass it here so A2UI surfaces
 * emitted by lane-backed turns reach connected browser clients —
 * dropping the adapter silently loses those messages.
 */
export async function createStandaloneHostController(config: {
  runtime: ResolvedGatewayRuntime;
  workspacePath: string;
  permissionMode: PermissionMode;
  permissionEngine: PermissionEngine;
  permissionStore: PermissionStore;
  fileAdapters: NodeFileAdapters;
  surfaceAdapter?: HostSurfaceAdapter;
}): Promise<GatewayHostController> {
  const controller = await createStartedRuntimeController({
    runtime: config.runtime,
    workspacePath: config.workspacePath,
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
  const { runtime, workspacePath, permissionMode, surfaceAdapter, trustWorkspace = false } = config;

  // Create permission engine and store
  const permissionEngine = new PermissionEngine();
  const permissionStore = new PermissionStore();

  // Load persisted rules. Workspace-local rules require explicit trust
  // so a hostile clone can't ride its `.agents-js/permission-rules.json`
  // into the engine.
  const persistedRules = loadPersistedRules(workspacePath, trustWorkspace);
  permissionEngine.loadRules(persistedRules);
  permissionStore.init(persistedRules, createSaveCallback(workspacePath, trustWorkspace));

  // Create file adapters
  const fileAdapters = createNodeFileAdapters(workspacePath);

  // Create the initial runtime controller and wrap it in a stable facade so
  // bridge/executor subscribers survive runtime swaps.
  let activeController = await createStartedRuntimeController({
    runtime,
    workspacePath,
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
        createController: ({ runtime, permissionMode }) =>
          createStartedRuntimeController({
            runtime,
            workspacePath,
            fileAdapters,
            permissionEngine,
            permissionStore,
            permissionMode,
            surfaceAdapter,
          }),
        runtime: nextConfig.runtime,
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
