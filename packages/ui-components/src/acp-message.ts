import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

// Ensure acp-code-block is registered (side-effect import)
import "./acp-code-block.ts";

type InlineToken =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "link"; text: string; url: string }
  | { type: "br" };

/**
 * Single-pass alternation across the inline markdown vocabulary:
 * inline code, bold, italic, link, and explicit newline. Regex with `|`
 * ordering is the natural fit — a hand-rolled scanner would reimplement
 * the same priority logic with much more code, and the ordering matters
 * because the bold pattern must win against the italic pattern.
 */
const INLINE_MARKDOWN_TOKEN_PATTERN =
  /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)|\n/g;

/**
 * A single chat message bubble with role-based styling.
 *
 * - User messages: right-aligned, plain text, --acp-text color.
 * - Agent messages: left-aligned, --acp-success color, with inline markdown:
 *   bold, italic, inline code, fenced code blocks (via `acp-code-block`),
 *   links, and line breaks.
 *
 * ## Theming
 *
 * Styleable via the `--acp-message-*` and `--acp-bubble-*` CSS custom
 * property namespaces, plus the `bubble`, `role-label`, and `copy-btn`
 * shadow parts.
 *
 * Tokens (all default to the global `--acp-*` palette + the pre-tokenization
 * hardcoded values, so existing consumers see no visual change):
 * - `--acp-message-padding`
 * - `--acp-bubble-max-width`
 * - `--acp-bubble-padding`
 * - `--acp-bubble-radius`
 * - `--acp-bubble-radius-tail` (asymmetric corner on the role-side)
 * - `--acp-bubble-font-size`
 * - `--acp-bubble-line-height`
 * - `--acp-bubble-user-bg`, `--acp-bubble-user-color`
 * - `--acp-bubble-agent-bg`, `--acp-bubble-agent-color`
 * - `--acp-role-label-font-size`
 * - `--acp-role-label-color-user`, `--acp-role-label-color-agent`
 *
 * Parts:
 * - `part="role-label"` — the role indicator span. Forwards
 *   `[data-role="user"]` / `[data-role="agent"]` for state-keyed CSS.
 * - `part="bubble"` — the message bubble container. Forwards
 *   `[data-role="user"]` / `[data-role="agent"]`.
 * - `part="copy-btn"` — the copy-to-clipboard button (agent messages only).
 */
@safeCustomElement("acp-message")
export class AcpMessage extends LitElement {
  /** Message author role. Named `messageRole` to avoid colliding with HTMLElement.role. */
  @property({ type: String, attribute: "role" })
  accessor messageRole: "user" | "agent" = "user";

  @property({ type: String })
  accessor text = "";

  @state()
  private accessor _copied = false;

