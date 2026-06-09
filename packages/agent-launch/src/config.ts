/**
 * Schema + loader for the `agent-launch-config.json` file consumed by
 * {@link buildLaunchPlan}. Phase 1 of the AJS-141 migration: covers the
 * subset of fields needed for claude-code fresh-mode launches; later
 * phases extend `AgentEntry` with resume / status / per-harness fields.
 *
 * **Config search path** (5-question default #2, per vault plan):
 *
 * 1. Explicit `--config <path>` argument on the launch subcommand
 * 2. `AGENTS_JS_LAUNCH_CONFIG` env var
 * 3. `~/.config/agents-js/agent-launch-config.json`
 * 4. `./agent-launch-config.json` (cwd-relative)
 *
 * The caller resolves the path (CLI does this) and passes it to
 * {@link loadLaunchConfig}; the loader does not search itself, so unit
 * tests stay deterministic.
 *
 * **Critique-first reasoning**
 *
 * - **Boundary**: this module owns the schema definition + JSON parse +
 *   structural validation. It does NOT touch the filesystem outside the
 *   single `readFile(path)` call, and it does NOT spawn processes.
 * - **Default**: unknown fields on agent entries are PRESERVED in
 *   `extra` rather than rejected. The bash original is permissive
 *   (jq returns empty for missing keys); strict-by-default rejection
 *   would break source compat with the live dot-cognee config that
 *   already carries unrecognized fields (`identity_files`,
 *   `memory_paths`, etc. — Phase 1 doesn't consume them).
 * - **Contract**: returns a {@link LaunchConfig} with typed `agents`
 *   record. Unknown harness kinds are surfaced via `harness: string`
 *   (the plan builder rejects unsupported harnesses, not the loader).
 * - **Safety**: every required field on `AgentEntry` is validated;
 *   missing or wrong-typed fields throw a `LaunchConfigError` with the
 *   agent name + offending field for actionable diagnostics.
 * - **Validation**: unit tests cover well-formed config parse,
 *   missing-required-field rejection, wrong-type rejection,
 *   unknown-harness pass-through (rejected later at plan build).
 */

import { readFile } from "node:fs/promises";

/**
 * One agent entry from `agent-launch-config.json`. Phase 1 fields only;
 * later phases extend (resume flags, matrix token, gemini symlinks, etc.).
 *
 * The `extra` bag captures unrecognized fields so the loader can be
 * permissive without losing data — later phases that need those fields
 * promote them out of `extra` into typed slots.
 */
