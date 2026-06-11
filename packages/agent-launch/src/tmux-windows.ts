/**
 * Composable tmux **window** operations for in-session multi-window launches
 * (e.g. the pi cockpit layout: runtime/ACP surface in window :0, interactive
 * TUI in :1, raw ACP stream in :2, log tail in :3).
 *
 * **Why a separate module from {@link ./tmux.ts}.** PR #176 established that
 * companion topologies (the codex `--with-receiver` receiver) are CLI-level
 * orchestration, and the session-level `TmuxRunner` stays session-scoped. This
 * module follows that boundary: it adds *window* primitives without touching the
 * session runner, reusing the identical injectable {@link TmuxSpawner} seam so it
 * is unit-tested with the same `mockSpawner` pattern (no real tmux binary).
 *
 * **Base-index normalization.** The operator's tmux may set `base-index 1`, so a
 * freshly created session's first window is NOT guaranteed to be `:0`. We detect
 * the first window index and, if needed, move it to `:0`, then create the
 * remaining windows. This yields a deterministic `:0`=runtime layout regardless
 * of the operator's `base-index` (verified across base-index 0 and 1).
 *
 * **Safety.** Every token is an explicit argv item passed to `spawnSync` /
 * `execFileSync` — tmux commands are NEVER concatenated through a shell, so
 * caller-supplied session names, window names, and send-keys payloads carry no
 * quoting hazard (same contract as {@link ./tmux.ts}).
 */
import { execFileSync, spawnSync } from "node:child_process";
import type { TmuxSpawner, TmuxSpawnResult } from "./tmux.ts";

/** Interactive attach/switch seam — handed the tmux argv; inherits stdio. */
export type TmuxAttach = (args: readonly string[]) => void;

export interface TmuxWindowOpsOptions {
  /** Override the tmux binary path (tests inject a fake). */
  readonly tmuxBin?: string;
  /** Override the spawner. Tests inject a recorder; production wraps `spawnSync`. */
  readonly spawner?: TmuxSpawner;
  /**
   * Override the interactive attach. Tests inject a recorder (attach must NOT go
   * through the capturing `spawner` — it hands the terminal to tmux via inherited
   * stdio and blocks until the user detaches).
   */
  readonly attach?: TmuxAttach;
  /**
   * Whether the launch is running INSIDE an existing tmux client. The CLI caller
   * computes this from its injected env (e.g. `Boolean(env.TMUX)`) and passes it,
   * so this module stays free of global `process.env` access. Defaults to `false`
   * (→ `attach-session`); when `true` we `switch-client`.
   */
  readonly insideTmux?: boolean;
}

export interface TmuxWindowOps {
  /** Read the index of the session's first (lowest-index) window. */
  firstWindowIndex(session: string): number;
  /** Move the first window to index `:0` when `base-index` left it elsewhere. */
  normalizeFirstWindowToZero(session: string): void;
  /** Create a window at `:<index>` without stealing focus (`-d`). */
  newWindow(session: string, index: number, name: string, cwd: string): void;
  /** Focus a window by index. */
  selectWindow(session: string, index: number): void;
  /** Send a command line (+ Enter) to a specific window's active pane. */
  sendKeysToWindow(session: string, index: number, payload: string): void;
  /**
   * Hand the terminal to the session: `switch-client` when already inside tmux,
   * else `attach-session`. Blocking + interactive (inherited stdio).
   */
  attachOrSwitch(session: string): void;
}

function defaultSpawner(tmuxBin: string): TmuxSpawner {
  return (args) => {
    const result = spawnSync(tmuxBin, args as string[], { encoding: "utf8" });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

function defaultAttach(tmuxBin: string): TmuxAttach {
  return (args) => {
    // stdio:"inherit" — the interactive client owns the terminal; this blocks
    // until the user detaches. NOT routed through the capturing spawner.
    execFileSync(tmuxBin, args as string[], { stdio: "inherit" });
  };
}

/**
 * Build {@link TmuxWindowOps}. Production callers pass no options; tests inject
 * `spawner` (and `attach`) to avoid the real binary.
 */
export function createTmuxWindowOps(options: TmuxWindowOpsOptions = {}): TmuxWindowOps {
  const tmuxBin = options.tmuxBin ?? "tmux";
  const spawner = options.spawner ?? defaultSpawner(tmuxBin);
  const attach = options.attach ?? defaultAttach(tmuxBin);
  const insideTmux = options.insideTmux ?? false;

  function expectZeroOrThrow(op: string, args: readonly string[]): TmuxSpawnResult {
    const r = spawner(args);
    if (r.status !== 0) {
      throw new Error(
        `[agents-js launch] tmux ${op} failed (exit=${r.status}): ${r.stderr.trim() || "<no stderr>"}`,
      );
    }
    return r;
  }

  function firstWindowIndex(session: string): number {
    const r = expectZeroOrThrow("list-windows", [
      "list-windows",
      "-t",
      session,
      "-F",
      "#{window_index}",
    ]);
    const first = r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    const idx = Number(first);
    if (!Number.isInteger(idx)) {
      throw new Error(
        `[agents-js launch] could not parse first window index for session "${session}" from tmux output: ${JSON.stringify(r.stdout)}`,
      );
    }
    return idx;
  }

  return {
    firstWindowIndex,

    normalizeFirstWindowToZero(session) {
      const idx = firstWindowIndex(session);
      if (idx !== 0) {
        expectZeroOrThrow("move-window", [
          "move-window",
          "-s",
          `${session}:${idx}`,
          "-t",
          `${session}:0`,
        ]);
      }
    },

    newWindow(session, index, name, cwd) {
      // `-d`: create detached so focus stays where the caller wants it; the
      // caller selects the default window (:0 = runtime) explicitly afterwards.
      expectZeroOrThrow("new-window", [
        "new-window",
        "-d",
        "-t",
        `${session}:${index}`,
        "-n",
        name,
        "-c",
        cwd,
      ]);
    },

    selectWindow(session, index) {
      expectZeroOrThrow("select-window", ["select-window", "-t", `${session}:${index}`]);
    },

    sendKeysToWindow(session, index, payload) {
      expectZeroOrThrow("send-keys", ["send-keys", "-t", `${session}:${index}`, payload, "Enter"]);
    },

    attachOrSwitch(session) {
      attach(insideTmux ? ["switch-client", "-t", session] : ["attach-session", "-t", session]);
    },
  };
}
