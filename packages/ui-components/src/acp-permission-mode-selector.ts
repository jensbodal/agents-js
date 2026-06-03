import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Default label copy for each mode. Consumers can override any subset via the
 * `labels` property; missing keys fall back to these values.
 */
export const DEFAULT_PERMISSION_MODE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  default: "Ask first",
  plan: "Plan first",
  acceptEdits: "Auto-approve edits",
  bypassPermissions: "Auto-approve all",
});

const PERMISSION_MODE_ORDER = ["default", "plan", "acceptEdits", "bypassPermissions"] as const;

/**
 * Compact dropdown for switching permission modes.
 *
 * Dispatches `acp-permission-mode-change` CustomEvent with `{ mode: string }`.
 *
 * Option copy is customizable via the `labels` property. Pass a partial record
 * keyed by canonical {@link PermissionMode} value to override any subset of the
 * defaults; unspecified keys fall back to {@link DEFAULT_PERMISSION_MODE_LABELS}.
 * The fixed four-mode option list is intentional — downstream consumers should
 * not reorder or extend the mode set via this component.
 *
 * ## Theming
 *
 * Styleable via the `--acp-select-*` CSS custom property namespace and the
 * `label` / `select` shadow parts.
 *
 * Tokens (all default to the global `--acp-*` palette for backwards
 * compatibility):
 * - `--acp-select-bg`
 * - `--acp-select-border`
 * - `--acp-select-color`
 * - `--acp-select-padding`
 * - `--acp-select-radius`
 * - `--acp-select-font-size`
 * - `--acp-select-focus-border`
 * - `--acp-select-label-color`
 * - `--acp-select-label-font-size`
 *
 * Parts:
 * - `part="label"` — the internal `<label>` element (only present when
 *   `hideLabel` is false).
 * - `part="select"` — the internal `<select>` element.
 *
 * Example (host CSS):
 * ```css
 * acp-permission-mode-selector[mode="default"]::part(select) {
 *   border-color: var(--color-green);
 * }
 * ```
 */
@safeCustomElement("acp-permission-mode-selector")
export class AcpPermissionModeSelector extends LitElement {
  @property({ type: String })
  accessor mode = "default";

  /**
   * Optional label overrides keyed by mode value. Triggers a re-render when
   * assigned (use a new object reference rather than mutating in place).
   * `attribute: false` because this is an object prop, not an HTML attribute.
   */
  @property({ attribute: false })
  accessor labels: Readonly<Record<string, string>> | null = null;

  /**
   * Suppress the internal `<label>` element. Use when the host is already
   * providing its own label (common in embedded layouts where the host
   * renders a shared uppercase label row above a trio of selectors).
   */
  @property({ type: Boolean })
  accessor hideLabel = false;

  /**
   * Visual variant. `"default"` renders the standalone-toolbar chrome
   * (padding, background, bottom border). `"embedded"` strips all host-level
   * chrome so the selector sits flush inside a host-owned container.
   *
   * Reflects to the `variant` HTML attribute so host CSS like
   * `acp-permission-mode-selector[variant="embedded"]` works.
   */
  @property({ type: String, reflect: true })
  accessor variant: "default" | "embedded" = "default";

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Default to global --acp-* palette so
         * existing consumers see no visual change. Hosts can override any
         * of these at the wrapper / host element to retheme the inner
         * <select> without reaching into shadow DOM. */
        --acp-select-bg: var(--acp-bg-secondary);
        --acp-select-border: var(--acp-border);
        --acp-select-color: var(--acp-text);
        --acp-select-padding: 3px 8px;
        --acp-select-radius: 4px;
        --acp-select-font-size: 12px;
        --acp-select-focus-border: var(--acp-accent);
        --acp-select-label-color: var(--acp-text-muted);
        --acp-select-label-font-size: 11px;

        display: flex;
        align-items: center;
        padding: 4px 16px;
        background: var(--acp-bg-secondary);
        border-bottom: 1px solid var(--acp-border);
      }

      /* Embedded variant strips the standalone-toolbar chrome so the
       * component sits flush in a host-owned container. */
      :host([variant="embedded"]) {
        padding: 0;
        background: transparent;
        border-bottom: none;
      }

      label {
        font-size: var(--acp-select-label-font-size);
        font-weight: 500;
        color: var(--acp-select-label-color);
        margin-right: 6px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }

      select {
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
    `,
  ];

  private _onChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value;
    this.dispatchEvent(
      new CustomEvent("acp-permission-mode-change", {
        bubbles: true,
        composed: true,
        detail: { mode: value },
      }),
    );
  }

  private _labelFor(value: string): string {
    return this.labels?.[value] ?? DEFAULT_PERMISSION_MODE_LABELS[value] ?? value;
  }

  protected override render() {
    return html`
      ${this.hideLabel ? html`` : html`<label part="label" for="perm-mode">Access</label>`}
      <select part="select" id="perm-mode" .value=${this.mode} @change=${this._onChange}>
        ${PERMISSION_MODE_ORDER.map(
          (value) => html`<option value=${value}>${this._labelFor(value)}</option>`,
        )}
      </select>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-permission-mode-selector": AcpPermissionModeSelector;
  }
}
