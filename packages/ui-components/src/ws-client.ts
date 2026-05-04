/**
 * Browser WebSocket client for the gateway's WS bridge.
 *
 * Connects to an explicit launcher- or query-provided WS bridge URL,
 * translates ACPSessionController events into a flat HostState, and
 * provides resolution methods that send messages back to the gateway.
 *
 * This module deliberately avoids importing from `apps/internal-gateway`
 * or Node-only packages -- it runs in the browser.
 */

import { A2UI_WS_FRAME_TYPE } from "@agents-js/a2ui-types";
import {
  mapModels,
  mapPendingElicitation,
  mapPermissionRequest,
  mapSnapshot,
} from "./ws-state-mapper.ts";

// Re-export all types so existing consumer imports (`from "./ws-client.ts"`) keep working.
export type {
  ElicitationResolution,
  HostState,
  HostStateListener,
  ModelInfo,
  PendingElicitationInfo,
  PendingPermissionInfo,
  PendingWriteGateInfo,
  PermissionOptionInfo,
  PermissionResolution,
  RuntimeInfo,
  RuntimeModelInfo,
  RuntimeSwitchOrigin,
  RuntimeSwitchState,
  SessionModelsInfo,
  WriteGateResolution,
} from "./ws-types.ts";

import type {
  ElicitationResolution,
  HostState,
  HostStateListener,
  PermissionResolution,
  RuntimeSwitchOrigin,
  WriteGateResolution,
  WSServerMessage,
} from "./ws-types.ts";

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const RECONNECT_DELAY_MS = 2_000;

/**
 * Optional behaviour hooks for {@link HostWSClient}.
 *
 * All fields are optional so existing `new HostWSClient(url)` call sites
 * keep working unchanged. Omitting a hook leaves the corresponding
 * surface inert.
 */
export interface HostWSClientOptions {
  /**
   * Invoked when the gateway forwards an inbound A2UI lifecycle message
   * (`CreateSurface` / `UpdateComponents` / `UpdateDataModel` /
   * `DeleteSurface`). The payload is the verbatim `A2uiMessage` the
   * agent emitted on the ACP `tool_call.content` channel; the client
   * does not validate it here — `A2uiHost.applyMessage` validates at
   * the ingress.
   */
  onA2uiMessage?: (message: unknown) => void;
}

