# @agents-js/ui-components

> Lit web components for ACP-aware chat interfaces. Drop-in surface with streaming, permissions, elicitation, auth, and theming.

## Installation

```sh
bun add @agents-js/ui-components
```

## API

<!-- Auto-generated from JSDoc -->

### Classes

- **`AcpModelSelector`**
- **`AcpCheckbox`**
- **`ChatAppProfileManager`**
- **`AcpChoicePicker`**
- **`AcpStatusBar`**
- **`AcpPermissionModeSelector`**
- **`AcpRow`**
- **`AcpImage`**
- **`AcpPlanPanel`**
- **`AcpButton`**
- **`AcpIcon`**
- **`AcpElicitationForm`**
- **`AcpWriteGateModal`**
- **`AcpSlider`**
- **`AcpPromptInput`**
- **`AcpPermissionModal`**
- **`AcpCodeBlock`**
- **`AcpStreamingText`**
- **`HostWSClient`**
- **`AcpDateTimeInput`**
- **`AcpDebugPanel`**
- **`PromptHistoryStore`**
- **`AcpOverlayStack`**

### Functions

- **`mapPermissionRequest`** — Map a raw RequestPermissionRequest object into the minimal PendingPermissionInfo shape expected by the UI components.
- **`mapPendingElicitation`** — Map a raw `PendingElicitation` (as serialized by the gateway) into the display-only `PendingElicitationInfo` used by the browser. The gateway's JSON serializer strips the `resolve` function, so the...
- **`mapModels`**
- **`mapRuntimeSwitchState`**
- **`mapSnapshot`** — Extract host-relevant fields from a full ACPSessionState snapshot. The snapshot arrives as the serialized ACPSessionState. The pending permission lives at `currentTurn.pendingPermission.request` wh...
- **`normalizeHostBridgeUrl`**
- **`shouldRepairSavedRuntimeRestore`**
- **`repairActiveSavedRuntimePreference`**
- **`loadConnectProfiles`**
- **`loadConnectPreferences`** — Load previously saved connection preferences. Returns the active profile's preferences, or `null` if nothing valid was saved.
- **`saveConnectPreferences`** — Save connection preferences into a named profile. If `profileId` is omitted, a new profile is created unless the store is empty, in which case the default profile ID is used.
- **`setActiveConnectProfile`**
- **`deleteConnectProfile`**
- **`clearConnectPreferences`** — Clear stored connection preferences and profiles.
- **`isKnownModelId`**
- **`deriveFallbackModelId`**
- **`reconcileModelSelection`**
- **`createPermissionResolution`**
- **`registerIconSet`** — Register an external icon set. Icons from this registry take priority over the built-in set and previously registered sets.
- **`clearIconRegistries`** — Clear all registered external icon sets, leaving only the built-in icons.
- **`safeCustomElement`** — Idempotent variant of Lit's `` decorator. Usage is identical to the Lit decorator: import { safeCustomElement } from "./safe-custom-element.ts"; \("acp-button") export class AcpButton extends LitEl...
- **`shouldClearStaleSessionHash`**
- **`isHostBridgeActiveForTarget`**
- **`resolveBrowserLaunchConfig`**
- **`deriveSessionState`** — Derive flat component properties from an incoming SessionStateLike. This is a pure function with no side effects — the caller is responsible for applying the result to Lit reactive properties with ...
- **`sessionViewStateChanged`** — Shallow-compare two `SessionViewState` objects. Returns `true` when at least one top-level value differs (meaning the component should re-render).
- **`createLocalStoragePromptHistoryPersistence`**

### Interfaces

