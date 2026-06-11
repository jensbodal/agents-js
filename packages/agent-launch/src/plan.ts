/**
 * Plan builder for {@link LaunchCommand}. Supports `mode: "fresh"` across a
 * registry of harnesses ({@link HARNESS_LAUNCHERS}). Resume mode + per-harness
 * session resolvers are a follow-up.
 *
 * **Critique-first reasoning**
 *
 * - **Boundary**: this module is a PURE function. Input = config entry +
 *   base env; output = structured plan record. No spawn, no tmux, no
 *   filesystem.
 * - **Default**: rejects unsupported harnesses + unsupported modes with
 *   a typed `LaunchPlanError` carrying the agent + harness for caller
 *   diagnostics. Strict-by-default — a harness is launchable iff it has a
 *   {@link HARNESS_LAUNCHERS} entry; unknown values never silently pass.
 * - **Contract**: returns `{cwd, command, args, env, sessionEnv}` — the
 *   tmux `set-environment` calls happen in `tmux.ts` consuming
 *   `sessionEnv`. The structured shape is testable without rendering
 *   shell strings (bash `printf '%q'` quoting ≠ JS string handling;
 *   equivalence is at the structured layer).
 * - **Safety**: argv splitting on whitespace is intentionally simple.
 *   `freshFlags` is treated as a whitespace-separated argv list; agents
 *   with embedded quoted flags surface as malformed (a quoted-flag parser
 *   is a follow-up alongside codex-cli's `launch_prompt` `printf '%q'` path).
 * - **Extension seam**: per-harness command/args/env live in
 *   {@link HARNESS_LAUNCHERS}, keyed by {@link SupportedHarness}. Adding a
 *   harness = one registry entry (a builder + any session-env keys it owns);
 *   {@link buildLaunchPlan}'s body never changes. The `Record` type forces
 *   every union member to have an entry, so the union and the dispatch table
 *   cannot drift apart.
 * - **Validation**: unit tests cover the cognee-claude fixture, the pi
 *   native-peer path, and negative cases (unsupported harness/mode, empty
 *   freshFlags, flag splitting), plus a registry-dispatch test proving a
 *   non-pi harness routes without touching pi env keys.
 */

import { tokenizeShellArgs } from "@agents-js/shell-args";
import type { AgentEntry } from "./config.ts";
import { loadHarnessDefaults } from "./harness-defaults.ts";
import { injectIdentityEnv, type LaunchEnv, parseEnvSetup } from "./identity.ts";
import { resolveProviderCredEnvKeys } from "./provider-registry.ts";

/**
 * `"fresh"` only today. `"resume"` lands once per-harness session resolvers do.
 */
export type LaunchMode = "fresh";

/**
 * Config harness kinds with a {@link HARNESS_LAUNCHERS} entry. The union is the
 * source of truth; the registry is typed as a total `Record` over it, so adding
 * a kind here without a launcher entry is a compile error (and vice versa) —
 * boundary-narrowing-drift is enforced structurally, not by convention.
 */
export type SupportedHarness = "claude-code" | "codex" | "pi";

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
  /**
   * When true, the CLI opens a cockpit layout — this runtime in tmux window
   * `:0` (the landing window), the interactive TUI in `:1`, a raw ACP stream in
   * `:2`, and a log tail in `:3`. The launcher owns the window orchestration +
   * the `agents-js client`/`run-logged` commands; the plan only carries the
   * intent. pi-harness only (validated in {@link buildLaunchPlan}).
   */
  readonly dualWindow: boolean;
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
 * Session-env keys every harness lifts into `sessionEnv` (tmux
 * set-environment): the git identity vars + MATRIX_AGENT that downstream tmux
 * windows (opened by the user later in the same session) need to see for git
 * commits + Matrix routing to behave consistently. A harness may declare
 * ADDITIONAL keys via {@link HarnessLauncher.sessionEnvKeys} (e.g. pi's
 * `AGENTS_JS_PI_*`). Caller-supplied vars in neither set go to the child
 * process env only.
 */
const BASE_SESSION_ENV_KEYS: readonly string[] = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "MATRIX_AGENT",
];

function splitFlags(flags: string): readonly string[] {
  // Quote-safe tokenization (shlex-like). codex-cli's `launch_prompt`
  // positional is produced with bash `printf %q`, so flags can carry quoted or
  // backslash-escaped whitespace that a naive `split(/\s+/)` would fracture.
  // `tokenizeShellArgs` already collapses unquoted whitespace; the
  // length filter drops any explicit quoted-empty token.
  return tokenizeShellArgs(flags).filter((t) => t.length > 0);
}

