// Importing any value from the `@agents-js/ui-components` barrel evaluates
// the package's `@safeCustomElement` decorators. The manifest editor is now
// the runtime selector, and this side-effectful import keeps registration
// behavior symmetric with sibling components.
import { safeCustomElement } from "@agents-js/ui-components";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";

/**
 * Phase of the playground shell, surfaced into `<docs-run-controls>` for
 * conditional rendering. Mirrors the legacy `<docs-meta-agent>` phase enum,
 * minus the chat-running states (`running` doesn't change run-controls UI
 * — those affordances belong on `<docs-chat-pane>`).
 */
export type RunControlsPhase = "detecting" | "ready-to-activate" | "loading" | "active" | "error";

/**
 * Inputs for `renderRunControls` — one struct per render so the pure
 * function stays cheap to call from tests without staging a full Lit
 * instance. The element class re-exports its own props through this shape.
 *
 * The manifest editor is the source of truth for runtime selection. The
 * shell reads `state.manifest.runtime` on activate; this control only renders
 * the activate button + status + error.
 *
 * Replay affordances:
 *   - `canReplay` is true when there's at least one past run to replay and no
 *     replay is currently active. Drives the "Replay last run" button visibility.
 *   - `isReplaying` is true while a replay is in flight. The replay button swaps
 *     to "Stop replay" and dispatches `playground-stop-replay`.
 */
export interface RunControlsRenderInput {
  phase: RunControlsPhase;
  loadProgressText: string;
  errorText: string;
  onActivate: () => void;
  canReplay: boolean;
  isReplaying: boolean;
  onReplay: () => void;
  onStopReplay: () => void;
}

/**
 * Pure render helper. WHY split out: Bun's test runner has no DOM, and
 * Lit's `@property` accessor decorator stores its value via private fields
 * that require constructor-time init. Tests using `Object.create(...)` to
 * skip the HTMLElement constructor cannot then write to the accessors
 * without throwing "Cannot read from private field". By extracting the
 * render branching into a free function we can drive every branch with a
 * plain object — same template result, no reactive plumbing required.
 */
export function renderRunControls(input: RunControlsRenderInput): TemplateResult {
  if (input.phase === "detecting") {
    return html`<p>Checking your browser…</p>`;
  }

  if (input.phase === "loading") {
    return html`<p class="progress">Loading… ${input.loadProgressText}</p>`;
  }

  if (input.phase === "active") {
    // Replay affordance: in the active phase, surface a "Replay last run"
    // button when at least one past run exists and no replay is in flight.
    // While replaying, the same button switches to "Stop replay" so the
    // user has a single consistent control for the replay state machine.
    // Full multi-run picker UI can extend this later; the current UX keeps a
    // single-button "replay last run" flow.
    return html`
      <p class="notice">Ready.</p>
      ${
        input.isReplaying
          ? html`<button class="replay" @click=${input.onStopReplay}>Stop replay</button>`
          : input.canReplay
            ? html`<button class="replay" @click=${input.onReplay}>Replay last run</button>`
            : nothing
      }
    `;
  }

  // ready-to-activate (default) and error both render the activate button
  // + optional error text so the user can retry after a failed activation.
  // The manifest editor (rendered separately by the shell) is now the
  // runtime selector; this control no longer offers a mode picker.
  return html`
    <p>The docs meta-agent runs locally in your browser.</p>
    ${input.errorText ? html`<p class="error">${input.errorText}</p>` : nothing}
    <button class="activate" @click=${input.onActivate}>Activate</button>
  `;
}

/**
 * `<docs-run-controls>` — Playground v2 activate button + status surface.
 *
 * Owns two small concerns split out from the legacy `<docs-meta-agent>`:
 * 1. Surface the activate button (label is now phase-agnostic; runtime
 *    choice lives on the manifest editor).
 * 2. Render activation/loading progress text and any activation error.
 *
 * It dispatches a single bubbling `playground-activate` `CustomEvent` (no
 * detail payload — the shell reads `state.manifest.runtime` to decide which
 * factory to invoke). The shell holds the runner cache and the store; this
 * element is render-only state and an event source.
 *
 * The manifest editor's runtime select is the single source of truth for
 * runtime selection.
 */
@safeCustomElement("docs-run-controls")
export class DocsRunControls extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }
    .notice {
      font-size: 0.9em;
      color: var(--vp-c-text-2, #777);
    }
    button.activate,
    button.replay {
      margin-top: 0.75rem;
      padding: 0.5rem 0.75rem;
      cursor: pointer;
    }
    button.replay {
      margin-left: 0.5rem;
    }
    button[disabled] {
      cursor: not-allowed;
      opacity: 0.6;
    }
    .progress {
      font-size: 0.95em;
      color: var(--vp-c-text-2, #777);
      margin-top: 0.5rem;
    }
    .error {
      color: var(--vp-c-danger-1, #900);
      font-size: 0.95em;
    }
  `;

  /** Current shell phase. Drives which sub-tree renders. */
  @property({ attribute: false })
  accessor phase: RunControlsPhase = "detecting";

  /** Loading-progress text emitted by the shell's runner-load callback. */
  @property({ type: String })
  accessor loadProgressText = "";

  /** Optional activation error to surface. */
  @property({ type: String })
  accessor errorText = "";

  /**
   * Whether the shell has at least one past run available to replay.
   * Drives the "Replay last run" button visibility. Set by the shell
   * from `state.runs.size > 0 && state.replayMode === null`.
   */
  @property({ type: Boolean })
  accessor canReplay = false;

  /**
   * Whether a replay is currently in flight. Swaps the replay button's
   * label to "Stop replay" and the click handler to dispatch
   * `playground-stop-replay`.
   */
  @property({ type: Boolean })
  accessor isReplaying = false;

  // Defined as prototype methods (not instance arrow fields) so test code
  // can spy on them without needing constructor-time initialization. Bound
  // to `this` at the render-call site below.
  protected _onActivate(): void {
    this.dispatchEvent(
      new CustomEvent("playground-activate", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected _onReplay(): void {
    // No detail payload: the shell looks up the most-recent runId from
    // its store snapshot. Keeping the event payload-free leaves room for
    // a future run-picker UI without a breaking change.
    this.dispatchEvent(
      new CustomEvent("playground-replay", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected _onStopReplay(): void {
    this.dispatchEvent(
      new CustomEvent("playground-stop-replay", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): TemplateResult {
    return renderRunControls({
      phase: this.phase,
      loadProgressText: this.loadProgressText,
      errorText: this.errorText,
      onActivate: this._onActivate.bind(this),
      canReplay: this.canReplay,
      isReplaying: this.isReplaying,
      onReplay: this._onReplay.bind(this),
      onStopReplay: this._onStopReplay.bind(this),
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-run-controls": DocsRunControls;
  }
}
