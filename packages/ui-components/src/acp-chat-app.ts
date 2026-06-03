import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { ChatAppProfileManager, type ProfileManagerState } from "./acp-chat-app-profiles.ts";
import {
  deriveSessionState,
  type SessionViewState,
  sessionViewStateChanged,
} from "./acp-chat-app-state.ts";
import { acpTheme } from "./acp-theme.ts";
import type {
  AgentCardLike,
  RuntimeInfoLike,
  SessionStateLike,
  TranscriptEntryLike,
  TranscriptToolCallEntryPayload,
} from "./acp-types.ts";
import type { ConnectPreferences, ConnectProfile } from "./connect-preferences-store.ts";
import {
  createLocalStoragePromptHistoryPersistence,
  PromptHistoryStore,
} from "./prompt-history-store.ts";
import { safeCustomElement } from "./safe-custom-element.ts";
import type { WorkflowSurfaceRenderState } from "./workflow-surface.ts";

import "./acp-connect-dialog.ts";
import "./acp-status-bar.ts";
import "./acp-transcript.ts";
import "./acp-prompt-input.ts";
import "./acp-debug-panel.ts";
import "./acp-permission-mode-selector.ts";
import "./acp-plan-panel.ts";
import "./acp-overlay-stack.ts";

function asController(ref: unknown): {
  subscribe: (listener: (event: unknown, state: unknown) => void) => () => void;
  getState: () => unknown;
  setTargetInput: (input: { url: string; headers?: Record<string, string>; mode?: string }) => void;
  clearTargetInput: () => void;
  connect: (input: { url: string }) => Promise<{ card: AgentCardLike }>;
  sendTurn: (text: string) => Promise<unknown>;
  respondToElicitation: (response: {
    action: string;
    content?: Record<string, unknown>;
  }) => Promise<void>;
  respondToAuthRequired: (methodId: string) => Promise<void>;
  resetSession?: () => void;
} {
  const obj = ref as Record<string, unknown>;
  const required = [
    "subscribe",
    "getState",
    "setTargetInput",
    "clearTargetInput",
    "connect",
    "sendTurn",
  ] as const;
  const missing = required.filter((m) => !obj || typeof obj[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`<acp-chat-app> controller missing required methods: ${missing.join(", ")}`);
  }
  return ref as ReturnType<typeof asController>;
}

/**
 * Top-level chat-app composite.
 *
 * ## Theming
 *
 * Composite-class component: primary mechanism is named `<slot>`
 * replacement (P4) so hosts can swap whole sections. P1 tokens handle
 * the chrome around host-provided slots.
 *
 * Tokens (default to pre-tokenization hardcoded values and the global
 * `--acp-*` palette):
 * - `--acp-chat-app-bg`, `--acp-chat-app-color`
 * - `--acp-session-toolbar-bg`, `--acp-session-toolbar-border`,
 *   `--acp-session-toolbar-padding`, `--acp-session-toolbar-gap`
 *
 * Slots (every slot has default content — hosts that don't slot
 * anything keep the current composition):
 * - `slot="status-bar"` — replaces the default `<acp-status-bar>`.
 * - `slot="transcript"` — replaces the default `<acp-transcript>`.
 * - `slot="prompt-input"` — replaces the default `<acp-prompt-input>`.
 * - `slot="overlays"` — replaces the default `<acp-overlay-stack>`.
 * - `slot="header"` — appended above the default chat layout (empty
 *   by default — use this for host banners).
 * - `slot="footer"` — appended below the default chat layout (empty
 *   by default — use this for host footers).
 */
@safeCustomElement("acp-chat-app")
export class AcpChatApp extends LitElement {
  @property({ attribute: false })
  accessor controller: unknown = null;

  @property({ type: String })
  accessor defaultUrl = "";

  /**
   * Integrated launcher flows already provide a paired target and bridge.
   * Keep the connect dialog copy neutral there instead of surfacing browser
   * transport internals like "Failed to fetch".
   */
  suppressProbeErrorDetails = false;

  /* ------------------------------------------------------------------ */
  /*  Grouped derived state (replaces 17 individual @state() properties) */
  /* ------------------------------------------------------------------ */

