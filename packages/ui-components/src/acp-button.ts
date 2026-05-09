import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A themed button component with variant, size, disabled, and loading states.
 *
 * Variants: "primary" (default), "secondary", "danger", "ghost".
 * Sizes: "sm", "md" (default), "lg".
 *
 * Renders a native `<button>` in shadow DOM. The `label` property sets
 * the button text; a default `<slot>` is also available for rich content.
 * When `loading` is true the button shows a spinner and is non-interactive.
 *
 * ## Theming
 *
 * Styleable via the `--acp-button-*` CSS custom property namespace and the
 * `button` / `spinner` shadow parts.
 *
 * Tokens (all default to the global `--acp-*` palette for backwards
 * compatibility):
 * - `--acp-button-radius`
 * - `--acp-button-font-weight`
 * - `--acp-button-transition`
 * - `--acp-button-padding-sm|md|lg`
 * - `--acp-button-font-size-sm|md|lg`
 * - `--acp-button-bg-primary|secondary|danger|ghost`
 * - `--acp-button-color-primary|secondary|danger|ghost`
 * - `--acp-button-border-primary|secondary|danger|ghost`
 *
 * Parts:
 * - `part="button"` — the inner `<button>` element.
 * - `part="spinner"` — the loading spinner (only present when `loading` is true).
 */
@safeCustomElement("acp-button")
export class AcpButton extends LitElement {
  @property({ type: String })
  accessor variant: "primary" | "secondary" | "danger" | "ghost" = "primary";

  @property({ type: String })
  accessor size: "sm" | "md" | "lg" = "md";

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @property({ type: Boolean, reflect: true })
  accessor loading = false;

  @property({ type: String })
  accessor label = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Defaults preserve pre-tokenization
         * visuals — the hardcoded 6px radius, 600 weight, 0.15s transition,
         * and per-variant palette are all exposed as overridable tokens. */
        --acp-button-radius: 6px;
        --acp-button-font-weight: 600;
        --acp-button-transition: background 0.15s, border-color 0.15s, opacity 0.15s;

        --acp-button-padding-sm: 4px 10px;
        --acp-button-padding-md: 8px 16px;
        --acp-button-padding-lg: 12px 24px;
        --acp-button-font-size-sm: 12px;
        --acp-button-font-size-md: 14px;
        --acp-button-font-size-lg: 16px;

        --acp-button-bg-primary: var(--acp-accent);
        --acp-button-color-primary: var(--acp-bg);
        --acp-button-border-primary: var(--acp-accent);

        --acp-button-bg-secondary: transparent;
        --acp-button-color-secondary: var(--acp-text);
        --acp-button-border-secondary: var(--acp-border);

        --acp-button-bg-danger: var(--acp-error);
        --acp-button-color-danger: #fff;
        --acp-button-border-danger: var(--acp-error);

        --acp-button-bg-ghost: transparent;
        --acp-button-color-ghost: var(--acp-text);
        --acp-button-border-ghost: transparent;

        display: inline-block;
      }

      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px solid transparent;
        border-radius: var(--acp-button-radius);
        font-family: inherit;
        font-weight: var(--acp-button-font-weight);
        cursor: pointer;
        transition: var(--acp-button-transition);
        line-height: 1.4;
      }

      /* ---------- sizes ---------- */
      button.size-sm {
        padding: var(--acp-button-padding-sm);
        font-size: var(--acp-button-font-size-sm);
      }
      button.size-md {
        padding: var(--acp-button-padding-md);
        font-size: var(--acp-button-font-size-md);
      }
      button.size-lg {
        padding: var(--acp-button-padding-lg);
        font-size: var(--acp-button-font-size-lg);
      }

      /* ---------- variants ---------- */
      button.variant-primary {
        background: var(--acp-button-bg-primary);
        color: var(--acp-button-color-primary);
        border-color: var(--acp-button-border-primary);
      }
      button.variant-primary:hover:not(:disabled) {
        background: var(--acp-accent-purple);
        border-color: var(--acp-accent-purple);
      }

      button.variant-secondary {
        background: var(--acp-button-bg-secondary);
        color: var(--acp-button-color-secondary);
        border-color: var(--acp-button-border-secondary);
      }
      button.variant-secondary:hover:not(:disabled) {
        background: var(--acp-bg-tertiary);
      }

      button.variant-danger {
        background: var(--acp-button-bg-danger);
        color: var(--acp-button-color-danger);
        border-color: var(--acp-button-border-danger);
      }
      button.variant-danger:hover:not(:disabled) {
        opacity: 0.85;
      }

      button.variant-ghost {
        background: var(--acp-button-bg-ghost);
        color: var(--acp-button-color-ghost);
        border-color: var(--acp-button-border-ghost);
      }
      button.variant-ghost:hover:not(:disabled) {
        background: var(--acp-bg-tertiary);
      }

      /* ---------- states ---------- */
      button:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }

      .spinner {
        display: inline-block;
        width: 1em;
        height: 1em;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: acp-spin 0.6s linear infinite;
      }

      @keyframes acp-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `,
  ];

  protected override render() {
    const classes = `variant-${this.variant} size-${this.size}`;
    const isDisabled = this.disabled || this.loading;

    return html`
      <button
        part="button"
        class=${classes}
        ?disabled=${isDisabled}
        aria-busy=${this.loading ? "true" : "false"}
        aria-disabled=${isDisabled ? "true" : "false"}
      >
        ${
          this.loading
            ? html`<span part="spinner" class="spinner" aria-hidden="true"></span>`
            : nothing
        }
        ${this.label ? this.label : html`<slot></slot>`}
      </button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-button": AcpButton;
  }
}
