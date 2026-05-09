import { css, html, LitElement, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { acpInputStyles } from "./acp-input-styles.ts";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A themed text input component supporting single-line and multiline modes.
 *
 * Dispatches `acp-input` on every keystroke and `acp-change` on blur / commit.
 * Supports validation via `required`, `pattern` (regex string), and
 * `errorMessage` (custom message shown when validation fails).
 *
 * When `multiline` is true, renders a `<textarea>` instead of `<input>`.
 */
@safeCustomElement("acp-text-field")
export class AcpTextField extends LitElement {
  @property({ type: String })
  accessor value = "";

  @property({ type: String })
  accessor placeholder = "";

  @property({ type: Boolean, reflect: true })
  accessor disabled = false;

  @property({ type: String })
  accessor label = "";

  /** HTML input type. Ignored when `multiline`. */
  @property({ type: String })
  accessor type: "text" | "password" | "email" | "number" | "tel" | "url" | "search" = "text";

  @property({ type: Boolean })
  accessor multiline = false;

  @property({ type: Boolean })
  accessor required = false;

  /** Regex pattern string for client-side validation. */
  @property({ type: String })
  accessor pattern = "";

  /** Custom error message shown when validation fails. */
  @property({ type: String })
  accessor errorMessage = "";

  static override styles = [
    acpTheme,
    acpInputStyles,
    css`
      textarea {
        min-height: 80px;
        resize: vertical;
      }
    `,
  ];

  private _cachedPattern = "";
  private _cachedPatternRegex: RegExp | null = null;

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has("pattern")) {
      this._recompilePattern();
    }
  }

  private _recompilePattern(): void {
    if (this.pattern) {
      try {
        this._cachedPatternRegex = new RegExp(this.pattern);
      } catch {
        this._cachedPatternRegex = null;
      }
    } else {
      this._cachedPatternRegex = null;
    }
    this._cachedPattern = this.pattern;
  }

  private _getPatternRegex(): RegExp | null {
    if (this._cachedPattern !== this.pattern) {
      this._recompilePattern();
    }
    return this._cachedPatternRegex;
  }

  private _validate(val: string): boolean {
    if (this.required && !val.trim()) return false;
    const regex = this._getPatternRegex();
    if (regex) {
      return regex.test(val);
    }
    return true;
  }

  private _handleInput(e: Event): void {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    this.value = target.value;
    this.dispatchEvent(
      new CustomEvent("acp-input", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleChange(e: Event): void {
    const target = e.target as HTMLInputElement | HTMLTextAreaElement;
    this.value = target.value;
    this.dispatchEvent(
      new CustomEvent("acp-change", {
        detail: { value: this.value, valid: this._validate(this.value) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected override render() {
    const isValid = this._validate(this.value);
    const invalidClass = !isValid && this.value ? "invalid" : "";
    const showError = !isValid && this.value && this.errorMessage;

    return html`
      ${this.label ? html`<label>${this.label}</label>` : ""}
      ${
        this.multiline
          ? html`<textarea
              class=${invalidClass}
              placeholder=${this.placeholder}
              ?disabled=${this.disabled}
              ?required=${this.required}
              .value=${this.value}
              @input=${this._handleInput}
              @change=${this._handleChange}
              aria-invalid=${!isValid && this.value ? "true" : "false"}
              aria-label=${this.label || this.placeholder}
            ></textarea>`
          : html`<input
              class=${invalidClass}
              type=${this.type}
              placeholder=${this.placeholder}
              ?disabled=${this.disabled}
              ?required=${this.required}
              pattern=${this.pattern || ""}
              .value=${this.value}
              @input=${this._handleInput}
              @change=${this._handleChange}
              aria-invalid=${!isValid && this.value ? "true" : "false"}
              aria-label=${this.label || this.placeholder}
            />`
      }
      ${showError ? html`<div class="error-text" role="alert">${this.errorMessage}</div>` : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-text-field": AcpTextField;
  }
}
