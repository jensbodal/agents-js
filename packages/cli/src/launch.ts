/**
 * `agents-js launch` subcommand.
 *
 * Launches a named agent in a fresh tmux session via the harness-launcher
 * registry (currently the claude-code, codex, and pi harnesses). Resume mode,
 * status overview, and bridge preflight land in subsequent phases per the
 * vault plan.
 *
 * **Subcommand shape**:
 *
 * ```
 *   agents-js launch <agent-name> [options]
 *
 *   --bg, --background, -d           Detached: create session, don't attach
 *   --config <path>                  Override config search path
 *   --help, -h                       Show this help
 *   --version, -v                    Print version
 * ```
 *
 * **Config search path** (5-question default #2):
 *
 *   1. `--config <path>` flag
 *   2. `AGENTS_JS_LAUNCH_CONFIG` env var
 *   3. `$XDG_CONFIG_HOME/agents-js/agent-launch-config.json` (when set)
 *   4. `~/.config/agents-js/agent-launch-config.json`
 *   5. `./agent-launch-config.json` (cwd-relative)
 *
 * The first path that exists wins. If none exist, launch fails with a
 * helpful error listing all candidates. `$XDG_CONFIG_HOME` is honored to
 * match `@agents-js/gateway-runtime`'s config resolution; it falls back to
 * `~/.config` (the XDG default) when unset, so existing layouts are unchanged.
 *
 * **Boundary discipline**: this module is pure parse + dispatch. It
 * does NOT spawn tmux directly — every side effect goes through
 * {@link createTmuxRunner} from `@agents-js/agent-launch`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  assertSelectedMatrixAgentUnique,
  buildLaunchPlan,
  createTmuxRunner,
  createTmuxWindowOps,
  type LaunchEnv,
  type LaunchPlan,
  loadLaunchConfig,
  MatrixAgentCollisionError,
  resolveAgentEntry,
  resolveLanAdvertiseHost,
  type TmuxRunner,
  type TmuxWindowOps,
} from "@agents-js/agent-launch";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { EXIT_DATAERR, EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import { handleVersionFlag } from "./version.ts";

interface LaunchCommandArgs {
  agentName?: string;
  bg: boolean;
  configPath?: string;
  help: boolean;
  withReceiver: boolean;
}

const LAUNCH_ARG_SPEC: ArgSpec<LaunchCommandArgs> = {
  "--bg": {
    kind: "flag",
    assign: (a) => {
      a.bg = true;
    },
    description: "Create session detached (no attach)",
  },
  "--background": {
    kind: "flag",
    assign: (a) => {
      a.bg = true;
    },
  },
  "-d": {
    kind: "flag",
    assign: (a) => {
      a.bg = true;
    },
  },
  "--config": {
    kind: "value",
    assign: (a, v) => {
      a.configPath = v;
    },
    description: "Override config search path",
    valueExample: "<path>",
  },
  "--with-receiver": {
    kind: "flag",
    assign: (a) => {
      a.withReceiver = true;
    },
    description: "Start a companion gateway-inbox receiver session",
  },
  "--help": {
    kind: "flag",
    assign: (a) => {
      a.help = true;
    },
    description: "Show launch help",
  },
  "-h": {
    kind: "flag",
    assign: (a) => {
      a.help = true;
    },
  },
};

function printLaunchUsage(output: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  output.write(
    `${[
      "Usage:",
      "  agents-js launch <agent-name> [options]",
      "",
      "Launch or attach to an agent's tmux session.",
      "Supports claude-code, codex, and pi harnesses in fresh mode.",
      "",
      "Options:",
      "  --bg, --background, -d   Create session detached, don't attach",
      "  --config <path>          Override config search path",
      "  --with-receiver          Start companion gateway-inbox receiver",
      "  --help, -h               Show this message",
      "  --version, -v            Print version",
      "",
      "Config search path (first found wins):",
      "  1. --config <path>",
      "  2. $AGENTS_JS_LAUNCH_CONFIG",
      "  3. $XDG_CONFIG_HOME/agents-js/agent-launch-config.json",
      "  4. ~/.config/agents-js/agent-launch-config.json",
      "  5. ./agent-launch-config.json",
      "",
      "Examples:",
      "  agents-js launch cognee-claude --bg",
      "  agents-js launch olthoi0-codex-0 --with-receiver --bg",
      "  agents-js launch ajs-claude --config ./scripts/agent-launch-config.json",
    ].join("\n")}\n`,
  );
}

/**
 * Resolve the config file path per the 4-step search order. Returns
 * the first existing path. Throws if none exist (with all candidates
 * listed for actionable diagnostics).
 */
