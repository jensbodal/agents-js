import type { CapabilityCardData, CapabilityTier } from "@agents-js/ui-components";
// Importing any value from the `@agents-js/ui-components` barrel evaluates the
// package's `@safeCustomElement` side effects, registering every `acp-*`
// element (including `acp-capability-card`) before this element renders.
import { safeCustomElement } from "@agents-js/ui-components";
import { css, html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";

/** Shape of `docs/public/capability-status.json` (generator output). */
export interface CapabilityStatusDoc {
  generated_at?: string;
  source_commit?: string;
  tier_counts: Record<CapabilityTier, number>;
  capabilities: CapabilityCardData[];
}

const TIER_ORDER: CapabilityTier[] = ["demonstrated", "undemonstrated", "over-claimed", "missing"];
const TIER_LABEL: Record<CapabilityTier, string> = {
  demonstrated: "Demonstrated",
  undemonstrated: "Undemonstrated",
  "over-claimed": "Over-claimed",
  missing: "Missing",
};

/**
 * The ecosystem/capability map. Consumes the generated
 * `capability-status.json` and renders the classification as a grid of
 * `acp-capability-card`s — dogfooding the agents-js design system to visualize
 * agents-js itself. Tier filter chips narrow the grid client-side.
 *
 * Read-only and fetch-free: the host (`DocsCapabilityMap.vue`) owns the fetch
 * and pushes the parsed doc into `.data`.
 */
@safeCustomElement("docs-capability-map")
export class DocsCapabilityMap extends LitElement {
  @property({ attribute: false })
  accessor data: CapabilityStatusDoc | undefined = undefined;

  @state()
  private accessor _filter: CapabilityTier | "all" = "all";

  static override styles = css`
    :host {
      display: block;
      font-size: 14px;
    }
    .summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    button.chip {
      cursor: pointer;
      border: 1px solid var(--vp-c-divider, #e2e2e3);
      background: var(--vp-c-bg-soft, #f6f6f7);
      color: var(--vp-c-text-1, #213547);
      border-radius: 9999px;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button.chip[aria-pressed="true"] {
      border-color: var(--vp-c-brand-1, #3451b2);
      color: var(--vp-c-brand-1, #3451b2);
      background: color-mix(in srgb, var(--vp-c-brand-1, #3451b2) 10%, transparent);
    }
    button.chip .count {
      font-variant-numeric: tabular-nums;
      opacity: 0.7;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .meta {
      margin-top: 16px;
      font-size: 12px;
      color: var(--vp-c-text-2, #67676c);
    }
    .empty {
      color: var(--vp-c-text-2, #67676c);
      font-style: italic;
    }
  `;

  private _setFilter(tier: CapabilityTier | "all"): void {
    this._filter = tier;
  }

  protected override render() {
    const doc = this.data;
    if (!doc) {
      return html`<p class="empty">Loading capability map…</p>`;
    }
    const total = doc.capabilities.length;
    const shown =
      this._filter === "all"
        ? doc.capabilities
        : doc.capabilities.filter((c) => c.tier === this._filter);

    return html`
      <div class="summary">
        <button
          class="chip"
          aria-pressed=${this._filter === "all"}
          @click=${() => this._setFilter("all")}
        >
          All <span class="count">${total}</span>
        </button>
        ${TIER_ORDER.map(
          (tier) => html`
            <button
              class="chip"
              aria-pressed=${this._filter === tier}
              @click=${() => this._setFilter(tier)}
            >
              ${TIER_LABEL[tier]} <span class="count">${doc.tier_counts?.[tier] ?? 0}</span>
            </button>
          `,
        )}
      </div>
      <div class="grid">
        ${shown.map((cap) => html`<acp-capability-card .capability=${cap}></acp-capability-card>`)}
      </div>
      ${
        doc.source_commit
          ? html`<p class="meta">
              Generated from source <code>${doc.source_commit}</code> · ${total} capabilities
            </p>`
          : nothing
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-capability-map": DocsCapabilityMap;
  }
}
