/**
 * A2A AgentExecutor backed by ACPSessionController.
 *
 * Translates controller events into A2A task status updates, delegating
 * all ACP lifecycle management (process, permissions, write gates, sessions)
 * to the controller. This is much simpler than ACPtoA2AExecutor because the
 * controller handles the complexity.
 */
import {
  buildStatusUpdate,
  buildTerminalTask,
  type ExecutionEventBus,
  getMessageText,
  type InitializableExecutor,
  type Message,
  nowIso,
  type RequestContext,
  type Task,
} from "@agents-js/a2a";
import {
  A2AClientProvider,
  extractA2AResponseText,
  type ParsedDispatchDirective,
  parseDispatchDirective,
} from "@agents-js/a2a-client";
import type { A2AAgentEntry, ACPAgentEntry } from "@agents-js/a2a-client/node";
import { formatRequestError, type InitializeResponse } from "@agents-js/acp";
import {
  ACPSessionController,
  type ACPSessionEvent,
  type ACPSessionState,
  createNodeFileAdapters,
  PermissionEngine,
  PermissionStore,
  type StartConfig,
} from "@agents-js/acp-host";
import {
  type ResolvedGatewayRuntime,
  resolveAcpAgentEntryToRuntime,
} from "@agents-js/gateway-runtime";
import { type AgentRegistryMap, loadRegistryFromDisk } from "./agent-registry.ts";
import { type AuditEmitter, newCorrelationId } from "./audit.ts";
import type { GatewayHostController } from "./host-session.ts";
import { buildHostRuntimeEnvPolicy } from "./runtime-env-policy.ts";
import { resolveHostWorkspaceFlag } from "./runtime-workspace-flag.ts";

export interface HostA2AExecutorOptions {
  /** Override the agent dispatch registry instead of loading from disk. */
  dispatchRegistry?: AgentRegistryMap;
  /** Override the A2A transport for dispatch (for testing). */
  dispatchTransport?: import("@agents-js/a2a-client").A2ATransport;
  /**
   * Working directory passed to ephemeral ACP-kind dispatch controllers.
   * Defaults to `process.cwd()`. Production wiring should pass the gateway's
   * configured workspace path; test wiring typically passes the test-server's
   * temp workspace.
   */
  dispatchWorkspacePath?: string;
  /**
   * Per-lane controller factory. When supplied, each distinct `contextId`
   * gets its own freshly-spawned `GatewayHostController` and underlying ACP
   * process, so independent lanes make forward progress in parallel instead
   * of serializing against the primary controller.
   *
   * When omitted, all lanes reuse the primary controller passed to the
   * constructor; concurrent different-contextId prompts
   * then still serialize at the shared controller, but they no longer
   * cross-publish each other's `PromptOutcome`s across event buses.
   */
  controllerFactory?: (contextId: string) => Promise<GatewayHostController>;
  /**
   * How long a lane may sit idle before the executor tears it down (and
   * destroys its lane-owned controller). Defaults to 30 minutes. Only
   * lanes spawned via `controllerFactory` are destroyed — the primary
   * controller is caller-owned and never touched. Set to `0` or a negative
   * number to disable eviction entirely. See plan §6a.
   */
  laneIdleTimeoutMs?: number;
  /**
   * Optional audit emitter. When provided, the executor records
   * lifecycle events for A2A tasks and `@@dispatch` invocations with
   * correlation IDs. Records carry only structural metadata — never
   * the user prompt, env values, or tool payloads.
   */
  audit?: AuditEmitter;
}

/** Default 30-minute idle timeout before a per-lane controller is torn down. */
const DEFAULT_LANE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface ActiveTask {
  taskId: string;
  contextId: string;
  eventBus: ExecutionEventBus;
  /**
   * null = never received any chunks (tool-only flow) → fallback to
   *   "Prompt completed." text in the terminal publication.
   * "" = received a chunk with empty text (rare edge case) → publish "" as
   *   agent completion (preserves empty-response semantics).
   * "text" = normal response.
   */
  textBuffer: string | null;
  agentMessageId?: string;
  cancelled?: boolean;
  /** Stable correlation token for audit / cross-surface tracing. */
  correlationId: string;
  /** Wall-clock timestamp at task creation (ms since epoch). */
  startedAtMs: number;
}

/**
 * Per-contextId lane. Replaces the executor-wide `inFlightPrompt` +
 * `owningTaskId` single-slot pair with a lane-keyed equivalent so that
 * concurrent different-contextId requests no longer republish each other's
 * `PromptOutcome` across event buses.
 *
 * Each lane owns a dedicated controller when the executor is constructed
 * with a `controllerFactory`; otherwise every lane reuses the primary
 * controller.
 * The lane's `ownsController` flag tracks which mode the lane is in so
 * teardown knows whether to call `destroy()`.
 */
interface SessionLane {
  contextId: string;
  /** Per-lane single-slot mutex. Replaces the executor-wide `inFlightPrompt`. */
  inFlightPrompt: Promise<PromptOutcome> | null;
  /**
   * The task currently holding this lane's mutex. Controller events from
   * this lane's controller are routed to this task's event bus. Set at
   * `runPrompt` start, cleared on resolve.
   */
  owningTaskId: string | null;
  /**
   * The controller that drives this lane's ACP session. When a
   * `controllerFactory` was provided, this is a lane-owned instance and
   * will be destroyed on lane eviction / executor shutdown. When no factory
   * was provided, this points at the primary controller (shared with
   * every other lane) and is NOT destroyed here.
   */
  controller: GatewayHostController;
  /** Whether this lane owns `controller` (factory-spawned) and must destroy it on teardown. */
  ownsController: boolean;
  /** Cached ACP sessionId allocated for this lane's controller. */
  acpSessionId: string | null;
  /** Subscription handle for the lane's controller; cleared on lane teardown. */
  unsubscribeController: (() => void) | null;
  /** Monotonic timestamp (ms) of the most recent activity; used by the idle sweep. */
  lastActivityMs: number;
}

/**
 * Result published by the primary in-flight execute() call. Duplicate calls
 * (A2A client retries, polls that become new message/send calls) republish
 * this result on their own eventBus without re-prompting the underlying ACP
 * agent.
 */
interface PromptOutcome {
  state: "completed" | "failed";
  text: string;
  messageId?: string;
  normalizedUserMessage: Message;
}

/**
 * Bridges A2A execution requests to an ACPSessionController.
 *
 * Unlike ACPtoA2AExecutor which manages raw ACP streams, this executor
 * delegates all lifecycle management to the controller and focuses on
 * translating controller events to A2A task status updates.
 */
