import { A2AClientController } from "@agents-js/a2a-client";
import { A2uiBridge, A2uiHost } from "@agents-js/a2ui-host";
import { renderSurface } from "@agents-js/a2ui-renderer";
import type {
  PermissionRequestLike,
  WorkflowSurfaceRenderState,
  WriteGateLike,
} from "@agents-js/ui-components";
import { AcpChatApp } from "@agents-js/ui-components";
import { wrapControllerForAgUiRuns } from "./agui-run-client.ts";
import { routeHostBridgeView } from "./host-view.ts";
import "@agents-js/ui-components";
import {
  createPermissionResolution,
  deriveDisplayedSessionStatus,
  deriveRuntimeNotice,
  type HostState,
  HostWSClient,
  isHostBridgeActiveForTarget,
  type PermissionModalDetail,
  type RuntimeInfo,
  repairActiveSavedRuntimePreference,
  resolveBrowserLaunchConfig,
  shouldClearStaleSessionHash,
  shouldRepairSavedRuntimeRestore,
} from "@agents-js/ui-components/web-ui-glue";
import { validateA2uiMessage } from "@agents-js/validation/a2ui";
import { runDemo } from "./a2ui-demo.ts";

const app = document.getElementById("app");
if (!app) throw new Error("Missing #app mount point");

const params = new URLSearchParams(window.location.search);
const browserEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

// -- Session hash persistence ------------------------------------------------

function getSessionIdFromHash(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const parts = new URLSearchParams(hash);
  return parts.get("session");
}

let _lastWrittenSessionId: string | null = null;

function setSessionIdInHash(sessionId: string): void {
  if (sessionId === _lastWrittenSessionId) return;
  _lastWrittenSessionId = sessionId;
  history.replaceState(null, "", `#session=${encodeURIComponent(sessionId)}`);
}

function clearSessionHash(): void {
  _lastWrittenSessionId = null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
}

const baseController = new A2AClientController();

// AG-UI is the primary run path for restricted-beta. The page query
// `?run=a2a` is a compatibility/diagnostic escape hatch that keeps the
// legacy A2A `sendTurn` for operators who need to compare the two
// transports side-by-side.
const useAguiRuns = params.get("run") !== "a2a";
const controller = useAguiRuns
  ? wrapControllerForAgUiRuns(baseController, {
      // The controller's resolved target URL is the source of truth at
      // run time; this fallback covers the brief window before the
      // first connect resolves.
      fallbackBaseUrl: "",
    })
  : baseController;
if (!useAguiRuns) {
  console.log("[web-ui] Run path: A2A (compat mode via ?run=a2a)");
} else {
  console.log("[web-ui] Run path: AG-UI (POST /agent SSE)");
}

const chatApp = new AcpChatApp();
chatApp.controller = controller;
app.appendChild(chatApp);

// -- A2UI surface mount ------------------------------------------------------
// Mounts adjacent to AcpChatApp so renderer output sits beside the ACP
// chat surface without reaching inside AcpChatApp's shadow DOM.
const a2uiMount = document.createElement("div");
a2uiMount.id = "a2ui-surface-mount";
a2uiMount.style.cssText =
  "position: relative; width: 100%; max-width: 720px; margin: 0 auto; padding: 0 16px;";
app.appendChild(a2uiMount);

// Inbound A2UI lifecycle messages reach `applyInbound` via the WS bridge
// (`onA2uiMessage` below). User-driven surface events flow back via
// `hostClient.sendSurfaceEvent`, which the gateway forwards to
// `controller.sendSurfaceEvent` so the agent / observers see the
// interaction. We also keep a console mirror so operator developers
// can spot interactions in the devtools log.
//
// Construct bridge without a host so its stable `onEvent` forwarder
// can be passed into the host constructor below; `attachHost`
// completes the cycle. The `hostClient` is constructed further down
// in the file but the bridge sink reads it lazily, so the late
// initialization order is fine.
let _hostClient: { sendSurfaceEvent(s: string, a: string, p: unknown): void } | null = null;
const a2uiBridge = new A2uiBridge({
  sink: {
    sendSurfaceEvent(surfaceId, actionName, payload) {
      console.log("[web-ui] a2ui surface event:", { surfaceId, actionName, payload });
      if (_hostClient !== null) {
        _hostClient.sendSurfaceEvent(surfaceId, actionName, payload);
      } else {
        console.warn("[web-ui] a2ui surface event dropped: host bridge unavailable", {
          surfaceId,
          actionName,
        });
      }
    },
  },
});
const a2uiHost = new A2uiHost(a2uiMount, {
  renderer: renderSurface,
  onEvent: a2uiBridge.onEvent,
});
a2uiBridge.attachHost(a2uiHost);

// Dev-only smoke: `?a2ui=demo` drives a scripted CreateSurface ->
// UpdateComponents -> UpdateDataModel round-trip so operators can
// confirm the renderer pipeline end-to-end without a live A2UI agent.
const isDev = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
if (isDev && params.get("a2ui") === "demo") {
  runDemo(a2uiBridge);
}

