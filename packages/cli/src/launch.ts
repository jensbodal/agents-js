/**
 * `agents-js launch` subcommand — Phase 1 of the AJS-141 migration.
 *
 * Phase 1 scope: launch a named agent in a fresh tmux session using a
 * claude-code harness. Resume mode, other harnesses, status overview,
 * and bridge preflight land in subsequent phases per the vault plan.
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
 *   3. `~/.config/agents-js/agent-launch-config.json`
 *   4. `./agent-launch-config.json` (cwd-relative)
 *
 * The first path that exists wins. If none exist, launch fails with a
 * helpful error listing all four candidates.
 *
 * **Boundary discipline**: this module is pure parse + dispatch. It
 * does NOT spawn tmux directly — every side effect goes through
 * {@link createTmuxRunner} from `@agents-js/agent-launch`.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildLaunchPlan,
  createTmuxRunner,
  detectLanHost,
  type LaunchEnv,
  loadLaunchConfig,
  resolveAgentEntry,
  type TmuxRunner,
} from "@agents-js/agent-launch";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import { handleVersionFlag } from "./version.ts";

interface LaunchCommandArgs {
  agentName?: string;
  bg: boolean;
  configPath?: string;
  help: boolean;
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
      "Launch or attach to an agent's tmux session. Phase 1 (AJS-141)",
      "supports claude-code harness in fresh mode only.",
      "",
      "Options:",
      "  --bg, --background, -d   Create session detached, don't attach",
      "  --config <path>          Override config search path",
      "  --help, -h               Show this message",
      "  --version, -v            Print version",
      "",
      "Config search path (first found wins):",
      "  1. --config <path>",
      "  2. $AGENTS_JS_LAUNCH_CONFIG",
      "  3. ~/.config/agents-js/agent-launch-config.json",
      "  4. ./agent-launch-config.json",
      "",
      "Examples:",
      "  agents-js launch cognee-claude --bg",
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

export interface LaunchCommandDependencies {
  output?: Pick<NodeJS.WriteStream, "write">;
  env?: NodeJS.ProcessEnv;
  home?: string;
  cwd?: string;
  /** Inject a custom tmux runner for tests (skips real binary probe). */
  createRunner?: () => TmuxRunner;
}

/**
 * Pure parse helper exposed for tests. Production code path is
 * {@link runLaunchCommand}.
 */
export function parseLaunchCommandArgs(argv: string[]): LaunchCommandArgs {
  return parseArgv<LaunchCommandArgs>(
    argv.filter((a) => !a.startsWith("@") && !isFirstPositional(a, argv)),
    LAUNCH_ARG_SPEC,
    {
      subcommandName: "launch",
      defaults: { bg: false, help: false },
    },
  );
}

function isFirstPositional(_a: string, _argv: string[]): boolean {
  // Stub: not used directly. parseLaunchCommandArgs handles positional
  // separately. Kept for symmetry with the parser pattern.
  return false;
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
      defaults: { bg: false, help: false },
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
  // Inject LAN-host detection at the impure CLI boundary (keeps buildLaunchPlan
  // pure). A native pi then advertises a routable LAN address instead of
  // loopback, so onboarded peers are reachable across machines by default.
  const plan = buildLaunchPlan(entry, {
    baseEnv: filterEnv(env),
    resolveLanHost: detectLanHost,
  });

  const runner = dependencies.createRunner ? dependencies.createRunner() : createTmuxRunner();

  if (runner.hasSession(plan.tmuxSession)) {
    output.write(
      `[agents-js] launch: session "${plan.tmuxSession}" already exists; not re-creating\n`,
    );
    if (parsed.bg) return EXIT_OK;
    // Attach path (foreground) is deferred — Phase 1 documents this as
    // "use tmux attach -t <session>" manually until --bg-less mode is
    // wired in Phase 5 alongside the dot-cognee shim cutover.
    output.write(`[agents-js] launch: attach with \`tmux attach -t ${plan.tmuxSession}\`\n`);
    return EXIT_OK;
  }

  runner.newSessionDetached(plan.tmuxSession, plan.cwd);

  // Push identity env onto the tmux session env so windows opened later
  // by the user see the same identity. Phase 1 set: git + MATRIX_AGENT.
  for (const [k, v] of Object.entries(plan.sessionEnv)) {
    runner.setEnvironment(plan.tmuxSession, k, v);
  }

  // Compose the launch command string for send-keys. Phase 1 emits
  //   <env exports> <binary> <args>
  // as a single send-keys payload so the harness inherits the env vars.
  // Phase 2+ revisits this when codex-cli's printf-quoted launch_prompt
  // surfaces shell-quoting concerns.
  //
  // Both sessionEnv (identity) and channelEnv (channel-adapter provisioning)
  // are exported into the harness process env so a launched session is fully
  // provisioned. channelEnv is intentionally absent from set-environment above
  // — it should not persist to later windows in the session.
  const envExports = Object.entries({ ...plan.sessionEnv, ...plan.channelEnv })
    .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
    .join(" && ");
  const cmdLine = `${envExports ? `${envExports} && ` : ""}cd ${JSON.stringify(plan.cwd)} && ${plan.command} ${plan.args.join(" ")}`;
  runner.sendKeys(plan.tmuxSession, cmdLine);

  output.write(`[agents-js] launch: session "${plan.tmuxSession}" created (detached)\n`);
  if (parsed.bg) {
    return EXIT_OK;
  }
  // Attach is deferred per Phase 1 doc — user attaches manually.
  output.write(`[agents-js] launch: attach with \`tmux attach -t ${plan.tmuxSession}\`\n`);
  return EXIT_OK;
}
