import {
  type BrowserCapabilities,
  chooseModel,
  createManifestValidator,
  createPlaygroundStore,
  DEFAULT_MANIFEST,
  detectBrowserCapabilities,
  type ManifestDraft,
  type PlaygroundState,
  type PlaygroundStore,
  type PromptRunner,
  type SupportedModelId,
} from "@agents-js/browser-runtime";
// Importing any value from the `@agents-js/ui-components` barrel evaluates
// the package's `@safeCustomElement` decorators (we register our own tag
// here too).
import { safeCustomElement } from "@agents-js/ui-components";
import { css, html, LitElement, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import "./docs-chat-pane.ts"; // side-effect import: registers <docs-chat-pane>
import "./docs-manifest-editor.ts"; // side-effect import: registers <docs-manifest-editor>
import "./docs-run-controls.ts"; // side-effect import: registers <docs-run-controls>
import "./docs-trace-inspector.ts"; // side-effect import: registers <docs-trace-inspector>
import type { RunControlsPhase } from "./docs-run-controls.ts";

/**
 * Pre-activation runner factory — invoked only if something dispatches
 * `START_RUN` before `activate()` runs. Throws so the misuse is loud rather
 * than silent.
 *
 * WHY a real factory (not a `null` placeholder): the store invokes
 * `runnerFactory()` inside `START_RUN`'s side-effect path and dispatches
 * `FINALIZE_RUN { status: "errored" }` on rejection. Returning a rejected
 * promise here gives well-defined behavior if the chat pane somehow becomes
 * interactable pre-activation; making the factory non-optional keeps the
 * store dependency contract honest.
 */
function preActivationRunnerFactory(): Promise<PromptRunner> {
  return Promise.reject(new Error("Runner not yet activated."));
}

/**
 * `<docs-playground-shell>` — Playground v2 root element.
 *
 * Replaces the legacy `<docs-meta-agent>` element. Owns:
 * - The `PlaygroundStore` instance — created eagerly after capability
 *   detection (so the manifest editor can render pre-activation), recreated
 *   on `activate()` with the user-chosen runner factory while preserving
 *   the in-progress manifest draft.
 * - The cached `PromptRunner` (single download / single WebLLM engine).
 * - Capability detection + model picking on `connectedCallback`.
 * - Translation of child `CustomEvent`s into `store.dispatch` calls. Children
 *   (`<docs-run-controls>`, `<docs-chat-pane>`, `<docs-trace-inspector>`,
 *   `<docs-manifest-editor>`) never touch the store directly — single
 *   source of truth: shell owns store, children render from props.
 *
 * Layout:
 * - Pre-activation: run-controls + manifest editor side-by-side. The user
 *   picks a runtime in the manifest editor, applies it, then clicks Activate.
 * - Active: chat pane (left) + tabbed inspector (right). The tab selector
 *   switches between `<docs-trace-inspector>` and `<docs-manifest-editor>`,
 *   driven by `state.ui.activeTab`.
 *
 * Re-render strategy: subscribing to the store triggers `requestUpdate()` on
 * each commit. Re-render churn is fine at this scale — the only mutating
 * surface is a single transcript and a few status fields.
 */
@safeCustomElement("docs-playground-shell")
export class DocsPlaygroundShell extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      border: 1px solid var(--vp-c-divider, #ddd);
      border-radius: 8px;
      padding: 1rem;
      max-width: 960px;
    }
    .pre-activate {
      display: block;
      margin-top: 1rem;
    }
    .grid-2-pane {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
      gap: 1rem;
      margin-top: 1rem;
    }
    @media (max-width: 720px) {
      .grid-2-pane {
        grid-template-columns: 1fr;
      }
    }
    .inspector-tabs {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .tab-buttons {
      display: flex;
      gap: 0.25rem;
      border-bottom: 1px solid var(--vp-c-divider, #ddd);
    }
    .tab {
      padding: 0.4rem 0.75rem;
      cursor: pointer;
      background: transparent;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--vp-c-text-2, #777);
      font-size: 0.9em;
      font-family: inherit;
    }
    .tab.active {
      color: var(--vp-c-brand-1, #2c3e50);
      border-bottom-color: var(--vp-c-brand-1, #2c3e50);
      font-weight: 600;
    }
  `;

  /** Probe used to detect browser capabilities. Injectable for tests. */
  @property({ attribute: false })
  accessor capabilitiesProbe: () => Promise<BrowserCapabilities> = detectBrowserCapabilities;

  /**
   * Factory that produces a `PromptRunner` for the chosen WebLLM model.
   * Set to `null` by default — embedders (the VitePress `DocsMetaAgent.vue`
   * mount) inject a real WebLLM-backed factory at mount time. Used when
   * `state.manifest.runtime === "local-wasm-worker"`.
   */
  @property({ attribute: false })
  accessor runnerFactory:
    | ((modelId: SupportedModelId, onProgress: (p: unknown) => void) => Promise<PromptRunner>)
    | null = null;

  /**
   * Mock-runner factory. Same injection contract as `runnerFactory`. Used
   * when `state.manifest.runtime === "mock"`.
   */
  @property({ attribute: false })
  accessor mockRunnerFactory: (() => Promise<PromptRunner>) | null = null;

  @state()
  private accessor _phase: RunControlsPhase = "detecting";

  @state()
  private accessor _modelId: SupportedModelId | null = null;

  @state()
  private accessor _loadProgressText = "";

  @state()
  private accessor _errorText = "";

  /** Most-recent state snapshot from the store. */
  @state()
  private accessor _state: PlaygroundState | null = null;

  private _store: PlaygroundStore | null = null;
  private _cachedRunner: PromptRunner | null = null;
  private _unsubscribe: (() => void) | null = null;

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    await this._detectCapabilities();
  }

  /**
   * Capability-detection seam, factored out of `connectedCallback` so tests
   * can exercise the real production path without going through Lit's
   * `super.connectedCallback()` (which touches `document` and would explode
   * in Bun's DOM-less runtime). Idempotent: only runs while `_phase` is the
   * initial `"detecting"` value.
   *
   * On completion, the store is created eagerly with a `preActivationRunnerFactory`
   * and seeded with `DEFAULT_MANIFEST`. This lets the manifest editor render
   * pre-activation: the user can pick a runtime in the manifest editor
   * before clicking Activate. The pre-activation factory throws if anything
   * dispatches `START_RUN` before `activate()` swaps it for the real one.
   */
  protected async _detectCapabilities(): Promise<void> {
    if (this._phase !== "detecting") return;
    const caps = await this.capabilitiesProbe();
    const id = chooseModel(caps);
    this._modelId = id;
    this._initStore({
      runnerFactory: preActivationRunnerFactory,
      initialManifest: this._defaultPreActivationManifest(id !== null),
    });
    this._phase = "ready-to-activate";
  }

  /**
   * Pick the pre-activation default manifest. WHY conditional: when WebGPU
   * isn't available, defaulting to `local-wasm-worker` would force the user
   * to manually flip to `mock` before they can activate. Defaulting to
   * `mock` in that case mirrors the legacy mode-picker fallback.
   */
  private _defaultPreActivationManifest(modelAvailable: boolean): ManifestDraft {
    return modelAvailable ? DEFAULT_MANIFEST : { ...DEFAULT_MANIFEST, runtime: "mock" };
  }

  /**
   * Build a fresh store with the given deps and rewire the subscription.
   * Called from `_detectCapabilities` (with the pre-activation throwing
   * factory) and from `activate()` (with the real chosen factory). The
   * existing `manifest` + `manifestDraft` are forwarded so an in-progress
   * draft survives the activation handoff.
   *
   * WHY recreate rather than mutate: `CreatePlaygroundStoreDeps.runnerFactory`
   * is captured at construction time and used inside the closure that drives
   * `START_RUN`. There's no documented seam for swapping it post-hoc, and
   * adding one would invite subtle race conditions during in-flight runs.
   * Recreating is safe because no run can be in flight pre-activation.
   */
  private _initStore(opts: {
    runnerFactory: () => Promise<PromptRunner>;
    initialManifest?: ManifestDraft;
  }): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._store = createPlaygroundStore({
      runnerFactory: opts.runnerFactory,
      validator: createManifestValidator(),
      initialManifest: opts.initialManifest,
    });
    this._unsubscribe = this._store.subscribe((state) => {
      this._state = state;
    });
    this._state = this._store.getState();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe?.();
    this._unsubscribe = null;
    void this._cleanup();
  }

  /**
   * Release any cached runner — the WebLLM `WebWorker` and the GPU memory
   * its engine holds. Called from `disconnectedCallback` and from the
   * post-`await` race guard in `activate()` (a runner that materializes
   * after the host has been torn down is disposed immediately rather than
   * orphaned).
   */
  private async _cleanup(): Promise<void> {
    if (this._cachedRunner) {
      try {
        await this._cachedRunner.dispose?.();
      } catch (err) {
        console.warn("Error disposing runner:", err);
      }
      this._cachedRunner = null;
    }
  }

  /**
   * Public API: surface a fatal initialization error from the embedder.
   * Mirrors the legacy `<docs-meta-agent>.setError` contract.
   */
  setError(message: string): void {
    this._phase = "error";
    this._errorText = message;
  }

  /**
   * Public API: load a runner for the manifest's chosen runtime, cache it,
   * and rebuild the store with the live factory. Exposed (instead of being
   * purely event-driven) so embedders can trigger activation directly if
   * needed — and so tests can stage the activation path without dispatching
   * a synthetic CustomEvent.
   *
   * Reads `state.manifest.runtime` to decide which factory to invoke. If
   * the chosen runtime has no factory (e.g. `agents-js-gateway`, which is
   * disabled in the manifest editor's UI), the shell flips to error phase
   * — defensive path; the form should prevent this.
   */
  async activate(): Promise<void> {
    if (!this._store) {
      // Shouldn't normally happen — `_detectCapabilities` always creates
      // the store. Guard so we surface the misuse loudly.
      this._phase = "error";
      this._errorText = "Activation requested before capability detection completed.";
      return;
    }
    const runtime = this._store.getState().manifest.runtime;
    this._phase = "loading";
    this._errorText = "";
    this._loadProgressText = "";
    try {
      const runner = await this._loadRunner(runtime);
      // Race guard: the user may have navigated away during the model
      // download. If the host element is no longer connected to the DOM,
      // dispose immediately rather than caching a runner that nothing will
      // ever release.
      if (!this.isConnected) {
        try {
          await runner.dispose?.();
        } catch (err) {
          console.warn("Error disposing runner after late disconnect:", err);
        }
        return;
      }
      this._cachedRunner = runner;
      // Preserve the in-progress manifest + draft across the store rebuild.
      const prior = this._store.getState();
      this._initStore({
        runnerFactory: async () => runner,
        initialManifest: prior.manifest,
      });
      // Re-apply the draft on top so pre-activation edits aren't lost.
      // (initialManifest seeds both manifest and manifestDraft to the same
      // value; a non-applied draft would otherwise vanish here.)
      if (prior.manifestDraft !== prior.manifest && this._store) {
        this._store.dispatch({
          type: "UPDATE_MANIFEST_DRAFT",
          patch: prior.manifestDraft,
        });
      }
      this._phase = "active";
    } catch (err) {
      this._phase = "error";
      this._errorText = `${runtime} load failed: ${(err as Error).message}`;
    }
  }

  private async _loadRunner(runtime: ManifestDraft["runtime"]): Promise<PromptRunner> {
    if (runtime === "mock") {
      if (!this.mockRunnerFactory) throw new Error("No mock runner factory configured.");
      return this.mockRunnerFactory();
    }
    if (runtime === "local-wasm-worker") {
      if (!this._modelId || !this.runnerFactory) {
        throw new Error("No model runner factory configured.");
      }
      return this.runnerFactory(this._modelId, (p) => {
        const text =
          typeof p === "object" && p !== null && "text" in p
            ? String((p as { text: unknown }).text)
            : "";
        this._loadProgressText = text;
      });
    }
    // `agents-js-gateway` and any future ids land here. The manifest editor
    // disables `agents-js-gateway` so this path is defensive only.
    throw new Error(`Runtime "${runtime}" is not yet implemented.`);
  }

  // --- Event translation: child events → store dispatches. -----------------

  private _onActivateRequested(): void {
    void this.activate();
  }

  private _onPrompt(e: CustomEvent<{ prompt: string }>): void {
    this._store?.dispatch({ type: "START_RUN", prompt: e.detail.prompt });
  }

  private _onCancel(): void {
    this._store?.dispatch({ type: "CANCEL_RUN" });
  }

  private _onManifestEdit(e: CustomEvent<{ patch: Partial<ManifestDraft> }>): void {
    this._store?.dispatch({ type: "UPDATE_MANIFEST_DRAFT", patch: e.detail.patch });
  }

  private _onManifestApply(): void {
    this._store?.dispatch({ type: "APPLY_MANIFEST" });
  }

  private _onTabSelect(tab: "trace" | "manifest"): void {
    this._store?.dispatch({ type: "SET_TAB", tab });
  }

  /**
   * Translate the `<docs-run-controls>` "Replay last run" event into a
   * `START_REPLAY` action. The most-recent run is the last entry in the
   * store's runs map (insertion order is preserved by Map). The current UI uses
   * a single-button "replay last run" flow; a full picker is deferred — see
   * TODO(replay-run-picker) on `<docs-run-controls>`.
   */
  private _onReplay(): void {
    if (!this._store) return;
    const state = this._store.getState();
    const ids = Array.from(state.runs.keys());
    const lastId = ids[ids.length - 1];
    if (!lastId) return;
    this._store.dispatch({ type: "START_REPLAY", runId: lastId });
  }

  private _onStopReplay(): void {
    this._store?.dispatch({ type: "STOP_REPLAY" });
  }

  private _isInputDisabled(): boolean {
    if (!this._state || this._state.activeRunId === null) return false;
    const run = this._state.runs.get(this._state.activeRunId);
    return run?.status === "running";
  }

  override render(): TemplateResult {
    const canReplay = this._canReplay();
    const isReplaying = this._isReplaying();
    return html`
      <docs-run-controls
        .phase=${this._phase}
        .loadProgressText=${this._loadProgressText}
        .errorText=${this._errorText}
        ?canReplay=${canReplay}
        ?isReplaying=${isReplaying}
        @playground-activate=${this._onActivateRequested.bind(this)}
        @playground-replay=${this._onReplay.bind(this)}
        @playground-stop-replay=${this._onStopReplay.bind(this)}
      ></docs-run-controls>
      ${
        this._phase === "active"
          ? this._renderActiveBody()
          : this._phase === "ready-to-activate" || this._phase === "error"
            ? this._renderPreActivateBody()
            : html``
      }
    `;
  }

  /**
   * Replay-button-visibility predicate. True when the store has at least
   * one past run that has FINISHED, AND no replay is currently active.
   *
   * The "finished" guard matters: replaying a still-`running` run would
   * race the live `RECEIVE_EVENT` stream against the replay engine's
   * cursor read of the same `run.events` array, producing nonsensical
   * interleaving (replay re-emits events from index 0 while new ones
   * land at the tail). The symmetric guard is the dispatch wrapper's
   * `START_RUN`-cancels-replay rule (live runs preempt replays); this
   * is the inverse — replays only allowed against finalized runs.
   *
   * The UI surfaces a single "Replay last run" button; the multi-run
   * picker is deferred. See TODO(replay-run-picker) on
   * `<docs-run-controls>`.
   */
  private _canReplay(): boolean {
    if (!this._state) return false;
    if (this._state.runs.size === 0 || this._state.replayMode !== null) return false;
    const ids = Array.from(this._state.runs.keys());
    const lastId = ids[ids.length - 1];
    if (!lastId) return false;
    const lastRun = this._state.runs.get(lastId);
    return lastRun !== undefined && lastRun.status !== "running";
  }

  private _isReplaying(): boolean {
    return this._state?.replayMode !== null && this._state?.replayMode !== undefined;
  }

  private _renderPreActivateBody(): TemplateResult {
    return html`
      <div class="pre-activate">
        <docs-manifest-editor
          .state=${this._state}
          @playground-manifest-edit=${this._onManifestEdit.bind(this)}
          @playground-manifest-apply=${this._onManifestApply.bind(this)}
        ></docs-manifest-editor>
      </div>
    `;
  }

  private _renderActiveBody(): TemplateResult {
    const activeTab = this._state?.ui.activeTab ?? "trace";
    // ARIA tab/tabpanel wiring: each tab button declares `aria-controls`
    // pointing at the panel's id, and the panel declares `role="tabpanel"`
    // + `aria-labelledby` pointing back at the tab id. This lets assistive
    // tech navigate the tab/panel relationship programmatically. We render
    // only the active panel (matching the existing conditional-render
    // pattern); the panel id swaps with the active tab so the labelling
    // stays correct under the conditional.
    const panelId = activeTab === "trace" ? "panel-trace" : "panel-manifest";
    const panelLabelId = activeTab === "trace" ? "tab-trace" : "tab-manifest";
    return html`
      <div class="grid-2-pane">
        <docs-chat-pane
          .state=${this._state}
          ?inputDisabled=${this._isInputDisabled()}
          @playground-prompt=${this._onPrompt.bind(this)}
          @playground-cancel=${this._onCancel.bind(this)}
        ></docs-chat-pane>
        <div class="inspector-tabs">
          <div class="tab-buttons" role="tablist" aria-label="Inspector tabs">
            <button
              id="tab-trace"
              class="tab ${activeTab === "trace" ? "active" : ""}"
              role="tab"
              aria-selected=${activeTab === "trace" ? "true" : "false"}
              aria-controls="panel-trace"
              @click=${(): void => this._onTabSelect("trace")}
            >
              Trace
            </button>
            <button
              id="tab-manifest"
              class="tab ${activeTab === "manifest" ? "active" : ""}"
              role="tab"
              aria-selected=${activeTab === "manifest" ? "true" : "false"}
              aria-controls="panel-manifest"
              @click=${(): void => this._onTabSelect("manifest")}
            >
              Manifest
            </button>
          </div>
          <div
            id=${panelId}
            role="tabpanel"
            aria-labelledby=${panelLabelId}
            class="tab-panel"
          >
          ${
            activeTab === "trace"
              ? html`<docs-trace-inspector .state=${this._state}></docs-trace-inspector>`
              : html`
                  <docs-manifest-editor
                    .state=${this._state}
                    @playground-manifest-edit=${this._onManifestEdit.bind(this)}
                    @playground-manifest-apply=${this._onManifestApply.bind(this)}
                  ></docs-manifest-editor>
                `
          }
          </div>
        </div>
      </div>
    `;
  }

  // -- Test-only handles. The shell's lifecycle methods (`activate`,
  //    `setError`) are public above; these accessors expose internal state
  //    so the suite can validate dispatch-translation without re-mounting.
  /** @internal */
  get __store(): PlaygroundStore | null {
    return this._store;
  }
  /** @internal */
  get __cachedRunner(): PromptRunner | null {
    return this._cachedRunner;
  }
  /** @internal */
  get __phase(): RunControlsPhase {
    return this._phase;
  }
  /** @internal */
  get __errorText(): string {
    return this._errorText;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-playground-shell": DocsPlaygroundShell;
  }
}
