import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Renders an ACP `Diff` content variant (file path + old text + new
 * text) as a unified diff with line-level prefixing. Lines that exist
 * only in `oldText` render as `-`, lines that exist only in `newText`
 * render as `+`, lines present in both are unchanged context.
 *
 * The diff algorithm is a minimal LCS-free pass: split both inputs by
 * `\n`, walk in lockstep, fall back to "all old removed then all new
 * added" when sequences diverge. Sufficient for ACP's typical use
 * (small file diffs the harness is about to apply); not a full
 * diff-match-patch. Hosts that need patience-diff or moved-line
 * detection should swap this component for a full diff library.
 *
 * Theming via `--acp-diff-block-*` tokens. Header shows the file path
 * as a code-formatted span; old/new sections each get their own
 * background tint pulled from the global error / success palette.
 */
@safeCustomElement("acp-diff-block")
export class AcpDiffBlock extends LitElement {
  /** File path the diff applies to. Rendered in the header. */
  @property({ type: String })
  accessor path = "";

  /** Original file text (the version on disk before the edit). */
  @property({ type: String })
  accessor oldText = "";

  /** Replacement file text (the version the harness wants to apply). */
  @property({ type: String })
  accessor newText = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        --acp-diff-block-border: var(--acp-border);
        --acp-diff-block-radius: 4px;
        --acp-diff-block-font: var(--acp-font, monospace);
        --acp-diff-block-font-size: 12px;
        --acp-diff-block-header-bg: var(--acp-bg-tertiary);
        --acp-diff-block-header-color: var(--acp-text);
        --acp-diff-block-add-bg: rgba(158, 206, 106, 0.12);
        --acp-diff-block-add-color: var(--acp-success);
        --acp-diff-block-remove-bg: rgba(247, 118, 142, 0.12);
        --acp-diff-block-remove-color: var(--acp-error);
        display: block;
        border: 1px solid var(--acp-diff-block-border);
        border-radius: var(--acp-diff-block-radius);
        font-family: var(--acp-diff-block-font);
        font-size: var(--acp-diff-block-font-size);
        overflow: hidden;
      }
      .header {
        background: var(--acp-diff-block-header-bg);
        color: var(--acp-diff-block-header-color);
        padding: 4px 8px;
        font-weight: 600;
      }
      .body {
        background: var(--acp-bg);
        color: var(--acp-text);
        padding: 4px 0;
        overflow-x: auto;
      }
      .line {
        display: flex;
        gap: 8px;
        padding: 0 8px;
        white-space: pre;
      }
      .line--add {
        background: var(--acp-diff-block-add-bg);
      }
      .line--add .marker {
        color: var(--acp-diff-block-add-color);
      }
      .line--remove {
        background: var(--acp-diff-block-remove-bg);
      }
      .line--remove .marker {
        color: var(--acp-diff-block-remove-color);
      }
      .marker {
        display: inline-block;
        width: 1ch;
        flex-shrink: 0;
        color: var(--acp-text-muted);
      }
      .text {
        flex: 1;
        word-break: break-all;
      }
    `,
  ];

  override render() {
    const lines = computeUnifiedDiff(this.oldText, this.newText);
    return html`
      ${this.path ? html`<div part="header" class="header">${this.path}</div>` : nothing}
      <div part="body" class="body">
        ${lines.map(
          (line) => html`
            <div class="line line--${line.kind}">
              <span class="marker">${markerFor(line.kind)}</span>
              <span class="text">${line.text}</span>
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-diff-block": AcpDiffBlock;
  }
}

interface DiffLine {
  kind: "context" | "add" | "remove";
  text: string;
}

function markerFor(kind: DiffLine["kind"]): string {
  if (kind === "add") return "+";
  if (kind === "remove") return "-";
  return " ";
}

/**
 * Minimal line-level diff. Walks the two line arrays in lockstep
 * marking equal lines as `context`. When a divergence appears, emits
 * all remaining old lines as `remove` and all remaining new lines as
 * `add` from the divergence point forward, then continues from the
 * common tail. Sufficient for the ACP "harness wants to apply this
 * edit" use case where old and new are usually almost-identical.
 */
function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.length === 0 ? [] : oldText.split("\n");
  const newLines = newText.length === 0 ? [] : newText.split("\n");
  const out: DiffLine[] = [];

  // Walk forward common prefix
  let i = 0;
  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) {
    out.push({ kind: "context", text: oldLines[i] ?? "" });
    i += 1;
  }

  // Walk backward common suffix from end of each side, but only as far
  // as the prefix walker reached.
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > i && newEnd > i && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  // Middle slice — emit all old as remove, all new as add. This is the
  // "diverged region" and matches the algorithm's documented limitation.
  for (let j = i; j < oldEnd; j += 1) {
    out.push({ kind: "remove", text: oldLines[j] ?? "" });
  }
  for (let j = i; j < newEnd; j += 1) {
    out.push({ kind: "add", text: newLines[j] ?? "" });
  }

  // Common suffix
  for (let j = oldEnd; j < oldLines.length; j += 1) {
    out.push({ kind: "context", text: oldLines[j] ?? "" });
  }

  return out;
}