  /** Derived view state from the controller's SessionStateLike snapshot. */
  @state({ hasChanged: sessionViewStateChanged })
  accessor _view: SessionViewState = {
    status: "idle",
    sessionId: "",
    transcript: [],
    pendingText: "",
    activeElicitation: null,
    activeAuth: null,
    inputDisabled: true,
    pendingPermission: null,
    pendingWriteGate: null,
    permissionMode: "default",
    sessionState: {},
    connected: false,
    agentCard: null,
    agentName: "",
    sessionTitle: "",
    plan: [],
    lastError: "",
  };

  /* ------------------------------------------------------------------ */
  /*  Non-derived state (NOT part of SessionViewState)                   */
  /* ------------------------------------------------------------------ */

  @state()
  accessor _connectError = "";

  @state()
  accessor _runtime: RuntimeInfoLike | null = null;

  @state()
  accessor _availableRuntimes: RuntimeInfoLike[] = [];

  @state()
  accessor _runtimeNotice = "";

  @state()
  accessor _workflowSurface: WorkflowSurfaceRenderState | null = null;

  /**
   * Active-turn tool calls forwarded from the WS bridge's
   * `HostState.currentTurn.toolCalls`. Rendered inline in the
   * transcript via `<acp-tool-call-detail>` (composed inside
   * `<acp-transcript>`) so users see ACP tool-call activity —
   * locations, raw I/O, diffs — alongside the conversation.
   *
   * Active-turn only: completed-turn tool calls live in the host's
   * `completedTurns[].toolCalls` and would need timestamp ordering
   * to interleave correctly with the message log; that's a separate
   * follow-up.
   */
  @state()
  accessor _currentToolCalls: TranscriptToolCallEntryPayload[] = [];

  @state()
  accessor _connecting = false;

  @state()
  accessor _hasSavedPreferences = false;

  @state()
  accessor _savedPreferences: ConnectPreferences | null = null;

  @state()
  accessor _profiles: ConnectProfile[] = [];

  @state()
  accessor _activeProfileId = "";

  @state()
  accessor _profileDraftName = "Default profile";

  private _historyStore = new PromptHistoryStore({
    persistence: createLocalStoragePromptHistoryPersistence(),
  });

  private _profileManager = new ChatAppProfileManager({
    getController: () => this.controller,
    isConnected: () => this._view.connected,
    setDefaultUrl: (url) => {
      this.defaultUrl = url;
    },
    setControllerTargetInput: (input) => asController(this.controller).setTargetInput(input),
    dispatchEvent: (event) => this.dispatchEvent(event),
  });

  private _unsubscribe: (() => void) | null = null;
  private _defaultTargetSyncQueued = false;
  private _subscriptionRefreshQueued = false;

  private get _isInflight(): boolean {
    const s = this._view.status;
    return s === "sending" || s === "waiting";
  }

  /**
   * Build the unified transcript array fed to `<acp-transcript>`. Merges
   * the controller's text-message stream with the WS-bridge `HostState`'s
   * active-turn tool calls so they render inline via
   * `<acp-tool-call-detail>` (composed inside the transcript component).
   *
   * Active tool calls are appended after the existing message stream —
   * during a turn they always belong at the end (between the user's last
   * message and any in-flight agent text), so positional ordering matches
   * temporal arrival without needing per-entry timestamps.
   *
   * Memoized on both input references so streaming `pendingText` re-renders
   * (which bypass both inputs) don't trigger O(n) transcript re-copies and
   * don't churn `<acp-transcript>`'s downstream change detection.
   */
  private _renderedTranscriptCache: {
    transcript: unknown;
    toolCalls: unknown;
    merged: TranscriptEntryLike[];
  } | null = null;

  private get _renderedTranscript(): TranscriptEntryLike[] {
    const messages = this._view.transcript as TranscriptEntryLike[];
    if (this._currentToolCalls.length === 0) return messages;

    const cache = this._renderedTranscriptCache;
    if (
      cache &&
      cache.transcript === this._view.transcript &&
      cache.toolCalls === this._currentToolCalls
    ) {
      return cache.merged;
    }

    const toolEntries: TranscriptEntryLike[] = this._currentToolCalls.map((toolCall) => ({
      id: `tool:${toolCall.toolCallId}`,
      kind: "tool_call",
      toolCall,
    }));
    const merged = [...messages, ...toolEntries];
    this._renderedTranscriptCache = {
      transcript: this._view.transcript,
      toolCalls: this._currentToolCalls,
      merged,
    };
    return merged;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this._loadProfilesFromManager();
    void this._historyStore.init();
    this._setupSubscription();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._teardownSubscription();
  }

