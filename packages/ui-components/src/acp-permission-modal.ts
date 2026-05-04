import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import type { PermissionRequestLike } from "./acp-types.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Permission request modal overlay.
 *
 * When the ACP agent wants to use a tool (file write, terminal, etc.),
 * this modal appears asking the user to approve or deny.
 *
 * Dispatches `acp-permission-response` CustomEvent with either
 * `{ outcome: "selected", optionId, selectedScope }` or
 * `{ outcome: "cancelled" }`.
 *
 * ## Theming
 *
 * Modal-class component: primary mechanism is P2 shadow parts; P1 tokens
 * handle color-level overrides.
 *
 * Tokens (default to pre-tokenization hardcoded values + the global
 * `--acp-*` palette):
 * - `--acp-modal-backdrop-bg`, `--acp-modal-backdrop-blur`
 * - `--acp-modal-card-bg`, `--acp-modal-card-border`,
 *   `--acp-modal-card-radius`, `--acp-modal-card-padding`,
 *   `--acp-modal-card-max-width`, `--acp-modal-card-shadow`
 *
 * Parts:
 * - `part="card"` — the modal card container.
 * - `part="header"` — the `<h2>` card header.
 * - `part="tool-title"` — the tool-title accent line.
 * - `part="raw-input"` — the raw-input collapsible block.
 * - `part="message"` — the plain-text message body.
 * - `part="scope-section"` — the scope-picker wrapper.
 * - `part="scope-heading"` — the scope picker heading.
 * - `part="scope-btn"` — individual scope buttons. Forwards `aria-pressed`
 *   so hosts can target selected state via
 *   `::part(scope-btn)[aria-pressed="true"]`.
 * - `part="options"` — the allow/deny option button group wrapper.
 * - `part="btn-allow"` / `part="btn-deny"` — individual option buttons
 *   keyed by kind.
 * - `part="footer"` — the reject footer wrapper.
 * - `part="btn-reject"` — the reject button.
 */
@safeCustomElement("acp-permission-modal")
export class AcpPermissionModal extends LitElement {
  @property({ attribute: false })
  accessor request: PermissionRequestLike | null = null;

  @state()
  accessor _rawInputExpanded = false;

