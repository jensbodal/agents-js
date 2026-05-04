/**
 * WebSocket bridge that connects ACPSessionController events to browser clients.
 *
 * Runs on a separate port (PORT + 1) from the A2A HTTP server to avoid
 * modifying UniversalA2AServer. Broadcasts controller events to all
 * connected clients and dispatches client messages to the controller.
 */

import { HTTP_STATUS } from "@agents-js/a2a";
import { A2UI_WS_FRAME_TYPE, type A2uiMessage } from "@agents-js/a2ui-types";
import type {
  ACPSessionEvent,
  ACPSessionState,
  PermissionMode,
  WriteGateResolution,
} from "@agents-js/acp-host";
import { SESSION_RESTORE_FAILURE_MESSAGE } from "@agents-js/acp-host/session-restore";
import type { ServerWebSocket } from "bun";
import type { GatewayHostController } from "./host-session.ts";
import type { RuntimeModelInfo } from "./model-cache.ts";
import type { SurfaceBroadcastFn } from "./surface-broadcaster.ts";

// Derive types from controller methods to avoid direct @agentclientprotocol/sdk imports
type PermissionResponse = Parameters<GatewayHostController["resolvePermission"]>[0];
type ElicitationResponseType = Parameters<GatewayHostController["resolveElicitation"]>[0];
type ModelId = Parameters<GatewayHostController["setModel"]>[0];

export type RuntimeSwitchOrigin = "manual" | "saved_restore";

export interface RuntimeSnapshotInfo {
  id: string;
  displayName: string;
}

export interface RuntimeSwitchState {
  status: "switching" | "failed" | "runtimeApplied" | "runtimeUnsupported";
  requestedRuntimeId: string;
  message: string;
  origin: RuntimeSwitchOrigin;
  preservedSession?: boolean;
  clearedPendingTurn?: boolean;
}

export type WSBridgeState = ACPSessionState & {
  permissionMode?: PermissionMode;
  runtime?: RuntimeSnapshotInfo;
  availableRuntimes?: RuntimeSnapshotInfo[];
  runtimeModels?: RuntimeModelInfo[];
  defaultModelId?: string;
  runtimeSwitchState?: RuntimeSwitchState | null;
};

// -- Message types (exported for Track D) --

/** Server-to-client messages */
export type WSServerMessage =
  | { type: "event"; event: ACPSessionEvent; state: WSBridgeState }
  | { type: "state_snapshot"; state: WSBridgeState }
  | { type: "a2ui_message"; message: A2uiMessage };

/** Client-to-server messages */
export type WSClientMessage =
  | { type: "resolve_permission"; response: PermissionResponse; selectedScope?: string }
  | { type: "resolve_write_gate"; result: WriteGateResolution }
  | { type: "resolve_elicitation"; response: ElicitationResponseType }
  | { type: "ensure_session" }
  | { type: "load_session"; sessionId: string }
  | { type: "set_runtime"; runtimeId: string; origin: RuntimeSwitchOrigin }
  | { type: "set_model"; modelId: ModelId }
  | { type: "set_permission_mode"; mode: PermissionMode }
  | { type: "request_state" }
  | { type: "cancel" }
  /**
   * Browser → server back-channel for A2UI surface interactions
   * (button clicks, form submits, etc.). The bridge forwards the
   * payload to `controller.sendSurfaceEvent`, which emits it onto
   * the ACP session event stream so observers (and ultimately the
   * agent, when it subscribes back) see the user action.
   *
   * `actionName` is part of the wire so a single sink can route
   * different events without parsing the opaque payload. The
   * gateway-side `surface_event` ACPSessionEvent carries
   * `{ surfaceId, event: { action, payload } }` so the existing
   * translator / broadcaster surface stays unchanged.
   */
  | { type: "surface_event"; surfaceId: string; actionName: string; payload: unknown };

export interface RuntimeSwapResult {
  runtime: RuntimeSnapshotInfo;
  runtimeModels?: RuntimeModelInfo[];
  defaultModelId?: string;
  preservedSession?: boolean;
  clearedPendingTurn?: boolean;
  message?: string;
}

