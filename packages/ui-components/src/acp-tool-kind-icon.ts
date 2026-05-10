import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Renders a small icon glyph + accessible label keyed off the ACP
 * `ToolKind` enum (read / edit / execute / think / fetch / search /
 * delete / move / other). Used as a visual cue inside `acp-tool-call-detail`
 * so users can scan the tool stream by category at a glance.
 *
 * Glyphs are pure ASCII / Unicode characters — no font dependency.
 * Hosts that want themed colors can override `--acp-tool-kind-color-<kind>`
 * tokens.
 *
 * The kind value is a string so receivers see whatever the harness
 * reports — even unknown kinds the SDK adds in future versions render
 * with the `other` glyph and the raw kind as a tooltip rather than
 * crashing.
 */
@safeCustomElement("acp-tool-kind-icon")
export class AcpToolKindIcon extends LitElement {
  /** ACP `ToolKind` value. Unknown values fall back to the `other` glyph. */
  @property({ type: String })
  accessor kind = "other";

  static override styles = [
    acpTheme,
    css`
      :host {
        --acp-tool-kind-size: 16px;
        --acp-tool-kind-color-read: var(--acp-accent);
        --acp-tool-kind-color-edit: var(--acp-accent-gold);
        --acp-tool-kind-color-execute: var(--acp-success);
        --acp-tool-kind-color-think: var(--acp-accent-purple);
        --acp-tool-kind-color-fetch: var(--acp-accent);
        --acp-tool-kind-color-search: var(--acp-accent);
        --acp-tool-kind-color-delete: var(--acp-error);
        --acp-tool-kind-color-move: var(--acp-accent-gold);
        --acp-tool-kind-color-other: var(--acp-text-muted);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--acp-tool-kind-size);
        height: var(--acp-tool-kind-size);
        font-family: monospace;
        font-size: calc(var(--acp-tool-kind-size) * 0.8);
        line-height: 1;
      }
      .glyph {
        display: inline-block;
      }
      .glyph[data-kind="read"]    { color: var(--acp-tool-kind-color-read); }
      .glyph[data-kind="edit"]    { color: var(--acp-tool-kind-color-edit); }
      .glyph[data-kind="execute"] { color: var(--acp-tool-kind-color-execute); }
      .glyph[data-kind="think"]   { color: var(--acp-tool-kind-color-think); }
      .glyph[data-kind="fetch"]   { color: var(--acp-tool-kind-color-fetch); }
      .glyph[data-kind="search"]  { color: var(--acp-tool-kind-color-search); }
      .glyph[data-kind="delete"]  { color: var(--acp-tool-kind-color-delete); }
      .glyph[data-kind="move"]    { color: var(--acp-tool-kind-color-move); }
      .glyph[data-kind="other"]   { color: var(--acp-tool-kind-color-other); }
    `,
  ];

  override render() {
    const glyph = GLYPH_BY_KIND[this.kind] ?? GLYPH_BY_KIND.other;
    const dataKind = glyph === GLYPH_BY_KIND[this.kind] ? this.kind : "other";
    return html`<span
      part="glyph"
      class="glyph"
      data-kind=${dataKind}
      role="img"
      title=${this.kind}
      aria-label=${`tool kind: ${this.kind}`}
      >${glyph}</span
    >`;
  }
}

const GLYPH_BY_KIND: Record<string, string> = {
  read: "👁",
  edit: "✎",
  execute: "▶",
  think: "💭",
  fetch: "↓",
  search: "🔍",
  delete: "✕",
  move: "→",
  other: "•",
};

declare global {
  interface HTMLElementTagNameMap {
    "acp-tool-kind-icon": AcpToolKindIcon;
  }
}