export class HostA2AExecutor implements InitializableExecutor {
  /**
   * The "primary" controller passed to the constructor. Kept for WS-bridge /
   * AG-UI compatibility (both still subscribe to a single controller for
   * surface-event broadcasting — see plan §6b option (a)). Also serves as the
   * fallback controller when no `controllerFactory` was supplied: every lane
   * points at this instance and they all serialize against `controllerBusy`.
   */
  private primaryController: GatewayHostController;
  private activeTasks = new Map<string, ActiveTask>();
  /**
   * Per-contextId lane map. Each lane owns its own `inFlightPrompt` mutex,
   * `owningTaskId` pointer, and (when `controllerFactory` is supplied) its
   * own dedicated `GatewayHostController`. Lanes are created on first
   * `execute()` for a given contextId and may be evicted by the idle sweep
   * (plan §6a).
   */
  private lanes = new Map<string, SessionLane>();
  /**
   * Reverse index for fast `cancelTask(taskId)` lookup. Populated when a
   * task takes ownership of its lane's prompt, cleared at `runPrompt`
   * resolve and at `execute()` teardown.
   */
  private taskToLane = new Map<string, SessionLane>();
  /**
   * ContextIds whose lane controllers are currently being constructed
   * via `controllerFactory(contextId)` but have not yet been inserted
   * into `lanes`. Closes the TOCTOU window the reviewer flagged: a
   * runtime switch attempted between `await controllerFactory(...)`
   * and `this.lanes.set(...)` would otherwise see `activeLaneCount:
   * 0` and proceed, even though a fresh controller bound to the
   * *previous* runtime was about to be inserted.
   */
  private pendingLaneCreations = new Set<string>();
  /**
   * In-flight `@@dispatch` invocations, mapped taskId → contextId.
   * Dispatch is intentionally non-cancelable for this release — the
   * ephemeral controller has no cancel-token threading yet. Recording
   * the (id, contextId) pair lets `cancelTask` publish an explicit
   * non-cancelable status update on the right A2A context instead of
   * silently no-op-ing.
   */
  private dispatchedTaskIds = new Map<string, string>();
  /**
   * Phase-1 shared-controller gate. Only engaged when no `controllerFactory`
   * was supplied — then all lanes point at the primary controller and must
   * serialize here. With a factory, each lane drives its own controller and
   * this stays `null` forever.
   */
  private controllerBusy: Promise<void> | null = null;
  /**
   * In phase-1 shared-controller mode: the contextId of the lane currently
   * driving the primary controller. `subscribeToPrimaryController` uses this
   * to route events to the correct lane's `owningTaskId` task. With a
   * factory, this field is unused because each lane subscribes to its own
   * controller directly.
   */
  private currentControllerLaneContextId: string | null = null;
  /** Phase-1-only: one-shot guard so we subscribe to the primary controller at most once. */
  private primarySubscribed = false;
  private readonly dispatchRegistryOverride: AgentRegistryMap | null;
  private dispatchProvider: A2AClientProvider | null;
  private readonly dispatchWorkspacePath: string;
  private readonly controllerFactory:
    | ((contextId: string) => Promise<GatewayHostController>)
    | null;
  private readonly laneIdleTimeoutMs: number;
  private readonly audit: AuditEmitter | null;
  private laneSweepTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;

  constructor(controller: GatewayHostController, options?: HostA2AExecutorOptions) {
    this.primaryController = controller;
    this.dispatchRegistryOverride = options?.dispatchRegistry ?? null;
    this.dispatchProvider = options?.dispatchTransport
      ? new A2AClientProvider(options.dispatchTransport)
      : null;
    this.dispatchWorkspacePath = options?.dispatchWorkspacePath ?? process.cwd();
    this.controllerFactory = options?.controllerFactory ?? null;
    this.laneIdleTimeoutMs = options?.laneIdleTimeoutMs ?? DEFAULT_LANE_IDLE_TIMEOUT_MS;
    this.audit = options?.audit ?? null;

    // The idle-sweep only matters when lanes own their controllers. In
    // shared-controller mode there is nothing to tear down, so skip the timer.
    if (this.controllerFactory && this.laneIdleTimeoutMs > 0) {
      this.startLaneIdleSweep();
    }
  }

  /**
   * Initialize method called by UniversalA2AServer.start().
   *
   * Returns an InitializeResponse-compatible object built from
   * the primary controller's current state. The controller was already
   * started by createHostSession(), so we just read its state.
   */
  async initialize(): Promise<InitializeResponse> {
    const state = this.primaryController.getState();

    return {
      protocolVersion: 1,
      agentInfo: {
        name: state.agentName ?? "agents-js-gateway",
        version: "0.1.0",
      },
      agentCapabilities: state.agentCapabilities ?? undefined,
    };
  }

  /**
   * Bridge a single A2A execute() request into an ACP prompt.
   *
   * State machine (linear modulo the cancel/error early-returns):
   *
   *   1. Detect `@@dispatch` directive → delegate to executeDirectDispatch.
   *   2. `resolveLane(contextId)` — lane lookup/creation + closed-state guard.
   *      Publishes a terminal failure and returns null on either failure mode.
   *   3. `ensureLaneReady(lane)` — if the lane's controller is in
   *      `error` or `cancelling`, force-reset and create a new session.
   *      Publishes a terminal failure and returns false if recovery fails.
   *      "prompting" is NOT stuck — it's the normal in-flight state.
   *   4. Register the ActiveTask + publish submitted/working.
   *   5. `trackPromptOwnership(lane, task, ...)` — either own the lane's
   *      single-slot prompt (start runPrompt) or join an existing in-flight
   *      prompt and republish its outcome on this request's eventBus. The
   *      cancel/error branches inside the join always call eventBus.finished()
   *      on the outer finally so cancelled task streams close cleanly.
   */
  async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const userText = getMessageText(context.userMessage);
    console.log("[Gateway] HostA2AExecutor: bridging A2A goal", {
      userText,
      contextId: context.contextId,
      taskId: context.taskId,
    });

    // ── @@dispatch directive — deterministic A2A routing ──
    const directive = parseDispatchDirective(userText);
    if (directive) {
      await this.executeDirectDispatch(context, eventBus, directive);
      return;
    }

    const resolved = await this.resolveLane(context, eventBus);
    if (!resolved) return;
    const { lane, controllerState } = resolved;

    const ready = await this.ensureLaneReady(context, eventBus, lane, controllerState);
    if (!ready) return;

    // Register the active task
    const correlationId = newCorrelationId();
    const task: ActiveTask = {
      taskId: context.taskId,
      contextId: context.contextId,
      eventBus,
      textBuffer: null,
      correlationId,
      startedAtMs: Date.now(),
    };
    this.activeTasks.set(context.taskId, task);
    this.taskToLane.set(context.taskId, lane);
    this.audit?.record({
      kind: "a2a-task-started",
      correlationId,
      taskId: context.taskId,
      contextId: context.contextId,
    });