export interface WSBridgeConfig {
  controller: GatewayHostController;
  port: number;
  runtime: RuntimeSnapshotInfo;
  availableRuntimes?: RuntimeSnapshotInfo[];
  runtimeModels?: RuntimeModelInfo[];
  defaultModelId?: string;
  setRuntime?: (runtimeId: string) => Promise<RuntimeSwapResult>;
  /**
   * Optional surface-broadcaster handle produced by
   * {@link createGatewaySurfaceBroadcaster}. The bridge calls `attach`
   * once during {@link createWSBridge}, handing the broadcaster a
   * fan-out callback that serializes each {@link A2uiMessage} as a
   * `{ type: "a2ui_message" }` frame and sends it to every connected
   * WebSocket. A bridge built without a broadcaster simply omits A2UI
   * forwarding.
   */
  surfaceBroadcaster?: { attach(broadcast: SurfaceBroadcastFn): void };
}

export interface WSBridgeHandle {
  server: ReturnType<typeof Bun.serve>;
  stop(): void;
}

export function createEnsureSessionCoordinator(
  controller: Pick<GatewayHostController, "getState" | "newSession">,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;

  return async () => {
    if (controller.getState().sessionId) {
      return;
    }

    if (!inFlight) {
      inFlight = (async () => {
        if (!controller.getState().sessionId) {
          await controller.newSession();
        }
      })().finally(() => {
        inFlight = null;
      });
    }

    await inFlight;
  };
}

/**
 * Serializes the session state for transmission over WebSocket.
 *
 * The ACPSessionState contains non-serializable fields (Maps, resolve functions)
 * that must be stripped or converted before JSON.stringify.
 */
function serializeState(state: Readonly<ACPSessionState>): ACPSessionState {
  return JSON.parse(
    JSON.stringify(state, (_key, value) => {
      if (value instanceof Map) {
        return Object.fromEntries(value);
      }
      if (typeof value === "function") {
        return undefined;
      }
      return value;
    }),
  );
}

function buildBridgeState(
  controller: GatewayHostController,
  runtime: RuntimeSnapshotInfo,
  availableRuntimes: RuntimeSnapshotInfo[] | undefined,
  runtimeModels: RuntimeModelInfo[] | undefined,
  defaultModelId: string | undefined,
  runtimeSwitchState: RuntimeSwitchState | null,
  state: Readonly<ACPSessionState> = controller.getState(),
): WSBridgeState {
  return {
    ...serializeState(state),
    permissionMode: controller.permissionMode,
    runtime,
    availableRuntimes,
    runtimeModels,
    defaultModelId,
    runtimeSwitchState,
  };
}

export interface RuntimeBridgeSnapshot {
  runtime: RuntimeSnapshotInfo;
  runtimeModels?: RuntimeModelInfo[];
  defaultModelId?: string;
  runtimeSwitchState: RuntimeSwitchState | null;
}

