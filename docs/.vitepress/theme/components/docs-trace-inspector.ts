import { EventType } from "@agents-js/agui-types";
import type { AguiEventEnvelope, PlaygroundState, RunRecord } from "@agents-js/browser-runtime";
// Importing any value from `@agents-js/ui-components` evaluates the package's
// `@safeCustomElement` decorators (we register our own tag here too).
import { safeCustomElement } from "@agents-js/ui-components";
import { css, html, LitElement, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, query } from "lit/decorators.js";

/**
 * Color buckets used for the type badge of each trace row. Mapped to
 * VitePress CSS vars in the element's static styles. Kept as a string union
 * (not a CSS-class enum) so `deriveTraceRows` stays a pure projection that
 * tests can assert against without touching the DOM.
 *
 *   blue   — `TEXT_MESSAGE_*` (the agent's prose)
 *   green  — `TOOL_CALL_*`    (the agent searching / reading)
 *   grey   — `RUN_STARTED` / `RUN_FINISHED` (lifecycle markers)
 *   red    — `RUN_ERROR`      (errors)
 *   muted  — everything else  (raw / state / reasoning / custom)
 */
export type TraceRowColor = "blue" | "green" | "grey" | "red" | "muted";

/**
 * One row in the trace inspector list. Produced by `deriveTraceRows`,
 * consumed by the element's render.
 *
 * `seq` is 1-indexed (matches what users read). `salient` is the most
 * useful single field for the row's event kind:
 *   - `TEXT_MESSAGE_CONTENT` → the `delta`
 *   - `TOOL_CALL_START`      → the `toolCallName`
 *   - `RUN_ERROR`            → the `message`
 *   - everything else        → empty string (the badge carries the info)
 *
 * The empty-string fallback is deliberate: rendering `JSON.stringify(event)`
 * here would re-introduce the noise the type badge was meant to compress.
 * If a future event kind needs a salient field, extend the switch in
 * `pickSalient` below.
 */
export interface TraceRow {
  seq: number;
  type: AguiEventEnvelope["type"];
  color: TraceRowColor;
  salient: string;
}

/**
 * Pure derivation: project the active run's AG-UI event log into a list of
 * `TraceRow`s. Mirrors the chat-pane's `deriveChatLines` pattern — keeping
 * the projection in a free function lets tests drive every event shape with
 * a fixture array, while the element class stays a thin renderer.
 *
 * The store enforces `EVENT_CAP=200`, so the array we receive is already
 * bounded. We do NOT slice or filter here — every event the store kept is
 * a row in the inspector, so users can trust 1:1 correspondence.
 *
 * Replay mode (M5): when `state.replayMode !== null`, the projection
 * switches to `state.replayBuffer` (the timer-driven re-emission buffer)
 * instead of the source run's `events`. The source run's events are never
 * mutated during replay — the buffer is a separate, cleared-on-stop
 * staging area so the user can scrub a past run without polluting the
 * authoritative event log.
 */
export function deriveTraceRows(state: PlaygroundState | null): TraceRow[] {
  const events = pickTraceEvents(state);
  return events.map((event, index) => ({
    seq: index + 1,
    type: event.type,
    color: pickColor(event),
    salient: pickSalient(event),
  }));
}

/**
 * Pick the event source for the inspector. During replay, we render the
 * buffered re-emissions; otherwise the active run's live events.
 *
 * Chat-pane uses its own helper (`pickRenderRun`) that synthesizes a
 * full `RunRecord` rather than picking just the events array — the chat
 * projection needs `prompt` for the leading user line, so the two
 * surfaces diverge in shape but follow the same replay-mode rule.
 */
function pickTraceEvents(state: PlaygroundState | null): readonly AguiEventEnvelope[] {
  if (!state) return [];
  if (state.replayMode !== null) return state.replayBuffer;
  const run = getActiveRun(state);
  return run?.events ?? [];
}

function pickColor(event: AguiEventEnvelope): TraceRowColor {
  // String-prefix grouping: every `TEXT_MESSAGE_*` is text-family, every
  // `TOOL_CALL_*` is tool-family. Cheaper to maintain than a hand-written
  // 20-arm switch, and AG-UI's enum names are stable enough to rely on.
  if (event.type.startsWith("TEXT_MESSAGE_")) return "blue";
  if (event.type.startsWith("TOOL_CALL_")) return "green";
  if (event.type === EventType.RUN_STARTED || event.type === EventType.RUN_FINISHED) {
    return "grey";
  }
  if (event.type === EventType.RUN_ERROR) return "red";
  return "muted";
}

function pickSalient(event: AguiEventEnvelope): string {
  if (isTextMessageContent(event)) return event.delta;
  if (isToolCallStart(event)) return event.toolCallName;
  if (isRunError(event)) return event.message;
  return "";
}

