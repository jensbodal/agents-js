import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Write gate modal overlay for file write approval.
 *
 * Shows the file path and a unified diff so the user can review what
 * the agent wants to write.
 *
 * Dispatches `acp-write-gate-response` CustomEvent with
 * `{ action: "approve" | "reject" | "allow_folder", folder?: string }`.
 *
 * ## Theming
 *
 * Modal-class component: primary mechanism is P2 shadow parts; P1 tokens
 * handle color overrides. Shares the `--acp-modal-*` namespace with
 * {@link AcpPermissionModal} so a single host declaration themes both.
 *
 * Tokens (default to pre-tokenization hardcoded values and the global
 * `--acp-*` palette):
 * - `--acp-modal-backdrop-bg`, `--acp-modal-backdrop-blur`
 * - `--acp-modal-card-bg`, `--acp-modal-card-border`,
 *   `--acp-modal-card-radius`, `--acp-modal-card-padding`,
 *   `--acp-modal-card-max-width`, `--acp-modal-card-shadow`
 *
 * Parts:
 * - `part="card"` — the modal card container.
 * - `part="header"` — the `<h2>` card header.
 * - `part="file-path"` — the file-path banner.
 * - `part="diff-area"` — the diff container.
 * - `part="actions"` — the footer action row.
 * - `part="btn-reject"`, `part="btn-allow-folder"`, `part="btn-approve"` —
 *   individual action buttons.
 */
@safeCustomElement("acp-write-gate-modal")
export class AcpWriteGateModal extends LitElement {
  @property({ type: String })
  accessor path = "";

  @property({ type: String })
  accessor diff = "";

  @property({ type: String })
  accessor closestParentFolder = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Shared --acp-modal-* namespace with
         * acp-permission-modal so a single host declaration themes both.
         * Defaults preserve pre-tokenization visuals. */
        --acp-modal-backdrop-bg: rgba(0, 0, 0, 0.6);
        --acp-modal-backdrop-blur: 4px;
        --acp-modal-card-bg: var(--acp-bg-secondary);
        --acp-modal-card-border: var(--acp-border);
        --acp-modal-card-radius: 12px;
        --acp-modal-card-padding: 24px 28px;
        --acp-modal-card-max-width: 500px;
        --acp-modal-card-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);

        display: flex;
        align-items: center;
        justify-content: center;
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: var(--acp-modal-backdrop-bg);
        backdrop-filter: blur(var(--acp-modal-backdrop-blur));
      }

      .card {
        background: var(--acp-modal-card-bg);
        border: 1px solid var(--acp-modal-card-border);
        border-radius: var(--acp-modal-card-radius);
        padding: var(--acp-modal-card-padding);
        max-width: var(--acp-modal-card-max-width);
        width: 100%;
        box-shadow: var(--acp-modal-card-shadow);
      }

      .header {
        margin: 0 0 16px;
        font-size: 16px;
        font-weight: 700;
        color: var(--acp-text);
      }

      .file-path {
        margin: 0 0 16px;
        padding: 8px 12px;
        background: var(--acp-bg-secondary);
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        font-family: var(--acp-font-mono, ui-monospace, monospace);
        font-size: 13px;
        color: var(--acp-text);
        word-break: break-all;
      }

      .diff-area {
        margin: 0 0 16px;
        padding: 10px 12px;
        background: var(--acp-bg);
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        max-height: 300px;
        overflow: auto;
      }

      .diff-area pre {
        margin: 0;
        font-family: var(--acp-font-mono, ui-monospace, monospace);
        font-size: 12px;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-all;
      }

      .diff-line-add {
        color: var(--acp-success, #9ece6a);
      }

      .diff-line-remove {
        color: var(--acp-error, #f7768e);
      }

      .diff-line-hunk {
        color: var(--acp-accent, #7aa2f7);
      }

      .diff-line-header {
        color: var(--acp-text-muted);
      }

      .diff-line-context {
        color: var(--acp-text);
      }

      .no-changes {
        color: var(--acp-text-muted);
        font-style: italic;
        font-size: 13px;
      }

      .actions {
        display: flex;
        gap: 8px;
        padding-top: 16px;
        border-top: 1px solid var(--acp-border);
      }

      button {
        padding: 8px 18px;
        border: 1px solid var(--acp-border);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s, border-color 0.15s;
      }

      .btn-reject {
        background: transparent;
        color: var(--acp-error);
        border-color: color-mix(in srgb, var(--acp-error) 40%, var(--acp-border));
      }

      .btn-reject:hover {
        background: color-mix(in srgb, var(--acp-error) 10%, transparent);
      }

      .btn-allow-folder {
        background: transparent;
        color: var(--acp-accent-gold, #e0af68);
        border-color: var(--acp-accent-gold, #e0af68);
      }

      .btn-allow-folder:hover {
        background: color-mix(in srgb, var(--acp-accent-gold) 10%, transparent);
      }

      .btn-approve {
        margin-left: auto;
        background: var(--acp-accent);
        color: var(--acp-bg);
        border-color: var(--acp-accent);
      }

      .btn-approve:hover {
        filter: brightness(1.1);
      }
    `,
  ];

  private _dispatch(action: "approve" | "reject" | "allow_folder"): void {
    const detail: { action: string; folder?: string } = { action };
    if (action === "allow_folder") {
      detail.folder = this.closestParentFolder;
    }
    this.dispatchEvent(
      new CustomEvent("acp-write-gate-response", {
        bubbles: true,
        composed: true,
        detail,
      }),
    );
  }

  private _renderDiffLines() {
    if (!this.diff.trim()) {
      return html`<span class="no-changes">(no changes)</span>`;
    }

    const lines = this.diff.split("\n");
    return html`<pre>${lines.map((line) => {
      let cls = "diff-line-context";
      if (line.startsWith("+++") || line.startsWith("---")) {
        cls = "diff-line-header";
      } else if (line.startsWith("@@")) {
        cls = "diff-line-hunk";
      } else if (line.startsWith("+")) {
        cls = "diff-line-add";
      } else if (line.startsWith("-")) {
        cls = "diff-line-remove";
      }
      return html`<span class=${cls}>${line}\n</span>`;
    })}</pre>`;
  }

  protected override render() {
    return html`
      <div part="card" class="card">
        <h2 part="header" class="header">Review Write</h2>

        <div part="file-path" class="file-path">${this.path}</div>

        <div part="diff-area" class="diff-area">
          ${this._renderDiffLines()}
        </div>

        <div part="actions" class="actions">
          <button part="btn-reject" class="btn-reject" @click=${() => this._dispatch("reject")}>
            Reject
          </button>

          ${
            this.closestParentFolder
              ? html`
                <button
                  part="btn-allow-folder"
                  class="btn-allow-folder"
                  @click=${() => this._dispatch("allow_folder")}
                >
                  Allow ${this.closestParentFolder}/
                </button>
              `
              : nothing
          }

          <button part="btn-approve" class="btn-approve" @click=${() => this._dispatch("approve")}>
            Accept
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-write-gate-modal": AcpWriteGateModal;
  }
}
