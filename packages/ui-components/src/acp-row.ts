import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A flexbox row layout primitive.
 *
 * Renders its children in a horizontal flex container with configurable
 * `gap`, `align` (align-items), `justify` (justify-content), and `wrap`.
 *
 * All layout is applied to the host element itself so that slotted
 * children participate directly in the flex layout.
 */
@safeCustomElement("acp-row")
export class AcpRow extends LitElement {
  /** CSS gap value between children (e.g. `"8px"`, `"1rem"`). */
  @property({ type: String })
  accessor gap = "";

  /** CSS align-items value (e.g. `"center"`, `"stretch"`, `"flex-start"`). */
  @property({ type: String })
  accessor align = "";

  /** CSS justify-content value (e.g. `"center"`, `"space-between"`). */
  @property({ type: String })
  accessor justify = "";

  /** Whether children wrap to new lines. */
  @property({ type: Boolean })
  accessor wrap = false;

  static override styles = [
    acpTheme,
    css`
      :host {
        display: flex;
        flex-direction: row;
        gap: var(--acp-row-gap, 0);
        color: var(--acp-text);
        font-family: var(--acp-font, system-ui, -apple-system, sans-serif);
      }
    `,
  ];

  protected override render() {
    return html`<slot></slot>`;
  }

  protected override updated(): void {
    this.style.gap = this.gap || "";
    this.style.alignItems = this.align || "";
    this.style.justifyContent = this.justify || "";
    this.style.flexWrap = this.wrap ? "wrap" : "";
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-row": AcpRow;
  }
}