- **`TranscriptEntryLike`** — Minimal shape matching TranscriptEntry from -js/a2a-client.
- **`AgentCardLike`** — Unified agent card shape — covers preview, snapshot, and view uses.
- **`RuntimeInfoLike`**
- **`ModelInfoLike`**
- **`SessionModelsLike`**
- **`TargetInspectionLike`**
- **`SessionStateLike`** — Unified session state shape — covers snapshot and view uses.
- **`PermissionRequestLike`** — Minimal shape for permission requests from acp-host.
- **`WriteGateLike`** — Minimal shape for write gate pending state.
- **`RuntimeModelLike`** — Model info from the runtime CLI (available before session creation).
- **`DebugRecordLike`** — Debug record shape — mirrors DebugRecord from a2a-client types.
- **`PlanEntryLike`** — Plan entry shape matching PlanEntryInfo from acp-host session state.
- **`ProfileManagerCallbacks`**
- **`ProfileManagerState`**
- **`AcpChoiceOption`**
- **`ConnectPreferences`**
- **`ConnectProfile`**
- **`ConnectProfilesState`**
- **`SaveConnectPreferencesOptions`**
- **`PermissionOptionInfo`** — Permission option shape matching /sdk PermissionOption.
- **`PendingPermissionInfo`** — Minimal permission request shape for display purposes.
- **`PendingWriteGateInfo`** — Minimal write-gate shape for display purposes.
- **`PendingElicitationInfo`** — Minimal elicitation request shape for display purposes. Mirrors the non-function fields of `PendingElicitation` on the host side (see `packages/acp-host/src/types/session.ts`). The gateway's JSON s...
- **`RuntimeInfo`**
- **`ModelInfo`**
- **`SessionModelsInfo`**
- **`RuntimeModelInfo`**
- **`RuntimeSwitchState`**
- **`HostTurnSummary`**
- **`HostState`** — Flat state object pushed to subscribers on every relevant event.
- **`PermissionResolution`**
- **`WriteGateResolution`**
- **`ElicitationResolution`**
- **`WorkflowActivityEntryState`**
- **`WorkflowSurfacePlanState`**
- **`WorkflowSurfaceActivityState`**
- **`WorkflowSurfaceInterruptActionState`**
- **`WorkflowSurfaceInterruptState`**
- **`WorkflowSurfaceComposerState`**
- **`WorkflowSurfaceTranscriptState`**
- **`WorkflowSurfaceContext`**
- **`WorkflowSurfaceRenderState`**
- **`BrowserLaunchConfig`**
- **`ResolveBrowserLaunchConfigOptions`**
- **`ChatAppDerivedState`**
- **`HostWSClientOptions`** — Optional behaviour hooks for {HostWSClient}. All fields are optional so existing `new HostWSClient(url)` call sites keep working unchanged. Omitting a hook leaves the corresponding surface inert.
- **`PromptHistoryPersistence`** — A framework-agnostic prompt history store that provides up-arrow input recall. Extracted from an earlier host prompt-history state machine and generalized here. No DOM or Lit dependencies — pure Ty...
- **`PromptHistoryStoreOptions`**
- **`HistoryNavResult`**

### Types

- **`PermissionModalDetail`**
- **`RuntimeSwitchOrigin`**
- **`WSServerMessage`** — Server-to-client messages sent by the ws-bridge.
- **`HostStateListener`**
- **`WorkflowSurfaceSeverity`**
- **`WorkflowSurfaceComposerMode`**
- **`WorkflowSurfaceActivityPhase`**
- **`WorkflowActivityKind`**
- **`WorkflowActivityStatus`**
- **`WorkflowSurfaceInterruptKind`**
- **`IconRegistry`** — Icon registry type: a record mapping icon names to SVG path data strings.
- **`SessionViewState`** — SessionViewState groups the derived state fields that drive the main chat view rendering. The component stores this as a single `()` property with a custom `hasChanged` guard instead of 17+ individ...

### Constants

- **`acpInputStyles`** — Shared CSS for input and label elements used across form components. Provides consistent styling for `<label>`, `<input>`, `<textarea>`, and `<select>` elements including focus, disabled, and error...
- **`acpTheme`** — Shared Tokyo Night theme as CSS custom properties. Each property uses a double-var pattern: the component references `var(--acp-bg, #0f1117)` as the compiled default, but hosts can set `--acp-bg` o...
- **`DEFAULT_PERMISSION_MODE_LABELS`** — Default label copy for each mode. Consumers can override any subset via the `labels` property; missing keys fall back to these values.

### Exports

- **`deriveRuntimeNotice`**
- **`deriveDisplayedSessionStatus`**
- **`AcpAuthSelector`**
- **`AcpChatApp`**
- **`type AcpChoiceOption`**
- **`AcpColumn`**
- **`AcpConnectDialog`**
- **`AcpDivider`**
- **`AcpMessage`**
- **`AcpModal`**
- **`AcpTextField`**
- **`AcpTranscript`**
- **`statusCategory`**
- **`registerAllComponents`**


## Dependencies

- `@agents-js/a2ui-types`
- `@agents-js/acp-host`
- `@agents-js/schema-utils`

### Peer Dependencies

- `lit`

## License

MIT

<!-- AUTO-GENERATED by scripts/generate-package-readmes.ts — do not edit -->
