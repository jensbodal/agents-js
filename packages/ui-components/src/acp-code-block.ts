import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A code block component with language badge, copy button, and themed styling.
 *
 * Uses Shadow DOM. Host-page CSS custom properties can still flow through
 * the shadow boundary.
 * Falls back gracefully if registration fails — textContent on the host
 * element remains visible as plain text.
 *
 * ## Theming
 *
 * Styleable via the `--acp-code-block-*` CSS custom property namespace
 * and the `header`, `filename`, `language`, `copy-btn`, `pre`, and `code`
 * shadow parts.
 *
 * Tokens (all default to the global `--acp-*` palette — preserves the
 * component's prior visual behavior on any host that themed via the
 * shared `--acp-*` tokens):
 * - `--acp-code-block-border`
 * - `--acp-code-block-radius`
 * - `--acp-code-block-font-size`
 * - `--acp-code-block-header-bg`
 * - `--acp-code-block-header-color`
 * - `--acp-code-block-header-padding`
 * - `--acp-code-block-font-family` (monospace)
 * - `--acp-code-block-bg`
 * - `--acp-code-block-color`
 * - `--acp-code-block-padding`
 * - `--acp-code-block-copy-btn-bg`
 * - `--acp-code-block-copy-btn-color`
 * - `--acp-code-block-copy-btn-hover-bg`
 * - `--acp-code-block-copy-btn-hover-color`
 *
 * Parts:
 * - `part="header"` — the header bar (only present when filename or
 *   language is set).
 * - `part="filename"` — the filename span.
 * - `part="language"` — the language badge span.
 * - `part="copy-btn"` — the copy-to-clipboard button.
 * - `part="pre"` — the `<pre>` block.
 * - `part="code"` — the inner `<code>` element.
 *
 * ### Obsidian-native token cleanup
 *
 * Prior revisions of this component read Obsidian-native CSS variables
 * (`--background-modifier-border`, `--text-muted`, `--font-monospace`)
 * directly. That made the component accidentally themed on Obsidian and
 * visually broken on non-Obsidian hosts. The current revision reads only
 * `--acp-*` tokens. Obsidian consumers should set the new
 * `--acp-code-block-*` (or global `--acp-*`) tokens on their plugin
 * container if they want to re-establish the cross-link with Obsidian's
 * palette.
 */
@safeCustomElement("acp-code-block")
export class AcpCodeBlock extends LitElement {
  @property({ type: String })
  accessor language = "";

  @property({ type: String })
  accessor code = "";

  @property({ type: String })
  accessor filename = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Default to the global --acp-*
         * palette so existing consumers inherit themed values. Obsidian
         * hosts that previously leaked Obsidian-native tokens directly
         * can map them into --acp-code-block-* at the plugin container
         * layer. */
        --acp-code-block-border: var(--acp-border);
        --acp-code-block-radius: 4px;
        --acp-code-block-font-size: 12px;
        --acp-code-block-header-bg: var(--acp-bg-secondary);
        --acp-code-block-header-color: var(--acp-text-muted);
        --acp-code-block-header-padding: 4px 8px;
        --acp-code-block-font-family: var(--acp-font-mono, ui-monospace, monospace);
        --acp-code-block-bg: var(--acp-bg);
        --acp-code-block-color: var(--acp-text);
        --acp-code-block-padding: 8px;
        --acp-code-block-copy-btn-bg: var(--acp-bg-tertiary);
        --acp-code-block-copy-btn-color: var(--acp-text-muted);
        --acp-code-block-copy-btn-hover-bg: var(--acp-border);
        --acp-code-block-copy-btn-hover-color: var(--acp-text);

        display: block;
        margin-top: 4px;
        border: 1px solid var(--acp-code-block-border);
        border-radius: var(--acp-code-block-radius);
        overflow: hidden;
        font-size: var(--acp-code-block-font-size);
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: var(--acp-code-block-header-padding);
        background-color: var(--acp-code-block-header-bg);
        border-bottom: 1px solid var(--acp-code-block-border);
        font-family: var(--acp-code-block-font-family);
        color: var(--acp-code-block-header-color);
        font-size: 11px;
      }
      .filename {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .language-badge {
        flex-shrink: 0;
        margin-left: 8px;
        opacity: 0.7;
      }
      .copy-btn {
        flex-shrink: 0;
        margin-left: 8px;
        padding: 2px 6px;
        border: none;
        border-radius: 3px;
        background: var(--acp-code-block-copy-btn-bg);
        color: var(--acp-code-block-copy-btn-color);
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
      }
      .copy-btn:hover {
        background: var(--acp-code-block-copy-btn-hover-bg);
        color: var(--acp-code-block-copy-btn-hover-color);
      }
      pre {
        margin: 0;
        padding: var(--acp-code-block-padding);
        overflow-x: auto;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: var(--acp-code-block-font-family);
        color: var(--acp-code-block-color);
        background: var(--acp-code-block-bg);
        line-height: 1.4;
      }
    `,
  ];

  private handleCopy(): void {
    const clip = (navigator as unknown as { clipboard?: { writeText(t: string): Promise<void> } })
      .clipboard;
    clip?.writeText(this.code).catch(() => {});
  }

  protected override render() {
    const showHeader = this.filename || this.language;
    return html`
      ${
        showHeader
          ? html`
            <div part="header" class="header">
              ${
                this.filename
                  ? html`<span part="filename" class="filename">${this.filename}</span>`
                  : html`<span part="language" class="language-badge">${this.language}</span>`
              }
              ${
                this.filename && this.language
                  ? html`<span part="language" class="language-badge">${this.language}</span>`
                  : ""
              }
              <button part="copy-btn" class="copy-btn" @click=${this.handleCopy}>Copy</button>
            </div>
          `
          : ""
      }
      <pre part="pre"><code part="code">${this.code}</code></pre>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-code-block": AcpCodeBlock;
  }
}
