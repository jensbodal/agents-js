import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import type { AgentCardLike, SessionStateLike } from "./acp-types.ts";
import { statusCategory } from "./acp-utils.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

type DebugTab = "card" | "session" | "trace";

/**
 * A collapsible debug panel with three tabs: Card, Session, and Trace.
 *
 * Shows agent card metadata, current session state, and recent debug records.
 */
@safeCustomElement("acp-debug-panel")
export class AcpDebugPanel extends LitElement {
  @property({ attribute: false })
  accessor state: SessionStateLike = {};

  @property({ attribute: false })
  accessor agentCard: AgentCardLike | null = null;

  @state()
  accessor _activeTab: DebugTab = "card";

  @state()
  accessor _collapsed = false;

  static override styles = [
    acpTheme,
    css`
      :host {
        display: block;
        background: var(--acp-bg-secondary);
        border: 1px solid var(--acp-border);
        border-radius: 8px;
        color: var(--acp-text);
        overflow: hidden;
        font-size: 13px;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: var(--acp-bg-tertiary);
        cursor: pointer;
        user-select: none;
        border-bottom: 1px solid var(--acp-border);
      }

      .header:hover {
        background: color-mix(in srgb, var(--acp-accent) 8%, var(--acp-bg-tertiary));
      }

      .header-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--acp-accent-purple);
        letter-spacing: 0.02em;
      }

      .chevron {
        font-size: 11px;
        color: var(--acp-text-muted);
        transition: transform 0.2s;
      }

      .chevron.open {
        transform: rotate(180deg);
      }

      .body {
        display: none;
      }

      .body.open {
        display: block;
      }

      .tabs {
        display: flex;
        border-bottom: 1px solid var(--acp-border);
      }

      .tab {
        flex: 1;
        padding: 8px 12px;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--acp-text-muted);
        font-size: 12px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        text-align: center;
        transition: color 0.15s, border-color 0.15s;
      }

      .tab:hover {
        color: var(--acp-text);
      }

      .tab.active {
        color: var(--acp-accent);
        border-bottom-color: var(--acp-accent);
      }

      .content {
        padding: 12px 14px;
        min-height: 80px;
        max-height: 320px;
        overflow-y: auto;
      }

      .row {
        display: flex;
        gap: 8px;
        margin-bottom: 4px;
        line-height: 1.5;
        font-size: 12px;
      }

      .row-key {
        color: var(--acp-text-muted);
        min-width: 100px;
        flex-shrink: 0;
        font-weight: 500;
      }

      .row-value {
        color: var(--acp-text);
        word-break: break-all;
        font-family: var(--acp-font-mono, ui-monospace, monospace);
      }

      .row-value.status-success {
        color: var(--acp-success);
      }
      .row-value.status-error {
        color: var(--acp-error);
      }
      .row-value.status-active {
        color: var(--acp-accent);
      }

      .empty {
        color: var(--acp-text-muted);
        font-size: 12px;
        font-style: italic;
      }

      /* Trace table */
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 11px;
        font-family: var(--acp-font-mono, ui-monospace, monospace);
      }

      th {
        text-align: left;
        padding: 4px 6px;
        color: var(--acp-text-muted);
        font-weight: 600;
        border-bottom: 1px solid var(--acp-border);
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      td {
        padding: 3px 6px;
        color: var(--acp-text);
        border-bottom: 1px solid color-mix(in srgb, var(--acp-border) 40%, transparent);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
      }

      tr:last-child td {
        border-bottom: none;
      }

      .dir-inbound {
        color: var(--acp-success);
      }
      .dir-outbound {
        color: var(--acp-accent);
      }

      .status-ok {
        color: var(--acp-success);
      }
      .status-err {
        color: var(--acp-error);
      }
    `,
  ];

  private _toggleCollapse(): void {
    this._collapsed = !this._collapsed;
  }

  private _setTab(tab: DebugTab): void {
    this._activeTab = tab;
  }

  private _statusClass(status?: string): string {
    if (!status) return "";
    return `status-${statusCategory(status)}`;
  }

  private _renderCard() {
    const card = this.agentCard;
    if (!card) {
      return html`<div class="empty">No agent card available</div>`;
    }

    const streaming = card.capabilities?.streaming ?? card.capabilities?.supportsStreaming;

    return html`
      <div class="row">
        <span class="row-key">Name</span>
        <span class="row-value">${card.name ?? "-"}</span>
      </div>
      <div class="row">
        <span class="row-key">URL</span>
        <span class="row-value">${card.url ?? "-"}</span>
      </div>
      <div class="row">
        <span class="row-key">Protocol</span>
        <span class="row-value">${card.protocolVersion ?? "unknown"}</span>
      </div>
      <div class="row">
        <span class="row-key">Streaming</span>
        <span class="row-value">${streaming ? "yes" : "no"}</span>
      </div>
    `;
  }

