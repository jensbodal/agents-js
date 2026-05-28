/**
 * Thin tmux wrapper around `execFileSync` (no shell interpolation —
 * each token is an explicit argv item). Phase 1 surfaces only the
 * operations needed for fresh-launch: `has-session`, `new-session`,
 * `set-environment`, `send-keys`, `attach`, `switch-client`.
 *
 * **Critique-first reasoning**
 *
 * - **Boundary**: this module is the ONLY place that spawns tmux. The
 *   rest of the package is testable without a tmux binary because
 *   `plan.ts` returns structured data and the tmux layer consumes it
 *   from a separate entry point.
 * - **Default**: `requireTmux()` runs at module entry to a launch path
 *   (NOT at import time — tests don't need tmux to import the module).
 *   Hard-fail without tmux per vault plan 5-question default #3.
 * - **Contract**: every command takes a session name as a string;
 *   commands that mutate (new-session, set-environment, send-keys) are
 *   idempotent at the tmux level (new-session is gated by
 *   `hasSession`, set-environment overwrites, send-keys is fire-and-
 *   forget). Functions return either void or boolean (for hasSession).
 * - **Safety**: argv is passed as separate tokens to `execFileSync` —
 *   tmux command + flags are NEVER concatenated through a shell. This
 *   eliminates the quoting class of bugs the bash original navigates
 *   with `printf '%q'`. Caller-supplied strings (session names, env
 *   values, send-keys payloads) flow through as exec args, not shell
 *   strings.
 * - **Validation**: this module is mocked in unit tests (the `tmuxBin`
 *   override). Integration smoke runs the real binary in e2e.
 */

import { execFileSync, spawnSync } from "node:child_process";

/**
 * Override for tests. Production caller doesn't pass this; the default
 * resolves to `"tmux"` from PATH.
 */
export interface TmuxRunnerOptions {
  /** Override the tmux binary path (tests inject `"/usr/bin/true"`). */
  readonly tmuxBin?: string;
  /**
   * Override the spawner. Tests inject a recorder; production uses the
   * default which wraps `execFileSync` / `spawnSync`.
   */
  readonly spawner?: TmuxSpawner;
}

/**
 * Spawner signature. `args` is `["tmux", ...tmuxArgs]` semantically —
 * caller passes JUST the tmux args; the spawner prepends the resolved
 * tmux binary internally.
 */
export type TmuxSpawner = (args: readonly string[]) => TmuxSpawnResult;

export interface TmuxSpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Default spawner using `spawnSync`. Captures stdout/stderr as strings
 * for the call sites that need them (hasSession parses exit code only;
 * sendKeys + setEnvironment + newSession are fire-and-forget but log
 * stderr on non-zero exit).
 */
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

/**
 * Resolved tmux runner. Constructed once by the launch path (CLI) and
 * passed to every tmux operation in the same launch.
 */
export interface TmuxRunner {
  hasSession(session: string): boolean;
  newSessionDetached(session: string, cwd: string): void;
  setEnvironment(session: string, key: string, value: string): void;
  sendKeys(session: string, payload: string): void;
}

/**
 * Build a {@link TmuxRunner}. Production callers pass no options;
 * tests inject `tmuxBin` and/or `spawner` to avoid the real binary.
 *
 * The function eagerly verifies tmux is on PATH (via a `tmux -V`
 * probe) so callers fail fast at launch entry, not deep into the
 * sequence after creating partial state.
 */
export function createTmuxRunner(options: TmuxRunnerOptions = {}): TmuxRunner {
  const tmuxBin = options.tmuxBin ?? "tmux";
  const spawner = options.spawner ?? defaultSpawner(tmuxBin);

  // Eager probe — fail fast if tmux is absent or the override is wrong.
  // Skipped when a custom spawner is supplied (tests).
  if (options.spawner === undefined) {
    try {
      execFileSync(tmuxBin, ["-V"], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      throw new Error(
        `[agents-js launch] tmux binary not found or not executable at "${tmuxBin}" — install tmux or set PATH so it resolves`,
      );
    }
  }

  function expectZeroOrThrow(op: string, args: readonly string[]): void {
    const r = spawner(args);
    if (r.status !== 0) {
      throw new Error(
        `[agents-js launch] tmux ${op} failed (exit=${r.status}): ${r.stderr.trim() || "<no stderr>"}`,
      );
    }
  }

  return {
    hasSession(session) {
      const r = spawner(["has-session", "-t", `=${session}`]);
      return r.status === 0;
    },

    newSessionDetached(session, cwd) {
      expectZeroOrThrow("new-session", ["new-session", "-d", "-s", session, "-c", cwd]);
    },

    setEnvironment(session, key, value) {
      // Pass key + value as separate argv tokens. tmux's
      // set-environment supports `KEY=VALUE` or `KEY VALUE` forms;
      // separated avoids any caller-visible escape boundary.
      expectZeroOrThrow("set-environment", ["set-environment", "-t", session, key, value]);
    },

    sendKeys(session, payload) {
      // `:` window-spec sends to the active pane of the named session.
      expectZeroOrThrow("send-keys", ["send-keys", "-t", `${session}:`, payload, "Enter"]);
    },
  };
}