    // Every call publishes submitted+working on its own eventBus so the A2A
    // client sees a complete lifecycle, even when it joins an in-flight prompt.
    const normalizedUserMessage = this.normalizeMessage(context.userMessage);
    this.publishTask(task, {
      kind: "task",
      id: task.taskId,
      contextId: task.contextId,
      status: { state: "submitted", timestamp: nowIso() },
      history: [normalizedUserMessage],
    });
    this.publishStatusUpdate(task, { state: "working", final: false });

    let terminalState: "completed" | "failed" | "canceled" = "completed";
    try {
      const outcome = await this.trackPromptOwnership(lane, task, userText, normalizedUserMessage);

      if (task.cancelled) {
        terminalState = "canceled";
        this.publishTerminalTask(task, outcome.normalizedUserMessage, {
          state: "canceled",
          text: "",
        });
        return;
      }

      terminalState = outcome.state === "completed" ? "completed" : "failed";
      this.publishTerminalTask(task, outcome.normalizedUserMessage, {
        state: outcome.state,
        text: outcome.text,
        ...(outcome.messageId ? { messageId: outcome.messageId } : {}),
      });
    } catch (error) {
      if (task.cancelled) {
        terminalState = "canceled";
        this.publishTerminalTask(task, normalizedUserMessage, {
          state: "canceled",
          text: "",
        });
        return;
      }
      const message = formatRequestError(error);
      console.error("[Gateway] HostA2AExecutor: task failed", { error: message });
      terminalState = "failed";
      this.publishTerminalTask(task, normalizedUserMessage, {
        state: "failed",
        text: message,
      });
    } finally {
      // `eventBus.finished()` MUST fire on every exit path, including the two
      // `if (task.cancelled) return` early-returns above. Without this, a
      // cancel that races an in-flight prompt resolve leaves the original
      // task's event stream open and the A2A client never sees completion.
      // cancelTask() calls `finished()` on its OWN eventBus (the cancel-RPC
      // one), not this one, so it cannot be relied on for the original
      // task's terminal signal.
      eventBus.finished();
      this.audit?.record({
        kind: "a2a-task-finished",
        correlationId,
        taskId: context.taskId,
        contextId: context.contextId,
        state: terminalState,
      });
      this.activeTasks.delete(context.taskId);
      this.taskToLane.delete(context.taskId);
    }
  }

  /**
   * Resolve the `SessionLane` for `context.contextId`, creating it if
   * necessary. Publishes a terminal failure on the caller's eventBus and
   * returns `null` when:
   *   - the controllerFactory throws while spawning a lane controller, or
   *   - the lane's controller is `closed` (unrecoverable).
   *
   * Touches `lane.lastActivityMs` on success so the idle-sweep doesn't
   * evict a lane that's actively serving a request. Returns the lane
   * paired with the snapshot of `controllerState` taken during the closed
   * check so the caller can reuse it for stuck-state detection without
   * a second `getState()` call (some test mocks count getState invocations
   * to verify only the original error state is observed).
   */
  private async resolveLane(
    context: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<{ lane: SessionLane; controllerState: ACPSessionState } | null> {
    let lane: SessionLane;
    try {
      lane = await this.getOrCreateLane(context.contextId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.publishTaskFailed(context, eventBus, `Controller factory failed: ${message}`);
      eventBus.finished();
      return null;
    }
    lane.lastActivityMs = Date.now();

    const controllerState = lane.controller.getState();
    if (controllerState.status === "closed") {
      const reason = controllerState.lastError || "closed";
      this.publishTaskFailed(context, eventBus, `Controller is not ready: ${reason}`);
      eventBus.finished();
      return null;
    }
    return { lane, controllerState };
  }

  /**
   * Ensure the lane's controller is in a state where it can accept a new
   * prompt. If the controller is in a stuck state (`error` or `cancelling`),
   * force-reset it and create a new ACP session. No-op for any other state.
   *
   * "prompting" is the normal state while the agent processes a prompt — it
   * must NOT be treated as stuck, or concurrent/polling requests force-reset
   * the active session and create an infinite session-creation loop.
   *
   * Returns `true` when the lane is ready (either no recovery was needed, or
   * recovery succeeded). Returns `false` when recovery itself failed; in that
   * case, a terminal failure has already been published on the caller's
   * eventBus and the caller should bail without further work.
   */
  private async ensureLaneReady(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    lane: SessionLane,
    controllerState: ACPSessionState,
  ): Promise<boolean> {
    const s = controllerState.status;
    if (s !== "error" && s !== "cancelling") return true;

    const originalError = controllerState.lastError || controllerState.status;
    console.log("[Gateway] HostA2AExecutor: controller in stuck state, attempting recovery", {
      status: controllerState.status,
      lastError: originalError,
    });
    try {
      lane.controller.forceReset();
      await lane.controller.newSession();
      console.log("[Gateway] HostA2AExecutor: recovery succeeded");
      return true;
    } catch (recoveryErr) {
      const recoveryMsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
      this.publishTaskFailed(
        context,
        eventBus,
        `Controller is not ready: ${originalError} (recovery failed: ${recoveryMsg})`,
      );
      eventBus.finished();
      return false;
    }
  }

  /**
   * Resolve the lane's in-flight prompt for this task.
   *
   * If the lane already has an in-flight prompt (same-contextId concurrent
   * request), this task joins and republishes the owner's outcome on its own
   * eventBus. Otherwise this task takes ownership and starts `runPrompt`,
   * clearing `lane.inFlightPrompt` once the promise settles.
   *
   * Different-contextId requests never reach this branch because they
   * resolve to a different lane in `resolveLane`.
   */
  private async trackPromptOwnership(
    lane: SessionLane,
    task: ActiveTask,
    userText: string,
    normalizedUserMessage: Message,
  ): Promise<PromptOutcome> {
    let ownsPrompt = false;
    if (lane.inFlightPrompt) {
      console.log("[Gateway] HostA2AExecutor: joining in-flight prompt (lane mutex)", {
        contextId: task.contextId,
        taskId: task.taskId,
      });
    } else {
      ownsPrompt = true;
      lane.inFlightPrompt = this.runPrompt(lane, task, userText, normalizedUserMessage);
    }

    const pending = lane.inFlightPrompt;
    try {
      return await pending;
    } finally {
      if (ownsPrompt && lane.inFlightPrompt === pending) {
        lane.inFlightPrompt = null;
      }
    }
  }

  /**
   * Look up or create the `SessionLane` for a contextId.
   *
   * When a `controllerFactory` was supplied, newly-created lanes spawn a
   * fresh controller (the factory owns the `start()` call) and subscribe to
   * it directly — different contextIds then make forward progress against
   * independent ACP processes in parallel. When no factory is present, every
   * lane points at the primary controller and the executor serializes them
   * on `controllerBusy`.
   */
  private async getOrCreateLane(contextId: string): Promise<SessionLane> {
    const existing = this.lanes.get(contextId);
    if (existing) return existing;

    if (this.controllerFactory) {
      // Factory mode: each lane owns a freshly-spawned controller.
      // Mark the lane as pending BEFORE awaiting the factory so a
      // runtime-switch attempt during construction sees the activity
      // and rejects. Without this, the switch could land between
      // `await controllerFactory(...)` and `this.lanes.set(...)`,
      // and the freshly-spawned controller (bound to the previous
      // runtime) would still be inserted post-switch.
      this.pendingLaneCreations.add(contextId);
      let controller: GatewayHostController;
      try {
        controller = await this.controllerFactory(contextId);
      } finally {
        this.pendingLaneCreations.delete(contextId);
      }
      const lane: SessionLane = {
        contextId,
        inFlightPrompt: null,
        owningTaskId: null,
        controller,
        ownsController: true,
        acpSessionId: null,
        unsubscribeController: null,
        lastActivityMs: Date.now(),
      };
      lane.unsubscribeController = this.subscribeToLaneController(lane);
      this.lanes.set(contextId, lane);
      return lane;
    }

    // Shared-controller mode (no factory): every lane reuses the primary
    // controller. Subscribe to the primary exactly once; route events via
    // `currentControllerLaneContextId`.
    if (!this.primarySubscribed) {
      this.subscribeToPrimaryController();
      this.primarySubscribed = true;
    }
    const lane: SessionLane = {
      contextId,
      inFlightPrompt: null,
      owningTaskId: null,
      controller: this.primaryController,
      ownsController: false,
      acpSessionId: null,
      unsubscribeController: null,
      lastActivityMs: Date.now(),
    };
    this.lanes.set(contextId, lane);
    return lane;
  }

  /**
   * Owns the actual ACP prompt execution for a single logical turn within a
   * lane. Called at most once at a time per lane (gated by
   * `lane.inFlightPrompt`); concurrent same-contextId execute() calls await
   * the returned promise and republish its outcome.
   *
   * Serializes at the executor-wide `controllerBusy` gate because the shared
   * `ACPSessionController` can only handle one prompt at a time. While this
   * lane holds the gate, `currentControllerLaneContextId` points at it so
   * `subscribeToController` routes incoming events to `lane.owningTaskId`'s
   * event bus.
   */
  private async runPrompt(
    lane: SessionLane,
    task: ActiveTask,
    userText: string,
    normalizedUserMessage: Message,
  ): Promise<PromptOutcome> {
    // Shared-controller mode: wait for the primary controller to be free
    // and claim it for this lane. Factory mode skips the gate entirely
    // because each lane owns its own controller.
    const usesSharedController = !lane.ownsController;
    let releaseControllerBusy: (() => void) | undefined;
    if (usesSharedController) {
      while (this.controllerBusy) {
        await this.controllerBusy;
      }
      this.controllerBusy = new Promise<void>((resolve) => {
        releaseControllerBusy = resolve;
      });
    }

    const previousLaneOwningTaskId = lane.owningTaskId;
    lane.owningTaskId = task.taskId;
    const previousControllerLaneContextId = this.currentControllerLaneContextId;
    if (usesSharedController) {
      this.currentControllerLaneContextId = lane.contextId;
    }

    try {
      // Reuse a pre-created session when the browser eagerly bootstraps one.
      if (!lane.controller.getState().sessionId) {
        lane.acpSessionId = await lane.controller.newSession();
      } else if (!lane.acpSessionId) {
        lane.acpSessionId = lane.controller.getState().sessionId;
      }

      await lane.controller.sendPrompt([{ type: "text", text: userText }]);

      // `??` distinguishes null (no chunks received → tool-only turn) from ""
      // (legitimately empty chunk). See ActiveTask.textBuffer for the states.
      const finalText = task.textBuffer ?? "Prompt completed.";
      const finalMessageId = task.agentMessageId ?? crypto.randomUUID();
      return {
        state: "completed",
        text: finalText,
        messageId: finalMessageId,
        normalizedUserMessage,
      };
    } catch (error) {
      const message = formatRequestError(error);
      return {
        state: "failed",
        text: message,
        normalizedUserMessage,
      };
    } finally {
      lane.lastActivityMs = Date.now();
      if (lane.owningTaskId === task.taskId) {
        lane.owningTaskId = previousLaneOwningTaskId;
      }
      if (usesSharedController) {
        if (this.currentControllerLaneContextId === lane.contextId) {
          this.currentControllerLaneContextId = previousControllerLaneContextId;
        }
        this.controllerBusy = null;
        releaseControllerBusy?.();
      }
    }
  }

  // -- @@dispatch helpers --

  private getDispatchRegistry(): AgentRegistryMap {
    if (this.dispatchRegistryOverride) {
      return this.dispatchRegistryOverride;
    }
    return loadRegistryFromDisk();
  }

  private getDispatchProvider(): A2AClientProvider {
    if (!this.dispatchProvider) {
      this.dispatchProvider = new A2AClientProvider();
    }
    return this.dispatchProvider;
  }

  private async executeDirectDispatch(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    directive: ParsedDispatchDirective,
  ): Promise<void> {
    const { agentName } = directive;
    const registry = this.getDispatchRegistry();
    const entry = registry[agentName];
    const normalizedUserMessage = this.normalizeMessage(context.userMessage);

    if (!entry) {
      const available = Object.keys(registry);
      const availableList = available.length > 0 ? available.join(", ") : "(none)";
      this.publishTaskFailed(
        context,
        eventBus,
        `Unknown agent "${agentName}". Available agents: ${availableList}`,
      );
      eventBus.finished();
      return;
    }

    // Shared prelude: publish submitted/working for any valid kind before
    // diverging to the kind-specific backend.
    eventBus.publish(
      buildStatusUpdate(context.taskId, context.contextId, {
        state: "submitted",
        final: false,
      }),
    );
    eventBus.publish(
      buildStatusUpdate(context.taskId, context.contextId, {
        state: "working",
        text: `Dispatching to ${agentName}...`,
        final: false,
      }),
    );

    if (entry.kind === "a2a") {
      await this.dispatchA2A(context, eventBus, directive, entry, normalizedUserMessage);
      return;
    }

    if (entry.kind === "acp") {
      await this.dispatchAcp(context, eventBus, directive, entry, normalizedUserMessage);
      return;
    }

    // Future-proof: any unknown kind publishes a descriptive failed terminal.
    // This branch is structurally unreachable today (AgentEntry is a
    // discriminated union of "a2a" | "acp") but prevents silent drop on
    // registry schema extensions.
    const unknownEntry = entry as { kind: string };
    eventBus.publish(
      buildTerminalTask(context.taskId, context.contextId, normalizedUserMessage, {
        state: "failed",
        text: `Dispatch to "${agentName}" failed: unknown registry kind "${unknownEntry.kind}"`,
      }),
    );
    eventBus.finished();
  }

  private async dispatchA2A(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    directive: ParsedDispatchDirective,
    entry: A2AAgentEntry,
    normalizedUserMessage: Message,
  ): Promise<void> {
    const { agentName, payload } = directive;
    // Track A2A-kind dispatch in the same map ACP-kind dispatch uses
    // so cancelTask publishes the explicit non-cancelable response,
    // runtime-switch gating sees the active dispatch, and the audit
    // emitter records the lifecycle. Without tracking, A2A dispatch
    // appeared "invisible" to those surfaces — the reviewer flagged
    // this as a P1 because it meant runtime switches could land
    // mid-dispatch and cancel attempts silently fell through to the
    // primary controller.
    const correlationId = newCorrelationId();
    const startedAtMs = Date.now();
    this.dispatchedTaskIds.set(context.taskId, context.contextId);
    this.audit?.record({
      kind: "dispatch-started",
      correlationId,
      agentName,
      harness: "a2a",
      kindVariant: "a2a",
      taskId: context.taskId,
    });

    let dispatchState: "completed" | "failed" = "completed";
    try {
      const provider = this.getDispatchProvider();
      const target = await provider.connect({ url: entry.url });
      const result = await provider.sendTurn(target, payload || "(no message)", {
        contextId: context.contextId,
        stream: false,
      });

      const responseText = extractA2AResponseText(result);

      eventBus.publish(
        buildTerminalTask(context.taskId, context.contextId, normalizedUserMessage, {
          state: "completed",
          text: responseText || "(empty response)",
          metadata: {
            "agents-js.cancelable": false,
            "agents-js.correlationId": correlationId,
            "agents-js.dispatch": {
              agentName,
              agentUrl: entry.url,
              directive: directive.fullMatch,
            },
          },
        }),
      );
    } catch (error) {
      dispatchState = "failed";
      const message = formatRequestError(error);
      console.error("[Gateway] HostA2AExecutor: @@dispatch (a2a) failed", {
        agentName,
        error: message,
      });
      eventBus.publish(
        buildTerminalTask(context.taskId, context.contextId, normalizedUserMessage, {
          state: "failed",
          text: `Dispatch to "${agentName}" failed: ${message}`,
          metadata: {
            "agents-js.cancelable": false,
            "agents-js.correlationId": correlationId,
          },
        }),
      );
    } finally {
      this.audit?.record({
        kind: "dispatch-finished",
        correlationId,
        agentName,
        harness: "a2a",
        kindVariant: "a2a",
        taskId: context.taskId,
        state: dispatchState,
        durationMs: Date.now() - startedAtMs,
      });
      this.dispatchedTaskIds.delete(context.taskId);
      eventBus.finished();
    }
  }

  /**
   * ACP-kind dispatch path. Spawns a fresh `ACPSessionController` per
   * `@@dispatch` invocation, drives it through start → newSession → sendPrompt,
   * translates incremental agent chunks to A2A `working` status updates on the
   * caller's event bus, and tears the controller down in `finally` regardless
   * of success or failure.
   *
   * Three design pins (D2 synthesis §4):
   *
   * 1. **Per-dispatch ephemeral controller lifetime.** Each call spawns a
   *    fresh process; no pooling, no session reuse. Matches the one-shot
   *    RPC shape of A2A dispatch today.
   * 2. **Bypasses the lane mutex + controller-busy gate.** Those serialize
   *    `this.controller` (the primary gateway host session) and its per-
   *    contextId lanes; ephemeral dispatch controllers are a disjoint
   *    resource with their own internal gate.
   * 3. **Closure-scoped subscription via `subscribeDispatchController`.**
   *    Does not touch lane state / `activeTasks` / `subscribeToController`
   *    — those remain primary-prompt-only (Gamma's invariant, commit e70d2f5).
   *
   * Permission mode is **inherited** from the primary gateway controller
   * — operators who launched the gateway in "ask"/"plan"/"hub" get those
   * modes for dispatched runs too, instead of the previous hard-coded
   * "yolo" override. A dispatch directive does not implicitly grant
   * elevated trust.
   *
   * Cancel semantics: dispatch is **non-cancelable** for this release.
   * The ephemeral controller has no cancel-token threading yet. Both
   * the working status update and the terminal task metadata publish
   * `agents-js.cancelable=false`, and `cancelTask(dispatchedTaskId)`
   * returns an explicit non-cancelable status update rather than
   * silently no-op-ing.
   */
  private async dispatchAcp(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    directive: ParsedDispatchDirective,
    entry: ACPAgentEntry,
    normalizedUserMessage: Message,
  ): Promise<void> {
    const { agentName, payload } = directive;
    const dispatchController = new ACPSessionController();
    const correlationId = newCorrelationId();
    const startedAtMs = Date.now();
    this.dispatchedTaskIds.set(context.taskId, context.contextId);
    this.audit?.record({
      kind: "dispatch-started",
      correlationId,
      agentName,
      harness: entry.harness,
      kindVariant: "acp",
      taskId: context.taskId,
    });

    let dispatchState: "completed" | "failed" = "completed";
    try {
      await this.spawnEphemeralController(dispatchController, entry);

      // `runEphemeralPrompt` owns the subscription lifecycle from creation to
      // teardown via its own try/finally so a thrown sendPrompt still
      // detaches the listener before propagating.
      const { text, messageId, nonInteractiveFailure } = await this.runEphemeralPrompt(
        dispatchController,
        { taskId: context.taskId, contextId: context.contextId, eventBus },
        payload,
      );

      // Race guard: when sendPrompt resolves AFTER the subscription
      // converted a permission/write-gate/elicitation event into a
      // final "failed" status update, the agent's "completion"
      // signal arrived on the wire after the cancel was issued and
      // is not authoritative. Publishing a "completed" terminal
      // here would put two terminal events on the bus — the
      // reviewer flagged this as a P1 race because the A2A client
      // could settle on either. The non-interactive-failure path
      // already published its own final update, so we skip the
      // success terminal entirely.
      if (nonInteractiveFailure) {
        dispatchState = "failed";
      } else {
        eventBus.publish(
          buildTerminalTask(context.taskId, context.contextId, normalizedUserMessage, {
            state: "completed",
            text: text || "(empty response)",
            ...(messageId ? { messageId } : {}),
            metadata: {
              "agents-js.cancelable": false,
              "agents-js.correlationId": correlationId,
              "agents-js.dispatch": {
                agentName,
                harness: entry.harness,
                ...(entry.command ? { command: entry.command } : {}),
                directive: directive.fullMatch,
              },
            },
          }),
        );
      }
    } catch (error) {
      dispatchState = "failed";
      const message = formatRequestError(error);
      console.error("[Gateway] HostA2AExecutor: @@dispatch (acp) failed", {
        agentName,
        harness: entry.harness,
        error: message,
      });
      eventBus.publish(
        buildTerminalTask(context.taskId, context.contextId, normalizedUserMessage, {
          state: "failed",
          text: `Dispatch to "${agentName}" (harness "${entry.harness}") failed: ${message}`,
          metadata: {
            "agents-js.cancelable": false,
            "agents-js.correlationId": correlationId,
          },
        }),
      );
    } finally {
      this.audit?.record({
        kind: "dispatch-finished",
        correlationId,
        agentName,
        harness: entry.harness,
        kindVariant: "acp",
        taskId: context.taskId,
        state: dispatchState,
        durationMs: Date.now() - startedAtMs,
      });
      this.dispatchedTaskIds.delete(context.taskId);
      this.disposeEphemeralController(dispatchController);
      eventBus.finished();
    }
  }

  /**
   * Bring an ephemeral controller online: resolve the runtime, build a slim
   * StartConfig, start the process, **inherit the primary controller's
   * permission mode** (so dispatched targets honor the gateway's policy
   * instead of running unconditionally autonomous), and allocate a session.
   * Throws on any failure; the caller's outer try/finally is responsible
   * for disposing the controller in that case.
   */
  private async spawnEphemeralController(
    dispatchController: ACPSessionController,
    entry: ACPAgentEntry,
  ): Promise<void> {
    const runtime = await resolveAcpAgentEntryToRuntime(entry);
    const workspacePath = this.resolveDispatchCwd();
    const startConfig = buildEphemeralDispatchStartConfig(runtime, workspacePath);

    await dispatchController.start(startConfig);
    // Inherit the gateway's current permission mode so a dispatch
    // directive does not implicitly grant elevated trust. The primary
    // controller's permissionMode is updated via setPermissionMode at
    // gateway level; reading it here gives dispatched targets the same
    // policy operators see in the chat UI.
    await dispatchController.setPermissionMode(this.primaryController.permissionMode);
    await dispatchController.newSession();
  }

  /**
   * Subscribe to the controller, drive the prompt to completion, and return
   * the captured text + messageId. The subscription is wired up in a
   * try/finally so a thrown `sendPrompt` always detaches the listener before
   * propagating.
   */
  private async runEphemeralPrompt(
    dispatchController: ACPSessionController,
    sink: { taskId: string; contextId: string; eventBus: ExecutionEventBus },
    payload: string | undefined,
  ): Promise<{
    text: string;
    messageId: string | undefined;
    /**
     * `true` when the subscription already published a final
     * "failed" status update for a non-interactive event
     * (permission/write-gate/elicitation). The caller MUST NOT
     * publish its own "completed" terminal in that case — that
     * would race two terminal events onto the same A2A bus.
     */
    nonInteractiveFailure: boolean;
  }> {
    const subscription = subscribeDispatchController(dispatchController, sink);
    try {
      await dispatchController.sendPrompt([{ type: "text", text: payload || "(no message)" }]);
      const text = subscription.getTextBuffer() ?? "Prompt completed.";
      const messageId = subscription.getAgentMessageId();
      return {
        text,
        messageId,
        nonInteractiveFailure: subscription.hasNonInteractiveFailure(),
      };
    } finally {
      subscription.unsubscribe();
    }
  }

  /**
   * Best-effort controller teardown.
   *
   * `destroy()` may throw on controllers that never successfully started —
   * we've already published a terminal task by the time this runs, so we
   * swallow to preserve the caller's event stream.
   */
  private disposeEphemeralController(dispatchController: ACPSessionController): void {
    try {
      dispatchController.destroy();
    } catch {
      // best-effort; see method jsdoc.
    }
  }

  private resolveDispatchCwd(): string {
    return this.dispatchWorkspacePath;
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    // Dispatch tasks are non-cancelable for this release. Surface the
    // refusal explicitly so the A2A client sees a definite signal
    // instead of inferring it from a delayed terminal event.
    const dispatchContextId = this.dispatchedTaskIds.get(taskId);
    if (dispatchContextId !== undefined) {
      eventBus.publish(
        buildStatusUpdate(taskId, dispatchContextId, {
          state: "working",
          text: "Cancel rejected: @@dispatch tasks are non-cancelable in this release.",
          final: false,
          metadata: { "agents-js.cancelable": false },
        }),
      );
      eventBus.finished();
      return;
    }

    const task = this.activeTasks.get(taskId);
    const lane = this.taskToLane.get(taskId);
    if (task) {
      task.cancelled = true;
      this.activeTasks.delete(taskId);
      this.taskToLane.delete(taskId);
    }

    // Cancel the controller that is actually driving this task's prompt.
    // With per-lane controllers, cancelling the primary controller would
    // have no effect on a peer lane's in-flight work. Fall back to the
    // primary controller when the task's lane can't be located (e.g. the
    // task completed between the cancel RPC dispatch and now).
    const target = lane?.controller ?? this.primaryController;
    try {
      await target.cancel();
    } catch {
      // Ignore cancel errors
    } finally {
      eventBus.finished();
    }
  }

  /**
   * Snapshot of in-flight work this executor knows about. Used to gate
   * runtime switches: the gateway must reject a runtime change while
   * any of these counters are non-zero, otherwise an in-flight A2A
   * prompt or dispatch would be cut off mid-turn (or worse, a lane
   * controller for the *old* runtime would silently keep handling
   * follow-up prompts after the operator believed the switch
   * completed).
   *
   * Read-only by design — writers must mutate the underlying maps.
   */
  getActivitySnapshot(): {
    activeTaskCount: number;
    activeDispatchCount: number;
    activeLaneCount: number;
    inFlightLaneCount: number;
    pendingLaneCount: number;
  } {
    let inFlightLaneCount = 0;
    for (const lane of this.lanes.values()) {
      if (lane.inFlightPrompt !== null) inFlightLaneCount += 1;
    }
    return {
      activeTaskCount: this.activeTasks.size,
      activeDispatchCount: this.dispatchedTaskIds.size,
      activeLaneCount: this.lanes.size,
      inFlightLaneCount,
      pendingLaneCount: this.pendingLaneCreations.size,
    };
  }

  /**
   * Best-effort eviction of every lane that is not currently driving a
   * prompt. Call this *after* a successful runtime switch so future
   * work spawns fresh lane controllers against the new runtime instead
   * of inheriting the previous runtime's controller. Lanes still in
   * flight are skipped and survive — but the activity-snapshot gate
   * upstream should already have prevented those from existing.
   */
  destroyIdleLanes(): { evicted: number; skipped: number } {
    let evicted = 0;
    let skipped = 0;
    for (const [contextId, lane] of [...this.lanes.entries()]) {
      if (lane.inFlightPrompt !== null) {
        skipped += 1;
        continue;
      }
      this.teardownLane(lane);
      this.lanes.delete(contextId);
      evicted += 1;
    }
    return { evicted, skipped };
  }

  /**
   * Executor-wide shutdown hook. Tears down the idle-sweep timer and
   * destroys every factory-spawned lane controller. The primary controller
   * is caller-owned and is left alone.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.laneSweepTimer) {
      clearInterval(this.laneSweepTimer);
      this.laneSweepTimer = null;
    }
    for (const lane of this.lanes.values()) {
      this.teardownLane(lane);
    }
    this.lanes.clear();
    this.taskToLane.clear();
    this.activeTasks.clear();
    this.dispatchedTaskIds.clear();
  }

  // -- Lane lifecycle --

  private startLaneIdleSweep(): void {
    // Sweep frequency = quarter of the idle timeout, capped at 5 minutes so
    // the test-mode short timeouts still fire quickly without starving the
    // event loop in production.
    const intervalMs = Math.min(Math.max(this.laneIdleTimeoutMs / 4, 100), 5 * 60 * 1000);
    this.laneSweepTimer = setInterval(() => {
      this.sweepIdleLanes();
    }, intervalMs);
    // Don't keep the Node event loop alive just for the sweeper.
    const timer = this.laneSweepTimer as { unref?: () => void };
    timer.unref?.();
  }

  private sweepIdleLanes(): void {
    if (this.destroyed) return;
    const now = Date.now();
    for (const [contextId, lane] of this.lanes) {
      // Never evict a lane that is currently driving an in-flight prompt or
      // has an active task registered against it.
      if (lane.inFlightPrompt !== null || lane.owningTaskId !== null) continue;
      if (now - lane.lastActivityMs < this.laneIdleTimeoutMs) continue;

      console.log("[Gateway] HostA2AExecutor: evicting idle lane", {
        contextId,
        idleMs: now - lane.lastActivityMs,
      });
      this.teardownLane(lane);
      this.lanes.delete(contextId);
    }
  }

  private teardownLane(lane: SessionLane): void {
    lane.unsubscribeController?.();
    lane.unsubscribeController = null;
    if (lane.ownsController) {
      try {
        (lane.controller as { destroy?: () => void }).destroy?.();
      } catch (err) {
        console.warn("[Gateway] HostA2AExecutor: lane controller destroy failed", {
          contextId: lane.contextId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // -- Private helpers --

  /**
   * Shared-controller mode event handler. Routes incoming events via
   * `currentControllerLaneContextId → lane → lane.owningTaskId`. Only used
   * when no `controllerFactory` was supplied (every lane shares the primary
   * controller, so the source of events is ambiguous without the pointer).
   */
  private subscribeToPrimaryController(): void {
    this.primaryController.subscribe((event: ACPSessionEvent, state: ACPSessionState) => {
      const laneContextId = this.currentControllerLaneContextId;
      if (!laneContextId) return;
      const lane = this.lanes.get(laneContextId);
      if (!lane?.owningTaskId) return;
      const task = this.activeTasks.get(lane.owningTaskId);
      if (!task) return;
      this.handleControllerEvent(task, event, state);
    });
  }

  /**
   * Factory-mode event handler: the lane owns its own controller, so the
   * event source is unambiguous — route straight to `lane.owningTaskId`.
   * Returns the unsubscribe handle so the lane teardown path can detach.
   */
  private subscribeToLaneController(lane: SessionLane): () => void {
    return lane.controller.subscribe((event: ACPSessionEvent, state: ACPSessionState) => {
      if (!lane.owningTaskId) return;
      const task = this.activeTasks.get(lane.owningTaskId);
      if (!task) return;
      this.handleControllerEvent(task, event, state);
    });
  }

  private handleControllerEvent(
    task: ActiveTask,
    event: ACPSessionEvent,
    _state: ACPSessionState,
  ): void {
    switch (event.type) {
      case "session_update": {
        // Extract text chunks from session updates
        const update = event.notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          // Coalesce null → "" on first chunk, then append. null signals
          // "no chunks received yet" so the terminal path can distinguish
          // a tool-only turn (null) from a legitimately empty chunk ("").
          task.textBuffer = (task.textBuffer ?? "") + (update.content.text ?? "");

          // Track agent message ID if available
          const updateWithId = update as { messageId?: unknown };
          if (
            typeof updateWithId.messageId === "string" &&
            updateWithId.messageId.length > 0 &&
            !task.agentMessageId
          ) {
            task.agentMessageId = updateWithId.messageId;
          }

          this.publishStatusUpdate(task, {
            state: "working",
            text: task.textBuffer,
            final: false,
            messageId: task.agentMessageId,
          });
        }
        break;
      }

      case "permission_requested":
        this.publishStatusUpdate(task, {
          state: "input-required",
          text: `Permission requested: ${event.request.toolCall?.title ?? "tool call"}`,
          final: false,
        });
        break;

      case "write_gate_requested":
        this.publishStatusUpdate(task, {
          state: "input-required",
          text: `Write approval needed: ${event.path}`,
          final: false,
        });
        break;

      case "elicitation_requested":
        this.publishStatusUpdate(task, {
          state: "input-required",
          text: event.request.message,
          final: false,
        });
        break;

      case "error":
        this.publishStatusUpdate(task, {
          state: "failed",
          text: event.message,
          final: true,
        });
        break;

      default:
        // Other events (status_changed, etc.) are informational
        break;
    }
  }

  private normalizeMessage(message: Message): Message {
    return {
      ...message,
      kind: "message",
    };
  }

  private publishTask(task: ActiveTask, nextTask: Task): void {
    task.eventBus.publish(nextTask);
  }

  private publishStatusUpdate(
    task: ActiveTask,
    options: Parameters<typeof buildStatusUpdate>[2],
  ): void {
    task.eventBus.publish(buildStatusUpdate(task.taskId, task.contextId, options));
  }

  private publishTerminalTask(
    task: ActiveTask,
    userMessage: Message,
    options: {
      state: Parameters<typeof buildTerminalTask>[3]["state"];
      text: string;
      messageId?: string;
    },
  ): void {
    this.publishTask(task, buildTerminalTask(task.taskId, task.contextId, userMessage, options));
  }

  private publishTaskFailed(
    context: RequestContext,
    eventBus: ExecutionEventBus,
    errorMessage: string,
  ): void {
    eventBus.publish(
      buildTerminalTask(
        context.taskId,
        context.contextId,
        this.normalizeMessage(context.userMessage),
        {
          state: "failed",
          text: errorMessage,
        },
      ),
    );
  }
}