export class HostWSClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<HostStateListener>();
  private state: HostState = {};
  private pendingMessages: Record<string, unknown>[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;
  private suppressReconnectOnce = false;
  private readonly onA2uiMessage?: (message: unknown) => void;

  constructor(
    private url: string,
    options: HostWSClientOptions = {},
  ) {
    this.onA2uiMessage = options.onA2uiMessage;
  }

  // -- lifecycle ------------------------------------------------------------

  connect(): void {
    this.explicitlyClosed = false;
    this._open();
  }

  disconnect(): void {
    this.explicitlyClosed = true;
    this._clearReconnect();
    // Drop any pending messages: replaying them into a later session
    // (a reconnect to the same host or a connect to a different one)
    // is a footgun. The setUrl path already does this; keep parity
    // here so an explicit disconnect cleans the same way.
    this.pendingMessages = [];
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // -- subscriptions --------------------------------------------------------

  subscribe(listener: HostStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): HostState {
    return this.state;
  }

  // -- resolution methods (browser → gateway) -------------------------------

  resolvePermission(response: PermissionResolution): void {
    this._send({
      type: "resolve_permission",
      response: response.response,
      selectedScope: response.selectedScope,
    });
  }

  resolveWriteGate(result: WriteGateResolution): void {
    this._send({ type: "resolve_write_gate", result });
  }

  resolveElicitation(response: ElicitationResolution): void {
    this._send({ type: "resolve_elicitation", response });
  }

  setPermissionMode(mode: string): void {
    this._send({ type: "set_permission_mode", mode });
  }

  ensureSession(): void {
    this._send({ type: "ensure_session" });
  }

  loadSession(sessionId: string): void {
    this._send({ type: "load_session", sessionId });
  }

  setRuntime(runtimeId: string, origin: RuntimeSwitchOrigin = "manual"): void {
    this._setState({
      ...this.state,
      runtimeSwitchState: {
        status: "switching",
        requestedRuntimeId: runtimeId,
        message: `Switching runtime to "${runtimeId}"...`,
        origin,
      },
    });
    this._send({ type: "set_runtime", runtimeId, origin });
  }

  cancel(): void {
    this._send({ type: "cancel" });
  }

  setModel(modelId: string): void {
    this._send({ type: "set_model", modelId });
  }

  /**
   * Forward a user-driven A2UI surface event back to the gateway. The
   * gateway invokes `controller.sendSurfaceEvent(surfaceId, { action,
   * payload })`, which emits the event into the ACP session stream so
   * agents and observers see the user's interaction. Use this from the
   * `A2uiBridge` sink — without it, browser clicks are silently
   * dropped.
   *
   * **Surface events are moment-bound and are NEVER queued.** A click
   * on an old surface is meaningless after the underlying session has
   * disconnected — replaying it into a later session/runtime is a
   * security/UX hazard. When the WS is not `OPEN`, this method drops
   * the event with a console warning and returns `false` so the
   * caller (the A2UI sink) can surface a non-blocking notice if it
   * cares to.
   */
  sendSurfaceEvent(surfaceId: string, actionName: string, payload: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn("[ui-components/ws-client] surface_event dropped: WebSocket is not OPEN", {
        surfaceId,
        actionName,
        readyState: this.ws?.readyState ?? "(no socket)",
      });
      return false;
    }
    // Bypass the queue path that `_send` falls through to; surface
    // events MUST NOT be replayed when the socket reopens.
    this.ws.send(JSON.stringify({ type: "surface_event", surfaceId, actionName, payload }));
    return true;
  }

  setUrl(url: string): void {
    if (url === this.url) {
      return;
    }

    this.url = url;
    this.pendingMessages = [];
    this._clearReconnect();
    this._setState({});

    if (this.ws) {
      this.suppressReconnectOnce = true;
      this.ws.close();
      this.ws = null;
    }

    if (!this.explicitlyClosed) {
      this._open();
    }
  }

  // -- internals ------------------------------------------------------------

  private _open(): void {
    if (this.ws) return;

    const ws = new WebSocket(this.url);

    ws.addEventListener("open", () => {
      if (this.ws !== ws) {
        return;
      }
      ws.send(JSON.stringify({ type: "request_state" }));
      this._flushPending();
    });

    ws.addEventListener("message", (event) => {
      this._handleSocketMessage(ws, event.data as string);
    });

    ws.addEventListener("close", () => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      if (this.suppressReconnectOnce) {
        this.suppressReconnectOnce = false;
        return;
      }
      if (!this.explicitlyClosed) {
        this._scheduleReconnect();
      }
    });

    ws.addEventListener("error", () => {
      // The close event will fire after error — reconnect handled there.
    });

    this.ws = ws;
  }

  private _handleSocketMessage(ws: WebSocket, raw: string): void {
    if (this.ws !== ws) {
      return;
    }
    this._handleMessage(raw);
  }

  private _handleMessage(raw: string): void {
    let msg: WSServerMessage;
    try {
      msg = JSON.parse(raw) as WSServerMessage;
    } catch {
      return;
    }

    if (msg.type === "state_snapshot") {
      this._setState(mapSnapshot(msg.state));
    } else if (msg.type === "event") {
      this._applyEvent(msg.event, msg.state as Record<string, unknown> | undefined);
    } else if (msg.type === A2UI_WS_FRAME_TYPE) {
      this.onA2uiMessage?.(msg.message);
    }
  }

  private _applyEvent(
    event: Record<string, unknown> & { type: string },
    state?: Record<string, unknown>,
  ): void {
    // Every `event` wire frame carries a full WSBridgeState snapshot
    // (see `packages/host/src/ws-bridge.ts` `broadcastSerialized`).
    // When present, re-derive authoritative HostState through the same
    // mapper used for `state_snapshot` frames. This guarantees fields
    // like `workflowSurface`, `pendingElicitation`, plan/queue/status,
    // etc. stay in lock-step with the host-side state without relying
    // on a synthetic recompute path.
    if (state) {
      this._setState(mapSnapshot(state));
      return;
    }

    // Fallback: no attached snapshot. Patch only the field the event
    // names — used by unit tests that exercise individual event paths
    // without a full WSBridgeState. Keep the list conservative; prefer
    // attaching a `state` field in production wire traffic.
    switch (event.type) {
      case "permission_requested": {
        const req = event.request as Record<string, unknown> | undefined;
        if (req) {
          this._setState({
            ...this.state,
            pendingPermission: mapPermissionRequest(req),
          });
        }
        break;
      }
      case "permission_resolved":
        this._setState({ ...this.state, pendingPermission: null });
        break;
      case "elicitation_requested": {
        const req = event.request as Record<string, unknown> | undefined;
        this._setState({
          ...this.state,
          pendingElicitation: mapPendingElicitation({ request: req }),
        });
        break;
      }
      case "elicitation_resolved":
        this._setState({ ...this.state, pendingElicitation: null });
        break;
      case "write_gate_requested":
        this._setState({
          ...this.state,
          pendingWriteGate: {
            path: String(event.path ?? ""),
            diff: String(event.diff ?? ""),
            closestParentFolder: String(event.closestParentFolder ?? ""),
          },
        });
        break;
      case "write_gate_resolved":
        this._setState({ ...this.state, pendingWriteGate: null });
        break;
      case "status_changed": {
        const update: HostState = { ...this.state };
        if (typeof event.status === "string") {
          update.sessionStatus = event.status;
        }
        this._setState(update);
        break;
      }
      case "model_changed": {
        const nextModels = mapModels(event.models);
        this._setState({ ...this.state, models: nextModels });
        break;
      }
      case "session_created":
      case "session_loaded": {
        const sessionId = typeof event.sessionId === "string" ? event.sessionId : null;
        if (sessionId !== null) {
          this._setState({ ...this.state, sessionId });
        }
        break;
      }
      case "session_info_updated": {
        const title = typeof event.title === "string" ? event.title : null;
        this._setState({ ...this.state, sessionTitle: title });
        break;
      }
      case "plan_updated": {
        const entries = Array.isArray(event.entries) ? event.entries : null;
        this._setState({ ...this.state, plan: entries as HostState["plan"] });
        break;
      }
      case "queue_changed": {
        const count = typeof event.count === "number" ? event.count : 0;
        this._setState({ ...this.state, queueCount: count });
        break;
      }
      default:
        break;
    }
  }

  private _setState(next: HostState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  private _send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }

    this.pendingMessages.push(msg);
  }

  private _flushPending(): void {
    if (this.ws?.readyState !== WebSocket.OPEN || this.pendingMessages.length === 0) {
      return;
    }

    const pending = [...this.pendingMessages];
    this.pendingMessages = [];
    for (const msg of pending) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private _scheduleReconnect(): void {
    this._clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, RECONNECT_DELAY_MS);
  }

  private _clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