export function resolveConfigPath(
  args: { configPath?: string },
  env: NodeJS.ProcessEnv,
  home: string,
  cwd: string,
): string {
  const candidates: Array<{ source: string; path: string | undefined }> = [
    { source: "--config", path: args.configPath },
    { source: "$AGENTS_JS_LAUNCH_CONFIG", path: env.AGENTS_JS_LAUNCH_CONFIG },
    {
      source: "$XDG_CONFIG_HOME/agents-js/agent-launch-config.json",
      path: env.XDG_CONFIG_HOME
        ? path.join(env.XDG_CONFIG_HOME, "agents-js", "agent-launch-config.json")
        : undefined,
    },
    {
      source: "~/.config/agents-js/agent-launch-config.json",
      path: path.join(home, ".config", "agents-js", "agent-launch-config.json"),
    },
    { source: "./agent-launch-config.json", path: path.join(cwd, "agent-launch-config.json") },
  ];
  for (const c of candidates) {
    if (c.path && existsSync(c.path)) return c.path;
  }
  const tried = candidates
    .filter((c) => c.path)
    .map((c) => `  - ${c.source}: ${c.path}`)
    .join("\n");
  throw new Error(
    `[agents-js launch] no config file found. Tried:\n${tried}\nSpecify --config <path> or place one at ~/.config/agents-js/agent-launch-config.json`,
  );
}

/**
 * Filter process.env down to defined string values for the launch env
 * base. Excludes undefined / non-string entries so the `LaunchEnv`
 * contract holds.
 */
function filterEnv(env: NodeJS.ProcessEnv): LaunchEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function renderCommandLine(
  cwd: string,
  command: string,
  args: readonly string[],
  env: LaunchEnv,
): string {
  const envExports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join(" && ");
  return `${envExports ? `${envExports} && ` : ""}cd ${JSON.stringify(cwd)} && ${command} ${args.join(" ")}`;
}

interface ReceiverLaunchPlan {
  readonly tmuxSession: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: LaunchEnv;
  readonly sessionEnv: LaunchEnv;
}

function requireReceiverEnv(value: string | undefined, name: string): string {
  if (value && value.trim().length > 0) return value;
  throw new Error(`[agents-js launch] --with-receiver requires ${name} via channel_env or env`);
}

function buildReceiverPlan(plan: LaunchPlan): ReceiverLaunchPlan {
  if (plan.harness === "claude-code") return buildClaudeReceiverPlan(plan);
  if (plan.harness === "codex") return buildCodexReceiverPlan(plan);
  throw new Error(
    `[agents-js launch] --with-receiver is only supported for harness "claude-code" or "codex"`,
  );
}