// -- Ephemeral dispatch helpers (ACP-kind dispatch path) --

/**
 * Subscribe to an ephemeral dispatch controller and translate relevant
 * `ACPSessionEvent`s into A2A `working` status updates on a caller-provided
 * event bus. Closure-scoped: owns its own text buffer + message-id capture
 * and does NOT touch the executor's `owningTaskId` / `activeTasks` / primary
 * `subscribeToController` — those remain primary-prompt-only.
 *
 * Permission / write-gate / elicitation events are treated as terminal
 * failures: dispatch is non-interactive — it has no UI to prompt the
 * operator. Under inherited `"ask"`/`"plan"`/`"hub"` modes the agent
 * may still emit one of these events; we publish a failed status
 * update *and* call `controller.cancel()` so the in-flight `sendPrompt`
 * unblocks instead of hanging forever waiting for a `resolvePermission`
 * call that no surface will make. Under `"yolo"` the agent should not
 * emit these in practice; if it does, the same fail+cancel path
 * applies.
 *
 * @internal — Exported only for unit tests. Not part of the
 * `@agents-js/host` package's public surface; the package barrel does
 * not re-export it. Consumers should use `@@dispatch` through
 * `HostA2AExecutor.execute()`.
 */
export function subscribeDispatchController(
  controller: ACPSessionController,
  sink: {
    taskId: string;
    contextId: string;
    eventBus: ExecutionEventBus;
  },
): {
  unsubscribe: () => void;
  /** `null` = no chunks received; `""` = empty chunk received; otherwise the accumulated text. */
  getTextBuffer: () => string | null;
  getAgentMessageId: () => string | undefined;
  /**
   * Did the subscription already publish a *final* status update for
   * the dispatch (because the agent emitted a permission /
   * write-gate / elicitation event that we converted to non-
   * interactive failure)? When `true`, the caller MUST NOT publish
   * its own "completed" terminal — that would race two terminal
   * events onto the same A2A event bus and the A2A client could
   * settle on either.
   */
  hasNonInteractiveFailure: () => boolean;
} {
  let textBuffer: string | null = null;
  let agentMessageId: string | undefined;
  let nonInteractiveFailure = false;

  /**
   * Fire-and-forget cancel. Swallows rejections — the dispatch's
   * outer try/catch already handles the resulting cancel/error and
   * publishes a failed terminal task, so a controller cancel that
   * itself throws should not bubble through this subscription.
   */
  const cancelDispatchController = (): void => {
    void Promise.resolve(controller.cancel()).catch(() => {
      // intentional: cancel best-effort during dispatch teardown
    });
  };

  const unsubscribe = controller.subscribe((event: ACPSessionEvent, _state: ACPSessionState) => {
    switch (event.type) {
      case "session_update": {
        const update = event.notification.update;
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          textBuffer = (textBuffer ?? "") + (update.content.text ?? "");

          const updateWithId = update as { messageId?: unknown };
          if (
            typeof updateWithId.messageId === "string" &&
            updateWithId.messageId.length > 0 &&
            !agentMessageId
          ) {
            agentMessageId = updateWithId.messageId;
          }

          sink.eventBus.publish(
            buildStatusUpdate(sink.taskId, sink.contextId, {
              state: "working",
              text: textBuffer,
              final: false,
              ...(agentMessageId ? { messageId: agentMessageId } : {}),
            }),
          );
        }
        break;
      }

      case "permission_requested":
        nonInteractiveFailure = true;
        sink.eventBus.publish(
          buildStatusUpdate(sink.taskId, sink.contextId, {
            state: "failed",
            text: `Dispatch target requested permission; dispatch is non-interactive (tool: ${
              event.request.toolCall?.title ?? "unknown"
            })`,
            final: true,
          }),
        );
        cancelDispatchController();
        break;

      case "write_gate_requested":
        nonInteractiveFailure = true;
        sink.eventBus.publish(
          buildStatusUpdate(sink.taskId, sink.contextId, {
            state: "failed",
            text: `Dispatch target requested write approval; dispatch is non-interactive (path: ${event.path})`,
            final: true,
          }),
        );
        cancelDispatchController();
        break;

      case "elicitation_requested":
        nonInteractiveFailure = true;
        sink.eventBus.publish(
          buildStatusUpdate(sink.taskId, sink.contextId, {
            state: "failed",
            text: `Dispatch target elicitation is not supported: ${event.request.message}`,
            final: true,
          }),
        );
        cancelDispatchController();
        break;

      case "error":
        sink.eventBus.publish(
          buildStatusUpdate(sink.taskId, sink.contextId, {
            state: "failed",
            text: event.message,
            final: true,
          }),
        );
        break;

      default:
        // status_changed, etc. — informational; don't mirror to A2A.
        break;
    }
  });

  return {
    unsubscribe,
    getTextBuffer: () => textBuffer,
    getAgentMessageId: () => agentMessageId,
    hasNonInteractiveFailure: () => nonInteractiveFailure,
  };
}

