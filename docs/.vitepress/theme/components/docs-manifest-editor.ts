import {
  createManifestValidator,
  type ManifestDraft,
  type ManifestValidator,
  type PermissionsPolicy,
  type PlaygroundState,
  type RuntimeId,
  renderManifestAsYaml,
} from "@agents-js/browser-runtime";
// Importing any value from `@agents-js/ui-components` evaluates its
// `@safeCustomElement` decorators (we register our own tag here too).
import { safeCustomElement } from "@agents-js/ui-components";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

/**
 * One entry in the runtime selector. `disabled: true` keeps the option in
 * the visible enum (so users can see what's coming) while preventing it
 * from being chosen — see `RUNTIME_OPTIONS` for the canonical list. The
 * manifest schema still validates a disabled value if a hand-edited manifest
 * sets it; the form just refuses to surface it as a live choice.
 */
export interface RuntimeOption {
  value: RuntimeId;
  label: string;
  disabled?: boolean;
  /** Optional human-readable note rendered next to disabled options. */
  note?: string;
}

/**
 * Runtimes the M4 manifest editor knows how to surface. `mock` and
 * `local-wasm-worker` are wired to real adapters (see `runtime-adapter.ts`);
 * `agents-js-gateway` is reserved for a future remote-runtime adapter
 * (M5+, DOT-307) and is rendered disabled.
 *
 * WHY a module-level constant: the option list is part of the public
 * contract — tests assert on it directly to catch a future "I added a
 * runtime to RuntimeId but forgot to surface it" drift.
 */
export const RUNTIME_OPTIONS: readonly RuntimeOption[] = Object.freeze([
  { value: "mock", label: "Mock — canned-response preview, no download" },
  { value: "local-wasm-worker", label: "Local WebLLM — runs in your browser on WebGPU" },
  {
    value: "agents-js-gateway",
    label: "agents-js-gateway",
    disabled: true,
    note: "coming soon",
  },
]);

const PERMISSIONS_OPTIONS: ReadonlyArray<{ value: PermissionsPolicy; label: string }> =
  Object.freeze([
    { value: "explicit", label: "explicit (ask before each tool call)" },
    { value: "plan", label: "plan (ask once per plan)" },
    { value: "yolo", label: "yolo (auto-approve everything)" },
  ]);

/**
 * Pure dirty check between the applied manifest and the in-progress draft.
 *
 * WHY a free function: the editor's "Unsaved" badge is a derived view; the
 * logic stays trivially testable without staging an HTMLElement. Comparison
 * is intentionally shallow-by-field rather than `JSON.stringify` so a
 * future shape change (extra optional field) gives us a chance to update
 * the helper deliberately rather than silently false-positive.
 */
export function isManifestDirty(applied: ManifestDraft, draft: ManifestDraft): boolean {
  if (applied.name !== draft.name) return true;
  if (applied.runtime !== draft.runtime) return true;
  if (applied.permissions !== draft.permissions) return true;
  if (applied.tools.length !== draft.tools.length) return true;
  for (let i = 0; i < applied.tools.length; i += 1) {
    const a = applied.tools[i];
    const b = draft.tools[i];
    if (!a || !b) return true;
    if (a.name !== b.name) return true;
    if (a.allow !== b.allow) return true;
  }
  return false;
}

/**
 * Render input for the pure render helper. Mirrors the run-controls /
 * trace-inspector pattern: every field a render decision touches is on the
 * struct so tests can drive every branch with a plain object.
 */
export interface ManifestEditorRenderInput {
  state: PlaygroundState | null;
  validator: ManifestValidator;
  validationErrors: string[] | null;
  onPatch: (patch: Partial<ManifestDraft>) => void;
  onApply: () => void;
}

/**
 * Pure render helper. WHY split from the element class: Bun's test runner
 * has no DOM, and Lit's `@property` accessor decorators store their values
 * in private fields that require constructor-time init. Tests using
 * `Object.create(...)` to bypass the HTMLElement constructor cannot then
 * write to the accessors without throwing "Cannot read from private field".
 * Extracting the render branching into a free function lets us drive every
 * branch with a plain input struct — same template result, no reactive
 * plumbing required. (Same trade as `renderRunControls`.)
 */
