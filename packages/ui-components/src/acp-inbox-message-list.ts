import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import "./acp-inbox-message-item.ts";
import type { InboxMessageLike } from "./acp-inbox-message-item.ts";
import { acpInputStyles } from "./acp-input-styles.ts";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Renders a list of inbox messages with an optional client-side
 * `from_session` text filter. Hosts pass the message array; the
 * component owns only display state (current filter input).
 *
 * Read-only render — no internal fetching, no subscriptions. Hosts
 * own the refresh cadence and pass updated `messages` props.
 *
 * **Scope context (AJS-85 Phase 1):** this is the AGENT INBOX browser —
 * durable per-session messages from `agent-msg.db`. NOT a Matrix room
 * transcript browser; that's a separate substrate covered by
 * DOT-499/500/501. v1 is linear chronological + client-side filter.
 * Threading (`m.in_reply_to`), live overlay, and `kind` discriminator
 * filtering are Phase 2/3 follow-ons.
 *
 * @fires acp-inbox-refresh - Bubbling event when the user clicks refresh.
 */
@safeCustomElement("acp-inbox-message-list")
export class AcpInboxMessageList extends LitElement {
  /** Messages to render. Pass the array verbatim from the data source. */
  @property({ attribute: false })
  accessor messages: InboxMessageLike[] = [];

  /** Heading text shown above the list. */
  @property({ type: String })
  accessor heading = "Inbox";

  /** Subtitle/context text shown under the heading. */
  @property({ type: String, attribute: "subtitle" })
  accessor subtitle = "";

  /** When true, show a loading indicator instead of the list. */
  @property({ type: Boolean })
  accessor loading = false;

  /** When set, show as an error banner above the list. */
  @property({ type: String, attribute: "error-message" })
  accessor errorMessage = "";

  /** Current client-side from-session filter (case-insensitive substring). */
  @state()
  private accessor _filter = "";

  static override styles = [
    acpTheme,
    acpInputStyles,
    css`
      :host {
        --acp-inbox-list-gap: 8px;
        --acp-inbox-list-padding: 16px;
        display: block;
        padding: var(--acp-inbox-list-padding);
        color: var(--acp-text-primary);
        font-family: var(--acp-font, system-ui, sans-serif);
      }

      header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }

      .title-block {
        flex: 1 1 auto;
        min-width: 0;
      }

      h1 {
        font-size: 18px;
        font-weight: 600;
        margin: 0;
      }

      .subtitle {
        font-size: 12px;
        color: var(--acp-text-secondary);
        margin-top: 2px;
      }

      .toolbar {
        display: flex;
        gap: 8px;
        margin-bottom: 12px;
        align-items: center;
      }

      .toolbar input[type="search"] {
        flex: 1 1 auto;
      }

      button.refresh {
        background: var(--acp-bg-tertiary, rgba(255, 255, 255, 0.05));
        color: var(--acp-text-primary);
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        padding: 6px 12px;
        cursor: pointer;
        font: inherit;
      }

      button.refresh:hover {
        background: var(--acp-bg-hover, rgba(255, 255, 255, 0.1));
      }

      .list {
        display: flex;
        flex-direction: column;
        gap: var(--acp-inbox-list-gap);
      }

      .empty,
      .loading {
        font-size: 14px;
        color: var(--acp-text-secondary);
        font-style: italic;
        padding: 24px 16px;
        text-align: center;
        border: 1px dashed var(--acp-border);
        border-radius: 8px;
      }

      .error {
        font-size: 13px;
        color: var(--acp-error, #ff6b6b);
        background: var(--acp-error-bg, rgba(255, 107, 107, 0.08));
        border: 1px solid var(--acp-error, #ff6b6b);
        border-radius: 6px;
        padding: 10px 12px;
        margin-bottom: 12px;
      }

      .count {
        font-size: 12px;
        color: var(--acp-text-secondary);
      }
    `,
  ];

  override render() {
    const filtered = filterMessages(this.messages, this._filter);
    return html`
      <header>
        <div class="title-block">
          <h1>${this.heading}</h1>
          ${this.subtitle ? html`<div class="subtitle">${this.subtitle}</div>` : nothing}
        </div>
        <button class="refresh" type="button" @click=${this._onRefreshClick}>Refresh</button>
      </header>
      ${this.errorMessage ? html`<div class="error" role="alert">${this.errorMessage}</div>` : nothing}
      <div class="toolbar">
        <input
          type="search"
          placeholder="Filter by from_session…"
          .value=${this._filter}
          @input=${this._onFilterInput}
          aria-label="Filter messages by from_session"
        />
        <span class="count">${filtered.length} / ${this.messages.length}</span>
      </div>
      <div class="list" role="list">
        ${
          this.loading
            ? html`<div class="loading">Loading…</div>`
            : filtered.length === 0
              ? html`<div class="empty">${this._renderEmpty()}</div>`
              : filtered.map(
                  (msg) => html`
                  <acp-inbox-message-item role="listitem" .message=${msg}></acp-inbox-message-item>
                `,
                )
        }
      </div>
    `;
  }

  private _renderEmpty(): string {
    if (this._filter && this.messages.length > 0) {
      return `No messages match filter "${this._filter}"`;
    }
    return "No messages in inbox";
  }

  private _onFilterInput(e: Event): void {
    const target = e.target as HTMLInputElement | null;
    this._filter = target?.value ?? "";
  }

  private _onRefreshClick(): void {
    this.dispatchEvent(new CustomEvent("acp-inbox-refresh", { bubbles: true, composed: true }));
  }
}

/**
 * Apply a case-insensitive substring filter on `from_session`.
 * Exported for unit testing.
 */
export function filterMessages(
  messages: readonly InboxMessageLike[],
  filter: string,
): InboxMessageLike[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return [...messages];
  return messages.filter((m) => m.from_session.toLowerCase().includes(needle));
}