function buildCodexReceiverPlan(plan: LaunchPlan): ReceiverLaunchPlan {
  if (plan.harness !== "codex") {
    throw new Error(`[agents-js launch] --with-receiver is only supported for harness "codex"`);
  }

  const identity =
    plan.env.CODEX_GATEWAY_IDENTITY ??
    plan.env.AGENTS_GATEWAY_SUB ??
    plan.env.MATRIX_AGENT ??
    plan.tmuxSession;
  const gatewayUrl = requireReceiverEnv(
    plan.env.CODEX_GATEWAY_URL ?? plan.env.AGENTS_GATEWAY_URL,
    "CODEX_GATEWAY_URL/AGENTS_GATEWAY_URL",
  );
  const keyCommand = requireReceiverEnv(
    plan.env.CODEX_GATEWAY_KEY_CMD ?? plan.env.AGENTS_GATEWAY_KEY_CMD,
    "CODEX_GATEWAY_KEY_CMD/AGENTS_GATEWAY_KEY_CMD",
  );
  const senderAllowlist =
    plan.env.CODEX_GATEWAY_SENDER_ALLOWLIST ?? plan.env.AGENTS_GATEWAY_SENDER_ALLOWLIST;

  const receiverEnv: LaunchEnv = Object.freeze({
    ...plan.sessionEnv,
    CODEX_GATEWAY_IDENTITY: identity,
    CODEX_GATEWAY_URL: gatewayUrl,
    CODEX_GATEWAY_KEY_CMD: keyCommand,
    CODEX_WORKSPACE: plan.cwd,
    CODEX_GATEWAY_CURSOR_PATH:
      plan.env.CODEX_GATEWAY_CURSOR_PATH ??
      path.join(plan.cwd, ".agents", identity, "gateway-inbox-cursor.json"),
    CODEX_GATEWAY_FETCH: plan.env.CODEX_GATEWAY_FETCH ?? "curl",
    CODEX_GATEWAY_SKIP_GIT_REPO_CHECK: plan.env.CODEX_GATEWAY_SKIP_GIT_REPO_CHECK ?? "true",
    ...(plan.env.CODEX_GATEWAY_POLL_INTERVAL_MS
      ? { CODEX_GATEWAY_POLL_INTERVAL_MS: plan.env.CODEX_GATEWAY_POLL_INTERVAL_MS }
      : {}),
    ...(plan.env.CODEX_GATEWAY_POLL_LIMIT
      ? { CODEX_GATEWAY_POLL_LIMIT: plan.env.CODEX_GATEWAY_POLL_LIMIT }
      : {}),
    ...(senderAllowlist ? { CODEX_GATEWAY_SENDER_ALLOWLIST: senderAllowlist } : {}),
  });

  return {
    tmuxSession: plan.env.CODEX_GATEWAY_RECEIVER_SESSION ?? `${plan.tmuxSession}-receiver`,
    cwd: plan.cwd,
    command: plan.env.CODEX_GATEWAY_RECEIVER_COMMAND ?? "agents-js",
    args: plan.env.CODEX_GATEWAY_RECEIVER_COMMAND ? [] : ["codex-receiver"],
    env: receiverEnv,
    sessionEnv: plan.sessionEnv,
  };
}

function buildClaudeReceiverPlan(plan: LaunchPlan): ReceiverLaunchPlan {
  if (plan.harness !== "claude-code") {
    throw new Error(
      `[agents-js launch] --with-receiver is only supported for harness "claude-code"`,
    );
  }

  const identity =
    plan.env.CW_IDENTITY ??
    plan.env.CH_GATEWAY_IDENTITY ??
    plan.env.AGENTS_GATEWAY_SUB ??
    plan.env.MATRIX_AGENT ??
    plan.tmuxSession;
  const gatewayUrl = requireReceiverEnv(
    plan.env.CH_GATEWAY_URL ?? plan.env.AGENTS_GATEWAY_URL,
    "CH_GATEWAY_URL/AGENTS_GATEWAY_URL",
  );
  const keyCommand = requireReceiverEnv(
    plan.env.CH_GATEWAY_KEY_CMD ?? plan.env.AGENTS_GATEWAY_KEY_CMD,
    "CH_GATEWAY_KEY_CMD/AGENTS_GATEWAY_KEY_CMD",
  );
  const mcpConfigPath =
    plan.env.CW_CLAUDE_MCP_CONFIG ?? path.join(plan.cwd, ".agents", identity, "gateway-mcp.json");

  const receiverEnv: LaunchEnv = Object.freeze({
    ...plan.sessionEnv,
    CW_IDENTITY: identity,
    CH_GATEWAY_IDENTITY: identity,
    CH_GATEWAY_URL: gatewayUrl,
    CH_GATEWAY_KEY_CMD: keyCommand,
    CH_GATEWAY_FETCH: plan.env.CH_GATEWAY_FETCH ?? plan.env.AGENTS_GATEWAY_FETCH ?? "curl",
    CW_WORKSPACE: plan.cwd,
    CW_CURSOR_PATH:
      plan.env.CW_CURSOR_PATH ??
      path.join(plan.cwd, ".agents", identity, "claude-gateway-inbox-cursor.json"),
    CW_CLAUDE_CMD: plan.env.CW_CLAUDE_CMD ?? plan.command,
    ...(plan.env.CW_CLAUDE_ARGS ? { CW_CLAUDE_ARGS: plan.env.CW_CLAUDE_ARGS } : {}),
    CW_CLAUDE_MCP_CONFIG: mcpConfigPath,
    ...(plan.env.CW_GATEWAY_MCP_COMMAND
      ? { CW_GATEWAY_MCP_COMMAND: plan.env.CW_GATEWAY_MCP_COMMAND }
      : {}),
    ...(plan.env.CW_GATEWAY_MCP_ARGS ? { CW_GATEWAY_MCP_ARGS: plan.env.CW_GATEWAY_MCP_ARGS } : {}),
    ...(plan.env.CW_SENDER_ALLOWLIST ? { CW_SENDER_ALLOWLIST: plan.env.CW_SENDER_ALLOWLIST } : {}),
    ...(plan.env.CW_POLL_INTERVAL_MS ? { CW_POLL_INTERVAL_MS: plan.env.CW_POLL_INTERVAL_MS } : {}),
    ...(plan.env.CW_POLL_LIMIT ? { CW_POLL_LIMIT: plan.env.CW_POLL_LIMIT } : {}),
  });

  return {
    tmuxSession: plan.env.CW_RECEIVER_SESSION ?? `${plan.tmuxSession}-receiver`,
    cwd: plan.cwd,
    command: plan.env.CW_RECEIVER_COMMAND ?? "agents-js",
    args: plan.env.CW_RECEIVER_COMMAND ? [] : ["claude-receiver"],
    env: receiverEnv,
    sessionEnv: plan.sessionEnv,
  };
}

