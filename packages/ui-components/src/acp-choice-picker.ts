import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

export interface AcpChoiceOption {
  value: string;
  label: string;
}

/**
 * A themed choice picker component supporting single-select and multi-select.
 *
 * In single-select mode (`multiple=false`, default), behaves like a radio group.
 * In multi-select mode (`multiple=true`), behaves like a checkbox group.
 *
 * Options are provided via the `options` property as `Array<{ value, label }>`.
 * The `value` property is a `string` (single) or `string[]` (multi).
 *
 * Dispatches `acp-change` with `detail: { value: string | string[] }`.
 * Supports keyboard navigation: Arrow keys move focus, Space/Enter select.
 */
@safeCustomElement("acp-choice-picker")
export class AcpChoicePicker extends LitElement {
  @property({ attribute: false })
  accessor options: AcpChoiceOption[] = [];

  @property({ attribute: false })
  accessor value: string | string[] = "";

  @property({ type: Boolean })
  accessor multiple = false;

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

      .group-label {
        display: block;
        margin-bottom: 6px;
        font-size: 13px;
        font-weight: 500;
        color: var(--acp-text);
      }

      .options-list {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .option {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.1s;
        font-size: 14px;
        color: var(--acp-text);
      }

      .option:hover:not(.option--disabled) {
        background: var(--acp-bg-tertiary);
      }

      .option--selected {
        background: color-mix(in srgb, var(--acp-accent) 12%, transparent);
      }

      .option--disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .option:focus-visible {
        outline: 2px solid var(--acp-accent);
        outline-offset: -2px;
      }

      .indicator {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border: 2px solid var(--acp-border);
        flex-shrink: 0;
        transition: background 0.15s, border-color 0.15s;
      }

      .indicator--radio {
        border-radius: 50%;
      }

      .indicator--checkbox {
        border-radius: 3px;
      }

      .option--selected .indicator {
        background: var(--acp-accent);
        border-color: var(--acp-accent);
      }

      .indicator-mark {
        display: none;
        color: var(--acp-bg);
        font-size: 10px;
        line-height: 1;
      }

      .option--selected .indicator-mark {
        display: block;
      }

      .indicator--radio .indicator-mark {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--acp-bg);
      }
    `,
  ];

  private _isSelected(optionValue: string): boolean {
    if (this.multiple && Array.isArray(this.value)) {
      return this.value.includes(optionValue);
    }
    return this.value === optionValue;
  }

  private _select(optionValue: string): void {
    if (this.disabled) return;

    if (this.multiple) {
      const current = Array.isArray(this.value) ? [...this.value] : [];
      const idx = current.indexOf(optionValue);
      if (idx >= 0) {
        current.splice(idx, 1);
      } else {
        current.push(optionValue);
      }
      this.value = current;
    } else {
      this.value = optionValue;
    }

    this.dispatchEvent(
      new CustomEvent("acp-change", {
        detail: { value: this.value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleKeydown(e: KeyboardEvent, optionValue: string): void {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      this._select(optionValue);
      return;
    }

    const options = this.renderRoot?.querySelectorAll(".option");
    if (!options) return;

    const items = Array.from(options) as HTMLElement[];
    const currentIdx = items.indexOf(e.currentTarget as HTMLElement);

    let nextIdx = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      nextIdx = (currentIdx + 1) % items.length;
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      nextIdx = (currentIdx - 1 + items.length) % items.length;
    }

    const nextItem = nextIdx >= 0 ? items[nextIdx] : undefined;
    if (nextItem) {
      nextItem.focus();
    }
  }

  protected override render() {
    const role = this.multiple ? "group" : "radiogroup";
    const optionRole = this.multiple ? "checkbox" : "radio";
    const indicatorType = this.multiple ? "checkbox" : "radio";

    return html`
      ${this.label ? html`<span class="group-label" id="group-label">${this.label}</span>` : nothing}
      <div
        class="options-list"
        role=${role}
        aria-labelledby=${this.label ? "group-label" : nothing}
      >
        ${this.options.map(
          (opt) => html`
            <div
              class="option ${this._isSelected(opt.value) ? "option--selected" : ""} ${this.disabled ? "option--disabled" : ""}"
              role=${optionRole}
              tabindex=${this.disabled ? -1 : 0}
              aria-checked=${this._isSelected(opt.value) ? "true" : "false"}
              aria-disabled=${this.disabled ? "true" : "false"}
              @click=${() => this._select(opt.value)}
              @keydown=${(e: KeyboardEvent) => this._handleKeydown(e, opt.value)}
            >
              <span class="indicator indicator--${indicatorType}">
                ${
                  indicatorType === "radio"
                    ? html`<span class="indicator-mark"></span>`
                    : html`<span class="indicator-mark" aria-hidden="true">✓</span>`
                }
              </span>
              <span>${opt.label}</span>
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-choice-picker": AcpChoicePicker;
  }
}