  protected override updated(changed: Map<string | number | symbol, unknown>): void {
    if (changed.has("controller")) {
      this._queueSubscriptionRefresh();
    }

    if ((changed.has("controller") || changed.has("defaultUrl")) && !this._view.connected) {
      this._queueDefaultTargetInputSync();
    }
  }

  private _setupSubscription(): void {
    if (!this.controller) return;

    const ctrl = asController(this.controller);
    this._unsubscribe = ctrl.subscribe((event: { type: string } | unknown, state: unknown) => {
      if ((event as { type?: string })?.type === "session.updated") {
        this._applyState(state as SessionStateLike);
      }
    });

    const initial = ctrl.getState();
    if (initial) {
      this._applyState(initial as SessionStateLike);
    }
  }

  private _teardownSubscription(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  private _syncDefaultTargetInput(): void {
    if (!this.controller) return;

    const ctrl = asController(this.controller);
    const url = this.defaultUrl.trim();
    if (!url) {
      ctrl.clearTargetInput();
      return;
    }

    ctrl.setTargetInput({ url });
  }

  private _queueDefaultTargetInputSync(): void {
    if (this._defaultTargetSyncQueued) {
      return;
    }

    this._defaultTargetSyncQueued = true;
    queueMicrotask(() => {
      this._defaultTargetSyncQueued = false;
      if (!this.isConnected || this._view.connected) {
        return;
      }
      this._syncDefaultTargetInput();
    });
  }

  private _queueSubscriptionRefresh(): void {
    if (this._subscriptionRefreshQueued) {
      return;
    }

    this._subscriptionRefreshQueued = true;
    queueMicrotask(() => {
      this._subscriptionRefreshQueued = false;
      if (!this.isConnected) {
        return;
      }
      this._teardownSubscription();
      this._setupSubscription();
    });
  }

  private _applyState(state: SessionStateLike): void {
    const next = deriveSessionState(state);
    if (this._view.lastError && !next.lastError && this._connectError) {
      this._connectError = "";
    }

    // The custom `hasChanged` on `_view` does a shallow-equal comparison,
    // so Lit will skip re-renders when nothing actually changed.
    this._view = next;
  }

  private async _handleConnect(e: Event): Promise<void> {
    const detail = (e as CustomEvent<{ url: string }>).detail;
    if (!this.controller) return;

    const ctrl = asController(this.controller);
    this._connectError = "";
    this._connecting = true;
    try {
      const target = await ctrl.connect({ url: detail.url });
      this._view = {
        ...this._view,
        connected: true,
        agentName: target.card.name ?? "",
        agentCard: target.card,
      };
      this._runtimeNotice = "";
    } catch (err) {
      this._connectError = err instanceof Error ? err.message : "Connection failed";
    } finally {
      this._connecting = false;
    }
  }

  private _handleRetry(): void {
    // Call controller first (may trigger re-entrant _applyState),
    // then set local state to ensure our values win.
    if (this.controller) {
      asController(this.controller).resetSession?.();
    }
    this._connectError = "";
    this._view = {
      ...this._view,
      lastError: "",
      transcript: [],
      status: "connected",
    };
  }

  private _handleTargetUrlChange(e: Event): void {
    if (!this.controller) return;

    const detail = (e as CustomEvent<{ url: string }>).detail;
    const ctrl = asController(this.controller);
    const url = detail.url.trim();
    if (!url) {
      ctrl.clearTargetInput();
      return;
    }

    ctrl.setTargetInput({ url });
  }

  private _targetStatusMessage(): string {
    const inspection = this._view.sessionState.targetInspection;
    switch (inspection?.status) {
      case "probing":
        return "Checking agent card...";
      case "unreachable":
        if (this.suppressProbeErrorDetails) {
          return "Unable to reach the agent card. Check the gateway URL and that the local gateway is running.";
        }
        return inspection.error
          ? `Waiting for agent card... (${inspection.error})`
          : "Waiting for agent card...";
      default:
        return "";
    }
  }

  private async _handleSend(e: Event): Promise<void> {
    const detail = (e as CustomEvent<{ text: string }>).detail;
    if (!this.controller) return;
    this._connectError = "";
    this._view = { ...this._view, lastError: "" };
    try {
      await asController(this.controller).sendTurn(detail.text);
    } catch (err) {
      this._connectError = err instanceof Error ? err.message : "Send failed";
    }
  }

  private _handleCancel(e: Event): void {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent("acp-cancel", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async _handleElicitationResponse(e: Event): Promise<void> {
    const detail = (e as CustomEvent<{ action: string; content?: Record<string, unknown> }>).detail;
    if (!this.controller) return;
    try {
      await asController(this.controller).respondToElicitation(detail);
    } catch (err) {
      this._connectError = err instanceof Error ? err.message : "Elicitation response failed";
    }
  }

  private async _handleAuthSelected(e: Event): Promise<void> {
    const detail = (e as CustomEvent<{ methodId: string }>).detail;
    if (!this.controller) return;
    try {
      await asController(this.controller).respondToAuthRequired(detail.methodId);
    } catch (err) {
      this._connectError = err instanceof Error ? err.message : "Auth selection failed";
    }
  }

  private _handlePermissionResponse = this._relayEvent("acp-permission-resolved");
  private _handleWriteGateResponse = this._relayEvent("acp-write-gate-resolved");
  private _handlePermissionModeChange = this._relayEvent("acp-permission-mode-changed");

  private _relayEvent(eventName: string) {
    return (e: Event) => {
      this.dispatchEvent(
        new CustomEvent(eventName, {
          bubbles: true,
          composed: true,
          detail: (e as CustomEvent).detail,
        }),
      );
    };
  }

  private _handleSettings(): void {
    this._view = { ...this._view, connected: false };
  }

  private _handleDisconnect(): void {
    // Call controller methods FIRST. These trigger synchronous _applyState
    // via the subscription, which may re-entrantly set _connected = true
    // (because resetSession preserves the target). Setting local state AFTER
    // ensures our values win. Lit batches all synchronous property changes
    // into a single render cycle with the final values.
    if (this.controller) {
      const ctrl = asController(this.controller);
      ctrl.resetSession?.();
      ctrl.clearTargetInput();
    }

    this._view = {
      ...this._view,
      connected: false,
      sessionId: "",
      transcript: [],
      status: "idle",
      lastError: "",
    };
    this._connectError = "";
    this._runtimeNotice = "";

    this.dispatchEvent(
      new CustomEvent("acp-disconnect", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleRuntimeChange = this._relayEvent("acp-runtime-change");

  private _loadProfilesFromManager(): void {
    const result = this._profileManager.load();
    this._applyProfileManagerState(result.state);
  }

  getSavedPreferences(): ConnectPreferences | null {
    return this._profileManager.getSavedPreferences();
  }

  private _handleSavePreferences(e: Event): void {
    const detail = (
      e as CustomEvent<{
        url: string;
        runtimeId: string;
        profileId?: string;
        profileName?: string;
        harnessId?: string;
        saveMode?: "update" | "create";
      }>
    ).detail;

    const result = this._profileManager.handleSave(detail);
    this._applyProfileManagerState(result.state);
  }

  private _handleProfileSelected(e: Event): void {
    const detail = (e as CustomEvent<{ profileId: string }>).detail;
    const result = this._profileManager.handleSelect(detail.profileId);
    this._applyProfileManagerState(result.state);
  }

  private _handleProfileDeleted(e: Event): void {
    const detail = (e as CustomEvent<{ profileId: string }>).detail;
    const result = this._profileManager.handleDelete(detail.profileId);
    this._applyProfileManagerState(result.state);
  }

  private _handleProfileNameChange(e: Event): void {
    const detail = (e as CustomEvent<{ name: string }>).detail;
    this._profileManager.handleNameChange(detail.name);
    this._profileDraftName = detail.name;
  }

  private _applyProfileManagerState(pmState: ProfileManagerState): void {
    this._profiles = pmState.profiles;
    this._activeProfileId = pmState.activeProfileId;
    this._hasSavedPreferences = pmState.hasSavedPreferences;
    this._savedPreferences = pmState.savedPreferences;
    this._profileDraftName = pmState.profileDraftName;
  }

  private _promptPlaceholder(): string {
    const toolTitle = this._view.pendingPermission?.toolCall?.title?.trim();
    if (toolTitle) {
      const label = toolTitle
        .replace(/^workspace[._-]/i, "")
        .replace(/[._-]+/g, " ")
        .trim();
      const normalizedLabel = label ? label.charAt(0).toUpperCase() + label.slice(1) : "Continue";
      return `${normalizedLabel}...`;
    }

    if (this._view.activeElicitation) {
      return "Respond to the current request...";
    }

    if (this._view.activeAuth) {
      return "Describe what you need to continue...";
    }

    return "Type a message...";
  }

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Defaults preserve pre-tokenization
         * visuals. Hosts can override to retheme the composite's chrome
         * without reaching into slotted content. */
        --acp-chat-app-bg: var(--acp-bg);
        --acp-chat-app-color: var(--acp-text);
        --acp-session-toolbar-bg: var(--acp-bg-secondary);
        --acp-session-toolbar-border: var(--acp-border);
        --acp-session-toolbar-padding: 8px 16px;
        --acp-session-toolbar-gap: 12px;

        display: flex;
        flex-direction: column;
        height: 100%;
        background: var(--acp-chat-app-bg);
        color: var(--acp-chat-app-color);
      }

      .connect-wrapper {
        display: flex;
        align-items: center;
        justify-content: center;
        flex: 1;
        padding: 20px;
      }

      .chat-area {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }

      .session-toolbar {
        display: flex;
        align-items: center;
        gap: var(--acp-session-toolbar-gap);
        padding: var(--acp-session-toolbar-padding);
        background: var(--acp-session-toolbar-bg);
        border-bottom: 1px solid var(--acp-session-toolbar-border);
        flex-wrap: wrap;
      }

      .runtime-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 9999px;
        border: 1px solid color-mix(in srgb, var(--acp-accent) 24%, var(--acp-border));
        background: color-mix(in srgb, var(--acp-accent) 8%, var(--acp-bg));
        font-size: 12px;
      }

      .runtime-chip__label {
        color: var(--acp-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-size: 11px;
      }

      .runtime-chip__value {
        color: var(--acp-text);
        font-weight: 500;
      }

      .settings-btn {
        margin-left: auto;
        padding: 4px 10px;
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        background: transparent;
        color: var(--acp-text-muted);
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
        transition: color 0.15s, border-color 0.15s, background 0.15s;
        white-space: nowrap;
      }

      .settings-btn:hover {
        color: var(--acp-text);
        border-color: var(--acp-accent);
        background: color-mix(in srgb, var(--acp-accent) 8%, transparent);
      }

      acp-transcript {
        flex: 1;
        min-height: 0;
      }

      acp-debug-panel {
        margin: 8px;
        flex-shrink: 0;
      }

      .error-banner {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 16px;
        background: color-mix(in srgb, var(--acp-error) 10%, var(--acp-bg));
        border-bottom: 1px solid color-mix(in srgb, var(--acp-error) 30%, var(--acp-border));
        color: var(--acp-error);
        font-size: 13px;
      }

      .error-dismiss-btn {
        margin-left: auto;
        padding: 2px 10px;
        border: 1px solid var(--acp-error);
        border-radius: 4px;
        background: transparent;
        color: var(--acp-error);
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
        white-space: nowrap;
      }

      .error-dismiss-btn:hover {
        background: color-mix(in srgb, var(--acp-error) 15%, transparent);
      }
    `,
  ];

  protected override render() {
    const debugState: SessionStateLike = {
      ...this._view.sessionState,
      runtime: this._runtime,
    };

    return html`
      <slot name="header"></slot>
      ${this._renderErrorBanner()}
      ${this._view.connected ? this._renderChatLayout() : this._renderConnectDialog()}
      <acp-debug-panel .state=${debugState} .agentCard=${this._view.agentCard}></acp-debug-panel>
      <slot name="footer"></slot>
    `;
  }

  private _renderErrorBanner() {
    if (!this._connectError) return nothing;
    return html`<div class="error-banner">
      ${this._connectError}
      ${
        this._view.sessionId
          ? html`<button class="error-dismiss-btn" @click=${this._handleRetry}>Dismiss</button>`
          : nothing
      }
    </div>`;
  }

  private _renderChatLayout() {
    const v = this._view;
    return html`
      <div class="chat-area">
        <slot name="status-bar">
          <acp-status-bar
            .agentName=${v.agentName}
            .profileName=${this._activeProfileId ? this._profileDraftName : ""}
            .status=${v.status}
            .sessionId=${v.sessionId}
            .sessionTitle=${v.sessionTitle}
          ></acp-status-bar>
        </slot>

        <div class="session-toolbar">
          ${
            this._runtime
              ? html`<div class="runtime-chip">
                <span class="runtime-chip__label">Runtime</span>
                <span class="runtime-chip__value">${this._runtime.displayName} (${this._runtime.id})</span>
              </div>`
              : nothing
          }
          <button class="settings-btn" @click=${this._handleSettings} title="Connection settings">Settings</button>
        </div>

        <acp-permission-mode-selector
          .mode=${v.permissionMode}
          @acp-permission-mode-change=${this._handlePermissionModeChange}
        ></acp-permission-mode-selector>

        <acp-plan-panel .plan=${v.plan} .workflowSurface=${this._workflowSurface}></acp-plan-panel>

        <slot name="transcript">
          <acp-transcript
            .transcript=${this._renderedTranscript}
            .pendingText=${v.pendingText}
            .status=${v.status}
            .lastError=${v.lastError}
            @acp-retry=${this._handleRetry}
          ></acp-transcript>
        </slot>

        <slot name="overlays">
          <acp-overlay-stack
            .activeElicitation=${v.activeElicitation}
            .activeAuth=${v.activeAuth}
            .pendingPermission=${v.pendingPermission}
            .pendingWriteGate=${v.pendingWriteGate}
            @acp-elicitation-response=${this._handleElicitationResponse}
            @acp-auth-selected=${this._handleAuthSelected}
            @acp-permission-response=${this._handlePermissionResponse}
            @acp-write-gate-response=${this._handleWriteGateResponse}
          ></acp-overlay-stack>
        </slot>

        <slot name="prompt-input">
          <acp-prompt-input
            ?disabled=${this._workflowSurface?.composer_surface.disabled ?? v.inputDisabled}
            ?inflight=${this._isInflight}
            .history=${this._historyStore}
            .placeholder=${this._workflowSurface?.composer_surface.placeholderText ?? this._promptPlaceholder()}
            .helperText=${this._workflowSurface?.composer_surface.helperText ?? ""}
            @acp-send=${this._handleSend}
            @acp-cancel=${this._handleCancel}
          ></acp-prompt-input>
        </slot>
      </div>
    `;
  }

  private _renderConnectDialog() {
    const targetInspection = this._view.sessionState.targetInspection;
    const targetUrl = this._view.sessionState.targetInput?.url ?? this.defaultUrl;
    const connectLoading = targetInspection?.status === "probing";
    const connectDisabled =
      this._view.status === "connecting" || targetInspection?.status !== "ready";

    return html`
      <div class="connect-wrapper">
        <acp-connect-dialog
          .connected=${this._view.connected}
          .connecting=${this._connecting}
          .defaultUrl=${this.defaultUrl}
          .url=${targetUrl}
          .status=${targetInspection?.status ?? "idle"}
          .statusMessage=${this._targetStatusMessage()}
          .connectDisabled=${connectDisabled}
          .connectLoading=${connectLoading}
          .runtime=${this._runtime}
          .preview=${targetInspection?.card ?? null}
          .availableRuntimes=${this._availableRuntimes}
          .hasSavedPreferences=${this._hasSavedPreferences}
          .profiles=${this._profiles}
          .activeProfileId=${this._activeProfileId}
          .profileName=${this._profileDraftName}
          .runtimeNotice=${this._runtimeNotice}
          @acp-url-change=${this._handleTargetUrlChange}
          @acp-connect=${this._handleConnect}
          @acp-disconnect=${this._handleDisconnect}
          @acp-runtime-change=${this._handleRuntimeChange}
          @acp-profile-select=${this._handleProfileSelected}
          @acp-profile-delete=${this._handleProfileDeleted}
          @acp-profile-name-change=${this._handleProfileNameChange}
          @acp-save-preferences=${this._handleSavePreferences}
        ></acp-connect-dialog>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-chat-app": AcpChatApp;
  }
}