function startSession(
  runner: TmuxRunner,
  launch: {
    readonly tmuxSession: string;
    readonly cwd: string;
    readonly command: string;
    readonly args: readonly string[];
    readonly env: LaunchEnv;
    readonly sessionEnv: LaunchEnv;
  },
  output: Pick<NodeJS.WriteStream, "write">,
): boolean {
  if (runner.hasSession(launch.tmuxSession)) {
    output.write(
      `[agents-js] launch: session "${launch.tmuxSession}" already exists; not re-creating\n`,
    );
    return false;
  }
  runner.newSessionDetached(launch.tmuxSession, launch.cwd);
  for (const [k, v] of Object.entries(launch.sessionEnv)) {
    runner.setEnvironment(launch.tmuxSession, k, v);
  }
  runner.sendKeys(
    launch.tmuxSession,
    renderCommandLine(launch.cwd, launch.command, launch.args, launch.env),
  );
  output.write(`[agents-js] launch: session "${launch.tmuxSession}" created (detached)\n`);
  return true;
}

/**
 * Cockpit launch (pi `dual_window`): a multi-window tmux session that lands you
 * on the runtime and surrounds it with the client TUI, a raw ACP stream, and a
 * log tail. Windows:
 *   :0 runtime — the pi process (its embedded A2A endpoint IS the ACP surface),
 *                wrapped in `agents-js run-logged` so its stderr tees to the
 *                logfile :3 follows. The default/landing window.
 *   :1 tui     — `agents-js client --agent <name> --wait` (drive the agent).
 *   :2 acp     — `agents-js client --agent <name> --wait --observe` (read-only
 *                raw A2A/ACP event stream).
 *   :3 logs    — `tail -F <logfile>` (the runtime stderr captured by run-logged).
 *
 * Mirrors {@link startSession}'s contract — idempotent (no-op if the session
 * exists), identity vars via `set-environment`, secrets via the send-keys export
 * (never `set-environment`) — but splits the work across windows through the
 * composable window-ops seam. The layout is forced regardless of the operator's
 * tmux `base-index`. Returns false when the session already exists.
 *
 * `dual_window` stays the config trigger (back-compat); the layout it opens grew
 * from two windows to this cockpit.
 */
/**
 * Agent names that are safe to interpolate into the client send-keys commands
 * (:1 tui and :2 acp). The name is trusted launch-config/identity data (a
 * slug-like fleet id), but the value reaches a shell via send-keys, so we fail
 * closed on anything outside a conservative slug charset rather than risk an
 * injection through a malformed config. Matches the registry/identity naming.
 */
const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeAgentName(name: string): boolean {
  return SAFE_AGENT_NAME.test(name);
}

/**
 * Like {@link renderCommandLine} but wraps the runtime binary in
 * `agents-js run-logged --log <path> -- …` so its stderr tees to `logPath`
 * (followed by the cockpit's :3 window) while stdin/stdout stay inherited — the
 * interactive :0 runtime keeps the terminal.
 */
