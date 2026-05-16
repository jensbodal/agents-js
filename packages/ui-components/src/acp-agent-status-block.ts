import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import {
  type AgentVisualState,
  type DeriveAgentVisualOptions,
  type DerivedAgentVisual,
  deriveAgentVisualState,
  type StatusSnapshotAgent,
} from "./agent-status-block-types.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/**
 * Renders one agent's status as a self-contained card. The component takes
 * the raw `StatusSnapshotAgent` shape from `/api/status` and derives its
 * visual state via the shared `deriveAgentVisualState` helper — hosts that
 * want a different bucketing (longer "active" window, finer-grained labels)
 * can call the helper themselves and bypass the component, or override the
 * thresholds via `active-threshold-seconds` / `stale-threshold-seconds`.
 *
 * The render is intentionally read-only — no interactive controls, no
 * subscriptions, no fetch. Hosts compose multiple blocks into a grid and
 * own the refresh cadence (poll `/api/status`, push new `agent` props to
 * each block).
 *
 * Theming follows the `acp-*` convention: tokens default to the global
 * palette, hosts override at an ancestor.
 */
@safeCustomElement("acp-agent-status-block")
export class AcpAgentStatusBlock extends LitElement {
  @property({ attribute: false })
  accessor agent: StatusSnapshotAgent | undefined = undefined;

  @property({ type: Number, attribute: "active-threshold-seconds" })
  accessor activeThresholdSeconds: number | undefined = undefined;

  @property({ type: Number, attribute: "stale-threshold-seconds" })
  accessor staleThresholdSeconds: number | undefined = undefined;

  static override styles = [
    acpTheme,
    css`
      :host {
        --acp-agent-block-bg: var(--acp-bg-secondary);
        --acp-agent-block-border: var(--acp-border);
        --acp-agent-block-padding: 14px 16px;
        --acp-agent-block-gap: 10px;
        --acp-agent-block-radius: 8px;
        --acp-agent-block-min-width: 260px;

        display: block;
        min-width: var(--acp-agent-block-min-width);
        padding: var(--acp-agent-block-padding);
        background: var(--acp-agent-block-bg);
        border: 1px solid var(--acp-agent-block-border);
        border-radius: var(--acp-agent-block-radius);
        font-size: 13px;
        color: var(--acp-text);
      }
      article {
        display: flex;
        flex-direction: column;
        gap: var(--acp-agent-block-gap);
      }
      header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
      }
      h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
      }
      .harness {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--acp-text-muted);
      }
      code.mxid {
        display: block;
        font-family: var(--acp-font-mono, ui-monospace, monospace);
        font-size: 11px;
        color: var(--acp-text-muted);
        word-break: break-all;
      }
      .state-row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .state-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .state-pill .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .state-pill[data-state="online-active"] {
        background: color-mix(in srgb, var(--acp-success) 15%, transparent);
        color: var(--acp-success);
      }
      .state-pill[data-state="online-active"] .dot {
        background: var(--acp-success);
      }
      .state-pill[data-state="online-idle"] {
        background: color-mix(in srgb, var(--acp-accent) 15%, transparent);
        color: var(--acp-accent);
      }
      .state-pill[data-state="online-idle"] .dot {
        background: var(--acp-accent);
      }
      .state-pill[data-state="offline-recent"] {
        background: color-mix(in srgb, var(--acp-text-muted) 15%, transparent);
        color: var(--acp-text-muted);
      }
      .state-pill[data-state="offline-recent"] .dot {
        background: var(--acp-text-muted);
      }
      .state-pill[data-state="offline-stale"] {
        background: color-mix(in srgb, var(--acp-error) 12%, transparent);
        color: var(--acp-error);
      }
      .state-pill[data-state="offline-stale"] .dot {
        background: var(--acp-error);
      }
      .activity {
        color: var(--acp-text-muted);
        font-size: 12px;
      }
      dl.meta {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        margin: 0;
        font-size: 12px;
      }
      dl.meta dt {
        color: var(--acp-text-muted);
        font-weight: 500;
      }
      dl.meta dd {
        margin: 0;
        word-break: break-word;
      }
      .gw-ok {
        color: var(--acp-success);
      }
      .gw-err {
        color: var(--acp-error);
      }
      .empty {
        color: var(--acp-text-muted);
        font-style: italic;
      }
    `,
  ];

  private _deriveOptions(): DeriveAgentVisualOptions {
    return {
      activeThresholdSeconds: this.activeThresholdSeconds,
      staleThresholdSeconds: this.staleThresholdSeconds,
    };
  }

  protected override render() {
    const agent = this.agent;
    if (!agent) {
      return html`<article class="empty">No agent data.</article>`;
    }

    const visual: DerivedAgentVisual = deriveAgentVisualState(agent, this._deriveOptions());

    return html`
      <article data-state=${visual.state as AgentVisualState}>
        <header>
          <div>
            <h3>${agent.name}</h3>
            <code class="mxid">${agent.mxid}</code>
          </div>
          ${agent.harness ? html`<span class="harness">${agent.harness}</span>` : nothing}
        </header>
        <div class="state-row">
          <span class="state-pill" data-state=${visual.state}>
            <span class="dot"></span>
            ${visual.stateLabel}
          </span>
          <span class="activity">${visual.activityLabel}</span>
        </div>
        <dl class="meta">
          ${agent.workspace ? html`<dt>Workspace</dt><dd>${agent.workspace}</dd>` : nothing}
          ${agent.transport ? html`<dt>Transport</dt><dd>${agent.transport}</dd>` : nothing}
          ${agent.tmux_session ? html`<dt>tmux</dt><dd>${agent.tmux_session}</dd>` : nothing}
          ${agent.pane_state ? html`<dt>Pane</dt><dd>${agent.pane_state}${agent.pane_detail ? html` · ${agent.pane_detail}` : nothing}</dd>` : nothing}
          ${
            agent.gateway_url
              ? html`<dt>Gateway</dt><dd class=${agent.gateway_healthy === false ? "gw-err" : agent.gateway_healthy === true ? "gw-ok" : ""}>${agent.gateway_healthy === false ? "✗" : agent.gateway_healthy === true ? "✓" : "?"} ${agent.gateway_url}</dd>`
              : nothing
          }
          ${
            typeof agent.deferred_messages === "number" && agent.deferred_messages > 0
              ? html`<dt>Deferred</dt><dd>${agent.deferred_messages}</dd>`
              : nothing
          }
        </dl>
      </article>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-agent-status-block": AcpAgentStatusBlock;
  }
}