export function renderManifestEditor(input: ManifestEditorRenderInput): TemplateResult {
  if (!input.state) {
    return html`<p class="empty">No manifest available yet.</p>`;
  }
  const draft = input.state.manifestDraft;
  const dirty = isManifestDirty(input.state.manifest, draft);
  const firstTool = draft.tools[0];
  // Single-tool form for M4. Multi-row editing tracked separately.
  // TODO(manifest-editor-multi-tool): see DOT-307 — extend to N tools with
  // add/remove affordances once the single-tool happy path stabilizes.
  const toolName = firstTool?.name ?? "";
  const toolAllow = firstTool?.allow ?? true;

  return html`
    <div class="header">
      <span class="title">Manifest</span>
      ${dirty ? html`<span class="dirty-badge">Unsaved</span>` : nothing}
    </div>

    <div class="form">
      <label class="row">
        <span class="label">name</span>
        <input
          type="text"
          class="input"
          .value=${draft.name}
          @input=${(e: Event): void => {
            const value = (e.target as HTMLInputElement).value;
            input.onPatch({ name: value });
          }}
        />
      </label>

      <label class="row">
        <span class="label">runtime</span>
        <select
          class="input"
          .value=${draft.runtime}
          @change=${(e: Event): void => {
            const value = (e.target as HTMLSelectElement).value as RuntimeId;
            input.onPatch({ runtime: value });
          }}
        >
          ${RUNTIME_OPTIONS.map(
            (opt) => html`
              <option
                value=${opt.value}
                ?disabled=${opt.disabled ?? false}
                ?selected=${opt.value === draft.runtime}
                title=${opt.note ?? ""}
              >
                ${opt.label}${opt.note ? html` (${opt.note})` : nothing}
              </option>
            `,
          )}
        </select>
      </label>

      <label class="row">
        <span class="label">permissions</span>
        <select
          class="input"
          .value=${draft.permissions}
          @change=${(e: Event): void => {
            const value = (e.target as HTMLSelectElement).value as PermissionsPolicy;
            input.onPatch({ permissions: value });
          }}
        >
          ${PERMISSIONS_OPTIONS.map(
            (opt) => html`
              <option value=${opt.value} ?selected=${opt.value === draft.permissions}>
                ${opt.label}
              </option>
            `,
          )}
        </select>
      </label>

      <div class="row tools-row">
        <span class="label">tools</span>
        <div class="tool-fields">
          <input
            type="text"
            class="input tool-name"
            .value=${toolName}
            @input=${(e: Event): void => {
              const value = (e.target as HTMLInputElement).value;
              input.onPatch({
                tools: [{ name: value, allow: toolAllow }],
              });
            }}
            placeholder="tool name"
          />
          <label class="allow-label">
            <input
              type="checkbox"
              ?checked=${toolAllow}
              @change=${(e: Event): void => {
                const checked = (e.target as HTMLInputElement).checked;
                input.onPatch({
                  tools: [{ name: toolName, allow: checked }],
                });
              }}
            />
            allow
          </label>
        </div>
      </div>
    </div>

    <pre class="yaml-preview" aria-label="manifest YAML preview">${renderManifestAsYaml(draft)}</pre>

    ${
      input.validationErrors !== null
        ? html`
            <ul class="errors" role="alert">
              ${input.validationErrors.map((err) => html`<li>${err}</li>`)}
            </ul>
          `
        : nothing
    }

    <button class="apply" @click=${input.onApply}>Validate & Apply</button>
  `;
}

/**
 * `<docs-manifest-editor>` — Playground v2 manifest editor pane.
 *
 * Renders the active draft's editable fields and a YAML preview, validates
 * on Apply, and surfaces inline error feedback when the validator rejects
 * the draft. State flows down from `<docs-playground-shell>` via the `state`
 * property (single-source-of-truth pattern); the editor never touches the
 * store directly. Edits dispatch `playground-manifest-edit` events with a
 * partial patch; Apply clicks dispatch `playground-manifest-apply`. The
 * shell translates both into store dispatches (`UPDATE_MANIFEST_DRAFT` and
 * `APPLY_MANIFEST` respectively).
 *
 * WHY this element exists: the manifest editor is the runtime selector for
 * Playground v2 — picking `mock` vs `local-wasm-worker` here drives which
 * factory the shell instantiates on `activate()`. The legacy mode picker on
 * `<docs-run-controls>` is retired in M4; this is the new source of truth.
 */
