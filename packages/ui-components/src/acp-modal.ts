import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * A themed modal dialog component with backdrop, focus trap,
 * and keyboard dismiss.
 *
 * Set `open` to `true` to show the modal. The title bar is rendered
 * when `title` is provided. When `closable` is true (default), a
 * close button is rendered and clicking the backdrop or pressing Escape
 * dispatches an `acp-close` event.
 *
 * Content is projected via the default slot.
 */
@safeCustomElement("acp-modal")
export class AcpModal extends LitElement {
  /** Whether the modal is visible. */
  @property({ type: Boolean, reflect: true })
  accessor open = false;

  /** Modal title shown in the header bar. */
  @property({ type: String })
  // @ts-expect-error TS4114: Lit accessor properties cannot combine `override`
  // with the current parser/tooling stack, but this intentionally shadows the
  // inherited HTMLElement title property for the modal header label.
  accessor title = "";

  /** Whether the modal can be dismissed by the user. */
  @property({ type: Boolean })
  accessor closable = true;

  static override styles = [
    acpTheme,
    css`
      :host {
        display: contents;
      }

      .backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.6);
        animation: acp-fade-in 0.15s ease;
      }

      .dialog {
        position: relative;
        min-width: 320px;
        max-width: 90vw;
        max-height: 85vh;
        overflow: auto;
        background: var(--acp-bg-secondary);
        border: 1px solid var(--acp-border);
        border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        animation: acp-scale-in 0.15s ease;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px 12px;
        border-bottom: 1px solid var(--acp-border);
      }

      .header-title {
        font-size: 16px;
        font-weight: 600;
        color: var(--acp-text);
        margin: 0;
      }

      .close-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border: none;
        border-radius: 6px;
        background: transparent;
        color: var(--acp-text-muted);
        font-size: 18px;
        cursor: pointer;
        transition: background 0.15s, color 0.15s;
        line-height: 1;
      }

      .close-btn:hover {
        background: var(--acp-bg-tertiary);
        color: var(--acp-text);
      }

      .body {
        padding: 16px 20px 20px;
      }

      @keyframes acp-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }

      @keyframes acp-scale-in {
        from {
          transform: scale(0.95);
          opacity: 0;
        }
        to {
          transform: scale(1);
          opacity: 1;
        }
      }
    `,
  ];

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._removeKeydownListener();
  }

  protected override updated(changed: Map<PropertyKey, unknown>): void {
    super.updated(changed);
    if (changed.has("open")) {
      if (this.open) {
        this._addKeydownListener();
        this._setInitialFocus();
      } else {
        this._removeKeydownListener();
      }
    }
  }

  private _boundKeydown: ((e: KeyboardEvent) => void) | null = null;

  private _addKeydownListener(): void {
    if (!this._boundKeydown) {
      this._boundKeydown = this._handleKeydown.bind(this);
    }
    document.addEventListener("keydown", this._boundKeydown);
  }

  private _removeKeydownListener(): void {
    if (this._boundKeydown) {
      document.removeEventListener("keydown", this._boundKeydown);
    }
  }

  private _setInitialFocus(): void {
    requestAnimationFrame(() => {
      const dialog = this.renderRoot?.querySelector(".dialog") as HTMLElement | null;
      if (!dialog) return;
      // Try to focus the first focusable element inside the dialog
      const focusable = this._getFocusableElements(dialog);
      const firstFocusable = focusable[0];
      if (firstFocusable) {
        firstFocusable.focus();
      } else {
        dialog.setAttribute("tabindex", "-1");
        dialog.focus();
      }
    });
  }

  private _getFocusableElements(container: HTMLElement): HTMLElement[] {
    const selector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

    // Collect focusable elements from the shadow DOM (e.g., close button)
    const shadowElements = Array.from(container.querySelectorAll<HTMLElement>(selector));

    // Collect focusable elements from slotted content (light DOM projected through <slot>)
    const slots = container.querySelectorAll("slot");
    const slottedElements: HTMLElement[] = [];
    for (const slot of slots) {
      const assigned = (slot as HTMLSlotElement).assignedElements({ flatten: true });
      for (const node of assigned) {
        const el = node as HTMLElement;
        // Check if the slotted element itself is focusable
        if (typeof el.matches === "function" && el.matches(selector)) {
          slottedElements.push(el);
        }
        // Also collect focusable descendants within slotted elements
        if (typeof el.querySelectorAll === "function") {
          const nested = Array.from(el.querySelectorAll<HTMLElement>(selector));
          slottedElements.push(...nested);
        }
      }
    }

    // Deduplicate (an element might appear in both shadow and slotted queries)
    const seen = new Set<HTMLElement>(shadowElements);
    const combined = [...shadowElements];
    for (const el of slottedElements) {
      if (!seen.has(el)) {
        seen.add(el);
        combined.push(el);
      }
    }

    return combined;
  }

  private _trapFocus(e: KeyboardEvent): void {
    const dialog = this.renderRoot?.querySelector(".dialog") as HTMLElement | null;
    if (!dialog) return;

    const focusable = this._getFocusableElements(dialog);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;

    // Resolve the deepest active element, which handles both shadow DOM
    // and slotted (light DOM) focused elements
    const active = this._getDeepActiveElement();

    if (e.shiftKey) {
      // Shift+Tab: if focus is on first element, wrap to last
      if (active === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      // Tab: if focus is on last element, wrap to first
      if (active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  private _getDeepActiveElement(): Element | null {
    let active: Element | null = document.activeElement;
    // Walk into shadow roots to find the deepest focused element
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    // Also check the component's own renderRoot for shadow-hosted focus
    const shadowActive =
      this.renderRoot instanceof ShadowRoot ? this.renderRoot.activeElement : null;
    if (shadowActive) {
      return shadowActive;
    }
    return active;
  }

  private _handleKeydown(e: KeyboardEvent): void {
    if (!this.open) return;

    if (this.closable && e.key === "Escape") {
      e.preventDefault();
      this._emitClose();
      return;
    }

    if (e.key === "Tab") {
      this._trapFocus(e);
    }
  }

  private _handleBackdropClick(e: MouseEvent): void {
    // Only close if the click is directly on the backdrop, not the dialog
    if (e.target === e.currentTarget && this.closable) {
      this._emitClose();
    }
  }

  private _emitClose(): void {
    this.dispatchEvent(
      new CustomEvent("acp-close", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected override render() {
    if (!this.open) return nothing;

    const showHeader = this.title || this.closable;

    return html`
      <div
        class="backdrop"
        @click=${this._handleBackdropClick}
      >
        <div
          class="dialog"
          role="dialog"
          aria-modal="true"
          aria-label=${this.title || "Modal dialog"}
        >
          ${
            showHeader
              ? html`
            <div class="header">
              ${this.title ? html`<h2 class="header-title">${this.title}</h2>` : html`<span></span>`}
              ${
                this.closable
                  ? html`<button
                  class="close-btn"
                  aria-label="Close"
                  @click=${this._emitClose}
                >✕</button>`
                  : nothing
              }
            </div>
          `
              : nothing
          }
          <div class="body">
            <slot></slot>
          </div>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-modal": AcpModal;
  }
}