function isTextMessageContent(
  e: AguiEventEnvelope,
): e is Extract<AguiEventEnvelope, { type: EventType.TEXT_MESSAGE_CONTENT }> {
  return e.type === EventType.TEXT_MESSAGE_CONTENT;
}
function isToolCallStart(
  e: AguiEventEnvelope,
): e is Extract<AguiEventEnvelope, { type: EventType.TOOL_CALL_START }> {
  return e.type === EventType.TOOL_CALL_START;
}
function isRunError(
  e: AguiEventEnvelope,
): e is Extract<AguiEventEnvelope, { type: EventType.RUN_ERROR }> {
  return e.type === EventType.RUN_ERROR;
}

/**
 * Pull the active `RunRecord` off a state snapshot. Local copy of the
 * chat-pane helper — duplicated rather than re-exported because the two
 * components shouldn't share an import edge through a sibling file.
 */
function getActiveRun(state: PlaygroundState | null): RunRecord | undefined {
  if (!state || state.activeRunId === null) return undefined;
  return state.runs.get(state.activeRunId);
}

/**
 * Pure auto-scroll heuristic. `wasAtBottom` is sampled on the *previous*
 * render; if the user was already at the bottom we follow new events, but
 * if they scrolled up to inspect a past event we leave them where they are.
 *
 * Factored out so tests can assert the rule without staging a DOM scroll
 * container — the element's `updated()` hook calls this with a real
 * scroll-target ref.
 *
 * WHY a flag (not a per-call DOM read): we have to capture "was at bottom"
 * BEFORE Lit applies the new render. Reading scrollTop in `updated()` is
 * already too late — the new rows have been appended and `scrollHeight`
 * grew, so the previous bottom-ness is gone. We sample on scroll events
 * + on the previous render's tail and pass the flag in.
 */
export function shouldAutoScroll(opts: { wasAtBottom: boolean }): boolean {
  return opts.wasAtBottom;
}

/**
 * Slack the at-bottom check tolerates, in pixels. Scrollbars and rounding
 * make `scrollTop + clientHeight === scrollHeight` flaky; 4px covers it
 * without making "I scrolled up a tiny bit" register as still-at-bottom.
 */
const AT_BOTTOM_SLACK_PX = 4;

/**
 * Compute whether a scroll container is currently scrolled to the bottom,
 * within `AT_BOTTOM_SLACK_PX`. Pure so tests can drive the threshold
 * without mounting a DOM container.
 */
export function isAtBottom(opts: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return opts.scrollTop + opts.clientHeight >= opts.scrollHeight - AT_BOTTOM_SLACK_PX;
}

/**
 * `<docs-trace-inspector>` — Playground v2 trace inspector pane.
 *
 * Renders the active run's AG-UI event log as a scrollable, color-coded,
 * sequence-numbered list. State flows down from `<docs-playground-shell>`
 * via the `state` property (single-source-of-truth pattern); the inspector
 * never touches the store directly.
 *
 * The store's `RECEIVE_EVENT` reducer caps `events` at 200 entries via FIFO,
 * so this element renders at most 200 rows at any time — no virtualization
 * needed. Re-render churn during a streaming answer is bounded by Lit's
 * built-in microtask batching: a chunked TEXT_MESSAGE stream collapses to
 * a single `requestUpdate()` per event-loop tick.
 *
 * TODO(trace-raf-batching): see DOT-305 — if profiling later shows that
 * 200-event bursts during streaming drop frames, switch to an
 * rAF-batched render queue (the `_pendingRender` flag in the M3 plan).
 * Microtask batching is sufficient for the current scale.
 */