function renderRuntimeCommandLine(
  cwd: string,
  command: string,
  args: readonly string[],
  env: LaunchEnv,
  logPath: string,
): string {
  const envExports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join(" && ");
  return `${envExports ? `${envExports} && ` : ""}cd ${JSON.stringify(cwd)} && agents-js run-logged --log ${JSON.stringify(logPath)} -- ${command} ${args.join(" ")}`;
}

function startCockpitSession(
  runner: TmuxRunner,
  windows: TmuxWindowOps,
  plan: LaunchPlan,
  agentName: string,
  logPath: string,
  output: Pick<NodeJS.WriteStream, "write">,
): boolean {
  const session = plan.tmuxSession;
  if (runner.hasSession(session)) {
    output.write(`[agents-js] launch: session "${session}" already exists; not re-creating\n`);
    return false;
  }
  runner.newSessionDetached(session, plan.cwd);
  for (const [k, v] of Object.entries(plan.sessionEnv)) {
    runner.setEnvironment(session, k, v);
  }
  windows.normalizeFirstWindowToZero(session);
  // Satellite windows are created detached (-d) so focus stays on :0 = runtime.
  windows.newWindow(session, 1, "tui", plan.cwd);
  windows.newWindow(session, 2, "acp", plan.cwd);
  windows.newWindow(session, 3, "logs", plan.cwd);
  // :0 = runtime (default landing window). The full env (sessionEnv +
  // channelEnv, incl. provider creds) rides the send-keys export; the runtime
  // binary is wrapped in `run-logged` so its stderr tees to the :3 logfile.
  windows.sendKeysToWindow(
    session,
    0,
    renderRuntimeCommandLine(
      plan.cwd,
      plan.command,
      plan.args,
      Object.freeze({ ...plan.sessionEnv, ...plan.channelEnv }),
      logPath,
    ),
  );
  // :1 = interactive client TUI. Connect by registered NAME — the runtime
  // self-registers its (possibly ephemeral) url, so the client resolves + waits.
  // The name is validated by the caller (isSafeAgentName) before send-keys.
  windows.sendKeysToWindow(session, 1, `agents-js client --agent ${agentName} --wait`);
  // :2 = read-only raw ACP/A2A event stream (passive observer; never sends).
  windows.sendKeysToWindow(session, 2, `agents-js client --agent ${agentName} --wait --observe`);
  // :3 = follow the runtime logfile (-F retries across create/rotate).
  windows.sendKeysToWindow(session, 3, `tail -n +1 -F ${JSON.stringify(logPath)}`);
  windows.selectWindow(session, 0);
  output.write(
    `[agents-js] launch: cockpit session "${session}" created (:0 runtime, :1 tui, :2 acp, :3 logs)\n`,
  );
  return true;
}

export interface LaunchCommandDependencies {
  output?: Pick<NodeJS.WriteStream, "write">;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  /** Inject a custom tmux runner for tests (skips real binary probe). */
  createRunner?: () => TmuxRunner;
  /** Inject a custom tmux window-ops seam for tests (dual-window launches). */
  createWindowOps?: () => TmuxWindowOps;
}

/**
 * Public entry. Wires `agents-js launch <agent>` into the top-level
 * dispatcher.
 *
 * Layout: first non-flag token is the agent name. Everything else
 * routes through `parseArgv` for `--flag` / `--key value` shapes.
 */
