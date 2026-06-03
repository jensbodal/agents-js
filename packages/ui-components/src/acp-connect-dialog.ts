import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import type { AgentCardLike, RuntimeInfoLike, TargetInspectionLike } from "./acp-types.ts";
import type { ConnectProfile } from "./connect-preferences-store.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Controlled connection dialog for entering an agent URL, previewing the agent
 * card, and dispatching connect/disconnect events.
 *
 * Dispatches:
 * - `acp-url-change` CustomEvent with `detail: { url: string }` while the URL changes
 * - `acp-connect` CustomEvent with `detail: { url: string }` on connect
 * - `acp-disconnect` CustomEvent on disconnect
 * - `acp-profile-select` CustomEvent with `detail: { profileId }` on quick-switch
 * - `acp-profile-delete` CustomEvent with `detail: { profileId }` on delete
 * - `acp-profile-name-change` CustomEvent with `detail: { name }` while name changes
 * - `acp-save-preferences` CustomEvent with profile detail on save/create
 */
@safeCustomElement("acp-connect-dialog")
export class AcpConnectDialog extends LitElement {
  @property({ type: Boolean })
  accessor connected = false;

  @property({ type: String })
  accessor agentName = "";

  @property({ type: String })
  accessor defaultUrl = "";

  @property({ type: String })
  accessor url = "";

  @property({ type: String })
  accessor status: TargetInspectionLike["status"] = "idle";

  @property({ type: String })
  accessor statusMessage = "";

  @property({ type: Boolean })
  accessor connectDisabled = true;

  @property({ type: Boolean })
  accessor connectLoading = false;

  @property({ type: Boolean })
  accessor connecting = false;

  @property({ attribute: false })
  accessor preview: AgentCardLike | null = null;

  @property({ attribute: false })
  accessor runtime: RuntimeInfoLike | null = null;

  @property({ attribute: false })
  accessor availableRuntimes: RuntimeInfoLike[] = [];

  @property({ type: Boolean })
  accessor hasSavedPreferences = false;

  @property({ attribute: false })
  accessor profiles: ConnectProfile[] = [];

  @property({ type: String })
  accessor activeProfileId = "";

  @property({ type: String })
  accessor profileName = "";

  /**
   * Optional notice string shown below the runtime selector.
   * Used for runtime mismatch warnings and restart instructions.
   */
  @property({ type: String })
  accessor runtimeNotice = "";