interface ChatAppHostState {
  suppressProbeErrorDetails: boolean;
  _view: {
    status: string;
  };
  _pendingPermission: PermissionRequestLike | null;
  _pendingWriteGate: WriteGateLike | null;
  _permissionMode: string;
  _runtime: RuntimeInfo | null;
  _availableRuntimes: RuntimeInfo[];
  _runtimeNotice: string;
  _lastError: string;
  _sessionTitle: string;
  _plan: NonNullable<HostState["plan"]>;
  _currentToolCalls: NonNullable<NonNullable<HostState["currentTurn"]>["toolCalls"]>;
  _runtimeSwitchState: HostState["runtimeSwitchState"];
  _workflowSurface: WorkflowSurfaceRenderState | null;
  _loadProfilesFromManager(): void;
}

let savedPrefs = chatApp.getSavedPreferences();
const launchConfig = resolveBrowserLaunchConfig({
  search: params,
  savedUrl: savedPrefs?.url,
  envTargetUrl: browserEnv?.VITE_AGENTS_DEFAULT_TARGET_URL,
  envWsUrl: browserEnv?.VITE_AGENTS_DEFAULT_WS_URL,
});
const effectiveUrl = launchConfig.defaultTargetUrl;
chatApp.defaultUrl = effectiveUrl;

const currentHostHttpUrl = launchConfig.hostBridgeTargetUrl ?? "";
const hostClient = launchConfig.hostBridgeUrl
  ? new HostWSClient(launchConfig.hostBridgeUrl, {
      onA2uiMessage: (message) => {
        // Validate at the WS ingress so the tightened
        // `applyInbound(message: A2uiMessage)` contract holds. The host
        // still runs `validateA2uiMessage` internally for defense in
        // depth; this check only narrows the compile-time type.
        const result = validateA2uiMessage(message);
        if (!result.valid) {
          console.warn("[web-ui] Dropping invalid A2UI message from WS:", result.error.message);
          return;
        }
        a2uiBridge.applyInbound(result.value);
      },
    })
  : null;
// Make hostClient visible to the A2UI bridge sink defined above.
_hostClient = hostClient;

const hostView = chatApp as unknown as ChatAppHostState;
let pendingHashRestoreSessionId: string | null = null;
let pendingSavedRuntimeRestoreId: string | null = null;
let latestHostState: HostState = {};
let savedRuntimeApplied = false;

function syncHostBridgeForTarget(targetUrl: string | null | undefined): void {
  if (!hostClient) {
    return;
  }

  if (isHostBridgeActiveForTarget(targetUrl, currentHostHttpUrl)) {
    hostClient.connect();
    return;
  }

  hostClient.disconnect();
  pendingHashRestoreSessionId = null;
  pendingSavedRuntimeRestoreId = null;
  latestHostState = {};
  savedRuntimeApplied = false;
}

function applyHostState(): void {
  const controllerState = controller.getState();
  const activeHttpUrl = controllerState.targetInput?.url ?? currentHostHttpUrl;
  const showHostState =
    hostClient !== null && isHostBridgeActiveForTarget(activeHttpUrl, currentHostHttpUrl);
  const workflowSurface = showHostState ? (latestHostState.workflowSurface ?? null) : null;
  const displayedStatus = showHostState
    ? deriveDisplayedSessionStatus(controllerState.status ?? "idle", latestHostState.sessionStatus)
    : (controllerState.status ?? "idle");

  // Route the host-bridge transcript into the view. In host-bridge (AG-UI)
  // mode the prompt is issued via `POST /agent`, so the A2A client controller
  // never observes the turn and its derived transcript/pendingText stay empty;
  // the bridge becomes the source of truth. In A2A mode the controller-derived
  // transcript is preserved. See `host-view.ts` (unit-tested) — DOT-532.
  hostView._view = routeHostBridgeView(hostView._view, {
    showHostState,
    displayedStatus,
    transcript: latestHostState.transcript,
    pendingAgentText: latestHostState.pendingAgentText,
  });

  hostView._pendingPermission = (
    showHostState ? latestHostState.pendingPermission : null
  ) as PermissionRequestLike | null;
  hostView._pendingWriteGate = (
    showHostState ? latestHostState.pendingWriteGate : null
  ) as WriteGateLike | null;
  hostView._permissionMode = showHostState ? (latestHostState.permissionMode ?? "ask") : "ask";
  hostView._runtime = showHostState ? (latestHostState.runtime ?? null) : null;
  hostView._availableRuntimes = showHostState ? (latestHostState.availableRuntimes ?? []) : [];
  hostView._lastError = showHostState ? (latestHostState.lastError ?? "") : "";
  hostView._sessionTitle = workflowSurface?.transcript_surface.title ?? "";
  hostView._plan = workflowSurface?.plan_surface.entries ?? [];
  hostView._currentToolCalls =
    showHostState && latestHostState.currentTurn?.toolCalls
      ? latestHostState.currentTurn.toolCalls
      : [];
  hostView._runtimeSwitchState = showHostState ? latestHostState.runtimeSwitchState : null;
  hostView._workflowSurface = workflowSurface;
  hostView._runtimeNotice = deriveRuntimeNotice(showHostState, latestHostState.runtimeSwitchState);
  hostView.suppressProbeErrorDetails = showHostState;
}
if (hostClient) {
  hostClient.subscribe((hostState) => {
    savedPrefs = chatApp.getSavedPreferences();
    latestHostState = hostState;

    const savedRuntimeId = savedPrefs?.runtimeId;
    if (
      launchConfig.restoreSavedRuntime &&
      !savedRuntimeApplied &&
      savedRuntimeId &&
      hostState.availableRuntimes?.length
    ) {
      savedRuntimeApplied = true;
      const match = hostState.availableRuntimes.find((r) => r.id === savedRuntimeId);
      if (match && hostState.runtime?.id !== savedRuntimeId) {
        pendingSavedRuntimeRestoreId = savedRuntimeId;
        hostClient.setRuntime(savedRuntimeId, "saved_restore");
      } else {
        pendingSavedRuntimeRestoreId = null;
      }
    }

    applyHostState();

    if (shouldRepairSavedRuntimeRestore(hostState, pendingSavedRuntimeRestoreId)) {
      const repair = repairActiveSavedRuntimePreference({
        hostState,
        fallbackUrl: savedPrefs?.url ?? effectiveUrl,
      });
      if (repair.repaired) {
        hostView._loadProfilesFromManager();
        savedPrefs = repair.savedPreferences ?? chatApp.getSavedPreferences();
      }
      pendingSavedRuntimeRestoreId = null;
    } else if (
      pendingSavedRuntimeRestoreId &&
      hostState.runtimeSwitchState?.origin === "saved_restore" &&
      hostState.runtimeSwitchState?.requestedRuntimeId === pendingSavedRuntimeRestoreId &&
      hostState.runtimeSwitchState.status !== "switching"
    ) {
      pendingSavedRuntimeRestoreId = null;
    }

    if (shouldClearStaleSessionHash(hostState, pendingHashRestoreSessionId)) {
      clearSessionHash();
    }

    // Sync session ID to URL hash for persistence across refreshes
    if (hostState.sessionId) {
      setSessionIdInHash(hostState.sessionId);
      pendingHashRestoreSessionId = null;
    }
  });
}

