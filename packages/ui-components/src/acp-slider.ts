import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A themed range slider component with min/max/step constraints.
 *
 * Dispatches `acp-change` with `detail: { value: number }` whenever the
 * slider value changes. Displays an optional label and current value readout.
 */
@safeCustomElement("acp-slider")
export class AcpSlider extends LitElement {
  @property({ type: Number })
  accessor value = 50;

  @property({ type: Number })
  accessor min = 0;

  @property({ type: Number })
  accessor max = 100;

  @property({ type: Number })
  accessor step = 1;

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @property({ type: String })
  accessor label = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        display: block;
      }

      .header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 6px;
      }

      .label-text {
        font-size: 13px;
        font-weight: 500;
        color: var(--acp-text);
      }

      .value-readout {
        font-size: 12px;
        color: var(--acp-text-muted);
        font-family: var(--acp-font-mono, ui-monospace, monospace);
      }

      input[type="range"] {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 6px;
        border-radius: 3px;
        background: var(--acp-bg-tertiary);
        outline: none;
        transition: opacity 0.15s;
      }

      input[type="range"]:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      input[type="range"]::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--acp-accent);
        cursor: pointer;
        border: 2px solid var(--acp-bg);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
        transition: background 0.15s;
      }

      input[type="range"]::-webkit-slider-thumb:hover {
        background: var(--acp-accent-purple);
      }

      input[type="range"]::-moz-range-thumb {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--acp-accent);
        cursor: pointer;
        border: 2px solid var(--acp-bg);
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
      }
    `,
  ];

  private _handleInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.value = Number(target.value);
    this.dispatchEvent(
      new CustomEvent("acp-change", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected override render() {
    return html`
      ${
        this.label
          ? html`<div class="header">
              <span class="label-text">${this.label}</span>
              <span class="value-readout">${this.value}</span>
            </div>`
          : ""
      }
      <input
        type="range"
        .value=${String(this.value)}
        min=${this.min}
        max=${this.max}
        step=${this.step}
        ?disabled=${this.disabled}
        aria-label=${this.label || nothing}
        aria-valuemin=${this.min}
        aria-valuemax=${this.max}
        aria-valuenow=${this.value}
        @input=${this._handleInput}
      />
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-slider": AcpSlider;
  }
}
