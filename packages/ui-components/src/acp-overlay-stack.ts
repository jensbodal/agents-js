/**
 * Overlay stack component for ACP chat modals.
 *
 * Renders up to four conditional overlay panels (elicitation, auth,
 * permission, write-gate) and re-dispatches their response events
 * so that the parent `<acp-chat-app>` can handle them.
 */

import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import type { PermissionRequestLike, SessionStateLike, WriteGateLike } from "./acp-types.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

import "./acp-elicitation-form.ts";
import "./acp-auth-selector.ts";
import "./acp-permission-modal.ts";
import "./acp-write-gate-modal.ts";

@safeCustomElement("acp-overlay-stack")
export class AcpOverlayStack extends LitElement {
  @property({ attribute: false })
  accessor activeElicitation: SessionStateLike["activeElicitation"] | null = null;

  @property({ attribute: false })
  accessor activeAuth: SessionStateLike["activeAuth"] | null = null;

  @property({ attribute: false })
  accessor pendingPermission: PermissionRequestLike | null = null;

  @property({ attribute: false })
  accessor pendingWriteGate: WriteGateLike | null = null;

  static override styles = css`
    :host {
      display: contents;
    }

    .overlay-container {
      padding: 12px 16px;
    }
  `;

  protected override render() {
    return html`
      ${
        this.activeElicitation
          ? html`<div class="overlay-container">
            <acp-elicitation-form
              .message=${this.activeElicitation.message ?? ""}
              .schema=${this.activeElicitation.requestedSchema ?? {}}
              @acp-elicitation-response=${this._redispatch}
            ></acp-elicitation-form>
          </div>`
          : nothing
      }
      ${
        this.activeAuth
          ? html`<acp-auth-selector
            .methods=${this.activeAuth.authMethods ?? []}
            .message=${this.activeAuth.message ?? ""}
            @acp-auth-selected=${this._redispatch}
          ></acp-auth-selector>`
          : nothing
      }
      ${
        this.pendingPermission
          ? html`<acp-permission-modal
            .request=${this.pendingPermission}
            @acp-permission-response=${this._redispatch}
          ></acp-permission-modal>`
          : nothing
      }
      ${
        this.pendingWriteGate
          ? html`<acp-write-gate-modal
            .path=${this.pendingWriteGate.path}
            .diff=${this.pendingWriteGate.diff}
            .closestParentFolder=${this.pendingWriteGate.closestParentFolder}
            @acp-write-gate-response=${this._redispatch}
          ></acp-write-gate-modal>`
          : nothing
      }
    `;
  }

  /**
   * Re-dispatch a child component's CustomEvent so it bubbles
   * through the overlay stack's shadow boundary to the parent.
   */
  private _redispatch(e: Event): void {
    e.stopPropagation();
    const ce = e as CustomEvent;
    this.dispatchEvent(
      new CustomEvent(ce.type, {
        bubbles: true,
        composed: true,
        detail: ce.detail,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-overlay-stack": AcpOverlayStack;
  }
}
