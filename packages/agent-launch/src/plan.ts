/**
 * Plan builder for {@link LaunchCommand}. Phase 1 covers `mode: "fresh"`
 * for the `claude-code` harness. Resume mode + per-harness session
 * resolvers land in Phase 5 per vault plan.
 *
 * **Critique-first reasoning**
 *
 * - **Boundary**: this module is a PURE function. Input = config entry +
 *   base env; output = structured plan record. No spawn, no tmux, no
 *   filesystem.
 * - **Default**: rejects unsupported harnesses + unsupported modes with
 *   a typed `LaunchPlanError` carrying the agent + harness for caller
 *   diagnostics. Strict-by-default for forward compat — Phase 2 adds
 *   harness branches by extending the switch, not by silently accepting
 *   unknown values.
 * - **Contract**: returns `{cwd, command, args, env, sessionEnv}` — the
 *   tmux `set-environment` calls happen in `tmux.ts` consuming
 *   `sessionEnv`. The structured shape is testable without rendering
 *   shell strings (bash `printf '%q'` quoting ≠ JS string handling;
 *   equivalence is at the structured layer).
 * - **Safety**: argv splitting on whitespace is intentionally simple.
 *   The bash original assembles a command string with shell-aware
 *   quoting; here we treat `freshFlags` as a whitespace-separated argv
 *   list. Agents with embedded quoted flags will surface as malformed
 *   in Phase 1 — they get a fix in Phase 2 alongside `launch_prompt`
 *   handling (codex-cli's `printf '%q'` path).
 * - **Validation**: unit tests cover the cognee-claude fixture plus
 *   negative cases (unsupported harness, missing required field via
 *   loader, empty freshFlags, fresh flag splitting).
 */

import type { AgentEntry } from "./config.ts";
import { injectIdentityEnv, type LaunchEnv } from "./identity.ts";

/**
 * Phase 1 supports `"fresh"` only. Phase 5 adds `"resume"` once
 * per-harness session resolvers land.
 */
export type LaunchMode = "fresh";

/**
 * Harnesses supported in Phase 1. Phase 2 extends this union with
 * `"codex-cli"`, `"opencode"`, `"kiro-cli"`, etc. The union is the
 * source of truth — adding a harness requires updating the switch in
 * {@link buildLaunchPlan}, which keeps boundary-narrowing-drift in
 * check.
 */
export type SupportedHarness = "claude-code";

const SUPPORTED_HARNESSES: ReadonlySet<string> = new Set<SupportedHarness>(["claude-code"]);

/**
 * Structured plan returned by {@link buildLaunchPlan}. The tmux layer
 * consumes this verbatim — `command` + `args` go to the child process;
 * `env` becomes the child env; `sessionEnv` is what gets pushed via
 * `tmux set-environment` so windows opened later in the same session
 * see the same identity vars.
 */
export interface LaunchPlan {
  /** tmux session name to attach/create. */
  readonly tmuxSession: string;
  /** Working directory the harness launches from. */
  readonly cwd: string;
  /** Binary to execute. Caller resolves to absolute path before spawn. */
  readonly command: string;
  /** Argv tokens passed to the binary. */
  readonly args: readonly string[];
  /** Full env record passed to the child process. */
  readonly env: LaunchEnv;
  /** Subset of env that should ALSO be pushed via tmux set-environment. */
  readonly sessionEnv: LaunchEnv;
  /** Harness kind — copied through for downstream observability. */
  readonly harness: SupportedHarness;
  /** Mode — Phase 1 always `"fresh"`. */
  readonly mode: LaunchMode;
}

/** Typed error raised when the plan cannot be built. */
export class LaunchPlanError extends Error {
  readonly agentName: string;
  readonly harness?: string;
  readonly mode?: string;
  constructor(message: string, opts: { agentName: string; harness?: string; mode?: string }) {
    super(`[agents-js launch-plan] agent="${opts.agentName}": ${message}`);
    this.name = "LaunchPlanError";
    this.agentName = opts.agentName;
    this.harness = opts.harness;
    this.mode = opts.mode;
  }
}

/**
 * Keys lifted into `sessionEnv` (tmux set-environment). Caller-supplied
 * vars that are NOT in this set go to the child process env only.
 *
 * The git identity vars + MATRIX_AGENT are the ones that downstream
 * tmux windows (opened by the user later in the same session) need to
 * see for git commits + Matrix routing to behave consistently.
 */
const SESSION_ENV_KEYS: ReadonlySet<string> = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "MATRIX_AGENT",
]);

function splitFlags(flags: string): readonly string[] {
  // Phase 1: whitespace split. Phase 2 adds quoted-flag support for
  // codex-cli's `launch_prompt` positional (which uses bash `printf %q`
  // in the original).
  const tokens = flags
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  return tokens;
}

function pickSessionEnv(env: LaunchEnv): LaunchEnv {
  const out: Record<string, string> = {};
  for (const k of SESSION_ENV_KEYS) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return Object.freeze(out);
}

export interface BuildLaunchPlanOptions {
  /**
   * Base environment to layer identity vars onto. Production callers
   * pass `process.env` (filtered to string values); tests inject a
   * controlled record.
   */
  readonly baseEnv: LaunchEnv;
  /** Phase 1 always `"fresh"`. */
  readonly mode?: LaunchMode;
}

/**
 * Build a {@link LaunchPlan} for `entry` in `mode`. Throws
 * {@link LaunchPlanError} for unsupported harnesses or mode.
 */
export function buildLaunchPlan(entry: AgentEntry, options: BuildLaunchPlanOptions): LaunchPlan {
  const mode: LaunchMode = options.mode ?? "fresh";
  if (mode !== "fresh") {
    throw new LaunchPlanError(`mode "${mode}" not supported in Phase 1 (only "fresh")`, {
      agentName: entry.tmuxSession,
      mode,
    });
  }
  if (!SUPPORTED_HARNESSES.has(entry.harness)) {
    throw new LaunchPlanError(
      `harness "${entry.harness}" not supported in Phase 1 (supported: ${Array.from(SUPPORTED_HARNESSES).sort().join(", ")})`,
      { agentName: entry.tmuxSession, harness: entry.harness },
    );
  }

  const env = injectIdentityEnv(entry, options.baseEnv);
  const args = splitFlags(entry.freshFlags);
  if (args.length === 0) {
    throw new LaunchPlanError(
      `fresh_flags is empty after split — harness would launch with no flags`,
      {
        agentName: entry.tmuxSession,
        harness: entry.harness,
      },
    );
  }

  return {
    tmuxSession: entry.tmuxSession,
    cwd: entry.workspace,
    command: entry.binary,
    args,
    env,
    sessionEnv: pickSessionEnv(env),
    harness: "claude-code",
    mode,
  };
}
