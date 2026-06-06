/**
 * Core session orchestrator for ACP agent communication.
 *
 * Manages the full lifecycle: spawn -> initialize -> session -> prompt -> cancel -> destroy.
 * UI subscribes to events and calls resolvePermission() for permission flows.
 *
 * Framework-agnostic: file I/O is injected via HostFileAdapters in StartConfig,
 * and terminal handlers consume a normalized workspace context rather than
 * reaching back into the controller.
 *
 * Implementation details (state helpers, event mapping, write-gate logic,
 * permission evaluation, MCP server lists, subscription utilities) are
 * extracted into focused sibling modules under `session-*.ts`.
 */
import { randomUUID } from "node:crypto";
import type {
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionModeState,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import {
  ACPClientController,
  type ACPControllerEvent,
  type ACPProcess,
  formatRequestError,
} from "@agents-js/acp";
import { extractResourceScope, generateScopeCandidates } from "@agents-js/policy";
import { normalizeAgentName } from "./agent-name-normalize.ts";
import { CapabilityCache } from "./capability-cache.ts";
import { Logger } from "./logger.ts";
import type { PermissionEngine } from "./permission-engine.ts";
import type { PermissionStore } from "./permission-store.ts";
import { createHostACPProcess } from "./process.ts";
import { buildControllerAdapters } from "./session-adapters.ts";
import { applyAgentDefaults, trySetAgentMode } from "./session-defaults.ts";
import { requestWriteGateApproval } from "./session-file-adapters.ts";
import { callHook } from "./session-hooks.ts";
import {
  cancelPendingElicitation,
  cancelPendingPermission,
  cancelPendingWriteGate,
  clearCancelSafetyTimer,
} from "./session-lifecycle.ts";
import { buildMcpServersList } from "./session-mcp.ts";
import {
  getHostManagedPermissionReason,
  type ModeFallbackReason,
  normalizeSessionModes,
} from "./session-modes.ts";
import { evaluatePermission } from "./session-permissions.ts";
import {
  createOpencodeDefaultAgentRecoveredConfig,
  isOpencodeDefaultAgentMissing,
} from "./session-recovery.ts";
import {
  buildCompletedTurnSnapshot,
  createInitialState,
  createTurnState,
  type PermissionMode,
} from "./session-state.ts";
import { emitEvent, type Listener, waitForReady } from "./session-subscription.ts";
import { handleSessionUpdate } from "./session-updates.ts";
import { createTerminalHandlers, type TerminalHandlers } from "./terminal-handlers.ts";
import type {
  HostElicitationAdapter,
  HostFileAdapters,
  HostSessionStorageAdapter,
  StartConfig,
} from "./types/adapters.ts";
import type { AgentConfig } from "./types/agent-config.ts";
import type { SessionHooks } from "./types/hooks.ts";
import type { HostACPProcessOptions } from "./types/process-options.ts";
import type {
  ACPSessionEvent,
  ACPSessionState,
  ACPSessionStatus,
  ProcessExitInfo,
  WriteGateResolution,
} from "./types/session.ts";
import type { ToolCallContentHandler } from "./types/tool-call-content-handler.ts";
import { type ResolvedWorkspaceContext, resolveWorkspaceContext } from "./workspace-context.ts";

// Re-export PermissionMode so existing imports from this file continue to work
export type { PermissionMode } from "./session-state.ts";
// Re-export ProcessExitInfo so callers that subscribe via `onProcessExit`
// can import the payload type alongside the controller.
export type { ProcessExitInfo } from "./types/session.ts";

/**
 * High-level session orchestrator for ACP agent communication.
 *
 * This is the top-level **Provider** for host applications. It composes
 * an {@link ACPClientController} with host-level concerns: permission evaluation
 * (with configurable modes: yolo, plan, ask, hub), terminal process management,
 * write-gate approval flows, elicitation state, prompt queuing, and session
 * lifecycle hooks.
 *
 * Host platforms (desktop app, CLI gateway, browser bridge) create one controller per agent
 * and drive it through: `start()` -> `newSession()` -> `prompt()` -> `destroy()`.
 *
 * Subscribe to events via {@link subscribe} to track state changes, permissions,
 * write gates, elicitation, terminal output, and turn completions.
 *
 * File I/O and elicitation are injected via {@link StartConfig} adapters,
 * keeping this class framework-agnostic.
 *
 * @example
 * ```ts ignore
 * const controller = new ACPSessionController();
 * controller.subscribe((event) => handleEvent(event));
 * await controller.start({ agentConfig, workspacePath, fileAdapters });
 * const sessionId = await controller.newSession();
 * await controller.prompt("Explain this codebase");
 * controller.destroy();
 * ```
 */
export class ACPSessionController {
  private listeners = new Set<Listener>();
  private state: ACPSessionState = createInitialState();
  private controller: ACPClientController | null = null;
  private controllerUnsubscribe: (() => void) | null = null;
  private agentConfig: AgentConfig | null = null;
  private permissionEngine: PermissionEngine | null = null;
  private permissionStore: PermissionStore | null = null;
  private elicitationAdapter: HostElicitationAdapter | null = null;
  private toolCallContentHandlers: ToolCallContentHandler[] = [];
  private fileAdapters: HostFileAdapters | null = null;
  private sessionStorage: HostSessionStorageAdapter | null = null;
  private mcpServerUrl: string | null = null;
  private mcpServerName: string | null = null;
  private extraBinPaths: string[] | null = null;
  private envPolicy: import("./env-policy.ts").HostEnvPolicyInput | null = null;
  private dependencyRegistry: import("./types/host-adapters.ts").DependencyRegistry | null = null;
  private clientInfo: { name: string; version: string } = { name: "acp-host", version: "0.1.0" };
  private hooks: SessionHooks | null = null;
  private cancelSafetyTimer: ReturnType<typeof setTimeout> | null = null;
  private promptTimeoutMs = 3_600_000; // 1 hour — timeout is a last-resort safety net, not a UX mechanism
  private log = new Logger("session");
  private permLog = new Logger("permission");
  private terminalHandlers: TerminalHandlers = createTerminalHandlers();
  private modeFallbackReason: ModeFallbackReason | null = null;
  private resolvedWorkspaceContext: ResolvedWorkspaceContext | null = null;
  /**
   * Last `StartConfig` passed to {@link start}, cached so the opencode
   * auto-recovery path can reconstruct a start-with-mutated-args without the
   * caller re-threading the whole config. Cleared by {@link destroy}.
   */
  private lastStartConfig: StartConfig | null = null;
  /**
   * One-shot latch: when {@link newSession} triggers the opencode default-agent
   * recovery flow (restart with `--pure` appended), this is set to true so the
   * flow cannot re-enter itself on a persistent failure. Cleared by
   * {@link destroy} so a fresh start/newSession cycle is allowed to retry.
   */
  private opencodeRecoveryAttempted = false;

  /**
   * Captured `ACPProcess` for the active spawn — wraps the controller's
   * underlying child-process surface so `getChildPid()` can read pid.
   * `null` between spawns and after `destroy()`.
   *
   * The `onProcessExit` listener captures its own `spawnedAtMs` snapshot
   * in the closure at registration time (see the `wrappedCreateProcess`
   * body in `start()`), so this field is NOT consulted at exit time —
   * that would race the destroy() reset.
   */
  private acpProcess: ACPProcess | null = null;
  /**
   * Per-spawn closure setter: flips the CURRENT spawn's
   * "destroyed-by-gateway" flag (captured inside the wrappedCreateProcess
   * closure). `destroy()` calls this before `dispose()` so the exit
   * observer reports `crash: false` for gateway-initiated teardowns.
   * `null` between spawns. Replaced atomically when the next spawn
   * starts — past spawns retain their own closure-local flag, so a
   * later destroy() can never retro-set an already-exited spawn's
   * crash classification.
   */
  private markCurrentSpawnDestroyed: (() => void) | null = null;
  /** Set of registered `onProcessExit` handlers (single-shot wrapper). */
  private processExitHandlers = new Set<(info: ProcessExitInfo) => void>();

  readonly capabilities = new CapabilityCache();

  /** Legacy public workspace path. This now reflects the effective session cwd. */
  workspacePath: string | null = null;
  /**
   * Permission mode (canonical ACP/Claude-Code vocabulary):
   * - `default` — prompt user before gated actions (reads auto-approve, writes prompt)
   * - `acceptEdits` — auto-approve edit operations (behavior parity with `default` today; edit-only auto-approve is a follow-up)
   * - `plan` — reads auto-approve and agent enters plan mode
   * - `bypassPermissions` — auto-approve everything (skip permission gating)
   *
   * Folder-scoped auto-approve is independent — driven by {@link hubDirectoryPath}
   * via the write-gate path check in `session-file-adapters.requestWriteGateApproval`,
   * not by the mode flag.
   */
  permissionMode: PermissionMode = "default";
  /** Hub directory path (workspace-identity-relative), auto-approved for writes. Set after session creation. */
  private hubDirectoryPath: string | null = null;
  /** Session-scoped writable folders added via the write-gate modal "Allow folder" button. */
  private sessionWritableFolders = new Set<string>();

  // -- Public subscription API --

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): Readonly<ACPSessionState> {
    return this.state;
  }

  getWorkspaceContext(): Readonly<ResolvedWorkspaceContext> | null {
    return this.resolvedWorkspaceContext;
  }

  /** Set the hub directory (workspace-identity-relative) for auto-approved writes. */
  setHubDirectory(hubPath: string): void {
    this.hubDirectoryPath = hubPath;
    this.state.hubPath = hubPath;
    this.log.info("Hub directory set", { hubPath });
  }

  /** Get the current hub directory path, or null if not set. */
  getHubDirectory(): string | null {
    return this.hubDirectoryPath;
  }

  /**
   * Reset the controller from "error" status back to "ready" so that
   * callers (e.g., the gateway) can retry session creation after a
   * transient failure. Only works when the underlying ACP process is
   * still alive (controller exists). No-ops if not in error state.
   */
  resetError(): void {
    if (this.state.status !== "error") return;
    if (!this.controller) {
      this.log.warn("resetError: no active controller, cannot recover");
      return;
    }
    this.log.info("Resetting error state to ready");
    this.state.lastError = null;
    this.setStatus("ready");
  }

  /**
   * Force-reset the session controller from any stuck state back to "ready".
   *
   * Use this when the controller is wedged in "prompting", "cancelling", or
   * other non-terminal states due to a hung ACP runtime. This is more
   * aggressive than resetError() which only works from "error" status.
   *
   * Cancels pending permissions/elicitations/write gates, clears the prompt
   * queue, resets the inner promptInFlight flag, and sets status to "ready".
   */
  forceReset(): void {
    if (!this.controller) {
      this.log.warn("forceReset: no active controller, cannot recover");
      return;
    }

    const prevStatus = this.state.status;
    this.log.warn("Force-resetting session controller", { fromStatus: prevStatus });

    // Cancel all pending async operations
    this.cancelPendingPermission();
    this.cancelPendingElicitation();
    this.cancelPendingWriteGate();

    // Clear the prompt queue
    if (this.state.promptQueue.length > 0) {
      this.state.promptQueue = [];
      this.emit({ type: "queue_changed", count: 0 });
    }

    // Clear the inner promptInFlight flag
    this.controller._forceResetPromptInFlight();

    // Clear cancel safety timer if active
    this.clearCancelSafetyTimer();

    // Reset state
    this.state.lastError = null;
    this.setStatus("ready");
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    this.permLog.info("Permission mode changed", { mode });

    const agentAdvertisedModes = this.state.modesAdvertisedByAgent;
    const modeCtx = {
      setMode: (id: string) => this.setMode(id),
      modes: this.state.modes,
      agentAdvertisedModes,
      modeFallbackReason: this.modeFallbackReason,
      permLog: this.permLog,
    };
    if (mode === "plan") {
      await trySetAgentMode("plan", "Agent plan mode activated", modeCtx);
    } else if (mode === "default" || mode === "acceptEdits") {
      // `acceptEdits` shares the `default` agent-mode today (host still gates
      // writes). Edit-only auto-approve at the write-gate is a follow-up.
      const syncResult = await trySetAgentMode(
        "default",
        "Agent default mode activated for permission gating",
        modeCtx,
      );
      const synced = syncResult.synced;
      this.state.permissionGatingActive = synced;
      this.emit({
        type: "permission_gating_status",
        active: synced,
        reason:
          synced && syncResult.hostManaged
            ? getHostManagedPermissionReason(this.state.modes, this.modeFallbackReason)
            : synced
              ? "Runtime mode sync succeeded — permission requests will be sent."
              : `Runtime does not advertise "default" mode — ungated writes will be cancelled.`,
      });
    }
  }

  setLocalLabel(label: string): void {
    this.state.localLabel = label;
    this.emit({ type: "status_changed", status: this.state.status });
  }

  /**
   * Set a transient error message on the controller state (e.g., for surfaced session load failures).
   */
  setLastError(error: string | null): void {
    this.state.lastError = error;
    this.setStatus(this.state.status);
  }

  // -- Lifecycle --

  /**
   * Start (or restart) the ACP session.
   *
   * **Implicit-restart semantics:** if `start()` is called while the controller
   * is already started (`this.controller` is non-null), the method silently calls
   * {@link destroy} first and reinitializes from the provided `config`. This resets
   * `promptQueue`, `completedTurns`, `lastError`, `currentTurn`, `pendingWriteGate`,
   * `pendingElicitation`, `plan`, `sessionTitle`, `sessionUpdatedAt`, `localLabel`,
   * `modes`, `modesAdvertisedByAgent`, `permissionGatingActive`, and the
   * internal `modeFallbackReason` back to their initial values before spawning a
   * fresh `ACPClientController`.
   *
   * Callers must NOT rely on any preserved state across `start()` calls. Queued
   * prompts, completed-turn history, and transient error messages are all dropped.
   *
   * This implicit-restart behavior is load-bearing in the host adapter's
   * `resetSession` path, which intentionally calls `start()` to clear state rather
   * than maintaining a separate reset method. A future breaking-change
   * alternative would make double-start throw instead.
   */
  async start(config: StartConfig): Promise<void> {
    if (this.controller) {
      this.destroy();
    }

    // Cache the config AFTER the implicit-restart destroy() above so the
    // opencode auto-recovery path can restart the controller with mutated
    // args without the caller re-threading the full config. destroy() clears
    // `lastStartConfig`, so this assignment must follow it.
    this.lastStartConfig = config;

    this.state.currentTurn = null;
    this.state.completedTurns = [];
    this.state.lastError = null;
    this.state.pendingWriteGate = null;
    this.state.pendingElicitation = null;
    this.state.plan = null;
    this.state.sessionTitle = null;
    this.state.sessionUpdatedAt = null;
    this.state.localLabel = null;
    this.state.promptQueue = [];
    this.state.modes = null;
    this.state.modesAdvertisedByAgent = false;
    this.state.permissionGatingActive = true;
    this.modeFallbackReason = null;

    const workspaceContext = resolveWorkspaceContext({
      workspacePath: config.workspacePath,
      workspaceIdentityPath: config.workspaceIdentityPath,
      sessionCwd: config.sessionCwd,
      approvedReadRoots: config.approvedReadRoots,
      approvedWriteRoots: config.approvedWriteRoots,
      scratchRoots: config.scratchRoots,
      autoApprovedWriteFolders: config.autoApprovedWriteFolders,
      directoryPolicy: config.directoryPolicy,
    });

    this.resolvedWorkspaceContext = workspaceContext;
    this.workspacePath = workspaceContext.sessionCwd;
    this.agentConfig = config.agentConfig;
    this.fileAdapters = config.fileAdapters;
    this.elicitationAdapter = config.elicitation ?? null;
    const nextToolCallContentHandlers = [...(config.toolCallContentHandlers ?? [])];
    this.closeToolCallContentHandlers();
    this.toolCallContentHandlers = nextToolCallContentHandlers;
    this.sessionStorage = config.sessionStorage ?? null;
    this.permissionEngine = config.permissionEngine ?? null;
    this.permissionStore = config.permissionStore ?? null;
    this.mcpServerUrl = config.mcpServerUrl ?? null;
    this.mcpServerName = config.mcpServerName ?? null;
    this.extraBinPaths = config.extraBinPaths ?? null;
    this.envPolicy = config.envPolicy ?? null;
    // Rebuild the terminal handlers so the underlying TerminalManager applies
    // the caller-supplied env policy to terminal env filtering. The previous
    // handlers' processes (if any) are abandoned with the prior session's
    // lifecycle; concurrent terminals across `start()` calls are not supported
    // by the embedding contract.
    this.terminalHandlers = createTerminalHandlers({ envPolicy: config.envPolicy });
    this.dependencyRegistry = config.dependencyRegistry ?? null;
    this.clientInfo = config.clientInfo ?? { name: "acp-host", version: "0.1.0" };
    this.hooks = config.hooks ?? null;
    if (config.promptTimeoutMs !== undefined) {
      this.promptTimeoutMs = config.promptTimeoutMs;
    }

    // Update capability flags based on MCP server availability
    this.refreshCapabilities();
    this.setStatus("initializing");
    this.log.info("Starting agent", {
      command: config.agentConfig.command,
      args: config.agentConfig.args,
      workspaceIdentityPath: workspaceContext.workspaceIdentityPath,
      sessionCwd: workspaceContext.sessionCwd,
    });

    const hostProcessOptions: HostACPProcessOptions = {
      command: config.agentConfig.command,
      args: config.agentConfig.args,
      env: config.agentConfig.env,
      sessionCwd: workspaceContext.sessionCwd,
      workspaceFlag: config.agentConfig.workspaceFlag,
      extraBinPaths: this.extraBinPaths ?? undefined,
      allowRealHome: config.agentConfig.allowRealHome,
      envPolicy: this.envPolicy ?? undefined,
    };

    // Rotate `processExitHandlers` to a fresh empty Set. The OLD set
    // stays alive inside the previous spawn's exit-listener closure (see
    // `wrappedCreateProcess` below), so any handlers registered against
    // the old spawn still fire on the old spawn's exit — even when the
    // exit event arrives on a later tick after a destroy → start cycle.
    // New `onProcessExit()` calls go into the new Set and bind to the
    // new spawn's exit listener.
    //
    // Note: the per-spawn `markCurrentSpawnDestroyed` closure is set
    // inside `wrappedCreateProcess` below, so the OLD spawn's closure
    // retains its own flag and a later `destroy()` cannot retroactively
    // flip an already-observed exit's `crash` classification.
    this.processExitHandlers = new Set();

    // Wrap whichever `createProcess` callback the caller / default supplies
    // so we can capture the returned `ACPProcess` for pid + exit-observer
    // surfaces. The wrapper preserves the original return value verbatim
    // — downstream `ACPClientController` consumes it unchanged.
    const baseCreateProcess =
      config.createProcess ??
      ((options: HostACPProcessOptions) =>
        createHostACPProcess(workspaceContext.workspaceIdentityPath, options));

    const wrappedCreateProcess = (options: HostACPProcessOptions): ACPProcess => {
      const acp = baseCreateProcess(options);
      this.acpProcess = acp;
      const spawnedAtMs = Date.now();
      // Snapshot per-spawn state into the exit-listener closure so a
      // subsequent destroy → start cycle does not race with this
      // child's exit event (which fires on a later tick than the
      // synchronous start()).
      const handlersForThisSpawn = this.processExitHandlers;
      let thisSpawnDestroyedByGateway = false;
      this.markCurrentSpawnDestroyed = () => {
        thisSpawnDestroyedByGateway = true;
      };

      // Mock infrastructure (`testing/mock-acp-agent.ts`) returns
      // `process: null as unknown as ChildProcess`, so we guard for the
      // null case AND for `.on` not being a function before subscribing
      // to the exit event. Mocks that don't expose a real child silently
      // skip the listener — exit-observer tests must use a real spawn.
      const child = acp.process;
      if (child !== null && typeof child?.on === "function") {
        child.on("exit", (code, signal) => {
          // Clear the class-level `acpProcess` reference so `getChildPid()`
          // stops returning a dead pid — but only if this exit is for
          // the controller's currently-tracked process. After a
          // destroy → start cycle, `this.acpProcess` already points at
          // the new spawn; we MUST NOT null it out from the old exit.
          if (this.acpProcess === acp) {
            this.acpProcess = null;
          }
          const info: ProcessExitInfo = {
            pid: child.pid,
            exitCode: code,
            signal,
            crash: !thisSpawnDestroyedByGateway,
            durationMs: Date.now() - spawnedAtMs,
          };
          for (const handler of handlersForThisSpawn) {
            try {
              handler(info);
            } catch (err) {
              this.log.warn("onProcessExit handler threw", {
                error: formatRequestError(err),
              });
            }
          }
        });
      }

      return acp;
    };

    try {
      this.controller = new ACPClientController({
        adapters: buildControllerAdapters({
          requestPermission: (request) => this._requestPermissionWithRules(request),
          handleSessionUpdate: (notification) => this._handleSessionUpdate(notification),
          fileAdapters: this.fileAdapters,
          requestWriteGateApproval: (gate) => this._requestWriteGateApproval(gate),
          terminalHandlers: this.terminalHandlers,
          terminalWorkspaceContext: {
            validationRoot: workspaceContext.workspaceIdentityPath,
            defaultCwd: workspaceContext.sessionCwd,
          },
          elicitationAdapter: this.elicitationAdapter,
          handleElicitationRequest: (request) => this._handleElicitationRequest(request),
        }),
        createProcess: wrappedCreateProcess,
        processOptions: hostProcessOptions,
        log: (message, data) => this.log.info(message, data),
        workspacePolicy: {
          resolveWorkspaceRoot: () => workspaceContext.workspaceIdentityPath,
        },
      });

      this.controllerUnsubscribe = this.controller.subscribe((event: ACPControllerEvent) => {
        if (event.type === "error") {
          const message = event.error instanceof Error ? event.error.message : String(event.error);
          this.log.error("Shared ACP controller error", { error: message });
          this.state.lastError = message;
          this.setStatus("error");
        }
      });

      const initResponse = await this.controller.initialize({
        clientInfo: this.clientInfo,
      });

      const rawAgentName = initResponse.agentInfo?.name ?? config.agentConfig.name;
      const normalizedAgentName = normalizeAgentName(rawAgentName);
      if (normalizedAgentName.normalized) {
        this.log.warn("agent name normalized", {
          original: normalizedAgentName.original,
          cleaned: normalizedAgentName.name,
        });
      }
      this.state.agentName = normalizedAgentName.name;
      this.state.agentCapabilities = initResponse.agentCapabilities ?? null;
      this.capabilities.update(initResponse.agentCapabilities);

      this.log.info("Agent initialized", {
        agent: this.state.agentName,
        protocolVersion: initResponse.protocolVersion,
      });

      this.setStatus("ready");
    } catch (err) {
      const message = formatRequestError(err);
      this.log.error("Failed to start agent", { error: message });
      // Init-failure cleanup intentionally does NOT call
      // `markCurrentSpawnDestroyed`: the common case is "child stream
      // closed because the child walked away" — initialize() rejects,
      // this catch runs, but the exit event already fired (or is about
      // to fire) with `crash: true`. Flipping the per-spawn flag here
      // would mis-classify a real crash as gateway-initiated. The flag
      // is reserved for explicit `destroy()` calls. We DO clear
      // `markCurrentSpawnDestroyed` so a subsequent destroy() call
      // doesn't accidentally flip the flag for a closure tied to the
      // failed-to-init spawn.
      this.markCurrentSpawnDestroyed = null;
      this.controller?.dispose();
      this.controller = null;
      this.controllerUnsubscribe?.();
      this.controllerUnsubscribe = null;
      this.acpProcess = null;
      this.state.lastError = message;
      this.setStatus("error");
      throw err;
    }
  }

  async newSession(): Promise<string> {
    try {
      return await this._newSessionOnce("create session");
    } catch (err) {
      const missingAgent = isOpencodeDefaultAgentMissing(err);
      const autoRecoverEnabled = this.lastStartConfig?.agentConfig.autoRecoverOpencodeDefaultAgent;
      // Scope guards:
      //   1. Only the opencode-specific JSON-RPC shape triggers recovery.
      //   2. The opt-in flag must be set on the active StartConfig (runtimes.ts
      //      sets it for the opencode curated profile; claude/gemini don't).
      //   3. The latch prevents re-entry on a persistent failure — one retry
      //      per controller-instance lifetime (cleared by destroy()).
      if (
        missingAgent === null ||
        autoRecoverEnabled !== true ||
        this.opencodeRecoveryAttempted ||
        this.lastStartConfig === null
      ) {
        throw err;
      }

      this.log.warn(
        `opencode reports default agent "${missingAgent}" not found — likely ZWSP-prefixed plugin agent. ` +
          "Restarting with --pure (set AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS=1 to make permanent).",
      );

      // Snapshot the config BEFORE destroy() clears lastStartConfig.
      const previousConfig = this.lastStartConfig;
      const recoveredConfig = createOpencodeDefaultAgentRecoveredConfig(previousConfig);

      this.destroy();
      await this.start(recoveredConfig);

      // Latch AFTER restart: start() → destroy() chain resets the flag, so
      // we mark the attempt only after the fresh controller is up. A second
      // pass through this catch block will now see the latch and propagate.
      this.opencodeRecoveryAttempted = true;

      return await this._newSessionOnce("create session (recovered)");
    }
  }

  private async _newSessionOnce(methodLabel: string): Promise<string> {
    const ctrl = this.ensureController();
    this.log.info("Creating new session");
    this.resetSessionState({ clearLastError: true });

    // Refresh capability flags before each session
    this.refreshCapabilities();

    const mcpServers = buildMcpServersList(this.mcpServerUrl, this.mcpServerName, this.log);

    return this._withSessionMethod(methodLabel, async () => {
      const response = await ctrl.newSession({
        cwd: this.resolvedWorkspaceContext?.sessionCwd ?? this.workspacePath ?? undefined,
        mcpServers,
      });

      this._applySessionResponse(response.sessionId, response, "new");
      await this.applyDefaults();

      this.emit({ type: "session_created", sessionId: response.sessionId });
      this.log.info("Session created", { sessionId: response.sessionId });

      return response.sessionId;
    });
  }

  async listSessions(
    cursor?: string,
  ): Promise<{ sessions: import("@agentclientprotocol/sdk").SessionInfo[]; nextCursor?: string }> {
    if (!this.capabilities.supportsListSessions()) {
      return { sessions: [] };
    }

    const ctrl = this.ensureController();
    const result = await ctrl.listSessions({
      cwd: this.resolvedWorkspaceContext?.sessionCwd ?? this.workspacePath ?? undefined,
      cursor,
    });

    return {
      sessions: result.sessions,
      nextCursor: result.nextCursor ?? undefined,
    };
  }

  async loadSession(sessionId: string): Promise<string> {
    if (!this.capabilities.supportsLoadSession()) {
      throw new Error("Agent does not support loading sessions.");
    }

    const ctrl = this.ensureController();
    this.setStatus("loading");
    this.log.info("Loading existing session", { sessionId });

    // Reset turn and queue state before loading to prevent stale data bleed
    this.resetSessionState();

    // Refresh capability flags before session load
    this.refreshCapabilities();

    const mcpServers = buildMcpServersList(this.mcpServerUrl, this.mcpServerName, this.log);

    return this._withSessionMethod("load session", async () => {
      let storedState: ACPSessionState | null = null;
      if (this.sessionStorage) {
        try {
          storedState = await this.sessionStorage.loadSession(sessionId);
        } catch (err) {
          this.log.warn("Failed to load session from storage", {
            error: formatRequestError(err),
          });
        }
      }

      const response = await ctrl.loadSession({
        sessionId,
        cwd: this.resolvedWorkspaceContext?.sessionCwd ?? this.workspacePath ?? undefined,
        mcpServers,
      });

      this._applySessionResponse(sessionId, response, "load");

      // Apply locally restored state over the empty new state
      if (storedState) {
        this.state.completedTurns = storedState.completedTurns;
        this.state.plan = storedState.plan;
        this.state.sessionTitle = storedState.sessionTitle;
        this.state.sessionUpdatedAt = storedState.sessionUpdatedAt;
        this.state.localLabel = storedState.localLabel;
        if (storedState.hubPath) {
          this.hubDirectoryPath = storedState.hubPath;
          this.state.hubPath = storedState.hubPath;
        }
        if (storedState.availableCommands && !this.state.availableCommands) {
          this.state.availableCommands = storedState.availableCommands;
        }
        if (storedState.usage && !this.state.usage) {
          this.state.usage = storedState.usage;
        }
      }

      await this.applyDefaults();

      this.emit({ type: "session_loaded", sessionId });
      this.log.info("Session loaded", { sessionId });
      this.setStatus("ready");

      return sessionId;
    });
  }

  /**
   * Close the active session gracefully.
   * Cancels pending permissions, elicitations, and write gates before closing.
   * Emits a `session_closed` event and resets session state.
   * @throws If the agent does not support session/close or no active connection.
   */
  async closeSession(): Promise<void> {
    if (!this.capabilities.supportsCloseSession()) {
      throw new Error("Agent does not support closing sessions.");
    }

    const ctrl = this.ensureController();
    if (!this.state.sessionId) {
      throw new Error("No active session to close.");
    }

    this.log.info("Closing session", { sessionId: this.state.sessionId });

    // Cancel pending async operations before closing
    this.cancelPendingPermission();
    this.cancelPendingElicitation();
    this.cancelPendingWriteGate();
    this.closeToolCallContentHandlers();

    return this._withSessionMethod("close session", async () => {
      await ctrl.closeSession();

      this.resetSessionState({ clearLastError: true, full: true });

      this.emit({ type: "session_closed" });
      this.setStatus("ready");
      this.log.info("Session closed");
    });
  }

  /**
   * Fork the active session, creating a new branched session with shared history.
   * Resets turn state for the new fork and emits a `session_forked` event.
   * @throws If the agent does not support session/fork or no active connection.
   */
  async forkSession(): Promise<string> {
    if (!this.capabilities.supportsForkSession()) {
      throw new Error("Agent does not support forking sessions.");
    }

    const ctrl = this.ensureController();
    if (!this.state.sessionId) {
      throw new Error("No active session to fork.");
    }

    const parentSessionId = this.state.sessionId;
    this.log.info("Forking session", { parentSessionId });

    const mcpServers = buildMcpServersList(this.mcpServerUrl, this.mcpServerName, this.log);

    return this._withSessionMethod("fork session", async () => {
      const response = await ctrl.forkSession({
        cwd: this.resolvedWorkspaceContext?.sessionCwd ?? this.workspacePath ?? undefined,
        mcpServers,
      });

      // Reset turn state for the new fork
      this.state.currentTurn = null;
      this.state.completedTurns = [];

      this._applySessionResponse(response.sessionId, response, "new");

      this.emit({
        type: "session_forked",
        sessionId: response.sessionId,
        parentSessionId,
      });
      this.log.info("Session forked", {
        parentSessionId,
        forkedSessionId: response.sessionId,
      });

      return response.sessionId;
    });
  }

  /**
   * Resume a previously closed session by its ID.
   * Resets turn state, normalizes modes from the response, and emits a `session_resumed` event.
   * @throws If the agent does not support session/resume or no active connection.
   */
  async resumeSession(sessionId: string): Promise<string> {
    if (!this.capabilities.supportsResumeSession()) {
      throw new Error("Agent does not support resuming sessions.");
    }

    const ctrl = this.ensureController();
    this.log.info("Resuming session", { sessionId });

    const mcpServers = buildMcpServersList(this.mcpServerUrl, this.mcpServerName, this.log);

    return this._withSessionMethod("resume session", async () => {
      const response = await ctrl.resumeSession({
        sessionId,
        cwd: this.resolvedWorkspaceContext?.sessionCwd ?? this.workspacePath ?? undefined,
        mcpServers,
      });

      // Reset turn and queue state AFTER the remote call succeeds to avoid
      // data loss if the resume request fails (network error, server error).
      this.resetSessionState();

      this._applySessionResponse(sessionId, response, "load");
      await this.applyDefaults();

      this.emit({ type: "session_resumed", sessionId });
      this.log.info("Session resumed", { sessionId });
      this.setStatus("ready");

      return sessionId;
    });
  }

  /**
   * Set a session configuration option on the server.
   * Delegates to ACPClientController.setConfigOption() and emits a
   * `config_option_changed` event on success.
   * @throws If the agent does not support config options or no active session.
   */
  async setConfigOption(
    configId: string,
    value: boolean | string,
    type?: "boolean",
  ): Promise<void> {
    if (!this.capabilities.supportsSetConfigOption()) {
      throw new Error("Agent does not support session config options.");
    }

    const ctrl = this.ensureController();
    if (!this.state.sessionId) {
      throw new Error("No active session. Call newSession() first.");
    }

    this.log.info("Setting config option", { configId, value });

    return this._withSessionMethod("set config option", async () => {
      const request =
        type === "boolean" || typeof value === "boolean"
          ? { configId, value: value as boolean, type: "boolean" as const }
          : { configId, value: value as string };
      await ctrl.setConfigOption(request);
      this.emit({ type: "config_option_changed", configId, value });
      this.log.info("Config option set", { configId, value });
    });
  }

  /**
   * Log out from the current authenticated state.
   * If a session is active, resets session state. Emits a `logged_out` event.
   * @throws If the agent does not support logout or no active connection.
   */
  async logout(): Promise<void> {
    if (!this.capabilities.supportsLogout()) {
      throw new Error("Agent does not support logout.");
    }

    const ctrl = this.ensureController();
    this.log.info("Logging out");

    // Cancel pending async operations before logging out
    this.cancelPendingPermission();
    this.cancelPendingElicitation();
    this.cancelPendingWriteGate();

    return this._withSessionMethod("logout", async () => {
      await ctrl.logout();

      // If a session was active, perform full cleanup
      if (this.state.sessionId) {
        this.resetSessionState({ clearLastError: true, full: true });
      }

      this.emit({ type: "logged_out" });
      this.setStatus("ready");
      this.log.info("Logged out");
    });
  }

  async sendPrompt(content: ContentBlock[]): Promise<void> {
    const ctrl = this.ensureController();
    if (!this.state.sessionId) {
      throw new Error("No active session. Call newSession() first.");
    }

    this.state.currentTurn = createTurnState();
    this.setStatus("prompting");
    this.log.info("Sending prompt");

    const modifiedContent = await callHook(this.log, "beforePrompt", () =>
      this.hooks?.beforePrompt?.(content, this.state.sessionId),
    );

    // The beforePrompt hook may be long-running (e.g. A2A streaming dispatch).
    // If the session was cancelled or reset during the await, bail out.
    if (!this.state.currentTurn) {
      this.log.warn("Session cancelled during beforePrompt hook — aborting prompt");
      return;
    }

    const promptContent = modifiedContent ?? content;
    const promptStart = Date.now();
    const requestId = randomUUID();
    const promptMessageId = randomUUID();
    this.state.currentTurn.userMessageId = promptMessageId;

    try {
      let promptTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const promptCall = ctrl.prompt({
        messageId: promptMessageId,
        prompt: promptContent,
      });

      let response: Awaited<ReturnType<typeof ctrl.prompt>>;
      if (this.promptTimeoutMs > 0) {
        response = await Promise.race([
          promptCall,
          new Promise<never>((_resolve, reject) => {
            promptTimeoutId = setTimeout(() => {
              reject(new Error(`Prompt timed out after ${this.promptTimeoutMs}ms`));
            }, this.promptTimeoutMs);
          }),
        ]).finally(() => {
          if (promptTimeoutId !== undefined) clearTimeout(promptTimeoutId);
        });
      } else {
        response = await promptCall;
      }

      const acknowledgedUserMessageId =
        typeof response.userMessageId === "string" && response.userMessageId.length > 0
          ? response.userMessageId
          : undefined;
      if (acknowledgedUserMessageId && this.state.currentTurn) {
        this.state.currentTurn.userMessageId = acknowledgedUserMessageId;
      }

      const completedAt = Date.now();
      const durationMs = completedAt - promptStart;
      const currentTurn = this.state.currentTurn ?? createTurnState();
      const completedTurn = buildCompletedTurnSnapshot({
        requestId,
        completedAt,
        durationMs,
        stopReason: response.stopReason,
        promptContent,
        currentTurn,
        planAtCompletion: this.state.plan,
      });
      this.state.completedTurns.push(completedTurn);
      this.log.info("Turn completed", { stopReason: response.stopReason });
      this.emit({ type: "turn_completed", stopReason: response.stopReason });

      void callHook(this.log, "afterPrompt", () =>
        this.hooks?.afterPrompt?.({
          sessionId: this.state.sessionId,
          promptContent,
          textChunks: currentTurn.textChunks,
          stopReason: response.stopReason,
          durationMs,
          requestId,
          userMessageId: currentTurn.userMessageId,
          agentMessageId: currentTurn.agentMessageId,
        }),
      );

      // Auto-drain: send next queued prompt if any
      if (this.state.promptQueue.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: length check above guarantees non-empty
        const next = this.state.promptQueue.shift()!;
        this.emit({ type: "queue_changed", count: this.state.promptQueue.length });
        this.log.info("Auto-draining queued prompt", { remaining: this.state.promptQueue.length });
        // Reset turn state immediately so listeners don't see stale data
        // between the completed turn and the drained prompt starting.
        this.state.currentTurn = createTurnState();
        this.sendPrompt(next).catch((err) => {
          const message = formatRequestError(err);
          this.log.error("Queued prompt failed", { error: message });
          if (this.state.status === "prompting") {
            this.state.lastError = message;
            this.setStatus("error");
          }
        });
        return;
      }
      this.setStatus("ready");
    } catch (err) {
      const message = formatRequestError(err);
      // If this was a timeout, cancel the stuck prompt and force-reset.
      // forceReset() sets status to "ready" -- the controller is usable again.
      // We communicate the error via lastError + re-throw, but do NOT
      // overwrite status to "error" (that would cause a ready->error flash).
      if (message.includes("Prompt timed out")) {
        this.log.warn("Prompt timed out, attempting cancel and force reset");
        try {
          await this.cancel();
        } catch {
          /* ignore cancel errors after timeout */
        }
        this.forceReset();
        this.log.error("Prompt failed (timeout, recovered to ready)", { error: message });
        this.state.lastError = message;
        throw err;
      }
      this.log.error("Prompt failed", { error: message });
      this.state.lastError = message;
      this.setStatus("error");
      throw err;
    }
  }

  async cancel(): Promise<void> {
    this.log.info("Cancelling current turn");

    // Always cancel pending permissions, elicitations, and write gates, even without an active connection
    this.cancelPendingPermission();
    this.cancelPendingElicitation();
    this.cancelPendingWriteGate();

    if (!this.controller || !this.state.sessionId) return;

    this.setStatus("cancelling");

    try {
      await this.controller.cancel();
    } catch (err) {
      const message = formatRequestError(err);
      if (!message.includes("no active prompt")) {
        this.log.warn("Cancel notification failed", {
          error: message,
        });
      }
    }

    // Safety net: if the prompt response doesn't arrive within 5s to
    // transition us out of "cancelling", force-recover to "ready" so the
    // UI doesn't freeze.
    this.cancelSafetyTimer = setTimeout(() => {
      if (this.state.status === "cancelling") {
        this.log.warn("Cancel safety timeout: forcing status to ready");
        this.setStatus("ready");
      }
      this.cancelSafetyTimer = null;
    }, 5_000);
  }

  /** Queue a prompt to send after the current turn completes. */
  queuePrompt(content: ContentBlock[]): void {
    this.state.promptQueue.push(content);
    this.emit({ type: "queue_changed", count: this.state.promptQueue.length });
    this.log.info("Prompt queued", { queueSize: this.state.promptQueue.length });
  }

  /** Cancel the current turn and immediately send this prompt. */
  async steer(content: ContentBlock[]): Promise<void> {
    this.log.info("Steering: cancelling current turn and sending new prompt");
    this.clearQueue();
    await this.cancel();
    // If cancel caused an error (e.g., in-flight prompt rejected), recover before sending.
    if (this.state.status === "error") {
      this.log.warn("steer(): cancel produced error state, recovering to ready");
      this.state.lastError = null;
      this.setStatus("ready");
    }
    // Wait for status to reach "ready" -- event-based wait covers both "cancelling" and
    // "prompting" (the in-flight sendPrompt resolving after cancel).
    // cancel() has a 5s safety timeout that forces "ready".
    if (this.state.status !== "ready") {
      await waitForReady(this.state, (l) => this.subscribe(l), 6000);
    }
    await this.sendPrompt(content);
  }

  /** Get the current queue contents (readonly copy). */
  getQueuedPrompts(): readonly ContentBlock[][] {
    return [...this.state.promptQueue];
  }

  /** Clear all queued prompts. */
  clearQueue(): void {
    this.state.promptQueue = [];
    this.emit({ type: "queue_changed", count: 0 });
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.controller) throw new Error("No active controller");
    await this.controller.setMode(modeId);
    if (this.state.modes) {
      this.state.modes = { ...this.state.modes, currentModeId: modeId };
      this.emit({ type: "mode_changed", modeId, modes: this.state.modes });
    }
    this.log.info("Mode changed", { modeId });
  }

  /**
   * Return the OS pid of the spawned ACP child, or `undefined` when no
   * child is alive (pre-spawn, post-destroy) or when running against a
   * test mock that doesn't surface a real `ChildProcess`.
   *
   * Used by `HarnessLaneManager` to populate the `pid` field on the
   * `gateway.harness.child-spawned` envelope.
   */
  getChildPid(): number | undefined {
    return this.acpProcess?.process?.pid;
  }

  /**
   * Subscribe to ACP child-process exit events. The handler fires once per
   * exit with a {@link ProcessExitInfo} payload. Returns an unsubscribe
   * function.
   *
   * Handler lifecycle: registered handlers persist across {@link destroy}
   * intentionally. `destroy()` calls `dispose()` which kills the child
   * synchronously, but Node delivers the `exit` event on a later tick —
   * the handler must still be subscribed to observe it. The next
   * {@link start} clears any stale handlers at the top of its body so
   * old observers don't fire on the next spawn's exit.
   *
   * Mocks that return `process: null` (see `testing/mock-acp-agent.ts`)
   * never invoke registered handlers — the wrapper in {@link start}
   * detects the missing `.on` and skips listener registration. Tests
   * exercising the exit observer must spawn a real child (e.g.
   * `createHostACPProcess` against `/bin/sh`).
   */
  onProcessExit(handler: (info: ProcessExitInfo) => void): () => void {
    this.processExitHandlers.add(handler);
    return () => {
      this.processExitHandlers.delete(handler);
    };
  }

  destroy(): void {
    this.log.info("Destroying controller");
    this.state.promptQueue = [];
    this.clearCancelSafetyTimer();
    this.cancelPendingPermission();
    this.cancelPendingElicitation();
    this.cancelPendingWriteGate();

    // Flip the per-spawn flag BEFORE dispose() so the child's "exit"
    // event fires while the closure-local flag is true — observers see
    // `crash: false`. This is closure-scoped to the CURRENT spawn, so
    // a later destroy() can never retroactively flip a past spawn's
    // already-observed exit, and a subsequent start() cycle's reset
    // doesn't race with the in-flight exit observation.
    this.markCurrentSpawnDestroyed?.();
    this.markCurrentSpawnDestroyed = null;

    if (this.controller) {
      this.controller.dispose();
      this.controller = null;
    }
    this.controllerUnsubscribe?.();
    this.controllerUnsubscribe = null;
    this.modeFallbackReason = null;

    // Clean up staging directory if file adapters support it
    if (this.fileAdapters && "cleanup" in this.fileAdapters) {
      const cleanable = this.fileAdapters as HostFileAdapters & { cleanup(): Promise<void> };
      cleanable.cleanup().catch((err) => {
        this.log.warn("Failed to clean up staging directory", {
          error: formatRequestError(err),
        });
      });
    }

    this.workspacePath = null;
    this.resolvedWorkspaceContext = null;
    this.agentConfig = null;
    this.elicitationAdapter = null;
    this.closeToolCallContentHandlers();
    this.sessionStorage = null;
    this.fileAdapters = null;
    this.permissionMode = "default";
    this.hubDirectoryPath = null;
    this.sessionWritableFolders.clear();
    this.permissionEngine = null;
    this.permissionStore = null;
    this.hooks = null;
    this.dependencyRegistry = null;
    this.mcpServerUrl = null;
    this.mcpServerName = null;
    this.extraBinPaths = null;
    this.envPolicy = null;
    // Clear cached start-config + recovery latch. The recovery flow is
    // careful to set `opencodeRecoveryAttempted = true` AFTER it calls
    // `start(recoveredConfig)` so a second pass through `newSession` on the
    // restarted controller will see the latch and refuse to re-enter.
    this.lastStartConfig = null;
    this.opencodeRecoveryAttempted = false;
    // NOTE: `processExitHandlers` is intentionally NOT cleared here.
    // `dispose()` above kills the child synchronously but Node delivers the
    // `exit` event on a later tick — clearing the handler set now would
    // race the observer and drop the very event the caller subscribed for.
    // The next `start()` clears stale handlers at the top of its body.
    this.acpProcess = null;
    this.capabilities.clear();
    // Emit "closed" before resetting state so listeners can read final state
    this.setStatus("closed");
    this.state = createInitialState();
    this.listeners.clear();
    this.terminalHandlers.destroyAll();
  }

  // -- Permission resolution (called by UI) --

  resolvePermission(response: RequestPermissionResponse, selectedScope?: string): void {
    const pending = this.state.currentTurn?.pendingPermission;
    if (!pending) {
      this.log.warn("resolvePermission called with no pending permission");
      return;
    }

    pending.resolve(response);
    if (this.state.currentTurn) {
      this.state.currentTurn.pendingPermission = null;
    }
    this.emit({
      type: "permission_resolved",
      cancelled: response.outcome.outcome === "cancelled",
      selectedScope,
    });

    // Fire afterPermission hook with selectedScope
    void callHook(this.log, "afterPermission", () =>
      this.hooks?.afterPermission?.(pending.request, response, this.state.sessionId, selectedScope),
    );

    if (this.state.status === "waiting_permission") {
      this.setStatus("prompting");
    }
  }

  // -- Write gate resolution (called by UI) --

  /** @internal Called by file-handlers to request write approval from UI */
  _requestWriteGateApproval(gate: {
    path: string;
    diff: string;
    absolutePath?: string;
  }): Promise<boolean> {
    // Directory-policy auto-approved write folders (session-level, resolved by
    // `resolveWorkspaceContext`) are the authoritative source for which folders
    // the agent may write to without approval.
    const allAutoApproved = this.resolvedWorkspaceContext?.autoApprovedWriteFolders ?? [];

    return requestWriteGateApproval(
      gate,
      this.state,
      this.hubDirectoryPath,
      allAutoApproved,
      this.sessionWritableFolders,
      (event) => this.emit(event),
      this.log,
    );
  }

  resolveWriteGate(result: WriteGateResolution): void {
    const pending = this.state.pendingWriteGate;
    if (!pending) {
      this.log.warn("resolveWriteGate called with no pending write gate");
      return;
    }
    pending.resolve(result);
    this.state.pendingWriteGate = null;
    this.emit({ type: "write_gate_resolved", approved: result.action !== "reject" });
  }

  // -- Elicitation resolution (called by UI) --

  resolveElicitation(response: CreateElicitationResponse): void {
    const pending = this.state.pendingElicitation;
    if (!pending) {
      this.log.warn("resolveElicitation called with no pending elicitation");
      return;
    }

    pending.resolve(response);
    this.state.pendingElicitation = null;
    this.emit({
      type: "elicitation_resolved",
      action: response.action,
    });

    if (this.state.status === "waiting_elicitation") {
      this.setStatus("prompting");
    }
  }

  // -- Internal methods (called by the shared ACP host adapters) --

  /** @internal Called when the shared ACP controller forwards a session update */
  _handleSessionUpdate(notification: SessionNotification): void {
    handleSessionUpdate(
      notification,
      this.state,
      this.hooks,
      (event) => this.emit(event),
      this.log,
      {
        contentHandlerContext: {
          emit: (event) => this.emit(event),
          log: this.log,
        },
        toolCallContentHandlers: this.toolCallContentHandlers,
      },
    );
  }

  // -- Host-driven custom surface event routing --

  /**
   * Emit a user-driven surface event (click, submit, etc.) onto the
   * session event stream. Hosts call this from their renderer when the
   * user interacts with an A2UI surface; agents receive the payload
   * out-of-band (A2UI has no standard back-channel shape).
   */
  sendSurfaceEvent(surfaceId: string, event: unknown): void {
    this.emit({ type: "surface_event", surfaceId, event });
  }

  private closeToolCallContentHandlers(): void {
    const handlers = this.toolCallContentHandlers;
    this.toolCallContentHandlers = [];
    for (const handler of handlers) {
      if (!handler.close) {
        continue;
      }
      Promise.resolve(handler.close()).catch((error) => {
        this.log.warn("ToolCallContentHandler.close failed", {
          error: formatRequestError(error),
        });
      });
    }
  }

  /** @internal Called when the shared ACP controller forwards an elicitation request */
  _handleElicitationRequest(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
    this.log.info("Elicitation requested", {
      mode: request.mode,
      message: request.message,
    });

    // If a host-provided adapter exists, delegate directly to it
    if (this.elicitationAdapter) {
      this.emit({ type: "elicitation_requested", request });
      return this.elicitationAdapter.request(request);
    }

    // Otherwise, manage state internally so the UI can resolve it
    return new Promise<CreateElicitationResponse>((resolve) => {
      this.state.pendingElicitation = { request, resolve };

      this.setStatus("waiting_elicitation");
      this.emit({ type: "elicitation_requested", request });
    });
  }

  /** @internal Called when the shared ACP controller requests permission from the host */
  _handlePermissionRequest(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    this.log.info("Permission requested", {
      toolName: request.toolCall?.title,
      optionCount: request.options?.length,
    });

    // Enrich the request with scope candidates for the UI scope selector
    const workspaceIdentityPath = this.resolvedWorkspaceContext?.workspaceIdentityPath;
    if (workspaceIdentityPath) {
      const resourceScope = extractResourceScope(request);
      const scopeCandidates = generateScopeCandidates(resourceScope, workspaceIdentityPath);
      if (scopeCandidates.length > 1) {
        (request as RequestPermissionRequest & { suggestedScopes?: unknown }).suggestedScopes =
          scopeCandidates;
      }
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      if (this.state.currentTurn) {
        this.state.currentTurn.pendingPermission = { request, resolve };
      } else {
        this.state.currentTurn = createTurnState();
        this.state.currentTurn.pendingPermission = { request, resolve };
      }

      this.setStatus("waiting_permission");
      this.emit({ type: "permission_requested", request });
    });
  }

  // -- Private helpers --

  private resetSessionState(options?: { clearLastError?: boolean; full?: boolean }): void {
    this.state.currentTurn = null;
    this.state.completedTurns = [];
    this.state.plan = null;
    this.state.sessionTitle = null;
    this.state.sessionUpdatedAt = null;
    this.state.hubPath = null;
    if (options?.clearLastError) {
      this.state.lastError = null;
    }
    if (options?.full) {
      this.state.sessionId = null;
      this.state.modes = null;
      this.state.availableCommands = null;
      this.state.usage = null;
    }
    this.hubDirectoryPath = null;
    this.sessionWritableFolders.clear();
    if (this.state.promptQueue.length > 0) {
      this.state.promptQueue = [];
      this.emit({ type: "queue_changed", count: 0 });
    }
  }

  /**
   * Apply mode normalization and state update from a session response.
   * Shared by newSession, loadSession, forkSession, and resumeSession.
   */
  private _applySessionResponse(
    sessionId: string,
    response: {
      modes?: SessionModeState | null;
    },
    sessionSource: "new" | "load",
  ): void {
    const normalizedModes = normalizeSessionModes(response.modes, {
      sessionId,
      sessionSource,
      log: this.log,
    });

    this.state.sessionId = sessionId;
    this.state.modes = normalizedModes.modes;
    this.state.modesAdvertisedByAgent = normalizedModes.agentAdvertisedModes;
    this.modeFallbackReason = normalizedModes.fallbackReason;
  }

  /**
   * Wrap a session method with common error-handling: log error, set lastError,
   * transition status to error, and re-throw.
   */
  private async _withSessionMethod<T>(methodName: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const message = formatRequestError(err);
      this.log.error(`Failed to ${methodName}`, { error: message });
      this.state.lastError = message;
      this.setStatus("error");
      throw err;
    }
  }

  private refreshCapabilities(): void {
    this.capabilities.setMcpServerAvailable(
      this.mcpServerUrl != null,
      this.dependencyRegistry?.isAvailable("data-query") ?? false,
    );
  }

  private ensureController(): ACPClientController {
    if (!this.controller) {
      throw new Error("No active ACP connection. Call start() first.");
    }
    return this.controller;
  }

  private setStatus(status: ACPSessionStatus): void {
    const prev = this.state.status;
    if (prev === "cancelling" && status !== "cancelling") {
      this.clearCancelSafetyTimer();
    }
    this.state.status = status;
    this.emit({ type: "status_changed", status });
    void callHook(this.log, "onStatusChange", () => this.hooks?.onStatusChange?.(prev, status));
  }

  private emit(event: ACPSessionEvent): void {
    emitEvent(this.listeners, event, this.state, this.log);

    if (this.state.sessionId && this.sessionStorage) {
      this.sessionStorage.saveSession(this.state.sessionId, this.state).catch((err) => {
        this.log.error("Failed to save session to storage", {
          error: formatRequestError(err),
        });
      });
    }
  }

  private cancelPendingPermission(): void {
    cancelPendingPermission(this.state, (event) => this.emit(event));
  }

  private cancelPendingElicitation(): void {
    cancelPendingElicitation(this.state, (event) => this.emit(event));
  }

  private cancelPendingWriteGate(): void {
    cancelPendingWriteGate(this.state, (event) => this.emit(event));
  }

  private clearCancelSafetyTimer(): void {
    this.cancelSafetyTimer = clearCancelSafetyTimer(this.cancelSafetyTimer);
  }

  private async applyDefaults(): Promise<void> {
    const config = this.agentConfig;
    if (!config) return;
    const agentAdvertisedModes = this.state.modesAdvertisedByAgent;
    const result = await applyAgentDefaults(config, {
      setMode: (id) => this.setMode(id),
      modes: this.state.modes,
      permissionMode: this.permissionMode,
      agentAdvertisedModes,
      modeFallbackReason: this.modeFallbackReason,
      log: this.log,
      permLog: this.permLog,
    });

    if (this.permissionMode === "default" || this.permissionMode === "acceptEdits") {
      this.state.permissionGatingActive = result.permissionGatingSynced;
      const synced = result.permissionGatingSynced;
      this.emit({
        type: "permission_gating_status",
        active: synced,
        reason:
          synced && result.permissionGatingHostManaged
            ? getHostManagedPermissionReason(this.state.modes, this.modeFallbackReason)
            : synced
              ? "Runtime mode sync succeeded — permission requests will be sent."
              : `Runtime does not advertise "default" mode — ungated writes will be cancelled.`,
      });
    }
  }

  private async _requestPermissionWithRules(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const response = await evaluatePermission(request, {
      permissionMode: this.permissionMode,
      hooks: this.hooks,
      permissionEngine: this.permissionEngine,
      permissionStore: this.permissionStore,
      agentName: this.state.agentName,
      workspaceIdentityPath: this.resolvedWorkspaceContext?.workspaceIdentityPath ?? null,
      sessionId: this.state.sessionId,
      log: this.log,
      permLog: this.permLog,
      handlePermissionRequest: (req) => this._handlePermissionRequest(req),
    });

    // Track approved tool call IDs for ungated write detection
    if (response.outcome.outcome === "selected" && request.toolCall?.toolCallId) {
      this.state.currentTurn?.approvedToolCallIds.add(request.toolCall.toolCallId);
    }

    return response;
  }
}
