import { EventType } from "@agents-js/agui-types";
import type { AguiEventEnvelope, PlaygroundState, RunRecord } from "@agents-js/browser-runtime";
// Importing any value from the `@agents-js/ui-components` barrel evaluates
// its `@safeCustomElement` decorators. We only re-use the decorator factory
// here, but the side-effectful import keeps the bundle consistent with the
// other docs components.
import { safeCustomElement } from "@agents-js/ui-components";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";

/**
 * One rendered transcript line. The discriminant `role` matches the chat
 * surface vocabulary, while the source data is AG-UI envelopes from the
 * playground store.
 */
export interface ChatLine {
  role: "user" | "agent" | "tool" | "error" | "cancelled";
  text: string;
}

/**
 * Pure derivation: project an active run's `RunRecord` into a list of
 * `ChatLine`s.
 *
 * WHY pure: the chat-pane is a pure projection of store state. Keeping the
 * derivation in a free function lets us snapshot AG-UI streams in tests
 * without mounting Lit, and keeps the element class trivially testable
 * (assert that the element renders the same array the helper produces).
 *
 * Mapping rules:
 *   - `RunRecord.prompt` → leading `user` line (no separate accumulator).
 *   - `TEXT_MESSAGE_START` opens a new `agent` line keyed by `messageId`.
 *   - `TEXT_MESSAGE_CONTENT` appends `delta` to the open agent line.
 *   - `TEXT_MESSAGE_END` closes the line (no visual marker; the next
 *     `_START` opens a new one).
 *   - `TOOL_CALL_START` emits a one-shot `tool` line with the tool name.
 *   - `RUN_ERROR` emits an `error` line — or a `cancelled` line if the
 *     bridge tagged it with `code === "cancelled"` (see `agui-event-bridge`).
 *   - `TOOL_CALL_ARGS`, `TOOL_CALL_END`, `RUN_FINISHED` are deliberately
 *     ignored at the chat surface (the trace inspector renders those).
 */
export function deriveChatLines(run: RunRecord | undefined): ChatLine[] {
  if (!run) return [];
  const lines: ChatLine[] = [{ role: "user", text: run.prompt }];
  // Track the currently-open agent line by its messageId so a stream of
  // CONTENT events folds into a single concatenated line. We use a Map
  // because TEXT_MESSAGE_END only closes the matching messageId — guards
  // against interleaved messages from a future multi-stream future.
  const openAgentLines = new Map<string, ChatLine>();
  for (const ev of run.events) {
    if (isTextMessageStart(ev)) {
      const line: ChatLine = { role: "agent", text: "" };
      openAgentLines.set(ev.messageId, line);
      lines.push(line);
      continue;
    }
    if (isTextMessageContent(ev)) {
      const line = openAgentLines.get(ev.messageId);
      if (line) {
        line.text += ev.delta;
      }
      continue;
    }
    if (isTextMessageEnd(ev)) {
      openAgentLines.delete(ev.messageId);
      continue;
    }
    if (isToolCallStart(ev)) {
      lines.push({ role: "tool", text: `→ ${ev.toolCallName}` });
      continue;
    }
    if (isRunError(ev)) {
      const role: ChatLine["role"] = ev.code === "cancelled" ? "cancelled" : "error";
      lines.push({ role, text: ev.message });
    }
    // TOOL_CALL_ARGS, TOOL_CALL_END, RUN_FINISHED — intentionally ignored.
  }
  return lines;
}

