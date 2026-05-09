import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Shape of an auth method entry — matches A2AAuthRequiredState.authMethods.
 */
interface AuthMethod {
  id: string;
  name?: string;
}

/**
 * Auth method selector rendered as a centered card overlay.
 *
 * Displays available authentication methods as clickable cards.
 * Dispatches `acp-auth-selected` CustomEvent with `detail: { methodId }`.
 */
@safeCustomElement("acp-auth-selector")
export class AcpAuthSelector extends LitElement {
  @property({ attribute: false })
  accessor methods: AuthMethod[] = [];

  @property({ type: String })
  accessor message = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        display: flex;
        align-items: center;
        justify-content: center;
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.6);
      }

      .card {
        background: var(--acp-bg-secondary);
        border: 1px solid var(--acp-border);
        border-radius: 12px;
        padding: 24px 28px;
        max-width: 420px;
        width: 100%;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }

      .title {
        margin: 0 0 6px;
        font-size: 16px;
        font-weight: 600;
        color: var(--acp-accent);
      }

      .description {
        margin: 0 0 20px;
        font-size: 13px;
        color: var(--acp-text-muted);
        line-height: 1.5;
      }

      .methods {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .method-btn {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 12px 16px;
        background: var(--acp-bg);
        border: 1px solid var(--acp-border);
        border-radius: 8px;
        color: var(--acp-text);
        font-size: 14px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        text-align: left;
        transition: border-color 0.15s, background 0.15s;
      }

      .method-btn:hover {
        border-color: var(--acp-accent);
        background: color-mix(in srgb, var(--acp-accent) 8%, var(--acp-bg));
      }

      .method-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 6px;
        background: color-mix(in srgb, var(--acp-accent-purple) 15%, transparent);
        color: var(--acp-accent-purple);
        font-size: 14px;
        font-weight: 700;
        flex-shrink: 0;
      }

      .method-label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .method-id {
        font-size: 11px;
        color: var(--acp-text-muted);
        font-family: var(--acp-font-mono, ui-monospace, monospace);
      }
    `,
  ];

  private _select(methodId: string): void {
    this.dispatchEvent(
      new CustomEvent("acp-auth-selected", {
        bubbles: true,
        composed: true,
        detail: { methodId },
      }),
    );
  }

  protected override render() {
    return html`
      <div class="card">
        <h2 class="title">Authentication Required</h2>
        ${this.message ? html`<p class="description">${this.message}</p>` : nothing}
        <div class="methods">
          ${this.methods.map(
            (method) => html`
              <button class="method-btn" @click=${() => this._select(method.id)}>
                <span class="method-icon">
                  ${(method.name ?? method.id).charAt(0).toUpperCase()}
                </span>
                <span>
                  <span class="method-label">${method.name ?? method.id}</span>
                  ${method.name ? html`<br /><span class="method-id">${method.id}</span>` : nothing}
                </span>
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-auth-selector": AcpAuthSelector;
  }
}