  /**
   * Tracks the runtime the user has selected in the dropdown.
   * Initialized from `this.runtime?.id` when the runtime prop changes,
   * so saved profile updates capture the user's intended runtime.
   */
  @state()
  accessor _selectedRuntimeId = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        display: block;
        background: var(--acp-bg-secondary);
        border: 1px solid var(--acp-border);
        border-radius: 8px;
        padding: 20px;
        color: var(--acp-text);
        max-width: 480px;
      }

      .title {
        margin: 0 0 16px;
        font-size: 16px;
        font-weight: 600;
        color: var(--acp-text);
      }

      .connected-info {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 16px;
        padding: 10px 14px;
        background: color-mix(in srgb, var(--acp-success) 10%, var(--acp-bg));
        border: 1px solid color-mix(in srgb, var(--acp-success) 30%, var(--acp-border));
        border-radius: 6px;
      }

      .connected-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--acp-success);
        flex-shrink: 0;
      }

      .connected-label {
        font-size: 13px;
        font-weight: 500;
        color: var(--acp-success);
      }

      .url-row {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
      }

      input[type="text"] {
        flex: 1;
        padding: 8px 10px;
        background: var(--acp-bg);
        border: 1px solid var(--acp-border);
        border-radius: 4px;
        color: var(--acp-text);
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s;
      }

      input[type="text"]:focus {
        border-color: var(--acp-accent);
      }

      .url-row input[type="text"] {
        font-family: var(--acp-font-mono, ui-monospace, monospace);
      }

      button {
        padding: 8px 18px;
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s, opacity 0.15s;
        white-space: nowrap;
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .btn-connect {
        background: var(--acp-accent);
        color: var(--acp-bg);
        border-color: var(--acp-accent);
      }
      .btn-connect:hover:not(:disabled) {
        filter: brightness(1.1);
      }

      .btn-disconnect {
        background: transparent;
        color: var(--acp-error);
        border-color: var(--acp-error);
      }
      .btn-disconnect:hover {
        background: color-mix(in srgb, var(--acp-error) 10%, transparent);
      }

      .btn-save {
        background: transparent;
        color: var(--acp-text);
        border-color: var(--acp-border);
        font-size: 12px;
        padding: 6px 14px;
      }

      .btn-save:hover:not(:disabled) {
        color: var(--acp-accent);
        border-color: var(--acp-accent);
      }

      .btn-save--active {
        color: var(--acp-accent);
        border-color: var(--acp-accent);
      }

      .status-box {
        margin-bottom: 12px;
        padding: 8px 12px;
        background: color-mix(in srgb, var(--acp-accent) 8%, var(--acp-bg));
        border: 1px solid color-mix(in srgb, var(--acp-accent) 24%, var(--acp-border));
        border-radius: 6px;
        font-size: 12px;
        line-height: 1.4;
        color: var(--acp-text-muted);
      }

      .status-box--unreachable {
        background: color-mix(in srgb, var(--acp-warning, #f59e0b) 8%, var(--acp-bg));
        border-color: color-mix(in srgb, var(--acp-warning, #f59e0b) 24%, var(--acp-border));
        color: var(--acp-text);
      }

      .runtime-box,
      .profile-box {
        margin-bottom: 12px;
        padding: 8px 12px;
        background: color-mix(in srgb, var(--acp-accent) 6%, var(--acp-bg));
        border: 1px solid color-mix(in srgb, var(--acp-accent) 16%, var(--acp-border));
        border-radius: 6px;
        font-size: 12px;
        line-height: 1.4;
        display: flex;
        align-items: center;
        gap: 8px;
        overflow: hidden;
      }

      .runtime-label,
      .profile-label {
        color: var(--acp-text-muted);
        flex-shrink: 0;
      }

      .runtime-value {
        color: var(--acp-text);
        font-weight: 500;
      }

      .runtime-select,
      .profile-select,
      .profile-name-input {
        flex: 1;
        min-width: 0;
        padding: 4px 8px;
        background: var(--acp-bg);
        border: 1px solid var(--acp-border);
        border-radius: 4px;
        color: var(--acp-text);
        font-size: 12px;
        font-family: inherit;
        outline: none;
      }

      .runtime-select,
      .profile-select {
        cursor: pointer;
      }

      .runtime-select:focus,
      .profile-select:focus,
      .profile-name-input:focus {
        border-color: var(--acp-accent);
      }

      .runtime-hint {
        display: block;
        margin-top: 4px;
        font-size: 11px;
        color: var(--acp-text-muted);
        font-style: italic;
      }

      .runtime-notice {
        margin-top: 6px;
        padding: 6px 10px;
        background: color-mix(in srgb, var(--acp-warning, #f59e0b) 10%, var(--acp-bg));
        border: 1px solid color-mix(in srgb, var(--acp-warning, #f59e0b) 30%, var(--acp-border));
        border-radius: 4px;
        font-size: 11px;
        line-height: 1.4;
        color: var(--acp-text);
      }

      .profile-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 12px;
        flex-wrap: wrap;
      }

      .preview {
        margin-top: 12px;
        padding: 14px;
        background: var(--acp-bg);
        border: 1px solid var(--acp-border);
        border-radius: 6px;
      }

      .preview-title {
        margin: 0 0 8px;
        font-size: 14px;
        font-weight: 600;
        color: var(--acp-accent-purple);
      }

      .preview-row {
        display: flex;
        gap: 6px;
        margin-bottom: 4px;
        font-size: 12px;
        line-height: 1.5;
      }

      .preview-key {
        color: var(--acp-text-muted);
        min-width: 80px;
        flex-shrink: 0;
      }

      .preview-value {
        color: var(--acp-text);
        word-break: break-all;
      }
    `,
  ];

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const runtimeChanged = changed.has("runtime");

    if ((changed.has("profiles") || changed.has("activeProfileId")) && !runtimeChanged) {
      const activeProfile = this.profiles.find((profile) => profile.id === this.activeProfileId);
      if (activeProfile?.runtimeId) {
        this._selectedRuntimeId = activeProfile.runtimeId;
      } else if (this.runtime?.id) {
        this._selectedRuntimeId = this.runtime.id;
      }
    }

    if (runtimeChanged && this.runtime?.id) {
      this._selectedRuntimeId = this.runtime.id;
    }
  }

  private normalizedUrl(): string {
    return this.url.trim().replace(/\/+$/, "");
  }

  private emit(name: string, detail?: Record<string, unknown>): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }));
  }

  private dispatchUrlChange(nextUrl: string): void {
    this.emit("acp-url-change", { url: nextUrl });
  }

  private connect(): void {
    const url = this.normalizedUrl();
    if (!url || this.connectDisabled) return;
    this.emit("acp-connect", { url });
  }

  private disconnect(): void {
    this.emit("acp-disconnect");
  }

  private savePreferences(mode: "update" | "create"): void {
    const url = this.normalizedUrl();
    const runtimeId = this._selectedRuntimeId || this.runtime?.id || "";
    this.emit("acp-save-preferences", {
      url,
      runtimeId,
      profileId: this.activeProfileId,
      profileName: this.profileName.trim(),
      harnessId: runtimeId || "default",
      saveMode: mode,
    });
  }

  private selectProfile(profileId: string): void {
    this.emit("acp-profile-select", { profileId });
  }

  private deleteProfile(): void {
    if (!this.activeProfileId) return;
    this.emit("acp-profile-delete", { profileId: this.activeProfileId });
  }

  private handleProfileNameInput(name: string): void {
    this.emit("acp-profile-name-change", { name });
  }

  protected override render() {
    if (this.connected) {
      return html`
        <h2 class="title">Agent Connection</h2>
        <div class="connected-info">
          <span class="connected-dot"></span>
          <span class="connected-label">
            Connected to ${this.agentName || "agent"}
          </span>
        </div>
        ${this.preview ? this.renderPreview(this.preview) : nothing}
        <button class="btn-disconnect" @click=${this.disconnect}>
          Disconnect
        </button>
      `;
    }

    return html`
      <h2 class="title">Connect to Agent</h2>
      <div class="profile-box">
        <span class="profile-label">Profile</span>
        <select
          class="profile-select"
          .value=${this.activeProfileId}
          @change=${(e: Event) => {
            const select = e.target as HTMLSelectElement;
            this.selectProfile(select.value);
          }}
        >
          <option value="">Unsaved settings</option>
          ${this.profiles.map(
            (profile) => html`
              <option value=${profile.id} ?selected=${profile.id === this.activeProfileId}>
                ${profile.name}
              </option>
            `,
          )}
        </select>
      </div>
      <div class="profile-box">
        <span class="profile-label">Name</span>
        <input
          class="profile-name-input"
          type="text"
          placeholder="Default profile"
          .value=${this.profileName}
          @input=${(event: { target: { value: string } }) => {
            this.handleProfileNameInput(event.target.value);
          }}
        />
      </div>
      <div class="url-row">
        <input
          type="text"
          placeholder=${this.defaultUrl}
          .value=${this.url}
          @input=${(event: { target: { value: string } }) => {
            this.dispatchUrlChange(event.target.value);
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter" && !this.connectDisabled && !this.connectLoading) {
              this.connect();
            }
          }}
        />
        <button
          class="btn-connect"
          ?disabled=${this.connectDisabled || this.connecting}
          @click=${this.connect}
        >
          ${this.connecting ? "Connecting..." : this.connectLoading ? "Checking..." : "Connect"}
        </button>
      </div>
      ${
        this.statusMessage
          ? html`
              <div
                class="status-box ${this.status === "unreachable" ? "status-box--unreachable" : ""}"
              >
                ${this.statusMessage}
              </div>
            `
          : nothing
      }
      ${this.runtime ? this.renderRuntime(this.runtime) : nothing}
      ${this.runtimeNotice ? html`<div class="runtime-notice">${this.runtimeNotice}</div>` : nothing}
      <div class="profile-actions">
        <button
          class="btn-save ${this.hasSavedPreferences ? "btn-save--active" : ""}"
          @click=${() => this.savePreferences("update")}
        >
          ${this.activeProfileId ? "Save Profile" : "Save as Default"}
        </button>
        <button class="btn-save" @click=${() => this.savePreferences("create")}>
          Save as New
        </button>
        <button class="btn-save" ?disabled=${!this.activeProfileId} @click=${this.deleteProfile}>
          Delete Profile
        </button>
      </div>
      ${this.preview ? this.renderPreview(this.preview) : nothing}
    `;
  }

  private renderRuntime(runtime: RuntimeInfoLike) {
    const activeId = this._selectedRuntimeId || runtime.id;
    if (this.availableRuntimes.length > 1) {
      return html`
        <div class="runtime-box" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
          <span class="runtime-label">Runtime</span>
          <select
            class="runtime-select"
            .value=${activeId}
            @change=${(e: Event) => {
              const select = e.target as HTMLSelectElement;
              const nextRuntimeId = select.value;
              if (nextRuntimeId === this._selectedRuntimeId) {
                return;
              }
              this._selectedRuntimeId = nextRuntimeId;
              this.emit("acp-runtime-change", { runtimeId: nextRuntimeId });
            }}
          >
            ${this.availableRuntimes.map(
              (r) => html`
                <option value=${r.id} ?selected=${r.id === activeId}>
                  ${r.displayName} (${r.id})
                </option>
              `,
            )}
          </select>
          ${!this.connected ? html`<span class="runtime-hint">(runtime changes apply live)</span>` : nothing}
        </div>
      `;
    }

    return html`
      <div class="runtime-box">
        <span class="runtime-label">Runtime</span>
        <span class="runtime-value">${runtime.displayName} (${runtime.id})</span>
      </div>
    `;
  }

  private renderPreview(card: AgentCardLike) {
    return html`
      <div class="preview">
        <div class="preview-title">${card.name ?? "Unknown Agent"}</div>
        ${
          card.description
            ? html`
                <div class="preview-row">
                  <span class="preview-key">Description</span>
                  <span class="preview-value">${card.description}</span>
                </div>
              `
            : nothing
        }
        ${
          card.url
            ? html`
                <div class="preview-row">
                  <span class="preview-key">URL</span>
                  <span class="preview-value">${card.url}</span>
                </div>
              `
            : nothing
        }
        <div class="preview-row">
          <span class="preview-key">Streaming</span>
          <span class="preview-value">
            ${card.capabilities?.streaming ? "Supported" : "Not supported"}
          </span>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-connect-dialog": AcpConnectDialog;
  }
}