export interface AgentEntry {
  /** tmux session name. Identifies the long-lived session for attach. */
  readonly tmuxSession: string;
  /** Harness kind. Phase 1 supports `"claude-code"` only. */
  readonly harness: string;
  /**
   * Binary name or absolute path. Resolution per
   * {@link resolveBinaryFromEntry} walks `~/.local/bin` → `$XDG_BIN_HOME`
   * → `$PATH` for non-absolute names.
   */
  readonly binary: string;
  /** Working directory the harness launches from. */
  readonly workspace: string;
  /**
   * Flags passed when launching a fresh session (no resume context).
   * Phase 1 uses these verbatim, split on whitespace for argv.
   */
  readonly freshFlags: string;
  /**
   * Optional env-setup shell snippet (e.g. `export MATRIX_AGENT=foo`).
   * Phase 1 parses simple `export KEY=VALUE` lines; complex shell is
   * rejected with a descriptive error.
   */
  readonly envSetup?: string;
  /**
   * Optional channel-adapter provisioning env (e.g.
   * `export CH_GATEWAY_URL=… && export CH_GATEWAY_IDENTITY=…`). Parsed like
   * {@link envSetup} but kept as a distinct field because these vars must
   * reach the spawned harness's process env (so its child channel-adapter
   * MCP inherits them) WITHOUT being pushed session-wide via
   * `tmux set-environment` like the identity vars are.
   */
  readonly channelEnv?: string;
  /** Git author identity for commits made from inside the session. */
  readonly gitAuthorName?: string;
  /** Git author identity for commits made from inside the session. */
  readonly gitAuthorEmail?: string;
  /** Matrix user id, used by gateway / bridge for routing. */
  readonly matrixMxid?: string;
  /**
   * Tools to pre-authorize for unattended operation, emitted as a
   * `--allowedTools` flag so the harness runs them without a per-call
   * permission prompt. Entries use Claude Code's `mcp__<server>__<tool>`
   * naming, e.g. `mcp__claude-channel-adapter__agents_js_send` (wildcards
   * like `mcp__claude-channel-adapter__*` are allowed). Pair with an
   * appropriate `--permission-mode` in `fresh_flags` for the desired
   * deny-by-default posture.
   */
  readonly allowedTools?: readonly string[];
  /**
   * pi harness (Phase 2) native-peer mode: the spec passed to `pi -e <…>`.
   * Defaults to `@agents-js/pi-extension` when unset. The extension binds the
   * pi process's localhost A2A endpoint so it joins the mesh as a native peer.
   */
  readonly piExtension?: string;
  /**
   * pi harness (Phase 2): fixed localhost port for the native-peer A2A endpoint
   * (`AGENTS_JS_PI_PORT`). When unset, pi-extension picks an ephemeral port and
   * self-registers its URL in `~/.agents-js/registry.json`.
   */
  readonly piPort?: string;
  /**
   * pi harness (Phase 2): the host the native-peer binds + advertises in its
   * agent-card / registry record (`AGENTS_JS_PI_HOST`). An explicit IP/hostname
   * is used literally — set `"127.0.0.1"` or `"localhost"` to force loopback.
   * The sentinels `"lan"` / `"auto"` request the host's detected LAN address so
   * the peer is reachable from other machines. When unset, the launch defaults
   * to the detected LAN address (loopback fallback) so onboarded peers join the
   * cross-machine mesh by default.
   */
  readonly piHost?: string;
  /**
   * Semantic LLM provider this agent authenticates against (e.g. `"zai"`). The
   * launch derives the provider's credential env-var names from
   * {@link resolveProviderCredEnvKeys} and lifts them into the exported session
   * env, so a native agent with no gateway/login-TUI still authenticates. When
   * a provider is declared but its cred env var is absent, the plan build fails
   * closed rather than launching a credentialless agent.
   */
  readonly provider?: string;
  /**
   * Open the agent as a dual-window launch: the interactive TUI in tmux window
   * `:0` (auto-connected via `agents-js client --agent <name> --wait`) and the
   * runtime in `:1`. pi-harness only in this increment; the plan build rejects
   * it on other harnesses. When unset/false the launch stays single-window.
   */
  readonly dualWindow?: boolean;
  /** Unrecognized fields preserved as-is for later-phase promotion. */
  readonly extra: Readonly<Record<string, unknown>>;
}

/**
 * Top-level config shape.
 *
 * **Lazy normalization** (PR #99 cognee-codex review fix): `agents`
 * holds RAW entries (`unknown`), not normalized {@link AgentEntry}s.
 * Per-entry validation happens in {@link resolveAgentEntry} when the
 * CLI selects ONE agent for launch. This lets the loader handle live
 * configs that mix Phase-1-supported profiles (claude-code with
 * fresh_flags) with profiles outside Phase 1 (codex without
 * fresh_flags, virtual profiles with null fields) without rejecting
 * the whole file.
 *
 * Forward-compat invariant: strict normalization still applies to the
 * SELECTED entry — a malformed target agent still fails clearly at
 * resolve-time with the same diagnostics as before.
 */
export interface LaunchConfig {
  /** Schema version. Bash original ships `0.1.0`. */
  readonly version: string;
  /** Optional human description. */
  readonly description?: string;
  /**
   * Operator's LAN domain (e.g. `q4m.dev`). When set, a launched native peer
   * advertises a stable `<shortHost>.<lanDomain>` FQDN instead of a raw IP, so
   * it stays reachable across DHCP lease changes. Fleet-wide (the launching
   * box's hostname + this domain); the CLI also honors `AGENTS_JS_LAN_DOMAIN`
   * as an override. Unset → the peer advertises its detected LAN IP.
   */
  readonly lanDomain?: string;
  /** Map of `agentName → RAW entry`. Normalize via {@link resolveAgentEntry}. */
  readonly agents: Readonly<Record<string, unknown>>;
}