  @state()
  accessor _selectedScope: string | null = null;

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Defaults preserve pre-tokenization
         * visuals. Hosts override at the wrapper / host element to
         * retheme the modal without reaching into shadow DOM. */
        --acp-modal-backdrop-bg: rgba(0, 0, 0, 0.6);
        --acp-modal-backdrop-blur: 4px;
        --acp-modal-card-bg: var(--acp-bg-secondary);
        --acp-modal-card-border: var(--acp-border);
        --acp-modal-card-radius: 12px;
        --acp-modal-card-padding: 24px 28px;
        --acp-modal-card-max-width: 500px;
        --acp-modal-card-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);

        display: flex;
        align-items: center;
        justify-content: center;
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: var(--acp-modal-backdrop-bg);
        backdrop-filter: blur(var(--acp-modal-backdrop-blur));
      }

      .card {
        background: var(--acp-modal-card-bg);
        border: 1px solid var(--acp-modal-card-border);
        border-radius: var(--acp-modal-card-radius);
        padding: var(--acp-modal-card-padding);
        max-width: var(--acp-modal-card-max-width);
        width: 100%;
        box-shadow: var(--acp-modal-card-shadow);
      }

      .header {
        margin: 0 0 16px;
        font-size: 16px;
        font-weight: 700;
        color: var(--acp-text);
      }

      .tool-title {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 600;
        color: var(--acp-accent);
      }

      .toggle-raw {
        display: inline-block;
        margin-bottom: 8px;
        padding: 0;
        background: none;
        border: none;
        color: var(--acp-text-muted);
        font-size: 12px;
        font-family: inherit;
        cursor: pointer;
        text-decoration: underline;
      }

      .toggle-raw:hover {
        color: var(--acp-accent);
      }

      .raw-input {
        margin: 0 0 12px;
        padding: 10px 12px;
        background: var(--acp-bg-secondary);
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        max-height: 200px;
        overflow: auto;
      }

      .raw-input pre {
        margin: 0;
        font-family: var(--acp-font-mono, ui-monospace, monospace);
        font-size: 12px;
        color: var(--acp-text);
        white-space: pre-wrap;
        word-break: break-all;
      }

      .message {
        margin: 0 0 16px;
        font-size: 13px;
        color: var(--acp-text);
        line-height: 1.5;
      }

      .options {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 16px;
      }

      button {
        padding: 8px 18px;
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }

      .btn-allow {
        background: var(--acp-accent);
        color: var(--acp-bg);
        border-color: var(--acp-accent);
      }

      .btn-allow:hover {
        filter: brightness(1.1);
      }

      .btn-deny {
        background: transparent;
        color: var(--acp-text-muted);
        border-color: var(--acp-border);
      }

      .btn-deny:hover {
        background: color-mix(in srgb, var(--acp-text-muted) 10%, transparent);
      }

      .option-description {
        font-size: 11px;
        color: var(--acp-text-muted);
        margin-top: 2px;
      }

      .footer {
        padding-top: 16px;
        border-top: 1px solid var(--acp-border);
      }

      .btn-reject {
        width: 100%;
        background: transparent;
        color: var(--acp-error);
        border-color: color-mix(in srgb, var(--acp-error) 40%, var(--acp-border));
      }

      .btn-reject:hover {
        background: color-mix(in srgb, var(--acp-error) 10%, transparent);
      }

      .scope-section {
        margin-bottom: 16px;
      }

      .scope-heading {
        margin: 0 0 8px;
        font-size: 12px;
        font-weight: 600;
        color: var(--acp-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      .scope-options {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .scope-copy {
        margin: 0 0 8px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--acp-text-muted);
      }

      .scope-btn {
        padding: 6px 12px;
        border: 1px solid var(--acp-border);
        border-radius: 4px;
        font-size: 12px;
        font-weight: 400;
        font-family: inherit;
        cursor: pointer;
        background: transparent;
        color: var(--acp-text-muted);
        text-align: left;
        transition: background 0.15s, border-color 0.15s, color 0.15s;
      }

      .scope-btn:hover {
        background: color-mix(in srgb, var(--acp-accent) 8%, transparent);
        color: var(--acp-text);
      }

      .scope-btn[aria-pressed="true"] {
        background: color-mix(in srgb, var(--acp-accent) 15%, transparent);
        border-color: var(--acp-accent);
        color: var(--acp-text);
        font-weight: 500;
      }
    `,
  ];

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("request")) {
      const suggestedScopes = this.request?.suggestedScopes ?? [];
      if (suggestedScopes.length === 0) {
        this._selectedScope = null;
        return;
      }

      const previousRequest = changed.get("request") as PermissionRequestLike | null | undefined;
      const requestChanged =
        this._scopeRequestKey(previousRequest) !== this._scopeRequestKey(this.request);
      const selectionStillValid = suggestedScopes.some(
        (candidate) => candidate.scope === this._selectedScope,
      );

      if (requestChanged || !selectionStillValid) {
        this._selectedScope = suggestedScopes[0]?.scope ?? null;
      }
    }
  }

  private _scopeRequestKey(request: PermissionRequestLike | null | undefined): string {
    if (!request) {
      return "";
    }

    return JSON.stringify({
      message: request.message ?? "",
      title: request.toolCall?.title ?? "",
      rawInput: request.toolCall?.rawInput ?? null,
      optionIds: request.options?.map((option) => option.optionId) ?? [],
    });
  }

  private _toggleRawInput(): void {
    this._rawInputExpanded = !this._rawInputExpanded;
  }

  private _selectOption(optionId: string): void {
    this.dispatchEvent(
      new CustomEvent("acp-permission-response", {
        bubbles: true,
        composed: true,
        detail: {
          outcome: "selected",
          optionId,
          selectedScope: this._selectedScope,
        },
      }),
    );
  }

  private _reject(): void {
    this.dispatchEvent(
      new CustomEvent("acp-permission-response", {
        bubbles: true,
        composed: true,
        detail: {
          outcome: "cancelled",
          selectedScope: this._selectedScope,
        },
      }),
    );
  }

  private _isAllowKind(kind: string): boolean {
    return kind === "allow_once" || kind === "allow_always";
  }

  protected override render() {
    if (!this.request) return nothing;

    const { toolCall, message, options } = this.request;
    const hasRawInput = toolCall?.rawInput !== undefined && toolCall?.rawInput !== null;
    const rawInputJson = hasRawInput ? JSON.stringify(toolCall?.rawInput, null, 2) : "";

    return html`
      <div part="card" class="card">
        <h2 part="header" class="header">Confirm Access</h2>

        ${toolCall?.title ? html`<div part="tool-title" class="tool-title">${toolCall.title}</div>` : nothing}

        ${
          hasRawInput
            ? html`
              <button class="toggle-raw" @click=${this._toggleRawInput}>
                ${this._rawInputExpanded ? "Hide" : "Show"} raw input
              </button>
              ${
                this._rawInputExpanded
                  ? html`
                    <div part="raw-input" class="raw-input">
                      <pre>${rawInputJson}</pre>
                    </div>
                  `
                  : nothing
              }
            `
            : nothing
        }

        ${message ? html`<div part="message" class="message">${message}</div>` : nothing}

        ${
          this.request?.suggestedScopes && this.request.suggestedScopes.length > 1
            ? html`
              <div part="scope-section" class="scope-section">
                <div part="scope-heading" class="scope-heading">Access Scope</div>
                <p class="scope-copy">Choose the narrowest scope that matches what you trust.</p>
                <div class="scope-options">
                  ${this.request.suggestedScopes.map(
                    (candidate) => html`
                      <button
                        part="scope-btn"
                        class="scope-btn"
                        aria-pressed=${this._selectedScope === candidate.scope ? "true" : "false"}
                        @click=${() => {
                          this._selectedScope = candidate.scope;
                        }}
                      >
                        ${candidate.label}
                      </button>
                    `,
                  )}
                </div>
              </div>
            `
            : nothing
        }

        ${
          options && options.length > 0
            ? html`
              <div part="options" class="options">
                ${options.map(
                  (opt) => html`
                    <button
                      part=${this._isAllowKind(opt.kind) ? "btn-allow" : "btn-deny"}
                      class=${this._isAllowKind(opt.kind) ? "btn-allow" : "btn-deny"}
                      @click=${() => this._selectOption(opt.optionId)}
                    >
                      ${opt.name ?? opt.optionId}
                      ${opt.description ? html`<div class="option-description">${opt.description}</div>` : nothing}
                    </button>
                  `,
                )}
              </div>
            `
            : nothing
        }

        <div part="footer" class="footer">
          <button part="btn-reject" class="btn-reject" @click=${this._reject}>Reject</button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-permission-modal": AcpPermissionModal;
  }
}
