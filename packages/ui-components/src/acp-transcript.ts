import { css, html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { acpTheme } from "./acp-theme.ts";
import type { TranscriptEntryLike } from "./acp-types.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

// Ensure child components are registered (side-effect imports)
import "./acp-message.ts";
import "./acp-streaming-text.ts";
import "./acp-tool-call-detail.ts";

/**
 * A scrollable transcript container that renders `acp-message` for each
 * transcript entry and an `acp-streaming-text` for pending agent output.
 *
 * Auto-scrolls to the bottom when new content arrives.
 *
 * ## Theming
 *
 * Composite-class component: primary mechanism is named `<slot>`
 * replacement (P4). P1 tokens handle the chrome around host-provided
 * slots.
 *
 * Tokens (default to pre-tokenization hardcoded values and the global
 * `--acp-*` palette):
 * - `--acp-transcript-padding`, `--acp-transcript-empty-color`,
 *   `--acp-transcript-empty-size`
 *
 * Slots (every slot has default content — hosts that don't slot
 * anything keep the current behavior):
 * - `slot="empty"` — replaces the "Waiting for messages..." empty-state
 *   body when the transcript is empty.
 * - `slot="thinking"` — replaces the thinking-dots indicator shown
 *   while the agent is preparing a response.
 * - `slot="error"` — replaces the inline error surface when
 *   `status === "error"`.
 */
@safeCustomElement("acp-transcript")
export class AcpTranscript extends LitElement {
  @property({ attribute: false })
  accessor transcript: TranscriptEntryLike[] = [];

  @property({ type: String })
  accessor pendingText = "";

  @property({ type: String })
  accessor status = "idle";

  /** Last error from the session controller — shown inline when status is "error". */
  @property({ type: String })
  accessor lastError = "";

  @state()
  private accessor _userScrolledUp = false;

  @state()
  private accessor _elapsedSeconds = 0;

  private _elapsedTimer: ReturnType<typeof setInterval> | null = null;

  private _wasThinking = false;

  private get _showThinking(): boolean {
    if (this.pendingText) return false; // streaming already started
    return this.status === "sending" || this.status === "waiting";
  }

  static override styles = [
    acpTheme,
    css`
      :host {
        /* Per-component tokens (P1). Defaults preserve pre-tokenization
         * visuals. */
        --acp-transcript-padding: 8px 0 24px 0;
        --acp-transcript-empty-color: var(--acp-text-muted);
        --acp-transcript-empty-size: 14px;

        display: block;
        flex: 1;
        min-height: 0;
      }
      .scroll-container {
        height: 100%;
        overflow-y: auto;
        padding: var(--acp-transcript-padding);
      }
      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--acp-transcript-empty-color);
        font-size: var(--acp-transcript-empty-size);
      }
      .thinking-indicator {
        display: flex;
        gap: 4px;
        padding: 12px 16px;
        align-items: center;
      }
      .thinking-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--acp-accent, #7c6af0);
        animation: thinking-bounce 1.4s ease-in-out infinite;
      }
      .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
      .thinking-dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes thinking-bounce {
        0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
        40% { opacity: 1; transform: scale(1); }
      }
      .elapsed-time {
        margin-left: 8px;
        color: var(--acp-text-muted, #888);
        font-size: 12px;
        font-variant-numeric: tabular-nums;
      }
      .error-inline {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 12px 16px;
        color: var(--acp-error, #e53e3e);
        font-size: 13px;
        line-height: 1.5;
      }
      .error-icon {
        flex-shrink: 0;
        font-size: 16px;
      }
      .error-actions {
        padding: 4px 16px 12px;
        display: flex;
        gap: 8px;
      }
      .error-action-btn {
        padding: 6px 16px;
        border: 1px solid var(--acp-error, #e53e3e);
        border-radius: 6px;
        background: transparent;
        color: var(--acp-error, #e53e3e);
        font-size: 13px;
        font-family: inherit;
        cursor: pointer;
        transition: background 0.15s;
      }
      .error-action-btn:hover {
        background: color-mix(in srgb, var(--acp-error, #e53e3e) 10%, transparent);
      }
    `,
  ];

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);

    if (changed.has("status") || changed.has("pendingText")) {
      const isThinking = this._showThinking;
      if (isThinking && !this._wasThinking) {
        this._clearElapsedTimer();
        this._elapsedTimer = setInterval(() => {
          this._elapsedSeconds++;
        }, 1_000);
      } else if (!isThinking && this._wasThinking) {
        this._clearElapsedTimer();
      }
      this._wasThinking = isThinking;
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated(changed);
    if (changed.has("transcript") || changed.has("pendingText")) {
      const last = this.transcript[this.transcript.length - 1];
      // The "user just sent — auto-scroll" behavior only fires on
      // user-message entries; tool-call entries don't reset the
      // scroll lock so a user reading earlier output isn't yanked
      // down by tool-call activity.
      if (last && last.kind !== "tool_call" && last.role === "user") {
        this._userScrolledUp = false;
      }
      this._scrollToBottom();
    }

    // Scroll to bottom when an error appears inline.
    if (changed.has("lastError") && this.lastError) {
      this._scrollToBottom();
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._clearElapsedTimer();
  }

  private _clearElapsedTimer(): void {
    if (this._elapsedTimer !== null) {
      clearInterval(this._elapsedTimer);
      this._elapsedTimer = null;
    }
    this._elapsedSeconds = 0;
  }

  private _scrollToBottom(): void {
    if (this._userScrolledUp) return;
    this.updateComplete.then(() => {
      const el = this.renderRoot?.querySelector(".scroll-container") as HTMLElement | null;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }

  private _dispatchRetry(): void {
    this.dispatchEvent(
      new CustomEvent("acp-retry", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private _handleScroll(e: Event): void {
    const el = e.target as HTMLElement;
    const threshold = 30;
    this._userScrolledUp = el.scrollTop + el.clientHeight < el.scrollHeight - threshold;
  }

  protected override render() {
    const hasContent = this.transcript.length > 0 || this.pendingText;

    return html`
      <div class="scroll-container" @scroll=${this._handleScroll}>
        ${
          hasContent
            ? html`
              ${repeat(
                this.transcript,
                (entry) => entry.id,
                (entry) =>
                  entry.kind === "tool_call"
                    ? html`
                        <acp-tool-call-detail
                          .toolCall=${entry.toolCall}
                        ></acp-tool-call-detail>
                      `
                    : html`
                        <acp-message
                          .messageRole=${entry.role}
                          .text=${entry.text}
                        ></acp-message>
                      `,
              )}
              ${
                this._showThinking
                  ? html`<slot name="thinking">
                    <div class="thinking-indicator">
                      <span class="thinking-dot"></span>
                      <span class="thinking-dot"></span>
                      <span class="thinking-dot"></span>
                      ${
                        this._elapsedSeconds > 0
                          ? html`<span class="elapsed-time">${this._elapsedSeconds}s</span>`
                          : nothing
                      }
                    </div>
                  </slot>`
                  : nothing
              }
              ${
                this.status === "error" && this.lastError
                  ? html`<slot name="error">
                    <div class="error-inline" role="alert">
                      <span class="error-icon" aria-hidden="true">&#9888;</span>
                      <span>${this.lastError}</span>
                    </div>
                    <div class="error-actions">
                      <button class="error-action-btn" @click=${this._dispatchRetry}>
                        ${this.transcript.length > 0 ? "New Session" : "Retry"}
                      </button>
                    </div>
                  </slot>`
                  : nothing
              }
              ${
                this.pendingText
                  ? html`<acp-streaming-text .text=${this.pendingText}></acp-streaming-text>`
                  : ""
              }
            `
            : html`<slot name="empty">
              <div class="empty-state">Waiting for messages...</div>
            </slot>`
        }
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-transcript": AcpTranscript;
  }
}