@safeCustomElement("docs-manifest-editor")
export class DocsManifestEditor extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
      border: 1px solid var(--vp-c-divider, #ddd);
      border-radius: 6px;
      padding: 0.75rem;
      background: var(--vp-c-bg-soft, #f6f6f6);
    }
    .header {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }
    .title {
      font-weight: 600;
      color: var(--vp-c-text-1, #222);
    }
    .dirty-badge {
      font-size: 0.75em;
      padding: 0.1em 0.5em;
      border-radius: 3px;
      background: var(--vp-c-warning-soft, #ffd);
      color: var(--vp-c-warning-1, #960);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .form {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-bottom: 0.75rem;
    }
    .row {
      display: grid;
      grid-template-columns: 6em 1fr;
      gap: 0.5rem;
      align-items: center;
    }
    .label {
      font-size: 0.85em;
      color: var(--vp-c-text-2, #777);
      font-family: var(--vp-font-family-mono, monospace);
    }
    .input {
      padding: 0.35rem 0.5rem;
      border: 1px solid var(--vp-c-divider, #ddd);
      border-radius: 4px;
      background: var(--vp-c-bg, #fff);
      color: var(--vp-c-text-1, #222);
      font-family: inherit;
      font-size: 0.9em;
    }
    .tools-row {
      align-items: start;
    }
    .tool-fields {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .tool-name {
      flex: 1;
    }
    .allow-label {
      display: inline-flex;
      gap: 0.25rem;
      align-items: center;
      font-size: 0.9em;
      color: var(--vp-c-text-2, #777);
    }
    .yaml-preview {
      background: var(--vp-c-bg, #fff);
      border: 1px solid var(--vp-c-divider, #ddd);
      border-radius: 4px;
      padding: 0.5rem;
      font-family: var(--vp-font-family-mono, monospace);
      font-size: 0.8em;
      color: var(--vp-c-text-1, #222);
      margin: 0 0 0.5rem;
      overflow-x: auto;
    }
    .errors {
      list-style: disc;
      margin: 0 0 0.5rem;
      padding-left: 1.5rem;
      color: var(--vp-c-danger-1, #900);
      font-size: 0.85em;
      background: var(--vp-c-danger-soft, #fee);
      border-radius: 4px;
      padding-top: 0.4rem;
      padding-bottom: 0.4rem;
    }
    .errors li {
      font-family: var(--vp-font-family-mono, monospace);
    }
    button.apply {
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      background: var(--vp-c-brand-1, #2c3e50);
      color: var(--vp-c-bg, #fff);
      border: none;
      border-radius: 4px;
      font-weight: 500;
    }
    button.apply:hover {
      background: var(--vp-c-brand-2, #1f2d3a);
    }
    .empty {
      color: var(--vp-c-text-2, #777);
      font-style: italic;
    }
  `;

  /**
   * Reactive playground state, fed in by `<docs-playground-shell>`. The
   * editor reads `state.manifestDraft` for in-progress edits and renders
   * "Unsaved" if `manifestDraft !== manifest`. Same pass-state-down pattern
   * as `<docs-chat-pane>` and `<docs-trace-inspector>`; the editor never
   * touches the store.
   */
  @property({ attribute: false })
  accessor state: PlaygroundState | null = null;

  /**
   * Validator for live-feedback on user input. Default is the production
   * `createManifestValidator()`. Injectable for tests so a stricter or
   * always-failing validator can be passed without going through the
   * production AJV compile path.
   */
  @property({ attribute: false })
  accessor validator: ManifestValidator = createManifestValidator();

  /**
   * Most-recent validation errors from the last failed Apply. `null` until
   * Apply runs and rejects; cleared back to `null` on a successful Apply
   * AND on any draft edit (so a stale error banner doesn't linger past the
   * fix that resolved it). Stored as `@state` (not `@property`) so the
   * shell can't write it from outside — the editor owns its validation
   * feedback.
   */
  @state()
  private accessor _validationErrors: string[] | null = null;

  // Defined as prototype methods (not arrow fields) so test code can spy on
  // them without needing constructor-time initialization, mirroring the
  // run-controls pattern.

  protected _onPatch(patch: Partial<ManifestDraft>): void {
    // Any draft edit dismisses stale validation feedback. Without this,
    // an error banner from a prior failed Apply (e.g. "name must NOT have
    // fewer than 1 characters") sticks around while the user types the
    // fix, which is confusing — they fix the empty name and the banner
    // still complains. The next Apply re-runs the validator and re-populates
    // errors if anything's still wrong.
    this._validationErrors = null;
    this.dispatchEvent(
      new CustomEvent("playground-manifest-edit", {
        detail: { patch },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected _onNameInput(e: Event): void {
    const value = (e.target as HTMLInputElement).value;
    this._onPatch({ name: value });
  }

  protected _onRuntimeChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value as RuntimeId;
    this._onPatch({ runtime: value });
  }

  protected _onPermissionsChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value as PermissionsPolicy;
    this._onPatch({ permissions: value });
  }

  protected _onToolNameInput(e: Event): void {
    const value = (e.target as HTMLInputElement).value;
    const draft = this.state?.manifestDraft;
    const allow = draft?.tools[0]?.allow ?? true;
    this._onPatch({ tools: [{ name: value, allow }] });
  }

  protected _onToolAllowChange(e: Event): void {
    const checked = (e.target as HTMLInputElement).checked;
    const draft = this.state?.manifestDraft;
    const name = draft?.tools[0]?.name ?? "";
    this._onPatch({ tools: [{ name, allow: checked }] });
  }

  protected _onApply(): void {
    const draft = this.state?.manifestDraft;
    if (!draft) return;
    const result = this.validator(draft);
    if (!result.valid) {
      // Surface validation errors inline; refuse to dispatch APPLY.
      this._validationErrors = result.errors ?? ["Manifest is invalid."];
      return;
    }
    this._validationErrors = null;
    this.dispatchEvent(
      new CustomEvent("playground-manifest-apply", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): TemplateResult {
    return renderManifestEditor({
      state: this.state,
      validator: this.validator,
      validationErrors: this._validationErrors,
      onPatch: this._onPatch.bind(this),
      onApply: this._onApply.bind(this),
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-manifest-editor": DocsManifestEditor;
  }
}
