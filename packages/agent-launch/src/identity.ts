/**
 * Identity env composition for {@link buildLaunchPlan}. Phase 1 scope:
 * git author identity (4 vars) + MATRIX_AGENT only.
 *
 * Per vault plan §4 phase 1: "injectIdentityEnv (git + MATRIX_AGENT only —
 * defer matrix-token injection and gemini symlinks to phase 3)".
 *
 * The matrix-token write to `~/.config/agents-js/config.json` lives in a
 * Phase 3 module (`writeMatrixTokenToProfileConfig`) that depends on
 * gateway-runtime's `writeAgentsJsConfig`. Gemini ACP symlinks (creds +
 * settings) are also Phase 3.
 *
 * **Critique-first reasoning**
 *
 * - **Boundary**: this module is a PURE function. No filesystem writes,
 *   no process spawns, no tmux calls. It composes an `Env` record from
 *   typed inputs and returns it. Side effects (tmux `set-environment`)
 *   happen in `tmux.ts` after the plan is built.
 * - **Default**: caller's `baseEnv` keys are preserved unless explicitly
 *   overridden. Git identity vars + MATRIX_AGENT WIN over `baseEnv` when
 *   the agent entry specifies them — caller's PATH / HOME / etc. flow
 *   through untouched.
 * - **Contract**: returns a fresh frozen object. Callers MAY pass
 *   `process.env` as `baseEnv` safely; we never mutate it.
 * - **Safety**: skips git identity entirely if either name OR email is
 *   missing — partial git identity (one set, one inherited) is a worse
 *   failure mode than no identity (the harness then falls back to local
 *   git config or refuses the commit, both visible failures vs. a
 *   silent wrong-author commit).
 * - **Validation**: unit tests cover full identity, name-only/email-only
 *   (both skipped), no envSetup, simple envSetup, multi-line envSetup,
 *   complex envSetup rejection.
 */

import type { AgentEntry } from "./config.ts";

/**
 * Env record passed to {@link injectIdentityEnv} as the base; returned as
 * a fresh object with identity vars layered on top.
 */
export type LaunchEnv = Readonly<Record<string, string>>;

/**
 * Typed error raised when {@link injectIdentityEnv} encounters an
 * `env_setup` snippet it can't interpret. Phase 1 only handles simple
 * `export KEY=VALUE` lines; complex shell (quoting, expansion,
 * command substitution) fails fast with this error so the caller can
 * decide to drop the agent or extend the parser.
 */
export class IdentityEnvError extends Error {
  readonly agentName?: string;
  readonly line?: string;
  constructor(message: string, opts: { agentName?: string; line?: string } = {}) {
    super(`[agents-js launch-identity] ${message}`);
    this.name = "IdentityEnvError";
    this.agentName = opts.agentName;
    this.line = opts.line;
  }
}

/**
 * Parse a single `export KEY=VALUE` line into a [key, value] pair.
 * Accepts:
 *   - `export FOO=bar`
 *   - `export FOO="bar"` (double-quoted value)
 *   - `export FOO='bar'` (single-quoted value)
 *   - leading whitespace, trailing whitespace
 *
 * Rejects (returns null):
 *   - command substitution `$(...)` `\`...\``
 *   - shell expansion `$VAR` (intentional — Phase 1 wants byte-identity)
 *   - non-export lines
 *   - missing `=`
 *   - non-identifier keys (must match /^[A-Za-z_][A-Za-z0-9_]*$/)
 */
const EXPORT_LINE = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
function parseExportLine(line: string): readonly [string, string] | null {
  const m = line.match(EXPORT_LINE);
  if (!m) return null;
  const key = m[1] as string;
  let value = (m[2] as string).trim();
  // Strip matching surrounding quotes.
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  // Reject shell expansion / command substitution. Phase 1 wants pure
  // literal values so the env contract is testable without spawning a
  // shell.
  if (value.includes("$(") || value.includes("`")) return null;
  if (/(?<!\\)\$/.test(value)) return null;
  return [key, value];
}

/**
 * Parse the per-agent `env_setup` string into a typed env record.
 * Splits on newlines + `&&`; each segment must parse as an `export`
 * line. Empty segments are skipped.
 */
export function parseEnvSetup(envSetup: string, agentName?: string): LaunchEnv {
  const out: Record<string, string> = {};
  // Bash original separates with newlines or `&&` (per agent-launch.sh
  // build_launch_cmd composing the launch command string).
  const segments = envSetup
    .split(/[\n;]|&&/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const segment of segments) {
    const parsed = parseExportLine(segment);
    if (!parsed) {
      throw new IdentityEnvError(
        `env_setup line is not a simple "export KEY=VALUE" (Phase 1 limit; reject command-subst + var-expansion): ${segment}`,
        { agentName, line: segment },
      );
    }
    const [key, value] = parsed;
    out[key] = value;
  }
  return out;
}

/**
 * Layer git identity + MATRIX_AGENT (from envSetup) onto `baseEnv` and
 * return a fresh frozen env record. Caller passes `process.env` as
 * baseEnv in production; tests inject a controlled record.
 */
export function injectIdentityEnv(entry: AgentEntry, baseEnv: LaunchEnv): LaunchEnv {
  const out: Record<string, string> = { ...baseEnv };

  // Git identity: both name + email or neither. Partial = silent wrong
  // author later, which is worse than missing.
  if (entry.gitAuthorName !== undefined && entry.gitAuthorEmail !== undefined) {
    out.GIT_AUTHOR_NAME = entry.gitAuthorName;
    out.GIT_AUTHOR_EMAIL = entry.gitAuthorEmail;
    out.GIT_COMMITTER_NAME = entry.gitAuthorName;
    out.GIT_COMMITTER_EMAIL = entry.gitAuthorEmail;
  }

  // envSetup: Phase 1 only extracts MATRIX_AGENT (the most-common
  // export). Other variables found here are passed through so dot-cognee
  // configs that already set additional vars (`MATRIX_HOMESERVER`,
  // `MATRIX_USER` — Phase 3 will own these formally) continue working.
  if (entry.envSetup !== undefined) {
    const parsed = parseEnvSetup(entry.envSetup, entry.tmuxSession);
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = v;
    }
  }

  return Object.freeze(out);
}