function isTextMessageStart(
  e: AguiEventEnvelope,
): e is Extract<AguiEventEnvelope, { type: EventType.TEXT_MESSAGE_START }> {
  return e.type === EventType.TEXT_MESSAGE_START;
}
function isTextMessageContent(
  e: AguiEventEnvelope,
): e is Extract<AguiEventEnvelope, { type: EventType.TEXT_MESSAGE_CONTENT }> {
  return e.type === EventType.TEXT_MESSAGE_CONTENT;
}
function isTextMessageEnd(
  e: AguiEventEnvelope,
): e is Extract<AguiEventEnvelope, { type: EventType.TEXT_MESSAGE_END }> {
  return e.type === EventType.TEXT_MESSAGE_END;
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
 * `<docs-chat-pane>` — Playground v2 transcript + input form.
 *
 * Subscribes to `PlaygroundState` via the shell-injected `state` property
 * (single-source-of-truth pattern; the shell owns the store and re-renders
 * children on every commit). The element dispatches `playground-prompt`
 * and `playground-cancel` `CustomEvent`s up to the shell, never calling
 * `store.dispatch` directly — the shell does that translation so the store
 * boundary stays in one file.
 */
@safeCustomElement("docs-chat-pane")
export class DocsChatPane extends LitElement {
  static override styles = css`
    :host {
      display: block;
      font-family: system-ui, sans-serif;
    }
    .chat {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      min-height: 200px;
    }
    .line {
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
    }
    .user {
      background: var(--vp-c-bg-soft, #f6f6f6);
    }
    .agent {
      background: var(--vp-c-brand-soft, #eef);
    }
    .tool {
      background: var(--vp-c-bg-mute, #f0f0f0);
      font-family: var(--vp-font-family-mono, monospace);
      font-size: 0.9em;
    }
    .error {
      background: var(--vp-c-danger-soft, #fee);
      color: var(--vp-c-danger-1, #900);
    }
    .cancelled {
      background: var(--vp-c-bg-mute, #f0f0f0);
      font-style: italic;
      color: var(--vp-c-text-2, #777);
    }
    .input-row {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;
    }
    input {
      flex: 1;
      padding: 0.5rem;
    }
    button {
      padding: 0.5rem 0.75rem;
      cursor: pointer;
    }
    .empty {
      color: var(--vp-c-text-2, #777);
      font-style: italic;
    }
    /* Replay mode: muted, italic visual cue per chat line so users
     * see the same distinction the trace inspector applies to its rows. */
    .line.replay {
      font-style: italic;
      opacity: 0.75;
    }
  `;

  /** Whole playground state, fed in by the shell. `null` until activated. */
  @property({ attribute: false })
  accessor state: PlaygroundState | null = null;

  /** Disable input + send while a run is in flight. */
  @property({ type: Boolean })
  accessor inputDisabled = false;

  /**
   * Local input-buffer state — chat-pane owns its own draft text. Marked
   * `@state` (not `@property`) so it stays internal: the shell never writes
   * `.inputValue` from the outside, and we don't want to expose it on the
   * external API surface.
   */
  @state()
  accessor inputValue = "";

  protected _onInput(e: Event): void {
    this.inputValue = (e.target as HTMLInputElement).value;
  }

  protected _onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") this._send();
  }

  protected _send(): void {
    const text = this.inputValue.trim();
    if (!text) return;
    this.inputValue = "";
    this.dispatchEvent(
      new CustomEvent("playground-prompt", {
        detail: { prompt: text },
        bubbles: true,
        composed: true,
      }),
    );
  }

  protected _cancel(): void {
    this.dispatchEvent(
      new CustomEvent("playground-cancel", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  override render(): TemplateResult {
    const isReplay = this.state?.replayMode !== null && this.state?.replayMode !== undefined;
    // During replay, derive lines from a synthetic RunRecord that points at
    // `replayBuffer` instead of the source run's `events`. The id + prompt
    // come from the replay-target run so the leading user line still makes
    // sense; only the events array is swapped.
    const renderRun = pickRenderRun(this.state);
    const lines = deriveChatLines(renderRun);
    const hasLines = lines.length > 0;
    const activeRun = getActiveRun(this.state);
    const showCancel = !isReplay && !!activeRun && activeRun.status === "running";
    const lineClassFor = (role: ChatLine["role"]): string =>
      isReplay ? `line ${role} replay` : `line ${role}`;

    return html`
      <div class="chat">
        ${
          hasLines
            ? lines.map(
                (l) =>
                  html`<div class=${lineClassFor(l.role)}>
                    <strong>${l.role}:</strong> ${l.text}
                  </div>`,
              )
            : html`<p class="empty">Send a prompt to start a run.</p>`
        }
      </div>
      <div class="input-row">
        <input
          .value=${this.inputValue}
          ?disabled=${this.inputDisabled}
          @input=${this._onInput.bind(this)}
          @keydown=${this._onKeydown.bind(this)}
          placeholder="Ask the docs..."
        />
        <button ?disabled=${this.inputDisabled} @click=${this._send.bind(this)}>Send</button>
        ${showCancel ? html`<button @click=${this._cancel.bind(this)}>Cancel</button>` : nothing}
      </div>
    `;
  }
}

/**
 * Pick the `RunRecord` the chat pane should project. During replay, we
 * synthesize a record from the replay-target run plus the `replayBuffer`
 * — preserving id/prompt/status from the source while swapping the
 * events to the timer-driven re-emission stream. Outside replay, the
 * active run.
 *
 * Exported for tests so the synthetic-record contract is independently
 * verifiable.
 */
export function pickRenderRun(state: PlaygroundState | null): RunRecord | undefined {
  if (!state) return undefined;
  if (state.replayMode !== null) {
    const source = state.runs.get(state.replayMode.runId);
    if (!source) return undefined;
    return { ...source, events: state.replayBuffer };
  }
  return getActiveRun(state);
}

/**
 * Helper: pull the active `RunRecord` off a state snapshot. Exported for
 * tests so they can validate the chat-pane's projection contract directly
 * against fixture state.
 */
export function getActiveRun(state: PlaygroundState | null): RunRecord | undefined {
  if (!state || state.activeRunId === null) return undefined;
  return state.runs.get(state.activeRunId);
}

declare global {
  interface HTMLElementTagNameMap {
    "docs-chat-pane": DocsChatPane;
  }
}
