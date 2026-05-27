import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * AJS-88 / DOT-502 v0.2 — Matrix-origin envelope, mirrored locally (no
 * runtime dep on `@agents-js/host`). Structural match with
 * `MatrixOriginEnvelope` from host. Snake-case field names match the
 * Matrix wire vocabulary.
 */
export interface MatrixOriginEnvelopeLike {
  event_id: string;
  room_id: string;
  sender: string;
  origin_server_ts: number;
  reply_to_event_id?: string;
}

/**
 * AJS-88 / DOT-502 v0.2 — origin discriminator. Open extension: future
 * additions like `"sms_inbound"` are allowed; consumers MUST handle
 * unknown values with a sensible default (treat as `"agents_message"`).
 * Use {@link normalizeInboxKindLike} at every read boundary.
 */
export type InboxKindLike = "matrix_room_mention" | "agents_message";

/**
 * Known-kind set, captured separately from the union so the read-boundary
 * predicate ({@link normalizeInboxKindLike}) can be written without
 * inlining an equality chain. Mirrors the host-side `KNOWN_INBOX_KINDS`.
 */
export const KNOWN_INBOX_KINDS_LIKE: ReadonlySet<InboxKindLike> = new Set<InboxKindLike>([
  "matrix_room_mention",
  "agents_message",
]);

/**
 * Normalise a raw `kind` value (possibly absent, possibly an unrecognised
 * future variant) to a known {@link InboxKindLike}. Per spec §7
 * back-compat: absent / unknown → `"agents_message"`.
 */
export function normalizeInboxKindLike(raw: unknown): InboxKindLike {
  if (typeof raw === "string" && (KNOWN_INBOX_KINDS_LIKE as ReadonlySet<string>).has(raw)) {
    return raw as InboxKindLike;
  }
  return "agents_message";
}

/**
 * Structural mirror of `InboxMessage` from `@agents-js/host`. Defined locally
 * so `@agents-js/ui-components` doesn't take a runtime dep on `@agents-js/host`
 * just to render a row. Consumers passing `InboxMessage[]` from host
 * structurally satisfy this shape.
 *
 * AJS-88 / DOT-502 v0.2 widening: `kind` + `matrix_origin` surfaced
 * additively. Existing rows pre-contract have neither set; the render
 * path treats absent `kind` as `"agents_message"` via
 * {@link normalizeInboxKindLike}.
 */
export interface InboxMessageLike {
  message_id: string;
  from_session: string;
  to_session: string;
  created_at: string;
  body: string;
  priority?: "low" | "normal" | "high";
  /**
   * AJS-88 / DOT-502 v0.2 — present on rows written by bridge fanout.
   * When set, the render path surfaces a small "matrix" badge so the
   * reader can distinguish bridge-fanout rows from native-send rows
   * without parsing body text.
   */
  matrix_origin?: MatrixOriginEnvelopeLike;
  /**
   * AJS-88 / DOT-502 v0.2 — origin discriminator. Absent / unknown →
   * treat as `"agents_message"` (back-compat with pre-contract rows).
   */
  kind?: InboxKindLike;
}

/**
 * Renders one inbox row as a self-contained card. The component takes the
 * raw `InboxMessageLike` shape and renders sender/recipient/timestamp/body.
 *
 * Read-only render — no interactive controls, no subscriptions, no fetch.
 * Hosts compose multiple items (typically via `<acp-inbox-message-list>`)
 * and own the data-source lifecycle.
 *
 * Theming follows the `acp-*` convention.
 *
 * **Scope context (AJS-85 Phase 1):** this component is part of the AGENT
 * INBOX browser surface — durable per-session messages from `agent-msg.db`.
 * It is NOT a Matrix room transcript renderer; that's a separate substrate
 * covered by DOT-499/500/501.
 */
@safeCustomElement("acp-inbox-message-item")
export class AcpInboxMessageItem extends LitElement {
  @property({ attribute: false })
  accessor message: InboxMessageLike | undefined = undefined;

  static override styles = [
    acpTheme,
    css`
      :host {
        --acp-inbox-item-bg: var(--acp-bg-secondary);
        --acp-inbox-item-border: var(--acp-border);
        --acp-inbox-item-padding: 12px 14px;
        --acp-inbox-item-radius: 8px;
        --acp-inbox-item-gap: 8px;
        display: block;
      }

      .row {
        background: var(--acp-inbox-item-bg);
        border: 1px solid var(--acp-inbox-item-border);
        border-radius: var(--acp-inbox-item-radius);
        padding: var(--acp-inbox-item-padding);
        display: flex;
        flex-direction: column;
        gap: var(--acp-inbox-item-gap);
      }

      .header {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: baseline;
        font-size: 12px;
        color: var(--acp-text-secondary);
      }

      .from {
        font-weight: 600;
        color: var(--acp-text-primary);
      }

      .arrow {
        opacity: 0.5;
      }

      .priority {
        margin-left: auto;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--acp-bg-tertiary, rgba(255, 255, 255, 0.05));
        color: var(--acp-text-secondary);
        text-transform: lowercase;
      }

      .priority[data-priority="high"] {
        color: var(--acp-warning, #ffb86c);
      }

      /*
       * AJS-88 / DOT-502 v0.2 -- origin discriminator badge. Surfaces
       * kind === "matrix_room_mention" so the reader can distinguish
       * bridge-fanout rows from native-send rows at a glance. Lives
       * alongside .priority in the header; both share margin-left:
       * auto for right-alignment, with .priority (when present)
       * winning the trailing slot.
       */
      .kind-badge {
        margin-left: auto;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--acp-bg-tertiary, rgba(255, 255, 255, 0.05));
        color: var(--acp-text-secondary);
        text-transform: lowercase;
      }

      /* When both badges render, the priority slot drops its auto margin
         so the kind badge anchors the right edge and priority floats next
         to it. */
      .kind-badge ~ .priority {
        margin-left: 0;
      }

      .body {
        font-size: 14px;
        color: var(--acp-text-primary);
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.4;
      }

      .empty {
        font-size: 13px;
        color: var(--acp-text-secondary);
        font-style: italic;
        padding: var(--acp-inbox-item-padding);
      }
    `,
  ];

  override render() {
    const msg = this.message;
    if (!msg) {
      return html`<div class="empty">no message</div>`;
    }
    const priority = msg.priority && msg.priority !== "normal" ? msg.priority : null;
    // AJS-88 / DOT-502 v0.2 — normalise once at the read boundary. Absent
    // / unknown → "agents_message"; we only surface a badge for the
    // bridge-fanout discriminator so native rows render identically to
    // pre-contract rows (zero visual churn for the legacy path).
    const kind = normalizeInboxKindLike(msg.kind);
    const showKindBadge = kind === "matrix_room_mention";
    return html`
      <div class="row" data-message-id=${msg.message_id}>
        <div class="header">
          <span class="from">${msg.from_session}</span>
          <span class="arrow">→</span>
          <span>${msg.to_session}</span>
          <span>·</span>
          <time datetime=${msg.created_at}>${formatTimestamp(msg.created_at)}</time>
          ${
            showKindBadge
              ? html`<span class="kind-badge" data-kind=${kind} title="bridge-fanout from Matrix room mention">matrix</span>`
              : nothing
          }
          ${
            priority
              ? html`<span class="priority" data-priority=${priority}>${priority}</span>`
              : nothing
          }
        </div>
        <div class="body">${msg.body}</div>
      </div>
    `;
  }
}

/**
 * Format an ISO 8601 timestamp for display. Falls back to the raw string
 * if the value isn't a parseable date so the UI doesn't crash on
 * unexpected backend output.
 */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
