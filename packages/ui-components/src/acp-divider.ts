import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A themed divider (separator) component supporting horizontal and vertical
 * orientations.
 *
 * Renders a thin rule using `role="separator"` in the shadow DOM.
 * The `orientation` property controls direction: `"horizontal"` (default)
 * or `"vertical"`. The `spacing` property adds margin around the divider.
 */
@safeCustomElement("acp-divider")
export class AcpDivider extends LitElement {
  /** Direction of the divider. */
  @property({ type: String, reflect: true })
  accessor orientation: "horizontal" | "vertical" = "horizontal";

  /** CSS margin value around the divider (e.g. `"8px"`, `"16px 0"`). */
  @property({ type: String })
  accessor spacing = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        display: block;
      }

      :host([orientation="vertical"]) {
        display: inline-block;
        height: 100%;
      }

      .divider {
        border: none;
        margin: 0;
        padding: 0;
      }

      /* Horizontal (default) */
      :host([orientation="horizontal"]) .divider,
      .divider {
        width: 100%;
        height: 1px;
        background: var(--acp-border);
      }

      /* Vertical */
      :host([orientation="vertical"]) .divider {
        width: 1px;
        height: 100%;
        min-height: 16px;
        background: var(--acp-border);
      }
    `,
  ];

  protected override render() {
    const style = this.spacing ? `margin:${this.spacing}` : "";

    return html`
      <div
        class="divider"
        role="separator"
        aria-orientation=${this.orientation}
        style=${style || nothing}
      ></div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-divider": AcpDivider;
  }
}
