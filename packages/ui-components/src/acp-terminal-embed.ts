import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Renders an ACP `Terminal` content variant as a read-only terminal
 * snapshot — monospace, dark background, optional command and exit
 * code in the header. This is the "tool produced terminal output"
 * surface for tool-call detail, distinct from the live xterm-style
 * UI a host might wire for an interactive command.
 *
 * Output is rendered as plain text (preserving newlines + spaces);
 * ANSI escape sequences pass through visually rather than being
 * stripped or interpreted. Hosts that need ANSI rendering can swap
 * this component for one that runs the output through xterm.js.
 *
 * Theming via `--acp-terminal-embed-*` tokens.
 */
@safeCustomElement("acp-terminal-embed")
export class AcpTerminalEmbed extends LitElement {
  /** Optional command string the terminal session ran. Rendered in the header. */
  @property({ type: String })
  accessor command = "";

  /** Optional exit code from the terminal session. Rendered in the header. */
  @property({ type: Number })
  accessor exitCode: number | undefined;

  /** Captured terminal output (stdout + stderr concatenated as the
   *  harness reported it). */
  @property({ type: String })
  accessor output = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        --acp-terminal-embed-border: var(--acp-border);
        --acp-terminal-embed-radius: 4px;
        --acp-terminal-embed-bg: #000;
        --acp-terminal-embed-color: #ddd;
        --acp-terminal-embed-font: var(--acp-font, monospace);
        --acp-terminal-embed-font-size: 12px;
        --acp-terminal-embed-header-bg: var(--acp-bg-tertiary);
        --acp-terminal-embed-header-color: var(--acp-text);
        --acp-terminal-embed-exit-ok-color: var(--acp-success);
        --acp-terminal-embed-exit-fail-color: var(--acp-error);
        display: block;
        border: 1px solid var(--acp-terminal-embed-border);
        border-radius: var(--acp-terminal-embed-radius);
        font-family: var(--acp-terminal-embed-font);
        font-size: var(--acp-terminal-embed-font-size);
        overflow: hidden;
      }
      .header {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        background: var(--acp-terminal-embed-header-bg);
        color: var(--acp-terminal-embed-header-color);
        padding: 4px 8px;
      }
      .command {
        flex: 1;
        font-weight: 600;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .exit {
        flex-shrink: 0;
      }
      .exit--ok {
        color: var(--acp-terminal-embed-exit-ok-color);
      }
      .exit--fail {
        color: var(--acp-terminal-embed-exit-fail-color);
      }
      pre {
        margin: 0;
        padding: 8px;
        background: var(--acp-terminal-embed-bg);
        color: var(--acp-terminal-embed-color);
        white-space: pre-wrap;
        word-break: break-all;
      }
    `,
  ];

  override render() {
    const hasHeader = this.command !== "" || this.exitCode !== undefined;
    return html`
      ${
        hasHeader
          ? html`
            <div part="header" class="header">
              <span class="command">${this.command || "(no command)"}</span>
              ${
                this.exitCode !== undefined
                  ? html`<span class="exit ${this.exitCode === 0 ? "exit--ok" : "exit--fail"}"
                    >exit ${this.exitCode}</span
                  >`
                  : nothing
              }
            </div>
          `
          : nothing
      }
      <pre part="output">${this.output}</pre>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-terminal-embed": AcpTerminalEmbed;
  }
}
