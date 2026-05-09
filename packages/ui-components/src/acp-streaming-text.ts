import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Renders streaming agent text with an animated blinking cursor at the end.
 *
 * ## Theming
 *
 * Styleable via the `--acp-streaming-*` CSS custom property namespace and
 * the `text` / `cursor` shadow parts.
 *
 * Tokens (all default to the global `--acp-*` palette + pre-tokenization
 * hardcoded values):
 * - `--acp-streaming-padding`
 * - `--acp-streaming-color`
 * - `--acp-streaming-font-size`
 * - `--acp-streaming-line-height`
 * - `--acp-streaming-cursor-bg`
 * - `--acp-streaming-cursor-width`
 *
 * Parts:
 * - `part="text"` — the text span.
 * - `part="cursor"` — the animated blinking cursor span.
 */
@safeCustomElement("acp-streaming-text")
export class AcpStreamingText extends LitElement {
  @property({ type: String })
  accessor text = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Defaults preserve pre-tokenization
         * visuals. Hosts override by setting any of these on a parent or
         * the host element. */
        --acp-streaming-padding: 8px 16px;
        --acp-streaming-color: var(--acp-success);
        --acp-streaming-font-size: 14px;
        --acp-streaming-line-height: 1.6;
        --acp-streaming-cursor-bg: var(--acp-success);
        --acp-streaming-cursor-width: 2px;

        display: block;
        padding: var(--acp-streaming-padding);
        color: var(--acp-streaming-color);
        font-size: var(--acp-streaming-font-size);
        line-height: var(--acp-streaming-line-height);
        white-space: pre-wrap;
        word-break: break-word;
      }
      .cursor {
        display: inline-block;
        width: var(--acp-streaming-cursor-width);
        height: 1em;
        margin-left: 1px;
        background: var(--acp-streaming-cursor-bg);
        vertical-align: text-bottom;
        animation: blink 0.8s step-end infinite;
      }
      @keyframes blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0; }
      }
    `,
  ];

  protected override render() {
    return html`<span part="text">${this.text}</span><span part="cursor" class="cursor"></span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-streaming-text": AcpStreamingText;
  }
}
