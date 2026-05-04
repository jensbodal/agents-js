import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { statusCategory } from "./acp-utils.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A status bar showing agent name, connection status badge, and session ID.
 *
 * Status colors:
 *   connected  -> --acp-success
 *   sending    -> --acp-accent
 *   waiting    -> --acp-accent
 *   error      -> --acp-error
 *   idle       -> --acp-text-muted
 *   others     -> --acp-text-muted
 *
 * ## Theming
 *
 * Composite-class component: primary mechanism is named `<slot>`
 * replacement (P4) so hosts can swap whole sections. P1 tokens handle
 * the chrome around host-provided slots.
 *
 * Tokens (default to pre-tokenization hardcoded values and the global
 * `--acp-*` palette):
 * - `--acp-status-bar-bg`, `--acp-status-bar-border`,
 *   `--acp-status-bar-padding`, `--acp-status-bar-gap`,
 *   `--acp-status-bar-font-size`, `--acp-status-bar-color`
 *
 * Slots (every slot has default content, so hosts that don't slot
 * anything keep the previous layout):
 * - `slot="leading"` — replaces the agent name cell.
 * - `slot="badge"` — replaces the status badge cell.
 * - `slot="trailing"` — replaces the session-id cell.
 * - Default (unnamed) slot — content appended between the default
 *   cells and the trailing slot for host-provided extras.
 */
@safeCustomElement("acp-status-bar")
export class AcpStatusBar extends LitElement {
  @property({ type: String })
  accessor agentName = "";

  @property({ type: String })
  accessor status = "idle";

  @property({ type: String })
  accessor sessionId = "";

  @property({ type: String })
  accessor profileName = "";

  @property({ type: String })
  accessor sessionTitle = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Defaults preserve pre-tokenization
         * visuals. Hosts override at an ancestor to retheme the status
         * bar's chrome. */
        --acp-status-bar-bg: var(--acp-bg-secondary);
        --acp-status-bar-border: var(--acp-border);
        --acp-status-bar-padding: 8px 16px;
        --acp-status-bar-gap: 12px;
        --acp-status-bar-font-size: 13px;
        --acp-status-bar-color: var(--acp-text);

        display: flex;
        align-items: center;
        gap: var(--acp-status-bar-gap);
        padding: var(--acp-status-bar-padding);
        background: var(--acp-status-bar-bg);
        border-bottom: 1px solid var(--acp-status-bar-border);
        font-size: var(--acp-status-bar-font-size);
        color: var(--acp-status-bar-color);
      }
      .agent-name {
        font-weight: 600;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .badge--success {
        background: color-mix(in srgb, var(--acp-success) 15%, transparent);
        color: var(--acp-success);
      }
      .badge--success .dot {
        background: var(--acp-success);
      }
      .badge--active {
        background: color-mix(in srgb, var(--acp-accent) 15%, transparent);
        color: var(--acp-accent);
      }
      .badge--active .dot {
        background: var(--acp-accent);
      }
      .badge--error {
        background: color-mix(in srgb, var(--acp-error) 15%, transparent);
        color: var(--acp-error);
      }
      .badge--error .dot {
        background: var(--acp-error);
      }
      .badge--idle {
        background: color-mix(in srgb, var(--acp-text-muted) 15%, transparent);
        color: var(--acp-text-muted);
      }
      .badge--idle .dot {
        background: var(--acp-text-muted);
      }
      .profile-name {
        color: var(--acp-text-muted);
        font-size: 12px;
      }
      .profile-name::before {
        content: "·";
        margin-right: 8px;
        color: var(--acp-border);
      }
      .session-title {
        color: var(--acp-text-muted);
        font-size: 12px;
        font-style: italic;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 300px;
      }
      .session-id {
        margin-left: auto;
        color: var(--acp-text-muted);
        font-size: 11px;
        font-family: var(--acp-font-mono, ui-monospace, monospace);
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    `,
  ];

  private _badgeClass(): string {
    return `badge--${statusCategory(this.status)}`;
  }

  protected override render() {
    const truncated =
      this.sessionId.length > 12 ? `${this.sessionId.slice(0, 8)}...` : this.sessionId;

    return html`
      <slot name="leading">
        <span class="agent-name">${this.agentName || "Agent"}</span>
        ${this.profileName ? html`<span class="profile-name">${this.profileName}</span>` : ""}
        ${this.sessionTitle ? html`<span class="session-title" title=${this.sessionTitle}>${this.sessionTitle}</span>` : ""}
      </slot>
      <slot name="badge">
        <span class="badge ${this._badgeClass()}">
          <span class="dot"></span>
          ${this.status}
        </span>
      </slot>
      <slot></slot>
      <slot name="trailing">
        ${truncated ? html`<span class="session-id" title=${this.sessionId}>${truncated}</span>` : ""}
      </slot>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-status-bar": AcpStatusBar;
  }
}
