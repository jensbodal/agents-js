import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A themed image component with lazy loading, aspect ratio support,
 * and error fallback.
 *
 * When the image fails to load, a placeholder with the `alt` text
 * is displayed. The `loading` attribute defaults to `"lazy"` for
 * native browser lazy loading.
 */
@safeCustomElement("acp-image")
export class AcpImage extends LitElement {
  /** Image source URL. */
  @property({ type: String })
  accessor src = "";

  /** Alternative text for accessibility. */
  @property({ type: String })
  accessor alt = "";

  /** CSS width value (e.g. `"200px"`, `"100%"`). */
  @property({ type: String })
  accessor width = "";

  /** CSS height value (e.g. `"150px"`, `"auto"`). */
  @property({ type: String })
  accessor height = "";

  /** Native loading strategy: `"lazy"` (default) or `"eager"`. */
  @property({ type: String })
  accessor loading: "lazy" | "eager" = "lazy";

  /** CSS aspect-ratio value (e.g. `"16/9"`, `"1/1"`). */
  @property({ type: String, attribute: "aspect-ratio" })
  accessor aspectRatio = "";

  /** URL to show when the primary `src` fails to load. */
  @property({ type: String })
  accessor fallback = "";

  @state()
  private accessor _errored = false;

  static override styles = [
    acpTheme,
    css`
      :host {
        display: inline-block;
        overflow: hidden;
      }

      img {
        display: block;
        max-width: 100%;
        height: auto;
        object-fit: cover;
        border-radius: 4px;
      }

      .fallback {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--acp-bg-tertiary);
        color: var(--acp-text-muted);
        font-size: 13px;
        border-radius: 4px;
        min-height: 48px;
        padding: 12px;
        text-align: center;
        word-break: break-word;
      }
    `,
  ];

  private _handleError(): void {
    this._errored = true;
  }

  protected override render() {
    const imgStyle = [
      this.width ? `width:${this.width}` : "",
      this.height ? `height:${this.height}` : "",
      this.aspectRatio ? `aspect-ratio:${this.aspectRatio}` : "",
    ]
      .filter(Boolean)
      .join(";");

    const activeSrc = this._errored && this.fallback ? this.fallback : this.src;

    if (this._errored && !this.fallback) {
      return html`
        <div
          class="fallback"
          role="img"
          aria-label=${this.alt || "Image failed to load"}
          style=${imgStyle || nothing}
        >
          ${this.alt || "Image unavailable"}
        </div>
      `;
    }

    return html`
      <img
        src=${activeSrc}
        alt=${this.alt}
        loading=${this.loading}
        style=${imgStyle || nothing}
        @error=${this._handleError}
      />
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-image": AcpImage;
  }
}