export async function runLaunchCommand(
  argv: string[],
  dependencies: LaunchCommandDependencies = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();
  const cwd = dependencies.cwd ?? process.cwd();

  const versionCode = handleVersionFlag(argv, output);
  if (versionCode !== undefined) return versionCode;

  // Split positional (first non-flag arg) from flags.
  let agentName: string | undefined;
  const flagsOnly: string[] = [];
  for (const a of argv) {
    if (agentName === undefined && !a.startsWith("-")) {
      agentName = a;
      continue;
    }
    flagsOnly.push(a);
  }

  let parsed: LaunchCommandArgs;
  try {
    parsed = parseArgv<LaunchCommandArgs>(flagsOnly, LAUNCH_ARG_SPEC, {
      subcommandName: "launch",
      defaults: { bg: false, help: false, withReceiver: false },
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    printLaunchUsage(process.stderr);
    return EXIT_USAGE;
  }

  if (parsed.help) {
    printLaunchUsage(output);
    return EXIT_OK;
  }

  if (!agentName) {
    process.stderr.write("[agents-js launch] missing required <agent-name>\n");
    printLaunchUsage(process.stderr);
    return EXIT_USAGE;
  }

  let configPath: string;
  try {
    configPath = resolveConfigPath({ configPath: parsed.configPath }, env, home, cwd);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_ERROR;
  }

  const config = await loadLaunchConfig(configPath);
  const entry = resolveAgentEntry(config, agentName);

  // Write-time MATRIX_AGENT uniqueness (#37 / ADR #75 Phase 1): reject the
  // launch if this agent's fleet identity is also claimed by another entry in
  // the config — two sessions sharing one MATRIX_AGENT collide on name-keyed
  // credential/memory/routing paths. Pure check over the loaded entry set; a
  // clean agent is never blocked by an unrelated dup elsewhere.
  try {
    assertSelectedMatrixAgentUnique(config, agentName);
  } catch (err) {
    if (err instanceof MatrixAgentCollisionError) {
      process.stderr.write(`${err.message}\n`);
      return EXIT_DATAERR;
    }
    throw err;
  }

  // Inject LAN-host resolution at the impure CLI boundary (keeps buildLaunchPlan
  // pure). A native pi advertises a stable `<shortHost>.<lanDomain>` FQDN when a
  // LAN domain is configured (config `lan_domain` or AGENTS_JS_LAN_DOMAIN), else
  // its detected LAN IP — so onboarded peers are reachable across machines and
  // survive DHCP lease changes.
  const lanDomain = config.lanDomain ?? env.AGENTS_JS_LAN_DOMAIN;
  const plan = buildLaunchPlan(entry, {
    baseEnv: filterEnv(env),
    resolveLanHost: () => resolveLanAdvertiseHost({ lanDomain }),
  });
  let receiverPlan: ReceiverLaunchPlan | undefined;
  if (parsed.withReceiver) {
    try {
      receiverPlan = buildReceiverPlan(plan);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return EXIT_DATAERR;
    }
  }

  const runner = dependencies.createRunner ? dependencies.createRunner() : createTmuxRunner();

  // Cockpit (pi `dual_window`): :0 runtime / :1 tui / :2 acp / :3 logs, then
  // auto-attach (landing on :0) in the foreground. --with-receiver is a
  // codex-only companion-session feature and does not combine with dual_window
  // (rejected at plan build for non-pi).
  if (plan.dualWindow) {
    // The client windows connect by registered name; validate it before it
    // reaches the send-keys commands (fail closed on a malformed config name).
    const agentName = plan.sessionEnv.AGENTS_JS_PI_NAME ?? plan.tmuxSession;
    if (!isSafeAgentName(agentName)) {
      process.stderr.write(
        `[agents-js launch] refusing cockpit launch: agent name "${agentName}" is not a safe slug (expected [A-Za-z0-9][A-Za-z0-9._-]*)\n`,
      );
      return EXIT_DATAERR;
    }
    const logPath = path.join(home, ".agents-js", "logs", `${agentName}.log`);
    const windows = dependencies.createWindowOps
      ? dependencies.createWindowOps()
      : createTmuxWindowOps({ insideTmux: Boolean(env.TMUX) });
    startCockpitSession(runner, windows, plan, agentName, logPath, output);
    if (parsed.bg) {
      return EXIT_OK;
    }
    // Foreground: hand the terminal to the session (lands on :0 = runtime;
    // switch-client when already inside tmux, else attach-session). Blocks until
    // the user detaches.
    windows.attachOrSwitch(plan.tmuxSession);
    return EXIT_OK;
  }

  startSession(
    runner,
    {
      tmuxSession: plan.tmuxSession,
      cwd: plan.cwd,
      command: plan.command,
      args: plan.args,
      env: Object.freeze({ ...plan.sessionEnv, ...plan.channelEnv }),
      sessionEnv: plan.sessionEnv,
    },
    output,
  );
  if (receiverPlan) {
    startSession(runner, receiverPlan, output);
  }
  if (parsed.bg) {
    return EXIT_OK;
  }
  // Attach is deferred per Phase 1 doc — user attaches manually.
  output.write(`[agents-js] launch: attach with \`tmux attach -t ${plan.tmuxSession}\`\n`);
  return EXIT_OK;
}
