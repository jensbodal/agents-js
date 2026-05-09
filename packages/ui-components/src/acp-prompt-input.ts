import { css, html, LitElement } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import type { PromptHistoryStore } from "./prompt-history-store.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A prompt input with a textarea and send button.
 *
 * Dispatches `acp-send` CustomEvent with `detail: { text: string }`
 * when the user clicks send or presses Enter (Shift+Enter for newline).
 * Clears the textarea after sending. Supports a `disabled` prop.
 */
@safeCustomElement("acp-prompt-input")
export class AcpPromptInput extends LitElement {
  @property({ type: Boolean })
  accessor disabled = false;

  /** True while a prompt is being processed — shows Cancel instead of Send. */
  @property({ type: Boolean })
  accessor inflight = false;

  @property({ attribute: false })
  accessor history: PromptHistoryStore | undefined;

  @property({ type: String })
  accessor placeholder = "Type a message...";

  @property({ type: String })
  accessor helperText = "";

  static override styles = [
    acpTheme,
    css`
      :host {
        display: block;
        padding: 12px 16px;
        background: var(--acp-bg-secondary);
        border-top: 1px solid var(--acp-border);
      }
      .input-row {
        display: flex;
        gap: 8px;
        align-items: flex-end;
      }
      .helper {
        margin-bottom: 8px;
        color: var(--acp-text-muted);
        font-size: 12px;
        line-height: 1.5;
      }
      textarea {
        flex: 1;
        min-height: 40px;
        max-height: 160px;
        padding: 10px 12px;
        border: 1px solid var(--acp-border);
        border-radius: 8px;
        background: var(--acp-bg);
        color: var(--acp-text);
        font-family: inherit;
        font-size: 14px;
        line-height: 1.5;
        resize: none;
        outline: none;
        transition: border-color 0.15s;
      }
      textarea:focus {
        border-color: var(--acp-accent);
      }
      textarea:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .send-btn {
        flex-shrink: 0;
        padding: 10px 20px;
        border: none;
        border-radius: 8px;
        background: var(--acp-accent);
        color: var(--acp-bg);
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, opacity 0.15s;
      }
      .send-btn:hover:not(:disabled) {
        background: var(--acp-accent-purple);
      }
      .send-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .cancel-btn {
        flex-shrink: 0;
        padding: 10px 20px;
        border: none;
        border-radius: 8px;
        background: var(--acp-error, #e53e3e);
        color: #fff;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s, opacity 0.15s;
      }
      .cancel-btn:hover {
        opacity: 0.85;
      }
    `,
  ];

  private _getTextarea(): HTMLTextAreaElement | null {
    return this.renderRoot?.querySelector("textarea") ?? null;
  }

  private _cancel(): void {
    this.dispatchEvent(
      new CustomEvent("acp-cancel", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _send(): void {
    if (this.disabled || this.inflight) return;
    const ta = this._getTextarea();
    if (!ta) return;
    const text = ta.value.trim();
    if (!text) return;

    this.dispatchEvent(
      new CustomEvent("acp-send", {
        detail: { text },
        bubbles: true,
        composed: true,
      }),
    );

    ta.value = "";
    this.history?.push(text);
    this._autoResize();
  }

  private _handleKeydown(e: KeyboardEvent): void {
    if (this.history && this._handleHistoryKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this._send();
    }
  }

  private _handleHistoryKeydown(e: KeyboardEvent): boolean {
    const ta = this._getTextarea();
    if (!ta || !this.history || this.history.length === 0) return false;

    if (e.key === "ArrowUp" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      const result = this.history.navigateUp(ta.value);
      if (result) {
        e.preventDefault();
        ta.value = result.value;
        ta.selectionStart = ta.selectionEnd = result.cursorPosition;
        this._autoResize();
      }
      return true;
    }

    if (e.key === "ArrowDown" && this.history.isNavigating) {
      if (ta.selectionStart !== ta.value.length) return false;
      const result = this.history.navigateDown();
      if (result) {
        e.preventDefault();
        ta.value = result.value;
        ta.selectionStart = ta.selectionEnd = result.cursorPosition;
        this._autoResize();
      }
      return true;
    }

    return false;
  }

  private _handleInput(): void {
    if (this.history?.isNavigating) {
      this.history.resetNavigation();
    }
    this._autoResize();
  }

  private _autoResize(): void {
    const ta = this._getTextarea();
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  protected override render() {
    const showCancel = this.inflight && !this.disabled;
    return html`
      ${this.helperText ? html`<div class="helper">${this.helperText}</div>` : null}
      <div class="input-row">
        <textarea
          placeholder=${this.placeholder}
          ?disabled=${this.disabled}
          @keydown=${this._handleKeydown}
          @input=${this._handleInput}
          rows="1"
        ></textarea>
        ${
          showCancel
            ? html`<button
                class="cancel-btn"
                @click=${this._cancel}
              >Cancel</button>`
            : html`<button
                class="send-btn"
                ?disabled=${this.disabled}
                @click=${this._send}
              >Send</button>`
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-prompt-input": AcpPromptInput;
  }
}
