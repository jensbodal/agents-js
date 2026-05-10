/**
 * Live "current action" status line — one row above the input bar that
 * swaps in place as the agent transitions through phases of a turn:
 *
 *   - `🤔 thinking… (4.2s, 1240 chars)` while `pendingThoughtText` is
 *     populated. Two signals so the user knows something is happening:
 *     wall-clock elapsed (so a long wait visibly progresses) and a
 *     cumulative thought-text character count (proxy for "the model
 *     is producing output, just not visible yet").
 *   - `▶ read_file (1.2s)` while a tool call is in `activeToolCalls`
 *   - empty (hidden) when neither is active
 *
 * Cleared via session reducer when first `message.delta` arrives, so the
 * line vanishes once the visible response starts streaming. After the
 * turn completes, the full timeline lives in `state.completedToolCalls`
 * for later transcript-history rendering (separate component).
 *
 * This is the standard "current action" pattern used by Claude Code,
 * Codex CLI, aider, etc. — give the user something to look at during
 * the otherwise-silent server-side reasoning phase rather than a frozen
 * screen for 30-60 seconds.
 */
import type { A2ASessionState } from "@agents-js/a2a-client";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";

export interface ClientActiveAction {
  root: BoxRenderable;
  update(state: A2ASessionState): void;
  /** Stop the elapsed-time refresh ticker. Must be called from the
   *  parent app's `destroy()` to avoid render-after-destroy errors
   *  and unnecessary wakeups in long-running processes/tests. */
  destroy(): void;
}

/** Format a duration in ms as a human label like "1.2s" / "32s". */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remSec = Math.floor(sec % 60);
  return `${min}m${remSec}s`;
}

/** Truncate a tool name with summary args for inline display. */
function truncateLabel(label: string, max = 60): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1)}…`;
}

export function createClientActiveAction(renderer: CliRenderer): ClientActiveAction {
  const line = new TextRenderable(renderer, {
    id: "client-active-action-line",
    content: "",
    fg: "#7aa2f7",
  });

  const root = new BoxRenderable(renderer, {
    id: "client-active-action-root",
    width: "100%",
    height: 1,
    flexDirection: "row",
    paddingLeft: 1,
    paddingRight: 1,
  });
  root.add(line);

  // Refresh ticker — drives the elapsed-time counter visible in the line.
  // Sync with the renderer's existing 30 FPS loop is overkill; 10 Hz is
  // fine for "elapsed seconds" UX and reduces wakeups when idle.
  // Comment 2 fix: skip the re-render entirely when the line has
  // nothing to update (no thinking, no active tool). The line content
  // is already empty in that state and the elapsed counter has nothing
  // to advance — re-rendering would just churn the renderer for no
  // visible change.
  let lastState: A2ASessionState | null = null;
  let thoughtStartedAt: number | null = null;
  let destroyed = false;
  const tick = setInterval(() => {
    if (destroyed || !lastState) return;
    if (!lastState.pendingThoughtText && lastState.activeToolCalls.length === 0) {
      return;
    }
    render(lastState);
    renderer.intermediateRender();
  }, 100);
  // Don't keep the event loop alive just to update the line.
  if (typeof tick.unref === "function") {
    tick.unref();
  }

  function render(state: A2ASessionState): void {
    const now = Date.now();
    const activeTool = state.activeToolCalls[state.activeToolCalls.length - 1];

    if (state.pendingThoughtText) {
      // Showing thinking. We don't render the thought text inline (could
      // be long and noisy); show two signals instead so the user knows
      // something is happening: an elapsed-time counter (so a long
      // wait visibly progresses) and a cumulative character count
      // (proxy for "the model is producing output, just not visible
      // yet"). Elapsed-time anchor is `thoughtStartedAt` so the
      // counter resets at the start of each thinking phase rather
      // than running on the whole turn.
      if (thoughtStartedAt === null) {
        thoughtStartedAt = now;
      }
      const elapsed = formatElapsed(now - thoughtStartedAt);
      const tokens = state.pendingThoughtText.length;
      line.content = `🤔 thinking… (${elapsed}, ${tokens} chars)`;
      line.fg = "#bb9af7";
    } else if (activeTool) {
      // Reset thought elapsed-time anchor — next thinking phase
      // starts a fresh counter rather than picking up where the
      // previous left off.
      thoughtStartedAt = null;
      const elapsed = formatElapsed(now - activeTool.startedAt);
      const label = truncateLabel(activeTool.toolName || "(unnamed tool)");
      line.content = `▶ ${label} (${elapsed})`;
      line.fg = "#7dcfff";
    } else {
      // Idle — empty content. Box still occupies its row to keep the
      // layout stable (avoids the input bar jumping when the line
      // appears/disappears mid-turn). Reset thought anchor so a new
      // thinking phase next turn starts from 0.
      thoughtStartedAt = null;
      line.content = "";
    }
  }

  return {
    root,
    update(state) {
      lastState = state;
      render(state);
    },
    destroy() {
      destroyed = true;
      clearInterval(tick);
    },
  };
}