  private _renderSession() {
    const s = this.state;
    if (!s.sessionId && !s.status) {
      return html`<div class="empty">No session data</div>`;
    }

    const messageCount = s.transcript?.length ?? 0;
    const statusCls = this._statusClass(s.status);

    return html`
      <div class="row">
        <span class="row-key">Status</span>
        <span class="row-value ${statusCls}">${s.status ?? "-"}</span>
      </div>
      <div class="row">
        <span class="row-key">Task State</span>
        <span class="row-value">${s.taskState ?? "-"}</span>
      </div>
      <div class="row">
        <span class="row-key">Context ID</span>
        <span class="row-value">${s.contextId ?? "-"}</span>
      </div>
      <div class="row">
        <span class="row-key">Task ID</span>
        <span class="row-value">${s.taskId ?? "-"}</span>
      </div>
      <div class="row">
        <span class="row-key">Messages</span>
        <span class="row-value">${messageCount}</span>
      </div>
      <div class="row">
        <span class="row-key">Pending Text</span>
        <span class="row-value">${s.pendingAgentText ? "yes" : "no"}</span>
      </div>
      <div class="row">
        <span class="row-key">Elicitation</span>
        <span class="row-value">${s.activeElicitation ? "active" : "none"}</span>
      </div>
      <div class="row">
        <span class="row-key">Auth</span>
        <span class="row-value">${s.activeAuth ? "active" : "none"}</span>
      </div>
      ${
        s.runtime
          ? html`
            <div class="row">
              <span class="row-key">Runtime</span>
              <span class="row-value">${s.runtime.displayName} (${s.runtime.id})</span>
            </div>
          `
          : nothing
      }
      ${
        s.models
          ? html`
            <div class="row">
              <span class="row-key">Model</span>
              <span class="row-value">${s.models.currentModelId}</span>
            </div>
            <div class="row">
              <span class="row-key">Models</span>
              <span class="row-value">${s.models.availableModels.length}</span>
            </div>
          `
          : nothing
      }
      ${
        s.lastError
          ? html`
            <div class="row">
              <span class="row-key">Last Error</span>
              <span class="row-value status-error">${s.lastError}</span>
            </div>
          `
          : nothing
      }
    `;
  }

  private _renderTrace() {
    const records = this.state.debugRecords;
    if (!records || records.length === 0) {
      return html`<div class="empty">No debug records yet</div>`;
    }

    // Show last 20 entries
    const recent = records.slice(-20);

    return html`
      <table>
        <thead>
          <tr>
            <th>Method</th>
            <th>Direction</th>
            <th>Status</th>
            <th>URL</th>
          </tr>
        </thead>
        <tbody>
          ${recent.map(
            (r) => html`
              <tr>
                <td>${r.method}</td>
                <td class=${r.direction === "inbound" ? "dir-inbound" : "dir-outbound"}>
                  ${r.direction}
                </td>
                <td class=${r.status && r.status >= 400 ? "status-err" : "status-ok"}>
                  ${r.status ?? "-"}
                </td>
                <td title=${r.url}>${r.url}</td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    `;
  }

  protected override render() {
    const isOpen = !this._collapsed;

    return html`
      <div class="header" @click=${this._toggleCollapse}>
        <span class="header-title">Debug Inspector</span>
        <span class="chevron ${isOpen ? "open" : ""}">&#9660;</span>
      </div>
      ${
        isOpen
          ? html`
            <div class="body open">
              <div class="tabs">
                <button
                  class="tab ${this._activeTab === "card" ? "active" : ""}"
                  @click=${() => this._setTab("card")}
                >
                  Card
                </button>
                <button
                  class="tab ${this._activeTab === "session" ? "active" : ""}"
                  @click=${() => this._setTab("session")}
                >
                  Session
                </button>
                <button
                  class="tab ${this._activeTab === "trace" ? "active" : ""}"
                  @click=${() => this._setTab("trace")}
                >
                  Trace
                </button>
              </div>
              <div class="content">
                ${
                  this._activeTab === "card"
                    ? this._renderCard()
                    : this._activeTab === "session"
                      ? this._renderSession()
                      : this._renderTrace()
                }
              </div>
            </div>
          `
          : nothing
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-debug-panel": AcpDebugPanel;
  }
}
