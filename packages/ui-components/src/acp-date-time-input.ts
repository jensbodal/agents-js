import { html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpInputStyles } from "./acp-input-styles.ts";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A themed date/time input component supporting date, time, and datetime modes.
 *
 * The `mode` property controls which HTML input type is rendered:
 *   - `"date"` → `<input type="date">`
 *   - `"time"` → `<input type="time">`
 *   - `"datetime"` → `<input type="datetime-local">`
 *
 * Dispatches `acp-change` with `detail: { value: string }` (ISO 8601 format)
 * whenever the value changes.
 */
@safeCustomElement("acp-date-time-input")
export class AcpDateTimeInput extends LitElement {
  @property({ type: String })
  accessor value = "";

  /** Input mode: "date", "time", or "datetime". */
  @property({ type: String })
  accessor mode: "date" | "time" | "datetime" = "datetime";

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @property({ type: String })
  accessor label = "";

  /** Minimum allowed value (ISO 8601 string). */
  @property({ type: String })
  accessor min = "";

  /** Maximum allowed value (ISO 8601 string). */
  @property({ type: String })
  accessor max = "";

  static override styles = [acpTheme, acpInputStyles];

  private _inputType(): string {
    if (this.mode === "date") return "date";
    if (this.mode === "time") return "time";
    return "datetime-local";
  }

  private _handleInput(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.value = target.value;
  }

  private _handleChange(e: Event): void {
    const target = e.target as HTMLInputElement;
    this.value = target.value;
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
      ${this.label ? html`<label>${this.label}</label>` : ""}
      <input
        type=${this._inputType()}
        .value=${this.value}
        min=${this.min || ""}
        max=${this.max || ""}
        ?disabled=${this.disabled}
        aria-label=${this.label || nothing}
        @change=${this._handleChange}
        @input=${this._handleInput}
      />
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-date-time-input": AcpDateTimeInput;
  }
}
