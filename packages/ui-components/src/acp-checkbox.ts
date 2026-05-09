import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A themed checkbox component with checked, unchecked, and indeterminate states.
 *
 * Dispatches `acp-change` with `detail: { checked: boolean }` when toggled.
 * When `indeterminate` is true, the checkbox displays a dash indicator and
 * its native indeterminate visual state is applied.
 */
@safeCustomElement("acp-checkbox")
export class AcpCheckbox extends LitElement {
  @property({ type: Boolean, reflect: true })
  accessor checked = false;

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @property({ type: String })
  accessor label = "";

  @property({ type: Boolean, reflect: true })
  accessor indeterminate = false;

  static override styles = [
    acpTheme,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
      }

      :host([disabled]) {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .checkbox-wrapper {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border: 2px solid var(--acp-border);
        border-radius: 4px;
        background: var(--acp-bg);
        transition: background 0.15s, border-color 0.15s;
        flex-shrink: 0;
      }

      :host([checked]) .checkbox-wrapper,
      :host([indeterminate]) .checkbox-wrapper {
        background: var(--acp-accent);
        border-color: var(--acp-accent);
      }

      .checkmark {
        display: none;
        color: var(--acp-bg);
        font-size: 12px;
        line-height: 1;
      }

      :host([checked]) .checkmark--check {
        display: block;
      }

      :host([indeterminate]) .checkmark--dash {
        display: block;
      }

      .label-text {
        font-size: 14px;
        color: var(--acp-text);
        user-select: none;
      }

      /* Hidden native input for a11y */
      input {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
    `,
  ];

  private _handleClick(): void {
    if (this.disabled) return;
    this.indeterminate = false;
    this.checked = !this.checked;
    this.dispatchEvent(
      new CustomEvent("acp-change", {
        detail: { checked: this.checked },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleKeydown(e: KeyboardEvent): void {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this._handleClick();
    }
  }

  protected override render() {
    return html`
      <div
        class="checkbox-wrapper"
        role="checkbox"
        tabindex=${this.disabled ? -1 : 0}
        aria-checked=${this.indeterminate ? "mixed" : this.checked ? "true" : "false"}
        aria-disabled=${this.disabled ? "true" : "false"}
        aria-label=${this.label || nothing}
        @click=${this._handleClick}
        @keydown=${this._handleKeydown}
      >
        <span class="checkmark checkmark--check" aria-hidden="true">✓</span>
        <span class="checkmark checkmark--dash" aria-hidden="true">–</span>
        <input
          type="checkbox"
          tabindex="-1"
          .checked=${this.checked}
          .indeterminate=${this.indeterminate}
          ?disabled=${this.disabled}
          aria-hidden="true"
        />
      </div>
      ${this.label ? html`<span class="label-text">${this.label}</span>` : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-checkbox": AcpCheckbox;
  }
}