/**
 * Typed error raised by {@link loadLaunchConfig} for any structural
 * validation failure. Carries the `path` + offending `agent` + `field`
 * for caller diagnostics.
 */
export class LaunchConfigError extends Error {
  readonly path: string;
  readonly agent?: string;
  readonly field?: string;
  constructor(message: string, opts: { path: string; agent?: string; field?: string }) {
    super(`[agents-js launch-config] ${opts.path}: ${message}`);
    this.name = "LaunchConfigError";
    this.path = opts.path;
    this.agent = opts.agent;
    this.field = opts.field;
  }
}

/** Required AgentEntry fields tested by {@link normalizeAgentEntry}. */
const REQUIRED_AGENT_FIELDS = [
  "tmux_session",
  "harness",
  "binary",
  "workspace",
  "fresh_flags",
] as const;

/** Fields promoted from `extra` into typed slots in Phase 1. */
const PROMOTED_AGENT_FIELDS = new Set<string>([
  "tmux_session",
  "harness",
  "binary",
  "workspace",
  "fresh_flags",
  "env_setup",
  "channel_env",
  "git_author_name",
  "git_author_email",
  "matrix_mxid",
  "allowed_tools",
  "pi_extension",
  "pi_port",
  "pi_host",
  "provider",
  "dual_window",
]);

function requireString(
  raw: Record<string, unknown>,
  field: string,
  ctx: { path: string; agent: string },
): string {
  const value = raw[field];
  if (typeof value !== "string") {
    throw new LaunchConfigError(`agent "${ctx.agent}" field "${field}" must be a string`, {
      path: ctx.path,
      agent: ctx.agent,
      field,
    });
  }
  return value;
}

function optionalString(
  raw: Record<string, unknown>,
  field: string,
  ctx: { path: string; agent: string },
): string | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new LaunchConfigError(
      `agent "${ctx.agent}" field "${field}" must be a string when present`,
      { path: ctx.path, agent: ctx.agent, field },
    );
  }
  return value;
}

function optionalStringArray(
  raw: Record<string, unknown>,
  field: string,
  ctx: { path: string; agent: string },
): readonly string[] | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new LaunchConfigError(
      `agent "${ctx.agent}" field "${field}" must be an array of strings when present`,
      { path: ctx.path, agent: ctx.agent, field },
    );
  }
  return Object.freeze([...value]);
}

function optionalBoolean(
  raw: Record<string, unknown>,
  field: string,
  ctx: { path: string; agent: string },
): boolean | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new LaunchConfigError(
      `agent "${ctx.agent}" field "${field}" must be a boolean when present`,
      { path: ctx.path, agent: ctx.agent, field },
    );
  }
  return value;
}

function normalizeAgentEntry(raw: unknown, ctx: { path: string; agent: string }): AgentEntry {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new LaunchConfigError(`agent "${ctx.agent}" entry must be an object`, {
      path: ctx.path,
      agent: ctx.agent,
    });
  }
  const obj = raw as Record<string, unknown>;
  for (const f of REQUIRED_AGENT_FIELDS) {
    if (!(f in obj)) {
      throw new LaunchConfigError(`agent "${ctx.agent}" is missing required field "${f}"`, {
        path: ctx.path,
        agent: ctx.agent,
        field: f,
      });
    }
  }
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!PROMOTED_AGENT_FIELDS.has(k)) {
      extra[k] = v;
    }
  }
  return {
    tmuxSession: requireString(obj, "tmux_session", ctx),
    harness: requireString(obj, "harness", ctx),
    binary: requireString(obj, "binary", ctx),
    workspace: requireString(obj, "workspace", ctx),
    freshFlags: requireString(obj, "fresh_flags", ctx),
    envSetup: optionalString(obj, "env_setup", ctx),
    channelEnv: optionalString(obj, "channel_env", ctx),
    gitAuthorName: optionalString(obj, "git_author_name", ctx),
    gitAuthorEmail: optionalString(obj, "git_author_email", ctx),
    matrixMxid: optionalString(obj, "matrix_mxid", ctx),
    allowedTools: optionalStringArray(obj, "allowed_tools", ctx),
    piExtension: optionalString(obj, "pi_extension", ctx),
    piPort: optionalString(obj, "pi_port", ctx),
    piHost: optionalString(obj, "pi_host", ctx),
    provider: optionalString(obj, "provider", ctx),
    dualWindow: optionalBoolean(obj, "dual_window", ctx),
    extra,
  };
}

