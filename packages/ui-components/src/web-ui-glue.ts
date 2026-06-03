/**
 * Web-UI glue layer.
 *
 * Re-exports the helpers and the WebSocket client used by reference web
 * shells (see `apps/web-ui`) to drive the chat components against a
 * gateway WS bridge. These live here -- not in the app -- because they
 * test component-level glue (permission resolution, runtime notice
 * derivation, host-state mapping) and need to ship and version with the
 * components themselves.
 */

export { normalizeHostBridgeUrl } from "./host-bridge-url.ts";
export {
  isHostBridgeActiveForTarget,
  resolveBrowserLaunchConfig,
} from "./launch-config.ts";
export {
  createPermissionResolution,
  type PermissionModalDetail,
} from "./permission-resolution.ts";
export { deriveRuntimeNotice } from "./runtime-notice.ts";
export {
  repairActiveSavedRuntimePreference,
  shouldRepairSavedRuntimeRestore,
} from "./saved-runtime-restore.ts";
export { shouldClearStaleSessionHash } from "./session-restore.ts";
export { deriveDisplayedSessionStatus } from "./status-bridge.ts";
export {
  type ElicitationResolution,
  type HostState,
  type HostStateListener,
  HostWSClient,
  type PendingElicitationInfo,
  type PendingPermissionInfo,
  type PendingWriteGateInfo,
  type PermissionOptionInfo,
  type PermissionResolution,
  type RuntimeInfo,
  type RuntimeSwitchOrigin,
  type RuntimeSwitchState,
  type WriteGateResolution,
} from "./ws-client.ts";
export {
  mapPendingElicitation,
  mapPermissionRequest,
  mapSnapshot,
} from "./ws-state-mapper.ts";
