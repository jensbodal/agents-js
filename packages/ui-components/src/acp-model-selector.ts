import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import type { SessionModelsLike } from "./acp-types.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Dropdown for switching the active agent model.
 *
 * Dispatches `acp-model-change` CustomEvent with `{ modelId: string }`.
 *
 * ## Theming
 *
 * Shares the `--acp-select-*` CSS custom property namespace with
 * {@link AcpPermissionModeSelector} so a single host declaration themes
 * both components. Also exposes `label` and `select` shadow parts.
 *
 * Tokens (all default to the global `--acp-*` palette):
 * - `--acp-select-bg`
 * - `--acp-select-border`
 * - `--acp-select-color`
 * - `--acp-select-padding`
 * - `--acp-select-radius`
 * - `--acp-select-font-size`
 * - `--acp-select-focus-border`
 * - `--acp-select-label-color`
 * - `--acp-select-label-font-size`
 * - `--acp-model-select-min-width` (model-specific, defaults to 180px)
 *
 * Parts:
 * - `part="label"` — internal `<label>` (only present when `hideLabel` is false).
 * - `part="select"` — internal `<select>`.
 */
@safeCustomElement("acp-model-selector")
export class AcpModelSelector extends LitElement {
  @property({ attribute: false })
  accessor models: SessionModelsLike | null = null;

  @property({ type: Boolean })
  accessor disabled = false;

  /**
   * Suppress the internal `<label>` element. Use when the host is already
   * providing its own label (common in embedded layouts where the host
   * renders a shared uppercase label row above a trio of selectors).
   */
  @property({ type: Boolean })
  accessor hideLabel = false;

  /**
   * Visual variant. `"default"` uses the component's natural inline layout.
   * `"embedded"` strips any standalone chrome so the selector sits flush
   * inside a host-owned container. Added for parity with
   * {@link AcpPermissionModeSelector}.
   */
  @property({ type: String, reflect: true })
  accessor variant: "default" | "embedded" = "default";

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Shared --acp-select-* namespace with
         * acp-permission-mode-selector so a single host declaration themes
         * both. Defaults preserve pre-tokenization visuals. */
        --acp-select-bg: var(--acp-bg-secondary);
        --acp-select-border: var(--acp-border);
        --acp-select-color: var(--acp-text);
        --acp-select-padding: 3px 8px;
        --acp-select-radius: 4px;
        --acp-select-font-size: 12px;
        --acp-select-focus-border: var(--acp-accent);
        --acp-select-label-color: var(--acp-text-muted);
        --acp-select-label-font-size: 11px;
        --acp-model-select-min-width: 180px;

        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* Embedded variant is a no-op on layout here (this component has no
       * standalone chrome today), but we honor the attribute for API parity
       * with acp-permission-mode-selector. Host CSS can still hang
       * overrides off [variant="embedded"]. */
      :host([variant="embedded"]) {
        padding: 0;
      }

      label {
        font-size: var(--acp-select-label-font-size);
        font-weight: 500;
        color: var(--acp-select-label-color);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      select {
        min-width: var(--acp-model-select-min-width);
        padding: var(--acp-select-padding);
        background: var(--acp-select-bg);
        border: 1px solid var(--acp-select-border);
        border-radius: var(--acp-select-radius);
        color: var(--acp-select-color);
        font-size: var(--acp-select-font-size);
        font-family: inherit;
        cursor: pointer;
        outline: none;
        transition: border-color 0.15s;
      }

      select:focus {
        border-color: var(--acp-select-focus-border);
      }

      select:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ];

  private _onChange(event: Event): void {
    const modelId = (event.target as HTMLSelectElement).value;
    this.dispatchEvent(
      new CustomEvent("acp-model-change", {
        bubbles: true,
        composed: true,
        detail: { modelId },
      }),
    );
  }

  protected override render() {
    if (!this.models || this.models.availableModels.length === 0) {
      return html``;
    }

    return html`
      ${this.hideLabel ? html`` : html`<label part="label" for="model-selector">Model</label>`}
      <select
        part="select"
        id="model-selector"
        .value=${this.models.currentModelId}
        ?disabled=${this.disabled}
        @change=${this._onChange}
      >
        ${this.models.availableModels.map(
          (model) => html`
            <option value=${model.modelId}>${model.name ?? model.modelId}</option>
          `,
        )}
      </select>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-model-selector": AcpModelSelector;
  }
}