controller.subscribe((event, state) => {
  syncHostBridgeForTarget(state.targetInput?.url ?? effectiveUrl);
  applyHostState();
  if (event.type !== "target.resolved") {
    return;
  }

  const resolvedUrl = state.targetInput?.url ?? currentHostHttpUrl;
  if (!hostClient || !isHostBridgeActiveForTarget(resolvedUrl, currentHostHttpUrl)) {
    return;
  }

  const savedSessionId = getSessionIdFromHash();
  if (savedSessionId) {
    pendingHashRestoreSessionId = savedSessionId;
    hostClient.loadSession(savedSessionId);
  } else {
    pendingHashRestoreSessionId = null;
    hostClient.ensureSession();
  }
});

syncHostBridgeForTarget(effectiveUrl);
applyHostState();

chatApp.addEventListener("acp-permission-resolved", (e: Event) => {
  const detail = (e as CustomEvent<PermissionModalDetail>).detail;
  hostClient?.resolvePermission(createPermissionResolution(detail));
});

chatApp.addEventListener("acp-elicitation-response", (e: Event) => {
  const detail = (e as CustomEvent<{ action: string; content?: Record<string, unknown> }>).detail;
  hostClient?.resolveElicitation(detail);
});

chatApp.addEventListener("acp-write-gate-resolved", (e: Event) => {
  const detail = (e as CustomEvent<{ action: string; folder?: string }>).detail;
  hostClient?.resolveWriteGate(detail);
});

chatApp.addEventListener("acp-permission-mode-changed", (e: Event) => {
  const detail = (e as CustomEvent<{ mode: string }>).detail;
  hostClient?.setPermissionMode(detail.mode);
});

chatApp.addEventListener("acp-runtime-change", (e: Event) => {
  const detail = (e as CustomEvent<{ runtimeId: string }>).detail;
  pendingSavedRuntimeRestoreId = null;
  hostClient?.setRuntime(detail.runtimeId, "manual");
});

chatApp.addEventListener("acp-cancel", () => {
  hostClient?.cancel();
});

chatApp.addEventListener("acp-disconnect", () => {
  console.log("[web-ui] Disconnect: clearing host state");
  clearSessionHash();
  pendingHashRestoreSessionId = null;
  pendingSavedRuntimeRestoreId = null;
  latestHostState = {};
  savedRuntimeApplied = false;
  hostClient?.disconnect();
  hostView._runtimeNotice = "";
});

chatApp.addEventListener("acp-save-preferences", (e: Event) => {
  const detail = (
    e as CustomEvent<{
      url: string;
      runtimeId: string;
      profileId?: string;
      profileName?: string;
      saveMode?: "update" | "create";
    }>
  ).detail;
  console.log(
    `[web-ui] Preferences saved: profile=${detail.profileName ?? detail.profileId ?? "default"}, url=${detail.url}, runtime=${detail.runtimeId}, mode=${detail.saveMode ?? "update"}`,
  );
  savedPrefs = chatApp.getSavedPreferences();
});