export function createRuntimeSwitchCoordinator(config: {
  initialRuntime: RuntimeSnapshotInfo;
  initialRuntimeModels?: RuntimeModelInfo[];
  initialDefaultModelId?: string;
  setRuntime?: (runtimeId: string) => Promise<RuntimeSwapResult>;
  onStateChange?: (snapshot: RuntimeBridgeSnapshot) => void;
}) {
  let runtime = config.initialRuntime;
  let runtimeModels = config.initialRuntimeModels;
  let defaultModelId = config.initialDefaultModelId;
  let runtimeSwitchState: RuntimeSwitchState | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  function snapshot(): RuntimeBridgeSnapshot {
    return {
      runtime,
      runtimeModels,
      defaultModelId,
      runtimeSwitchState,
    };
  }

  function emit(): void {
    config.onStateChange?.(snapshot());
  }

  async function performRuntimeSwitch(
    runtimeId: string,
    origin: RuntimeSwitchOrigin,
  ): Promise<void> {
    if (runtimeId === runtime.id) {
      runtimeSwitchState = {
        status: "runtimeApplied",
        requestedRuntimeId: runtimeId,
        message: `${runtime.displayName} is already active.`,
        origin,
        preservedSession: true,
        clearedPendingTurn: false,
      };
      emit();
      return;
    }

    if (!config.setRuntime) {
      runtimeSwitchState = {
        status: "runtimeUnsupported",
        requestedRuntimeId: runtimeId,
        message: `Runtime hot-swap is unavailable for "${runtimeId}" in this gateway build.`,
        origin,
      };
      emit();
      return;
    }

    runtimeSwitchState = {
      status: "switching",
      requestedRuntimeId: runtimeId,
      message: `Switching runtime to "${runtimeId}"...`,
      origin,
    };
    emit();

    try {
      const result = await config.setRuntime(runtimeId);
      runtime = result.runtime;
      runtimeModels = result.runtimeModels;
      defaultModelId = result.defaultModelId;
      runtimeSwitchState = {
        status: "runtimeApplied",
        requestedRuntimeId: runtimeId,
        message:
          result.message ??
          `Runtime switched to ${result.runtime.displayName} (${result.runtime.id}).`,
        origin,
        preservedSession: result.preservedSession,
        clearedPendingTurn: result.clearedPendingTurn,
      };
      emit();
    } catch (error) {
      runtimeSwitchState = {
        status: "failed",
        requestedRuntimeId: runtimeId,
        message: error instanceof Error ? error.message : String(error),
        origin,
      };
      emit();
    }
  }

  return {
    getSnapshot(): RuntimeBridgeSnapshot {
      return snapshot();
    },
    async setRuntime(runtimeId: string, origin: RuntimeSwitchOrigin = "manual"): Promise<void> {
      const nextRun = inFlight.catch(() => {}).then(() => performRuntimeSwitch(runtimeId, origin));
      inFlight = nextRun.catch(() => {});
      return nextRun;
    },
  };
}

