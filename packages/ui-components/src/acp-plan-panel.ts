import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import type { PlanEntryLike } from "./acp-types.ts";
import { safeCustomElement } from "./safe-custom-element.ts";
import type {
  WorkflowSurfaceActivityState,
  WorkflowSurfaceRenderState,
} from "./workflow-surface.ts";

/**
 * A collapsible panel showing the agent's plan entries with status indicators.
 * Hidden when there are no plan entries.
 */
@safeCustomElement("acp-plan-panel")
export class AcpPlanPanel extends LitElement {
  @property({ attribute: false })
  accessor plan: PlanEntryLike[] = [];

  @property({ attribute: false })
  accessor workflowSurface: WorkflowSurfaceRenderState | null = null;

  @state()
  private accessor _collapsed = false;

  static override styles = [
    acpTheme,
    css`
      :host {
        display: block;
      }
      .header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 16px;
        background: var(--acp-bg-secondary);
        border-bottom: 1px solid var(--acp-border);
        cursor: pointer;
        user-select: none;
        font-size: 12px;
        color: var(--acp-text-muted);
      }
      .header:hover {
        color: var(--acp-text);
      }
      .chevron {
        transition: transform 0.15s;
        font-size: 10px;
      }
      .chevron--collapsed {
        transform: rotate(-90deg);
      }
      .count {
        opacity: 0.7;
      }
      .entries {
        padding: 4px 0;
      }
      .summary {
        padding: 8px 16px 0;
        color: var(--acp-text);
        font-size: 13px;
        font-weight: 600;
      }
      .section-label {
        padding: 10px 16px 4px;
        color: var(--acp-text-muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .activity-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 4px 16px 8px;
      }
      .activity-item {
        display: flex;
        align-items: baseline;
        gap: 8px;
        font-size: 13px;
      }
      .activity-item__label {
        color: var(--acp-text);
        font-weight: 500;
      }
      .activity-item__detail {
        color: var(--acp-text-muted);
      }
      .entry {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 4px 16px;
        font-size: 13px;
        line-height: 1.5;
      }
      .icon {
        flex-shrink: 0;
        width: 16px;
        text-align: center;
        font-size: 12px;
        line-height: 1.5;
      }
      .icon--pending { color: var(--acp-text-muted); }
      .icon--in_progress { color: var(--acp-accent); }
      .icon--completed { color: var(--acp-success); }
      .content {
        color: var(--acp-text);
      }
      .content--completed {
        color: var(--acp-text-muted);
        text-decoration: line-through;
      }
      .content--high { font-weight: 600; }
      .content--low { opacity: 0.7; }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      .spinner {
        display: inline-block;
        animation: spin 1s linear infinite;
      }
    `,
  ];

  private _toggle(): void {
    this._collapsed = !this._collapsed;
  }

  private _statusIcon(status: PlanEntryLike["status"]): string {
    switch (status) {
      case "completed":
        return "\u2713";
      case "in_progress":
        return "\u25cc";
      default:
        return "\u25cb";
    }
  }

  protected override render() {
    const planEntries = this.workflowSurface?.plan_surface.entries ?? this.plan;
    const activitySurface = this.workflowSurface?.activity_surface ?? null;
    const completed =
      this.workflowSurface?.plan_surface.completedCount ??
      planEntries.filter((entry) => entry.status === "completed").length;
    const total = this.workflowSurface?.plan_surface.totalCount ?? planEntries.length;
    const summary =
      this.workflowSurface?.plan_surface.summary ??
      (total ? `${completed}/${total} completed` : null);

    if (!planEntries.length && !(activitySurface?.items.length ?? 0)) return nothing;

    return html`
      <div class="header" @click=${this._toggle}>
        <span class="chevron ${this._collapsed ? "chevron--collapsed" : ""}">&#9660;</span>
        <span>Workflow</span>
        ${total ? html`<span class="count">(${completed}/${total})</span>` : nothing}
      </div>
      ${
        this._collapsed
          ? nothing
          : html`
            ${summary ? html`<div class="summary">${summary}</div>` : nothing}
            ${this.renderActivity(activitySurface)}
            ${
              planEntries.length
                ? html`<div class="section-label">Plan</div>
                    <div class="entries">
            ${planEntries.map(
              (entry) => html`
                <div class="entry">
                  <span class="icon icon--${entry.status} ${entry.status === "in_progress" ? "spinner" : ""}">
                    ${this._statusIcon(entry.status)}
                  </span>
                  <span class="content content--${entry.status} content--${entry.priority}">
                    ${entry.content}
                  </span>
                </div>
              `,
            )}
          </div>`
                : nothing
            }
          `
      }
    `;
  }

  private renderActivity(activitySurface: WorkflowSurfaceActivityState | null) {
    if (!activitySurface?.items.length) {
      return nothing;
    }

    return html`
      <div class="section-label">Activity</div>
      <div class="activity-list">
        ${activitySurface.items.map(
          (item) => html`
            <div class="activity-item">
              <span class="activity-item__label">${item.label}</span>
              ${item.detail ? html`<span class="activity-item__detail">${item.detail}</span>` : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-plan-panel": AcpPlanPanel;
  }
}
