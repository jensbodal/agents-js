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
import { injectIdentityEnv, type LaunchEnv, parseEnvSetup } from "./identity.ts";

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
export type SupportedHarness = "claude-code" | "pi";

const SUPPORTED_HARNESSES: ReadonlySet<string> = new Set<SupportedHarness>(["claude-code", "pi"]);

/**
 * Default `-e <extension>` entry pi loads in native-peer mode. Operators
 * override via the `pi_extension` config field. The native-peer extension
 * exposes the live Pi TUI as a localhost A2A endpoint (see
 * `extras/pi-extension`), which is how a native pi joins the agents-js mesh.
 */
const DEFAULT_PI_EXTENSION = "@agents-js/pi-extension";

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
  /**
   * Channel-adapter provisioning env (from `channel_env`). These reach the
   * spawned harness's PROCESS env (so its child channel-adapter MCP inherits
   * them) but are intentionally NOT pushed via tmux set-environment — they
   * carry per-launch gateway wiring (incl. a key-fetch command), not the
   * session-wide identity vars in {@link sessionEnv}. Empty when unset.
   */
  readonly channelEnv: LaunchEnv;
  /**
   * Pre-authorized tools (from `allowed_tools`), also rendered into
   * {@link args} as a `--allowedTools` flag. Carried here too for
   * introspection/testing. Empty when unset.
   */
  readonly allowedTools: readonly string[];
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
  // pi native-peer vars — must reach the pi process via `launch.ts`'s
  // send-keys export (which only emits sessionEnv + channelEnv). Absent for
  // non-pi harnesses, so pickSessionEnv simply skips them.
  "AGENTS_JS_PI_NATIVE",
  "AGENTS_JS_PI_NAME",
  "AGENTS_JS_PI_PORT",
  "AGENTS_JS_PI_HOST",
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
  /**
   * Resolver for the host's LAN-reachable address. Injected so this planner
   * stays pure (no `os` read) while the native-pi launch can advertise a
   * routable A2A endpoint across machines instead of loopback. The CLI passes
   * {@link detectLanHost}; tests inject a fixed value. When omitted (or it
   * returns `undefined`), the launch keeps the localhost default — the
   * pi-extension falls back to `127.0.0.1`.
   */
  readonly resolveLanHost?: () => string | undefined;
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

  // Channel-adapter env is parsed like envSetup but kept separate so the CLI
  // can export it into the harness process env without pushing it session-wide.
  const channelEnv: LaunchEnv = entry.channelEnv
    ? Object.freeze({ ...parseEnvSetup(entry.channelEnv, entry.tmuxSession) })
    : Object.freeze({});
  // Identity + channel vars layered on the base env. Provider keys (e.g.
  // ZAI_API_KEY for pi) flow through from baseEnv untouched.
  const baseEnv = Object.freeze({ ...injectIdentityEnv(entry, options.baseEnv), ...channelEnv });

  // Harness-specific command/args/env. Phase 1 shipped claude-code; Phase 2
  // adds pi (native-peer mode onto the agents-js A2A bus). Adding a harness =
  // a new branch here + a token in SUPPORTED_HARNESSES.
  const harness = entry.harness as SupportedHarness;
  const built =
    harness === "pi"
      ? buildPiInvocation(entry, baseEnv, options.resolveLanHost)
      : buildClaudeCodeInvocation(entry, baseEnv);

  return {
    tmuxSession: entry.tmuxSession,
    cwd: entry.workspace,
    command: built.command,
    args: built.args,
    env: built.env,
    sessionEnv: pickSessionEnv(built.env),
    channelEnv,
    allowedTools: built.allowedTools,
    harness,
    mode,
  };
}

/** Command/args/env a single harness contributes to a {@link LaunchPlan}. */
interface HarnessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: LaunchEnv;
  readonly allowedTools: readonly string[];
}

/** claude-code (Phase 1): operator fresh_flags + optional `--allowedTools`. */
function buildClaudeCodeInvocation(entry: AgentEntry, baseEnv: LaunchEnv): HarnessInvocation {
  const flagArgs = splitFlags(entry.freshFlags);
  if (flagArgs.length === 0) {
    throw new LaunchPlanError(
      `fresh_flags is empty after split — harness would launch with no flags`,
      { agentName: entry.tmuxSession, harness: entry.harness },
    );
  }
  const allowedTools = entry.allowedTools ?? [];
  const args =
    allowedTools.length > 0 ? [...flagArgs, "--allowedTools", allowedTools.join(",")] : flagArgs;
  return { command: entry.binary, args, env: baseEnv, allowedTools };
}

/**
 * pi (Phase 2) — native-peer mode. Emits `pi -e <extension> [fresh_flags]`
 * with `AGENTS_JS_PI_*` env so the pi-extension binds a localhost A2A endpoint
 * under the agent's identity (its `MATRIX_AGENT` name), joining the agents-js
 * mesh as a native, always-listening peer. Provider auth comes from
 * `ZAI_API_KEY` in baseEnv or pi's own stored login. `fresh_flags` may be empty
 * — `-e <ext>` is the base invocation, so there is no empty-flags failure here.
 */
function buildPiInvocation(
  entry: AgentEntry,
  baseEnv: LaunchEnv,
  resolveLanHost?: () => string | undefined,
): HarnessInvocation {
  const extension = entry.piExtension ?? DEFAULT_PI_EXTENSION;
  const flagArgs = splitFlags(entry.freshFlags);
  const args: readonly string[] = ["-e", extension, ...flagArgs];
  const piName = baseEnv.MATRIX_AGENT ?? entry.tmuxSession;
  const host = resolvePiHost(entry.piHost, resolveLanHost);
  const env: LaunchEnv = Object.freeze({
    ...baseEnv,
    AGENTS_JS_PI_NATIVE: "1",
    AGENTS_JS_PI_NAME: piName,
    ...(entry.piPort ? { AGENTS_JS_PI_PORT: entry.piPort } : {}),
    ...(host ? { AGENTS_JS_PI_HOST: host } : {}),
  });
  return { command: entry.binary, args, env, allowedTools: [] };
}

/**
 * Resolve the A2A host a native pi binds + advertises. Config `pi_host` wins:
 * an explicit IP/hostname is used literally (set `"127.0.0.1"` / `"localhost"`
 * to force loopback); the sentinels `"lan"` / `"auto"` request the detected LAN
 * address. When `pi_host` is unset, default to the injected LAN resolver so an
 * onboarded peer is reachable across machines. A `undefined` result (no
 * resolver injected, or no LAN interface found) leaves `AGENTS_JS_PI_HOST`
 * unset, so the pi-extension keeps its `127.0.0.1` default — never advertise an
 * address we could not resolve.
 */
function resolvePiHost(
  piHost: string | undefined,
  resolveLanHost?: () => string | undefined,
): string | undefined {
  const explicit = piHost?.trim();
  if (explicit && explicit !== "lan" && explicit !== "auto") return explicit;
  return resolveLanHost?.();
}
