import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A flexbox column layout primitive.
 *
 * Renders its children in a vertical flex container with configurable
 * `gap`, `align` (align-items), and `justify` (justify-content).
 *
 * Layout styles are applied to the host element so that slotted
 * children participate directly in the flex layout.
 */
@safeCustomElement("acp-column")
export class AcpColumn extends LitElement {
  /** CSS gap value between children (e.g. `"8px"`, `"1rem"`). */
  @property({ type: String })
  accessor gap = "";

  /** CSS align-items value (e.g. `"center"`, `"stretch"`, `"flex-start"`). */
  @property({ type: String })
  accessor align = "";

  /** CSS justify-content value (e.g. `"center"`, `"space-between"`). */
  @property({ type: String })
  accessor justify = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--acp-column-gap, 0);
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
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-column": AcpColumn;
  }
}