  private _copyTimer: ReturnType<typeof setTimeout> | null = null;

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._copyTimer !== null) {
      clearTimeout(this._copyTimer);
      this._copyTimer = null;
    }
  }

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Defaults preserve pre-tokenization
         * visuals — host CSS can override any of these on an ancestor (or
         * the host element) to retheme the bubble without reaching into
         * shadow DOM. */
        --acp-message-padding: 4px 16px;

        --acp-bubble-max-width: 85%;
        --acp-bubble-padding: 10px 14px;
        --acp-bubble-radius: 12px;
        --acp-bubble-radius-tail: 4px;
        --acp-bubble-font-size: 14px;
        --acp-bubble-line-height: 1.6;

        --acp-bubble-user-bg: var(--acp-bg-tertiary);
        --acp-bubble-user-color: var(--acp-text);
        --acp-bubble-agent-bg: var(--acp-bg-secondary);
        --acp-bubble-agent-color: var(--acp-success);

        --acp-role-label-font-size: 11px;
        --acp-role-label-color-user: var(--acp-text-muted);
        --acp-role-label-color-agent: var(--acp-success);

        display: block;
        padding: var(--acp-message-padding);
      }
      .bubble {
        position: relative;
        max-width: var(--acp-bubble-max-width);
        padding: var(--acp-bubble-padding);
        border-radius: var(--acp-bubble-radius);
        font-size: var(--acp-bubble-font-size);
        line-height: var(--acp-bubble-line-height);
        word-break: break-word;
      }
      .copy-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        padding: 2px 8px;
        border: none;
        border-radius: 4px;
        background: var(--acp-bg-tertiary, #333);
        color: var(--acp-text-muted, #888);
        cursor: pointer;
        font-size: 11px;
        font-family: inherit;
        opacity: 0;
        transition: opacity 0.15s;
      }
      :host(:hover) .copy-btn {
        opacity: 1;
      }
      .copy-btn:hover {
        background: var(--acp-border, #444);
        color: var(--acp-text, #ccc);
      }
      .bubble--user {
        margin-left: auto;
        background: var(--acp-bubble-user-bg);
        color: var(--acp-bubble-user-color);
        border-bottom-right-radius: var(--acp-bubble-radius-tail);
        text-align: left;
      }
      .bubble--agent {
        margin-right: auto;
        background: var(--acp-bubble-agent-bg);
        color: var(--acp-bubble-agent-color);
        border-bottom-left-radius: var(--acp-bubble-radius-tail);
      }
      .role-label {
        display: block;
        font-size: var(--acp-role-label-font-size);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-bottom: 4px;
        opacity: 0.7;
      }
      .role-label--user {
        text-align: right;
        color: var(--acp-role-label-color-user);
      }
      .role-label--agent {
        color: var(--acp-role-label-color-agent);
      }

      /* Markdown inline styles */
      .bubble--agent strong { font-weight: 700; }
      .bubble--agent em { font-style: italic; }
      .bubble--agent code {
        padding: 1px 5px;
        border-radius: 3px;
        background: var(--acp-bg-tertiary);
        font-family: var(--acp-font-mono, ui-monospace, monospace);
        font-size: 0.9em;
      }
      .bubble--agent a {
        color: var(--acp-accent);
        text-decoration: underline;
        text-underline-offset: 2px;
      }
      .bubble--agent a:hover {
        color: var(--acp-accent-purple);
      }
    `,
  ];

  private _cachedText = "";
  private _cachedHtml: TemplateResult | null = null;

  private _handleCopy(): void {
    navigator.clipboard
      .writeText(this.text)
      .then(() => {
        this._copied = true;
        if (this._copyTimer !== null) clearTimeout(this._copyTimer);
        this._copyTimer = setTimeout(() => {
          this._copied = false;
          this._copyTimer = null;
        }, 1500);
      })
      .catch(() => {});
  }

  /**
   * Convert basic markdown to HTML for agent messages.
   * Handles: fenced code blocks, bold, italic, inline code, links, line breaks.
   */
  private _renderMarkdown(source: string): TemplateResult {
    // Split on fenced code blocks first. Accept end-of-input as a closing
    // fence so streaming deltas with an in-progress (unclosed) fence still
    // render as a code block instead of falling through to the inline
    // tokenizer, which would surface raw backticks in the UI. The non-greedy
    // `[\s\S]*?` naturally prefers the real ``` close when one is present.
    const fencedPattern = /```(\w*)\n([\s\S]*?)(?:```|$)/g;
    const parts: Array<
      { type: "text"; value: string } | { type: "code"; lang: string; code: string }
    > = [];
    let lastIndex = 0;

    // Use string.matchAll to iterate fenced code blocks
    for (const m of source.matchAll(fencedPattern)) {
      if (m.index > lastIndex) {
        parts.push({ type: "text", value: source.slice(lastIndex, m.index) });
      }
      parts.push({ type: "code", lang: m[1] ?? "", code: m[2] ?? "" });
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < source.length) {
      parts.push({ type: "text", value: source.slice(lastIndex) });
    }

    const rendered = parts.map((part) => {
      if (part.type === "code") {
        return html`<acp-code-block
          .language=${part.lang}
          .code=${part.code}
        ></acp-code-block>`;
      }
      // Inline markdown for text segments — tokenize then render via Lit templates
      const tokens = this._tokenizeInline(part.value);
      return this._renderInlineTokens(tokens);
    });

    return html`${rendered}`;
  }

  /**
   * Single-pass tokenizer for inline markdown.
   * Priority: code > bold > italic > link > newline.
   */
  _tokenizeInline(text: string): InlineToken[] {
    const tokens: InlineToken[] = [];
    let lastIndex = 0;

    // matchAll yields a fresh iterator each call (so the module-level
    // pattern's `lastIndex` state cannot leak between invocations) and
    // populates `index` on every yielded match per spec — no `?? 0`
    // fallback is needed (see the fenced-code block above for the same
    // pattern at line 230).
    for (const match of text.matchAll(INLINE_MARKDOWN_TOKEN_PATTERN)) {
      const matchIndex = match.index;
      if (matchIndex > lastIndex) {
        tokens.push({ type: "text", value: text.slice(lastIndex, matchIndex) });
      }

      if (match[1] != null) {
        tokens.push({ type: "code", value: match[1] });
      } else if (match[2] != null) {
        tokens.push({ type: "bold", value: match[2] });
      } else if (match[3] != null) {
        tokens.push({ type: "italic", value: match[3] });
      } else if (match[4] != null && match[5] != null) {
        tokens.push({ type: "link", text: match[4], url: match[5] });
      } else {
        tokens.push({ type: "br" });
      }

      lastIndex = matchIndex + match[0].length;
    }

    // Remaining text after last match
    if (lastIndex < text.length) {
      tokens.push({ type: "text", value: text.slice(lastIndex) });
    }

    return tokens;
  }

  /**
   * Map each inline token to a Lit html template.
   * All interpolation is auto-escaped by Lit — no unsafeHTML needed.
   */
  _renderInlineTokens(tokens: InlineToken[]): TemplateResult {
    const parts = tokens.map((token) => {
      if (token.type === "code") return html`<code>${token.value}</code>`;
      if (token.type === "bold") return html`<strong>${token.value}</strong>`;
      if (token.type === "italic") return html`<em>${token.value}</em>`;
      if (token.type === "br") return html`<br>`;
      if (token.type === "link") {
        const safeUrl = /^(https?:|mailto:)/i.test(token.url.trim()) ? token.url : "#";
        return html`<a href=${safeUrl} target="_blank" rel="noopener noreferrer">${token.text}</a>`;
      }
      return html`${token.value}`;
    });
    return html`${parts}`;
  }

  protected override render() {
    const isUser = this.messageRole === "user";
    const bubbleClass = isUser ? "bubble bubble--user" : "bubble bubble--agent";
    const labelClass = isUser ? "role-label role-label--user" : "role-label role-label--agent";

    let content: TemplateResult;
    if (isUser) {
      content = html`${this.text}`;
    } else {
      if (this.text !== this._cachedText || !this._cachedHtml) {
        this._cachedText = this.text;
        this._cachedHtml = this._renderMarkdown(this.text);
      }
      content = this._cachedHtml;
    }

    return html`
      <span part="role-label" data-role=${this.messageRole} class=${labelClass}>${this.messageRole}</span>
      <div part="bubble" data-role=${this.messageRole} class=${bubbleClass}>
        ${content}
        ${!isUser ? html`<button part="copy-btn" class="copy-btn" @click=${this._handleCopy}>${this._copied ? "Copied!" : "Copy"}</button>` : nothing}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-message": AcpMessage;
  }
}