/**
 * Parse + validate a config JSON string into a {@link LaunchConfig}.
 * Exposed for tests; production callers use {@link loadLaunchConfig}.
 */
export function parseLaunchConfig(text: string, path: string): LaunchConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new LaunchConfigError(
      `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { path },
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LaunchConfigError("config must be a JSON object at top level", { path });
  }
  const top = parsed as Record<string, unknown>;
  if (typeof top.version !== "string") {
    throw new LaunchConfigError(`top-level "version" must be a string`, {
      path,
      field: "version",
    });
  }
  if (typeof top.agents !== "object" || top.agents === null || Array.isArray(top.agents)) {
    throw new LaunchConfigError(`top-level "agents" must be an object`, {
      path,
      field: "agents",
    });
  }
  // Lazy normalization (PR #99 cognee-codex review fix):
  // - Preserve raw entries here; do NOT validate per-agent fields.
  // - Strict per-agent validation happens in resolveAgentEntry at
  //   launch-time for the SELECTED agent only.
  // Reason: live configs (e.g. dot-cognee's) mix Phase-1 entries with
  // non-Phase-1 profiles (codex without fresh_flags, virtual profiles
  // with nulls). Early per-agent normalization rejects the whole file
  // because of unrelated entries.
  const agentsRaw = top.agents as Record<string, unknown>;
  const description = typeof top.description === "string" ? top.description : undefined;
  const lanDomain = typeof top.lan_domain === "string" ? top.lan_domain : undefined;
  return {
    version: top.version,
    ...(description !== undefined ? { description } : {}),
    ...(lanDomain !== undefined ? { lanDomain } : {}),
    agents: agentsRaw,
  };
}

/**
 * Load + parse + validate the launch config at `path`. Throws
 * {@link LaunchConfigError} for any structural failure;
 * filesystem failures propagate as-is from `readFile`.
 */
export async function loadLaunchConfig(path: string): Promise<LaunchConfig> {
  const text = await readFile(path, "utf8");
  return parseLaunchConfig(text, path);
}

/**
 * Resolve a named agent from a loaded config and normalize its entry.
 *
 * **Lazy normalization point** (PR #99 cognee-codex review fix):
 * per-agent field validation happens HERE, not at load time. The
 * caller asks for ONE agent; we normalize just that one entry with
 * strict Phase-1 field requirements. Unrelated profiles (codex without
 * fresh_flags, virtual profiles with nulls) coexist in the same config
 * file without blocking valid Phase-1 launches.
 *
 * Throws {@link LaunchConfigError} when the agent is absent (lists
 * available names for actionable diagnostics) or when the selected
 * entry fails Phase-1 normalization.
 */
export function resolveAgentEntry(config: LaunchConfig, name: string): AgentEntry {
  const raw = config.agents[name];
  if (raw === undefined) {
    const available = Object.keys(config.agents).sort().join(", ");
    throw new LaunchConfigError(
      `agent "${name}" not found in config (available: ${available || "<none>"})`,
      { path: "<resolveAgentEntry>", agent: name },
    );
  }
  return normalizeAgentEntry(raw, { path: "<resolveAgentEntry>", agent: name });
}