/**
 * Build a slim `StartConfig` for an ephemeral ACP dispatch controller.
 *
 * Deliberately stripped relative to the primary `buildStartConfig` in
 * `host-session.ts`:
 *
 * - no `toolCallContentHandlers` — dispatch targets are RPC-like, no A2UI
 *   surface plumbing
 * - no `sessionStorage` — turns are ephemeral, not persisted
 * - no `hooks` — tool-call/lifecycle logging is unnecessary for one-shot
 *   dispatches
 * - **fresh** in-memory `PermissionEngine` + `PermissionStore` with no
 *   rule loading — dispatch is non-interactive: under inherited
 *   `"ask"`/`"plan"`/`"hub"` modes any permission/write-gate/elicitation
 *   event is converted to a failed terminal + controller cancel by
 *   `subscribeDispatchController` (so dispatch never hangs awaiting a
 *   resolution from a UI that does not exist for it). Sharing the
 *   gateway's persistent engine/store is intentionally avoided so
 *   concurrent dispatches do not contend on the same store and so a
 *   dispatched run cannot accidentally inherit a "remember-allow" rule
 *   that the operator added for an interactive session.
 * - `allowRealHome: true` — dispatched harnesses still need real credentials
 *   under `~/.config/...` to authenticate, same posture as the primary
 *   gateway host session
 */
function buildEphemeralDispatchStartConfig(
  runtime: ResolvedGatewayRuntime,
  workspacePath: string,
): StartConfig {
  const permissionEngine = new PermissionEngine();
  const permissionStore = new PermissionStore();
  const fileAdapters = createNodeFileAdapters(workspacePath);

  return {
    agentConfig: {
      name: `${runtime.definition.displayName} (dispatch)`,
      command: runtime.acp.command ?? runtime.definition.command,
      args: runtime.acp.args ?? runtime.definition.args,
      env: runtime.acp.env ?? {},
      authHints: [],
      workspacePolicy: "workspace-root-only",
      workspaceFlag: resolveHostWorkspaceFlag(runtime),
      allowRealHome: true,
      autoRecoverOpencodeDefaultAgent: runtime.acp.autoRecoverOpencodeDefaultAgent,
    },
    workspacePath,
    fileAdapters,
    permissionEngine,
    permissionStore,
    envPolicy: buildHostRuntimeEnvPolicy(runtime),
    clientInfo: { name: "agents-js-gateway-dispatch", version: "0.1.0" },
  };
}