/**
 * Select the session-wide env subset: the shared base keys, the launching
 * harness's own keys, and the agent's provider credential keys. The provider
 * keys are lifted here so a native agent (whose process only receives sessionEnv
 * via the CLI's send-keys export, not the full env) authenticates without
 * relying on the ambient session env. A key present in none stays
 * child-process-only.
 */
function pickSessionEnv(
  env: LaunchEnv,
  harness: SupportedHarness,
  providerCredKeys: readonly string[],
): LaunchEnv {
  const out: Record<string, string> = {};
  const keys = [
    ...BASE_SESSION_ENV_KEYS,
    ...(HARNESS_LAUNCHERS[harness].sessionEnvKeys ?? []),
    ...providerCredKeys,
  ];
  for (const k of keys) {
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
  // dual_window is a native-pi affordance (TUI window + embedded A2A/ACP
  // window). Other harnesses don't expose a self-registered A2A endpoint the
  // TUI could auto-connect to, so reject it here rather than silently ignore.
  if (entry.dualWindow && entry.harness !== "pi") {
    throw new LaunchPlanError(
      `dual_window is only supported for the "pi" harness (got "${entry.harness}")`,
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

  // Harness-specific command/args/env via the registry — no inline branch.
  // Adding a harness = a {@link HARNESS_LAUNCHERS} entry, nothing here.
  const harness = entry.harness as SupportedHarness;
  const built = HARNESS_LAUNCHERS[harness].build({
    entry,
    baseEnv,
    resolveLanHost: options.resolveLanHost,
  });

  // Identity-derived env — not harness-intrinsic, not operator-configurable.
  // Derived from the agent name convention: `-ajs-` → ajs-fronted (ACP),
  // `-tmux-` → tmux-wired, otherwise native.
  const agentName = entry.tmuxSession;
  const isAjs = agentName.includes("-ajs-");
  const isTmux = agentName.includes("-tmux-");
  const identityEnv: LaunchEnv = Object.freeze({
    AGENT_ACP_MODE: isAjs ? "true" : "false",
    AGENT_PROFILE: isAjs ? "ajs-fronted" : isTmux ? "tmux-wired" : "native",
  });
  const envWithIdentity = Object.freeze({ ...built.env, ...identityEnv });

  // Provider-credential derivation. The agent declares its provider; the cred
  // env-var NAMES come from the shared provider registry. Fail closed: a
  // declared provider whose cred var is absent from the env aborts the build
  // rather than launching a credentialless agent (which would silently hang at
  // first turn). The keys are then lifted into sessionEnv so a native agent —
  // whose process only sees sessionEnv via the CLI's send-keys export — can
  // authenticate without relying on the ambient session env.
  const providerCredKeys = resolveProviderCredEnvKeys(entry.provider);
  const missingCredKeys = providerCredKeys.filter((k) => built.env[k] === undefined);
  if (missingCredKeys.length > 0) {
    throw new LaunchPlanError(
      `provider "${entry.provider}" requires env ${missingCredKeys.join(", ")}, which ${missingCredKeys.length > 1 ? "are" : "is"} not set — refusing to launch a credentialless agent`,
      { agentName: entry.tmuxSession, harness: entry.harness },
    );
  }

  // Identity-derived keys lifted into sessionEnv alongside provider creds.
  const identitySessionEnvKeys: readonly string[] = ["AGENT_ACP_MODE", "AGENT_PROFILE"];

  return {
    tmuxSession: entry.tmuxSession,
    cwd: entry.workspace,
    command: built.command,
    args: built.args,
    env: envWithIdentity,
    sessionEnv: pickSessionEnv(envWithIdentity, harness, [
      ...providerCredKeys,
      ...identitySessionEnvKeys,
    ]),
    channelEnv,
    allowedTools: built.allowedTools,
    harness,
    mode,
    dualWindow: entry.dualWindow === true,
  };
}

/** Command/args/env a single harness contributes to a {@link LaunchPlan}. */
interface HarnessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: LaunchEnv;
  readonly allowedTools: readonly string[];
}

/** Inputs a harness builder receives — the same for every harness. */
interface HarnessBuildContext {
  readonly entry: AgentEntry;
  /** Identity + channel env already layered onto the base process env. */
  readonly baseEnv: LaunchEnv;
  /** LAN-host resolver injected at the CLI boundary (see {@link BuildLaunchPlanOptions}). */
  readonly resolveLanHost?: () => string | undefined;
}

/** A harness's registry entry: how to build its invocation + which env it owns session-wide. */
interface HarnessLauncher {
  /** Produce command/args/env for this harness. */
  readonly build: (ctx: HarnessBuildContext) => HarnessInvocation;
  /**
   * Env keys this harness contributes to `sessionEnv` ON TOP of
   * {@link BASE_SESSION_ENV_KEYS}. These must reach the harness process via
   * `launch.ts`'s send-keys export (which emits only sessionEnv + channelEnv).
   * Omit when the harness adds none beyond the shared base.
   */
  readonly sessionEnvKeys?: readonly string[];
}

/**
 * Default `-e <extension>` pi loads in native-peer mode. Operators override via
 * the `pi_extension` config field. The native-peer extension exposes the live Pi
 * TUI as a localhost A2A endpoint (see `extras/pi-extension`) — how a native pi
 * joins the agents-js mesh.
 */
const DEFAULT_PI_EXTENSION = "@agents-js/pi-extension";

/**
 * pi native-peer vars the pi launcher owns session-wide. Declared before
 * {@link HARNESS_LAUNCHERS} because the registry literal references it at
 * module-load time.
 */
/**
 * agents-js A2A mesh integration keys injected by the pi builder. These are
 * NOT harness defaults — they are agents-js infrastructure computed dynamically
 * at launch time.
 */
const PI_A2A_SESSION_ENV_KEYS: readonly string[] = [
  "AGENTS_JS_PI_NATIVE",
  "AGENTS_JS_PI_NAME",
  "AGENTS_JS_PI_PORT",
  "AGENTS_JS_PI_HOST",
];

/**
 * Harness launcher registry — the single extension seam. Typed as a total
 * `Record<SupportedHarness, …>`, so the union and this table cannot drift:
 * adding a {@link SupportedHarness} member without an entry (or vice versa) is a
 * compile error. {@link buildLaunchPlan} dispatches through this; its body never
 * grows a per-harness branch.
 */
const HARNESS_LAUNCHERS: Readonly<Record<SupportedHarness, HarnessLauncher>> = Object.freeze({
  "claude-code": {
    build: buildClaudeCodeInvocation,
    sessionEnvKeys: loadHarnessDefaults("claude-code").sessionEnvKeys,
  },
  codex: {
    build: buildCodexInvocation,
    sessionEnvKeys: loadHarnessDefaults("codex").sessionEnvKeys,
  },
  pi: {
    build: buildPiInvocation,
    // Harness defaults (AGENT_HARNESS) + agents-js A2A mesh keys.
    sessionEnvKeys: [...loadHarnessDefaults("pi").sessionEnvKeys, ...PI_A2A_SESSION_ENV_KEYS],
  },
});

/** Launchable harness kinds — derived from the registry, never hand-maintained. */
const SUPPORTED_HARNESSES: ReadonlySet<string> = new Set(Object.keys(HARNESS_LAUNCHERS));

/**
 * claude-code: operator fresh_flags + optional `--allowedTools`.
 * Harness defaults (e.g. `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`) are merged
 * under the operator's baseEnv — operator wins on conflict.
 */
function buildClaudeCodeInvocation({ entry, baseEnv }: HarnessBuildContext): HarnessInvocation {
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
  const defaults = loadHarnessDefaults("claude-code");
  const env: LaunchEnv = Object.freeze({ ...defaults.env, ...baseEnv });
  return { command: entry.binary, args, env, allowedTools };
}

/** codex: native Codex CLI fresh session using operator-provided flags. */
function buildCodexInvocation({ entry, baseEnv }: HarnessBuildContext): HarnessInvocation {
  const args = splitFlags(entry.freshFlags);
  const defaults = loadHarnessDefaults("codex");
  const env: LaunchEnv = Object.freeze({ ...defaults.env, ...baseEnv });
  return { command: entry.binary, args, env, allowedTools: [] };
}

/**
 * pi — native-peer mode. Emits `pi -e <extension> [fresh_flags]` with
 * `AGENTS_JS_PI_*` env so the pi-extension binds a localhost A2A endpoint under
 * the agent's identity (its `MATRIX_AGENT` name), joining the agents-js mesh as a
 * native, always-listening peer. Provider auth comes from `ZAI_API_KEY` in
 * baseEnv or pi's own stored login. `fresh_flags` may be empty — `-e <ext>` is
 * the base invocation, so there is no empty-flags failure here.
 */
function buildPiInvocation({
  entry,
  baseEnv,
  resolveLanHost,
}: HarnessBuildContext): HarnessInvocation {
  const extension = entry.piExtension ?? DEFAULT_PI_EXTENSION;
  const flagArgs = splitFlags(entry.freshFlags);
  const args: readonly string[] = ["-e", extension, ...flagArgs];
  const piName = baseEnv.MATRIX_AGENT ?? entry.tmuxSession;
  const host = resolvePiHost(entry.piHost, resolveLanHost);
  // Harness defaults (AGENT_HARNESS) layered under baseEnv, then agents-js
  // A2A mesh keys on top. Operator baseEnv wins over defaults.
  const defaults = loadHarnessDefaults("pi");
  const env: LaunchEnv = Object.freeze({
    ...defaults.env,
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
