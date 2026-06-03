/**
 * Small argv-parsing + value-normalization helpers shared by the
 * `serve`, `acp`, and `bridge` subcommands. Extracted to a single
 * module so each subcommand's entry file doesn't carry its own copy.
 *
 * None of these helpers have side effects; they exist purely to share
 * one canonical implementation of each validator.
 */

export const VALID_RUNTIME_LOG_LEVELS = new Set(["debug", "info", "warn", "error", "silent"]);

/**
 * Parse + normalize a `--runtime-log-level` value. Throws with a
 * human-readable error if the value isn't one of the accepted levels.
 */
export function parseRuntimeLogLevel(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!VALID_RUNTIME_LOG_LEVELS.has(normalized)) {
    throw new Error(
      `[agents-js] --runtime-log-level must be one of ${[...VALID_RUNTIME_LOG_LEVELS].join(", ")}.`,
    );
  }
  return normalized;
}

/**
 * Read the next argv value for a flag (mutating caller's index is
 * the caller's responsibility — this helper just validates presence).
 * Throws if the value is missing.
 */
export function consumeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`[agents-js] Missing value for ${flag}.`);
  }
  return value;
}

/**
 * Parse + validate a `--port` value (integer in [0, 65535]).
 */
export function parsePort(raw: string): number {
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 65535) {
    throw new Error("[agents-js] --port must be an integer between 0 and 65535.");
  }
  return numeric;
}

/**
 * Normalize a `--host` value. Returns `127.0.0.1` for blank input.
 */
export function normalizeHost(host: string | undefined): string {
  return host?.trim() ? host.trim() : "127.0.0.1";
}

/**
 * Terminal task-state values in the protocol-neutral vocabulary that
 * {@link import("@agents-js/a2a-client").A2ASessionState}.`taskState`
 * speaks (hyphenated strings — see `taskStateToVocabulary`). The CLI
 * stays on the vocabulary side of the proto boundary: A2A 1.0's
 * `isTerminalTaskState` operates on the proto `TaskState` enum, so the
 * non-interactive `send`/one-shot flows test terminality against this
 * set instead of pushing the proto enum up into client-side logic.
 */
const TERMINAL_TASK_VOCABULARY = new Set(["completed", "failed", "canceled", "rejected"]);

/** True when a session-vocabulary `taskState` is terminal. */
export function isTerminalTaskVocabulary(taskState: string | undefined): boolean {
  return taskState !== undefined && TERMINAL_TASK_VOCABULARY.has(taskState);
}