@safeCustomElement("docs-trace-inspector")
export class DocsTraceInspector extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      border: 1px solid var(--vp-c-divider, #ddd);
      border-radius: 6px;
      padding: 0.5rem;
    }
    .header {
      font-size: 0.85em;
      color: var(--vp-c-text-2, #777);
      margin-bottom: 0.5rem;
    }
    .scroll {
      max-height: 320px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    .row {
      display: grid;
      grid-template-columns: auto auto 1fr;
      gap: 0.5rem;
      align-items: baseline;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-family: var(--vp-font-family-mono, monospace);
      font-size: 0.85em;
    }
    .seq {
      color: var(--vp-c-text-2, #777);
      min-width: 2.5em;
      text-align: right;
    }
    .badge {
      padding: 0 0.4em;
      border-radius: 3px;
      font-weight: 600;
      font-size: 0.85em;
    }
    .salient {
      color: var(--vp-c-text-1, #222);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .blue {
      background: var(--vp-c-brand-soft, #eef);
      color: var(--vp-c-brand-1, #2c3e50);
    }
    .green {
      background: var(--vp-c-success-soft, #efe);
      color: var(--vp-c-success-1, #050);
    }
    .grey {
      background: var(--vp-c-bg-mute, #f0f0f0);
      color: var(--vp-c-text-2, #777);
    }
    .red {
      background: var(--vp-c-danger-soft, #fee);
      color: var(--vp-c-danger-1, #900);
    }
    .muted {
      background: var(--vp-c-bg-mute, #f0f0f0);
      color: var(--vp-c-text-2, #777);
    }
    .empty {
      color: var(--vp-c-text-2, #777);
      font-style: italic;
      padding: 0.5rem;
    }
    /* Replay mode (M5): muted, italic styling distinguishes replayed events
     * from live ones so users know they're watching a historical scrub. */
    .row.replay {
      font-style: italic;
      opacity: 0.75;
    }
    .replay-badge {
      display: inline-block;
      margin-left: 0.5rem;
      padding: 0 0.4em;
      border-radius: 3px;
      font-size: 0.75em;
      font-weight: 700;
      letter-spacing: 0.04em;
      background: var(--vp-c-warning-soft, #ffd);
      color: var(--vp-c-warning-1, #806000);
    }
  `;

  /**
   * Reactive playground state, fed in by `<docs-playground-shell>`. The
   * inspector reads `state.runs.get(state.activeRunId)?.events`. `null`
   * → renders the empty placeholder. Same pass-state-down pattern as
   * `<docs-chat-pane>`; the inspector never touches the store.
   */
  @property({ attribute: false })
  accessor state: PlaygroundState | null = null;

  @query(".scroll")
  private accessor _scrollEl: HTMLElement | null = null;

  /**
   * Tracked across renders: was the scroll container at the bottom on the
   * previous render? Auto-scroll-on-new-events follows only when this is
   * true, so a user who scrolled up to inspect a past event isn't yanked
   * back to the tail. Updated by `_onScroll`, read by `updated`.
   */
  private _wasAtBottom = true;

  /**
   * Stable reference to the scroll handler so `disconnectedCallback` can
   * `removeEventListener` it. Class-property arrow function (not a method
   * bound inline in `firstUpdated`) keeps the identity stable across the
   * add/remove pair — anonymous-closure variants leak listeners.
   *
   * WHY listener cleanup matters: Lit's `firstUpdated` only fires once per
   * instance lifetime, but the host element may be disconnected and
   * reconnected (M5 replay mode re-mounts the inspector). Without the
   * remove + re-add cycle below, a reconnected host has the OLD scroll
   * element wired into a now-dead reference, and `_wasAtBottom` writes
   * land against a detached node. Defensive cleanup also avoids a real
   * listener leak if any future teardown path nulls `_scrollEl` without
   * destroying the host. (See M3 review.)
   */
  private _onScroll = (): void => {
    const el = this._scrollEl;
    if (!el) return;
    this._wasAtBottom = isAtBottom({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  };

  override firstUpdated(): void {
    this._scrollEl?.addEventListener("scroll", this._onScroll);
  }

  override connectedCallback(): void {
    super.connectedCallback();
    // Re-attach listener on reconnect. `firstUpdated` won't fire a second
    // time, so without this hook the scroll-tracking surface goes silent
    // after a disconnect/reconnect cycle. Guarded against double-attach
    // because `addEventListener` with the same function ref is a no-op.
    this._scrollEl?.addEventListener("scroll", this._onScroll);
  }

  override disconnectedCallback(): void {
    this._scrollEl?.removeEventListener("scroll", this._onScroll);
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    if (!changed.has("state")) return;
    const el = this._scrollEl;
    if (!el) return;
    if (shouldAutoScroll({ wasAtBottom: this._wasAtBottom })) {
      el.scrollTop = el.scrollHeight;
    }
  }

  override render(): TemplateResult {
    const rows = deriveTraceRows(this.state);
    const isReplay = this.state?.replayMode !== null && this.state?.replayMode !== undefined;
    if (rows.length === 0) {
      // Surface the REPLAY badge even on empty buffer so the user knows
      // why the trace looks empty (replay just started, no ticks yet).
      return html`<div class="empty">
        No events yet.${isReplay ? html`<span class="replay-badge">REPLAY</span>` : nothing}
      </div>`;
    }
    const rowClass = isReplay ? "row replay" : "row";
    return html`
      <div class="header">
        ${rows.length} event${rows.length === 1 ? nothing : html`s`}
        ${isReplay ? html`<span class="replay-badge">REPLAY</span>` : nothing}
      </div>
      <div class="scroll">
        ${rows.map(
          (r) => html`
            <div class=${rowClass} data-seq=${r.seq}>
              <span class="seq">${r.seq}</span>
              <span class="badge ${r.color}">${r.type}</span>
              <span class="salient">${r.salient}</span>
            </div>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-trace-inspector": DocsTraceInspector;
  }
}
