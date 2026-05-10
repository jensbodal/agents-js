import type { ToolCallContent, ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import "./acp-diff-block.ts";
import "./acp-terminal-embed.ts";
import { acpTheme } from "./acp-theme.ts";
import "./acp-tool-kind-icon.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Mirrors the shape of `ActiveToolCall` from the `agents-js/a2a-client`
 * package without taking a runtime dependency on it — keeps
 * `ui-components` framework-agnostic. Consumers can pass an
 * `ActiveToolCall` straight in via `.toolCall=` (Lit property
 * binding); attribute-based binding is not supported because the
 * payload includes nested arrays / arbitrary `unknown` values that
 * don't serialize through DOM attributes.
 */
export interface AcpToolCallDetailData {
  toolCallId: string;
  toolName: string;
  status: string;
  startedAt?: number;
  toolKind?: ToolKind;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

/**
 * Renders the full ACP `ToolCall` payload as a single inline detail
 * block: header (kind icon + name + status badge) → location chips →
 * content variants (text / image / resource_link / resource / diff /
 * terminal) → expandable raw I/O.
 *
 * Visibility rules:
 *   - Each section is omitted when its data is missing or empty.
 *   - `null` content / locations (ACP "explicit clear") render as a
 *     muted "(cleared)" badge so users see that the harness withdrew
 *     a previously-reported value.
 *   - `rawInput` and `rawOutput` go behind `<details>` because they
 *     can be large; users expand on demand.
 *
 * Designed for inline embedding in `acp-transcript`. No outer margin;
 * hosts wrap with their own spacing.
 */
@safeCustomElement("acp-tool-call-detail")
export class AcpToolCallDetail extends LitElement {
  /** The tool-call snapshot to render. Pass an `ActiveToolCall` here. */
  @property({ attribute: false })
  accessor toolCall: AcpToolCallDetailData | undefined;

  /** Tracks whether the rawInput `<details>` is currently expanded.
   *  Updated by the `toggle` event so we can defer the (potentially
   *  expensive) JSON.stringify of large payloads until the user
   *  actually opens the section. */
  @state()
  private accessor _rawInputOpen = false;

  /** Tracks whether the rawOutput `<details>` is currently expanded. */
  @state()
  private accessor _rawOutputOpen = false;

  static override styles = [
    acpTheme,
    css`
      :host {
        --acp-tool-call-detail-border: var(--acp-border);
        --acp-tool-call-detail-radius: 6px;
        --acp-tool-call-detail-bg: var(--acp-bg-secondary);
        --acp-tool-call-detail-padding: 8px 12px;
        --acp-tool-call-detail-gap: 8px;
        --acp-tool-call-detail-status-pending-bg: var(--acp-bg-tertiary);
        --acp-tool-call-detail-status-pending-color: var(--acp-text-muted);
        --acp-tool-call-detail-status-progress-bg: rgba(122, 162, 247, 0.15);
        --acp-tool-call-detail-status-progress-color: var(--acp-accent);
        --acp-tool-call-detail-status-completed-bg: rgba(158, 206, 106, 0.15);
        --acp-tool-call-detail-status-completed-color: var(--acp-success);
        --acp-tool-call-detail-status-failed-bg: rgba(247, 118, 142, 0.15);
        --acp-tool-call-detail-status-failed-color: var(--acp-error);
        display: block;
        border: 1px solid var(--acp-tool-call-detail-border);
        border-radius: var(--acp-tool-call-detail-radius);
        background: var(--acp-tool-call-detail-bg);
        padding: var(--acp-tool-call-detail-padding);
        font-size: 13px;
      }
      .header {
        display: flex;
        align-items: center;
        gap: var(--acp-tool-call-detail-gap);
        margin-bottom: 6px;
      }
      .name {
        flex: 1;
        font-weight: 600;
        color: var(--acp-text);
        word-break: break-all;
      }
      .status {
        flex-shrink: 0;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        text-transform: lowercase;
      }
      .status[data-status="pending"] {
        background: var(--acp-tool-call-detail-status-pending-bg);
        color: var(--acp-tool-call-detail-status-pending-color);
      }
      .status[data-status="in_progress"] {
        background: var(--acp-tool-call-detail-status-progress-bg);
        color: var(--acp-tool-call-detail-status-progress-color);
      }
      .status[data-status="completed"] {
        background: var(--acp-tool-call-detail-status-completed-bg);
        color: var(--acp-tool-call-detail-status-completed-color);
      }
      .status[data-status="failed"] {
        background: var(--acp-tool-call-detail-status-failed-bg);
        color: var(--acp-tool-call-detail-status-failed-color);
      }
      .locations {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin: 4px 0;
      }
      .location-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--acp-bg-tertiary);
        color: var(--acp-text);
        font-family: monospace;
        font-size: 11px;
      }
      .cleared {
        font-style: italic;
        color: var(--acp-text-muted);
        font-size: 11px;
      }
      .content-block {
        margin: 6px 0;
      }
      .text-content {
        background: var(--acp-bg);
        color: var(--acp-text);
        padding: 6px 8px;
        border-radius: 4px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .resource {
        font-family: monospace;
        color: var(--acp-text-muted);
        font-size: 11px;
      }
      details {
        margin-top: 6px;
      }
      summary {
        cursor: pointer;
        color: var(--acp-text-muted);
        font-size: 11px;
      }
      summary:hover {
        color: var(--acp-text);
      }
      pre {
        margin: 4px 0 0;
        padding: 6px 8px;
        background: var(--acp-bg);
        color: var(--acp-text);
        border-radius: 4px;
        font-family: monospace;
        font-size: 11px;
        white-space: pre-wrap;
        word-break: break-all;
      }
    `,
  ];

  override render() {
    if (!this.toolCall) return nothing;
    const tc = this.toolCall;
    return html`
      <div part="header" class="header">
        ${
          tc.toolKind
            ? html`<acp-tool-kind-icon .kind=${tc.toolKind}></acp-tool-kind-icon>`
            : nothing
        }
        <span part="name" class="name">${tc.toolName || "(unnamed tool)"}</span>
        <span part="status" class="status" data-status=${tc.status}>${tc.status}</span>
      </div>
      ${this.#renderLocations(tc.locations)}
      ${this.#renderContent(tc.content)}
      ${this.#renderRawIO("rawInput", tc.rawInput)}
      ${this.#renderRawIO("rawOutput", tc.rawOutput)}
    `;
  }

  #renderLocations(
    locations: ToolCallLocation[] | null | undefined,
  ): TemplateResult | typeof nothing {
    if (locations === undefined) return nothing;
    if (locations === null) {
      return html`<div class="locations"><span class="cleared">(locations cleared)</span></div>`;
    }
    if (locations.length === 0) return nothing;
    return html`
      <div part="locations" class="locations">
        ${locations.map(
          (loc) => html`
            <span class="location-chip" title=${loc.path}>
              ${loc.path}${loc.line != null ? html`:${loc.line}` : nothing}
            </span>
          `,
        )}
      </div>
    `;
  }

  #renderContent(content: ToolCallContent[] | null | undefined): TemplateResult | typeof nothing {
    if (content === undefined) return nothing;
    if (content === null) {
      return html`<div class="content-block"><span class="cleared">(content cleared)</span></div>`;
    }
    if (content.length === 0) return nothing;
    return html`<div part="content">${content.map((c) => this.#renderContentBlock(c))}</div>`;
  }

  #renderContentBlock(block: ToolCallContent): TemplateResult {
    // ACP `ToolCallContent` is a discriminated union: content / diff / terminal.
    // The nested `content` branch wraps an MCP `Content` (text / image / audio
    // / resource_link / resource); render the text variant inline and surface
    // the others as muted resource badges (full image/audio rendering is host
    // territory — they'd need their own renderers).
    if (block.type === "diff") {
      return html`
        <div class="content-block">
          <acp-diff-block
            .path=${block.path}
            .oldText=${block.oldText ?? ""}
            .newText=${block.newText ?? ""}
          ></acp-diff-block>
        </div>
      `;
    }
    if (block.type === "terminal") {
      // The SDK's `Terminal` shape is a forward reference to a terminal
      // session id. The harness reports output via separate channels;
      // render whatever string content the SDK exposes here (output may
      // be empty if the host hasn't wired terminal-session retrieval).
      const term = block as unknown as { command?: string; exitCode?: number; output?: string };
      return html`
        <div class="content-block">
          <acp-terminal-embed
            .command=${term.command ?? ""}
            .exitCode=${term.exitCode}
            .output=${term.output ?? ""}
          ></acp-terminal-embed>
        </div>
      `;
    }
    // type === "content" — nested MCP ContentBlock
    const inner = (block as { content?: { type?: string; text?: string } }).content;
    if (inner?.type === "text" && typeof inner.text === "string") {
      return html`<div class="content-block"><div class="text-content">${inner.text}</div></div>`;
    }
    return html`
      <div class="content-block">
        <span class="resource">[${inner?.type ?? "content"}]</span>
      </div>
    `;
  }

  #renderRawIO(label: "rawInput" | "rawOutput", value: unknown): TemplateResult | typeof nothing {
    if (value === undefined) return nothing;
    const isOpen = label === "rawInput" ? this._rawInputOpen : this._rawOutputOpen;
    const partName = label === "rawInput" ? "raw-input" : "raw-output";
    const heading = label === "rawInput" ? "raw input" : "raw output";
    // Defer JSON.stringify until the user expands. Large rawInput /
    // rawOutput payloads (e.g. file contents, multi-MB tool output)
    // would otherwise stringify on every render even while the
    // section is collapsed, blocking the main thread.
    return html`
      <details part=${partName} @toggle=${(e: Event) => this.#onToggleRaw(label, e)}>
        <summary>${heading}</summary>
        ${isOpen ? html`<pre>${formatRawValue(value)}</pre>` : nothing}
      </details>
    `;
  }

  #onToggleRaw(label: "rawInput" | "rawOutput", event: Event): void {
    const target = event.target as HTMLDetailsElement | null;
    if (!target) return;
    if (label === "rawInput") {
      this._rawInputOpen = target.open;
    } else {
      this._rawOutputOpen = target.open;
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-tool-call-detail": AcpToolCallDetail;
  }
}

function formatRawValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Circular refs / BigInt / functions — fall back to a String coercion
    // so the user sees something rather than an empty <pre>.
    return String(value);
  }
}