export function createWSBridge(config: WSBridgeConfig): WSBridgeHandle {
  const {
    controller,
    port,
    runtime,
    availableRuntimes,
    runtimeModels,
    defaultModelId,
    setRuntime,
    surfaceBroadcaster,
  } = config;
  const clients = new Set<ServerWebSocket<unknown>>();
  const ensureSession = createEnsureSessionCoordinator(controller);
  const runtimeCoordinator = createRuntimeSwitchCoordinator({
    initialRuntime: runtime,
    initialRuntimeModels: runtimeModels,
    initialDefaultModelId: defaultModelId,
    setRuntime,
    onStateChange: () => {
      broadcastSnapshot();
    },
  });

  // Serialize `frame` once and fan it out to every connected client,
  // dropping any socket whose `send` throws (client disconnected). When
  // `target` is supplied, send to that client only.
  function broadcastSerialized(frame: WSServerMessage, target?: ServerWebSocket<unknown>): void {
    const serialized = JSON.stringify(frame);
    if (target) {
      target.send(serialized);
      return;
    }
    for (const client of clients) {
      try {
        client.send(serialized);
      } catch {
        clients.delete(client);
      }
    }
  }

  function broadcastSnapshot(target?: ServerWebSocket<unknown>): void {
    const runtimeSnapshot = runtimeCoordinator.getSnapshot();
    broadcastSerialized(
      {
        type: "state_snapshot",
        state: buildBridgeState(
          controller,
          runtimeSnapshot.runtime,
          availableRuntimes,
          runtimeSnapshot.runtimeModels,
          runtimeSnapshot.defaultModelId,
          runtimeSnapshot.runtimeSwitchState,
        ),
      },
      target,
    );
  }

  function broadcastA2ui(message: A2uiMessage): void {
    broadcastSerialized({ type: A2UI_WS_FRAME_TYPE, message });
  }

  surfaceBroadcaster?.attach(broadcastA2ui);

  const unsubscribe = controller.subscribe((event, state) => {
    const runtimeSnapshot = runtimeCoordinator.getSnapshot();
    broadcastSerialized({
      type: "event",
      event,
      state: buildBridgeState(
        controller,
        runtimeSnapshot.runtime,
        availableRuntimes,
        runtimeSnapshot.runtimeModels,
        runtimeSnapshot.defaultModelId,
        runtimeSnapshot.runtimeSwitchState,
        state,
      ),
    });
  });

  const server = Bun.serve({
    port,
    idleTimeout: 0,
    fetch(req, server) {
      if (server.upgrade(req)) {
        return undefined;
      }
      return new Response("WebSocket only", { status: HTTP_STATUS.UPGRADE_REQUIRED });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        broadcastSnapshot(ws);
        console.log(`[Gateway WS] Client connected (${clients.size} total)`);
      },

      message(ws, rawMessage) {
        void (async () => {
          const msg = JSON.parse(
            typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage),
          ) as WSClientMessage;

          switch (msg.type) {
            case "resolve_permission":
              controller.resolvePermission(msg.response, msg.selectedScope);
              break;
            case "resolve_write_gate":
              controller.resolveWriteGate(msg.result);
              break;
            case "resolve_elicitation":
              controller.resolveElicitation(msg.response);
              break;
            case "ensure_session":
              await ensureSession();
              broadcastSnapshot();
              break;
            case "load_session":
              try {
                await controller.loadSession(msg.sessionId);
              } catch (err) {
                console.warn("[Gateway WS] Failed to load session, falling back to new:", err);
                controller.setLastError(SESSION_RESTORE_FAILURE_MESSAGE);
                broadcastSnapshot();
                await ensureSession();
                controller.setLastError(SESSION_RESTORE_FAILURE_MESSAGE);
              }
              broadcastSnapshot();
              break;
            case "set_runtime":
              await runtimeCoordinator.setRuntime(msg.runtimeId, msg.origin);
              broadcastSnapshot();
              break;
            case "set_model":
              await controller.setModel(msg.modelId);
              break;
            case "set_permission_mode":
              await controller.setPermissionMode(msg.mode);
              broadcastSnapshot();
              break;
            case "request_state": {
              broadcastSnapshot(ws);
              break;
            }
            case "cancel":
              await controller.cancel();
              break;
            case "surface_event":
              // Wrap the actionName + payload into the shape ACP
              // surface_event observers expect. The agent receives
              // this through its A2UI bridge subscription.
              controller.sendSurfaceEvent(msg.surfaceId, {
                action: msg.actionName,
                payload: msg.payload,
              });
              break;
            default:
              console.warn("[Gateway WS] Unknown message type:", (msg as { type: string }).type);
          }
        })().catch((err) => {
          console.error(
            "[Gateway WS] Failed to process message:",
            err instanceof Error ? err.message : String(err),
          );
        });
      },

      close(ws) {
        clients.delete(ws);
        // If the last client disconnects while a resolution is pending,
        // cancel to prevent the controller from hanging forever.
        if (clients.size === 0) {
          const state = controller.getState();
          if (
            state.currentTurn?.pendingPermission ||
            state.pendingWriteGate ||
            state.pendingElicitation
          ) {
            console.warn(
              "[Gateway WS] Last client disconnected with pending resolution — cancelling",
            );
            void controller.cancel();
          }
        }
        console.log(`[Gateway WS] Client disconnected (${clients.size} total)`);
      },
    },
  });

  console.log(`[Gateway WS] WebSocket bridge listening on port ${port}`);

  return {
    server,
    stop() {
      unsubscribe();
      // Swap the broadcaster's sink to a no-op so any in-flight agent
      // messages post-stop are dropped instead of trying to send through
      // sockets we're about to close.
      surfaceBroadcaster?.attach(() => {});
      for (const ws of clients) {
        ws.close();
      }
      clients.clear();
      server.stop(true);
      console.log("[Gateway WS] Bridge stopped");
    },
  };
}
