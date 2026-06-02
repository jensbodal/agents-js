import { css, html, LitElement, nothing } from "lit";
import { property } from "lit/decorators.js";
import { acpTheme } from "./acp-theme.ts";
import { safeCustomElement } from "./safe-custom-element.ts";

/** Evidence tier for a capability, per the capability-reconciliation classification. */
export type CapabilityTier = "demonstrated" | "undemonstrated" | "over-claimed" | "missing";

export interface CapabilityEvidence {
  kind: string;
  ref: string;
  note: string;
}

export interface CapabilityPackageRef {
  name: string;
  dir?: string;
  version?: string;
}

/** One capability row from `docs/public/capability-status.json`. */
export interface CapabilityCardData {
  id: string;
  title: string;
  tier: CapabilityTier;
  packages: CapabilityPackageRef[];
  evidence: CapabilityEvidence[];
  notes?: string;
}

const TIER_LABEL: Record<CapabilityTier, string> = {
  demonstrated: "Demonstrated",
  undemonstrated: "Undemonstrated",
  "over-claimed": "Over-claimed",
  missing: "Missing",
};

/**
 * Renders one capability's evidence tier as a self-contained card — a sibling
 * of `acp-agent-status-block` built on the same `acpTheme` design tokens and
 * the same read-only, no-fetch, no-subscription pattern. Hosts compose many
 * cards into a grid (`repeat(auto-fit, minmax(260px, 1fr))`) and own the data
 * source (`capability-status.json`).
 *
 * The tier drives the pill color via `data-state`, mirroring the status-block's
 * `color-mix` token mechanism. The theme has no warning token, so the
 * `over-claimed` tier uses a local `--acp-capability-overclaimed` default that
 * hosts can override at an ancestor.
 */
@safeCustomElement("acp-capability-card")
export class AcpCapabilityCard extends LitElement {
  @property({ attribute: false })
  accessor capability: CapabilityCardData | undefined = undefined;

  static override styles = [
    acpTheme,
    css`
      :host {
        --acp-capability-card-bg: var(--acp-bg-secondary);
        --acp-capability-card-border: var(--acp-border);
        --acp-capability-overclaimed: #c2820e;
        --acp-capability-card-padding: 14px 16px;
        --acp-capability-card-gap: 10px;
        --acp-capability-card-radius: 8px;
        --acp-capability-card-min-width: 260px;

        display: block;
        min-width: var(--acp-capability-card-min-width);
        padding: var(--acp-capability-card-padding);
        background: var(--acp-capability-card-bg);
        border: 1px solid var(--acp-capability-card-border);
        border-radius: var(--acp-capability-card-radius);
        font-size: 13px;
        color: var(--acp-text);
      }
      article {
        display: flex;
        flex-direction: column;
        gap: var(--acp-capability-card-gap);
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
      .tier-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        white-space: nowrap;
      }
      .tier-pill .dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
      }
      .tier-pill[data-state="demonstrated"] {
        background: color-mix(in srgb, var(--acp-success) 15%, transparent);
        color: var(--acp-success);
      }
      .tier-pill[data-state="demonstrated"] .dot {
        background: var(--acp-success);
      }
      .tier-pill[data-state="undemonstrated"] {
        background: color-mix(in srgb, var(--acp-accent) 15%, transparent);
        color: var(--acp-accent);
      }
      .tier-pill[data-state="undemonstrated"] .dot {
        background: var(--acp-accent);
      }
      .tier-pill[data-state="over-claimed"] {
        background: color-mix(in srgb, var(--acp-capability-overclaimed) 18%, transparent);
        color: var(--acp-capability-overclaimed);
      }
      .tier-pill[data-state="over-claimed"] .dot {
        background: var(--acp-capability-overclaimed);
      }
      .tier-pill[data-state="missing"] {
        background: color-mix(in srgb, var(--acp-text-muted) 15%, transparent);
        color: var(--acp-text-muted);
      }
      .tier-pill[data-state="missing"] .dot {
        background: var(--acp-text-muted);
      }
      .packages {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .pkg-chip {
        font-family: var(--acp-font-mono, ui-monospace, monospace);
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        background: color-mix(in srgb, var(--acp-text-muted) 12%, transparent);
        color: var(--acp-text-muted);
      }
      .evidence {
        margin: 0;
        font-size: 12px;
        color: var(--acp-text-muted);
      }
      .evidence .kind {
        text-transform: uppercase;
        font-size: 10px;
        letter-spacing: 0.06em;
        font-weight: 600;
        color: var(--acp-text);
      }
      .notes {
        font-size: 12px;
        color: var(--acp-text-muted);
        font-style: italic;
      }
      .empty {
        color: var(--acp-text-muted);
        font-style: italic;
      }
    `,
  ];

  protected override render() {
    const cap = this.capability;
    if (!cap) {
      return html`<article class="empty">No capability data.</article>`;
    }
    const top = cap.evidence?.[0];
    return html`
      <article data-state=${cap.tier}>
        <header>
          <h3>${cap.title}</h3>
          <span class="tier-pill" data-state=${cap.tier}>
            <span class="dot"></span>
            ${TIER_LABEL[cap.tier] ?? cap.tier}
          </span>
        </header>
        ${
          cap.packages?.length
            ? html`<div class="packages">
                ${cap.packages.map((p) => html`<span class="pkg-chip">${p.name}</span>`)}
              </div>`
            : nothing
        }
        ${
          top
            ? html`<p class="evidence">
                <span class="kind">${top.kind}</span> · ${top.note}
              </p>`
            : nothing
        }
        ${cap.notes ? html`<p class="notes">${cap.notes}</p>` : nothing}
      </article>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "acp-capability-card": AcpCapabilityCard;
  }
}
