/**
 * `agents-js generate-config` — author a launch-config agent entry from a single
 * source of truth (CLI flags), validated through the SAME schema + validators
 * the launch/onboard path uses, then emitted for `agents-js onboard` to consume.
 *
 * Design: agent/profile generation is deliberately NOT a second validator and
 * NOT a parallel "profile" schema. The generator EMITS the existing
 * {@link AgentEntry} (snake_case JSON), and the existing launch-config
 * validation is the gate. The generation TARGET is the canonical launch-config
 * schema agent-launch already validates; this command constructs a raw entry,
 * runs it through `parseLaunchConfig` → `resolveAgentEntry` → `buildLaunchPlan`
 * → `assertSelectedMatrixAgentUnique` (the exact launch-time chain), and refuses
 * to emit anything that would not launch.
 *
 * Contract:
 *
 *   agents-js generate-config --name <name> --harness <claude-code|codex|pi>
 *     # updates the launch-visible user config by default
 *   agents-js generate-config ... --stdout    # prints JSON only, writes nothing
 *   agents-js generate-config ... --config <path>   # updates that config path
 *
 * Output modes:
 *   - default: insert/update the entry in the launch-visible user config
 *     (`AGENTS_JS_LAUNCH_CONFIG`, `XDG_CONFIG_HOME`, then `~/.config`),
 *     preserving existing agents + top-level fields when the file exists.
 *   - `--config <path>`: same update semantics for an explicit config path.
 *   - `--stdout` / `--print`: print a complete single-agent config to stdout
 *     and do not read or write any config file. Hints go to stderr so stdout
 *     stays clean JSON.
 *   - `--merge <path>`: backward-compatible alias for `--config <path>`.
 *
 * Secret boundary: a declared `--provider` requires its credential env var at
 * LAUNCH time (fail-closed in `buildLaunchPlan`). Generation validates the entry
 * SHAPE, not secret availability — so it injects a placeholder for the provider's
 * cred keys during validation and never reads or emits the real secret. The real
 * credential is still enforced when the agent is launched.
 *
 * Exit codes:
 *   0  — entry generated + emitted/written
 *   1  — generation failed (validation rejected the entry, or a write error)
 *   64 — usage error (missing required flag, unknown flag)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  assertSelectedMatrixAgentUnique,
  buildLaunchPlan,
  type LaunchConfig,
  type LaunchEnv,
  loadLaunchConfig,
  parseLaunchConfig,
  resolveAgentEntry,
  resolveProviderCredEnvKeys,
} from "@agents-js/agent-launch";
import { validateGatewayRuntimeProfileName } from "@agents-js/gateway-runtime";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "./exit-codes.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

/** Default schema version stamped on a freshly generated (non-merge) config. */
const DEFAULT_CONFIG_VERSION = "0.1.0";

/** Synthetic path used in validation diagnostics for the in-memory config. */
const SYNTHETIC_CONFIG_PATH = "<generate-config>";

/**
 * Default binary per supported harness. `harness` uses the launch-config kind
 * (`claude-code`), which maps to a different binary name (`claude`); other
 * harnesses share the kind as the binary. Overridable via `--binary`.
 */
const DEFAULT_BINARY: Readonly<Record<string, string>> = Object.freeze({
  "claude-code": "claude",
  codex: "codex",
  pi: "pi",
});

export interface GenerateConfigArgs {
  help?: boolean;
  name?: string;
  harness?: string;
  workspace?: string;
  binary?: string;
  tmuxSession?: string;
  freshFlags?: string;
  provider?: string;
  matrixAgent?: string;
  matrixMxid?: string;
  gitAuthorName?: string;
  gitAuthorEmail?: string;
  piPort?: string;
  piHost?: string;
  piExtension?: string;
  cockpit?: boolean;
  config?: string;
  merge?: string;
  printOnly?: boolean;
  configVersion?: string;
}

export interface GenerateConfigDependencies {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  /** Env for choosing the same default config path launch/onboard will read. */
  env?: NodeJS.ProcessEnv;
  /** Load an existing config for `--merge`. Tests inject an in-memory config. */
  loadConfig?: (path: string) => Promise<LaunchConfig>;
  /** Persist a config file for `--merge`. Tests capture the written text. */
  writeConfig?: (path: string, text: string) => Promise<void>;
  /** Home directory for inferred config/workspace paths. */
  home?: string;
}

const setGenerateConfigHelp = (a: GenerateConfigArgs): void => {
  a.help = true;
};

/** Argv-parser spec for `agents-js generate-config`. Exposed for docs governance. */
export const GENERATE_CONFIG_ARG_SPEC: ArgSpec<GenerateConfigArgs> = {
  "--help": { kind: "flag", assign: setGenerateConfigHelp, description: "Show this message." },
  "-h": { kind: "flag", assign: setGenerateConfigHelp, description: "Show this message." },
  "--name": {
    kind: "value",
    assign: (a, v) => {
      a.name = v;
    },
    description: "Agent name — the config map key, and default tmux session. Required.",
    valueExample: "<name>",
  },
  "--harness": {
    kind: "value",
    assign: (a, v) => {
      a.harness = v;
    },
    description: "Harness kind: claude-code | codex | pi. Required.",
    valueExample: "<kind>",
  },
  "--workspace": {
    kind: "value",
    assign: (a, v) => {
      a.workspace = v;
    },
    description:
      "Working directory the harness launches from. Defaults to ~/workspaces/agents/<name>.",
    valueExample: "<path>",
  },
  "--binary": {
    kind: "value",
    assign: (a, v) => {
      a.binary = v;
    },
    description: "Binary name or absolute path. Defaults to the harness's native binary.",
    valueExample: "<bin>",
  },
  "--tmux-session": {
    kind: "value",
    assign: (a, v) => {
      a.tmuxSession = v;
    },
    description: "tmux session name. Defaults to --name.",
    valueExample: "<session>",
  },
  "--fresh-flags": {
    kind: "value",
    assign: (a, v) => {
      a.freshFlags = v;
    },
    description:
      "Flags passed to a fresh harness launch (whitespace-split). Defaults to --approve for pi, empty otherwise.",
    valueExample: "<flags>",
  },
  "--provider": {
    kind: "value",
    assign: (a, v) => {
      a.provider = v;
    },
    description: "LLM provider id (e.g. zai, anthropic). Its cred env var is required at launch.",
    valueExample: "<id>",
  },
  "--matrix-agent": {
    kind: "value",
    assign: (a, v) => {
      a.matrixAgent = v;
    },
    description: "Fleet MATRIX_AGENT identity; emitted as `export MATRIX_AGENT=<v>` in env_setup.",
    valueExample: "<name>",
  },
  "--matrix-mxid": {
    kind: "value",
    assign: (a, v) => {
      a.matrixMxid = v;
    },
    description: "Matrix user id (matrix_mxid) for gateway/bridge routing.",
    valueExample: "<mxid>",
  },
  "--git-author-name": {
    kind: "value",
    assign: (a, v) => {
      a.gitAuthorName = v;
    },
    description: "Git author name for commits from inside the session.",
    valueExample: "<name>",
  },
  "--git-author-email": {
    kind: "value",
    assign: (a, v) => {
      a.gitAuthorEmail = v;
    },
    description: "Git author email for commits from inside the session.",
    valueExample: "<email>",
  },
  "--pi-port": {
    kind: "value",
    assign: (a, v) => {
      a.piPort = v;
    },
    description: "pi harness: fixed A2A port (AGENTS_JS_PI_PORT). Enables cross-host dispatch.",
    valueExample: "<port>",
  },
  "--pi-host": {
    kind: "value",
    assign: (a, v) => {
      a.piHost = v;
    },
    description: "pi harness: advertise host. Explicit IP, or the sentinels `lan`/`auto`.",
    valueExample: "<host>",
  },
  "--pi-extension": {
    kind: "value",
    assign: (a, v) => {
      a.piExtension = v;
    },
    description: "pi harness: `pi -e <spec>` extension. Defaults to @agents-js/pi-extension.",
    valueExample: "<spec>",
  },
  "--cockpit": {
    kind: "flag",
    assign: (a) => {
      a.cockpit = true;
    },
    description:
      "pi harness only: open the cockpit tmux layout (default for generated pi entries).",
  },
  "--config": {
    kind: "value",
    assign: (a, v) => {
      a.config = v;
    },
    description: "Insert/update the entry in this config path.",
    valueExample: "<config-path>",
  },
  "--stdout": {
    kind: "flag",
    assign: (a) => {
      a.printOnly = true;
    },
    description: "Print JSON to stdout and do not update a config file.",
  },
  "--print": {
    kind: "flag",
    assign: (a) => {
      a.printOnly = true;
    },
    description: "Alias for --stdout.",
  },
  "--merge": {
    kind: "value",
    assign: (a, v) => {
      a.merge = v;
    },
    description: "Backward-compatible alias for --config <path>.",
    valueExample: "<config-path>",
  },
  "--config-version": {
    kind: "value",
    assign: (a, v) => {
      a.configVersion = v;
    },
    description: "Schema version for a freshly generated config. Defaults to 0.1.0.",
    valueExample: "<version>",
  },
};

export function parseGenerateConfigArgs(argv: string[]): GenerateConfigArgs {
  return parseArgv<GenerateConfigArgs>(argv, GENERATE_CONFIG_ARG_SPEC, {
    subcommandName: "generate-config",
    defaults: { cockpit: false, printOnly: false },
  });
}

export function printGenerateConfigUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — generate-config`,
      "",
      "Author/update a launch-config agent entry from CLI flags, validated through the",
      "same schema + validators the launch/onboard path uses. The",
      "generator refuses to emit an entry that would not launch.",
      "",
      "Usage:",
      "  agents-js generate-config --name <name> --harness <kind> [options]",
      "",
      "Required:",
      "  --name <name>          Agent name (config key + default tmux session).",
      "  --harness <kind>       claude-code | codex | pi.",
      "",
      "Common options:",
      "  --workspace <path>     Working directory; defaults to ~/workspaces/agents/<name>.",
      "  --binary <bin>         Binary; defaults to the harness's native binary.",
      "  --tmux-session <name>  tmux session name; defaults to --name.",
      "  --fresh-flags <flags>  Fresh-launch flags (pi default: --approve).",
      "  --provider <id>        LLM provider (cred env var required at launch).",
      "  --matrix-agent <name>  Fleet MATRIX_AGENT identity; defaults to --name.",
      "  --matrix-mxid <mxid>   Matrix user id.",
      "  --git-author-name <n>  / --git-author-email <e>  Commit identity.",
      "",
      "pi-harness options:",
      "  --pi-port <port>       Fixed A2A port (AGENTS_JS_PI_PORT).",
      "  --pi-host <host>       Advertise host; explicit IP or `lan`/`auto`.",
      "  --pi-extension <spec>  `pi -e <spec>`; defaults to @agents-js/pi-extension.",
      "  --cockpit              Cockpit tmux layout (default for generated pi entries).",
      "",
      "Output:",
      "  (default)              Update the launch-visible user config.",
      "  --config <path>        Insert/update this config path.",
      "  --stdout, --print      Print a full config to stdout and write nothing.",
      "  --merge <path>         Back-compat alias for --config <path>.",
      "  --config-version <v>   Schema version for a fresh config (default 0.1.0).",
      "",
      "Examples:",
      "  agents-js generate-config --name demo --harness pi --provider zai --pi-port 3101",
      "  agents-js onboard demo",
      "",
      "  agents-js generate-config --name demo --harness codex --workspace /work --stdout",
      "",
      "Exit codes:",
      `  ${EXIT_OK}   Entry generated + emitted/written.`,
      `  ${EXIT_ERROR}   Generation failed (validation rejected the entry, or write error).`,
      `  ${EXIT_USAGE}  Usage error (missing required flag, unknown flag).`,
    ].join("\n")}\n`,
  );
}

/**
 * Build the raw snake_case agent entry from parsed flags. Pure + exported so
 * tests assert the emitted shape directly. Optional fields are omitted (not set
 * to undefined) so the emitted JSON carries only what the operator specified.
 */
export function buildRawAgentEntry(args: GenerateConfigArgs): Record<string, unknown> {
  const harness = args.harness as string;
  // The MATRIX_AGENT value is interpolated verbatim into the `env_setup` shell
  // string, so it must be a shell-safe slug — never `&&`, `;`, newlines, `$`,
  // backticks, or command substitution. Validate it through the SAME canonical
  // agent-name slug validator (`/^[a-z0-9_-]+$/`) the serve/bridge/acp commands
  // use for profile names, BEFORE it is ever embedded, so a hostile value is
  // rejected here rather than smuggled into the composed launch command.
  const matrixAgent =
    args.matrixAgent !== undefined
      ? validateGatewayRuntimeProfileName(args.matrixAgent)
      : undefined;
  const envSetup = matrixAgent !== undefined ? `export MATRIX_AGENT=${matrixAgent}` : undefined;
  const entry: Record<string, unknown> = {
    tmux_session: args.tmuxSession ?? args.name,
    harness,
    binary: args.binary ?? DEFAULT_BINARY[harness] ?? harness,
    workspace: args.workspace,
    fresh_flags: args.freshFlags ?? "",
  };
  if (envSetup !== undefined) entry.env_setup = envSetup;
  if (args.matrixMxid !== undefined) entry.matrix_mxid = args.matrixMxid;
  if (args.gitAuthorName !== undefined) entry.git_author_name = args.gitAuthorName;
  if (args.gitAuthorEmail !== undefined) entry.git_author_email = args.gitAuthorEmail;
  if (args.provider !== undefined) entry.provider = args.provider;
  if (args.piPort !== undefined) entry.pi_port = args.piPort;
  if (args.piHost !== undefined) entry.pi_host = args.piHost;
  if (args.piExtension !== undefined) entry.pi_extension = args.piExtension;
  if (args.cockpit) entry.cockpit = true;
  return entry;
}

function defaultUserConfigPath(home: string): string {
  return path.join(home, ".config", "agents-js", "agent-launch-config.json");
}

function defaultUpdateConfigPath(home: string, env: NodeJS.ProcessEnv): string {
  if (env.AGENTS_JS_LAUNCH_CONFIG?.trim()) return env.AGENTS_JS_LAUNCH_CONFIG;
  if (env.XDG_CONFIG_HOME?.trim()) {
    return path.join(env.XDG_CONFIG_HOME, "agents-js", "agent-launch-config.json");
  }
  return defaultUserConfigPath(home);
}

function inferWorkspace(home: string, name: string): string {
  return path.join(home, "workspaces", "agents", name);
}

function withInferredDefaults(args: GenerateConfigArgs, home: string): GenerateConfigArgs {
  const harness = args.harness;
  const name = args.name;
  return {
    ...args,
    workspace: args.workspace ?? (name ? inferWorkspace(home, name) : undefined),
    matrixAgent: args.matrixAgent ?? name,
    freshFlags: args.freshFlags ?? (harness === "pi" ? "--approve" : undefined),
    cockpit: args.cockpit || harness === "pi",
  };
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function defaultWriteConfig(configPath: string, text: string): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, text, "utf8");
}

/**
 * Validate the assembled config by running the SELECTED entry through the exact
 * launch-time chain: parse → resolve (normalize) → build plan → uniqueness. A
 * provider's cred keys are injected as a placeholder so generation validates the
 * entry SHAPE without requiring the real secret to be present. Throws on any
 * rejection (the caller maps it to a non-zero exit + leaves the file untouched).
 */
function validateGeneratedEntry(configObject: Record<string, unknown>, name: string): void {
  const config = parseLaunchConfig(JSON.stringify(configObject), SYNTHETIC_CONFIG_PATH);
  const entry = resolveAgentEntry(config, name);
  const placeholderEnv: Record<string, string> = {};
  for (const key of resolveProviderCredEnvKeys(entry.provider)) {
    placeholderEnv[key] = "generate-config-validation-placeholder";
  }
  buildLaunchPlan(entry, { baseEnv: placeholderEnv as LaunchEnv });
  assertSelectedMatrixAgentUnique(config, name);
}

export async function runGenerateConfigCommand(
  argv: string[],
  dependencies: GenerateConfigDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  // biome-ignore lint/style/noProcessEnv: CLI entry-point default; tests inject via dependencies.env.
  const env = dependencies.env ?? process.env;
  const home = dependencies.home ?? homedir();

  const versionExit = handleVersionFlag(argv, stdout);
  if (versionExit !== undefined) return versionExit;

  let args: GenerateConfigArgs;
  try {
    args = parseGenerateConfigArgs(argv);
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_USAGE;
  }

  if (args.help) {
    printGenerateConfigUsage(stdout);
    return EXIT_OK;
  }

  const missing = (["name", "harness"] as const).filter((k) => !args[k]?.trim());
  if (missing.length > 0) {
    stderr.write(
      `[agents-js] generate-config: missing required ${missing.map((m) => `--${m}`).join(", ")}. Run \`agents-js generate-config --help\`.\n`,
    );
    return EXIT_USAGE;
  }

  args = withInferredDefaults(args, home);
  const name = args.name as string;
  let rawEntry: Record<string, unknown>;
  try {
    rawEntry = buildRawAgentEntry(args);
  } catch (error) {
    // e.g. a shell-unsafe --matrix-agent slug rejected before it could be
    // interpolated into env_setup. Surface it and refuse, like the other
    // generation-time rejections below.
    stderr.write(
      `[agents-js] generate-config: refusing to emit — invalid flag value.\n  ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_ERROR;
  }

  // Assemble the config to validate + emit. Print-only mode is a fresh
  // single-agent config. Update mode layers the new entry onto an existing config
  // when present; a missing file starts a fresh config at the selected path.
  let configObject: Record<string, unknown>;
  let existingConfig: LaunchConfig | undefined;
  const updatePath = args.config ?? args.merge ?? defaultUpdateConfigPath(home, env);
  if (!args.printOnly) {
    const loadConfig = dependencies.loadConfig ?? loadLaunchConfig;
    try {
      existingConfig = await loadConfig(updatePath);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        stderr.write(
          `[agents-js] generate-config: failed to read config "${updatePath}": ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return EXIT_ERROR;
      }
    }
    configObject =
      existingConfig !== undefined
        ? {
            version: existingConfig.version,
            ...(existingConfig.description !== undefined
              ? { description: existingConfig.description }
              : {}),
            ...(existingConfig.lanDomain !== undefined
              ? { lan_domain: existingConfig.lanDomain }
              : {}),
            agents: { ...existingConfig.agents, [name]: rawEntry },
          }
        : {
            version: args.configVersion ?? DEFAULT_CONFIG_VERSION,
            agents: { [name]: rawEntry },
          };
  } else {
    configObject = {
      version: args.configVersion ?? DEFAULT_CONFIG_VERSION,
      agents: { [name]: rawEntry },
    };
  }

  try {
    validateGeneratedEntry(configObject, name);
  } catch (error) {
    stderr.write(
      `[agents-js] generate-config: refusing to emit — the entry would not launch.\n  ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return EXIT_ERROR;
  }

  const serialized = `${JSON.stringify(configObject, null, 2)}\n`;

  if (!args.printOnly) {
    const writeConfig = dependencies.writeConfig ?? defaultWriteConfig;
    try {
      await writeConfig(updatePath, serialized);
    } catch (error) {
      stderr.write(
        `[agents-js] generate-config: failed to write "${updatePath}": ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return EXIT_ERROR;
    }
    const launchHint =
      args.config || args.merge
        ? `agents-js onboard ${name} --config ${updatePath}`
        : `agents-js onboard ${name}`;
    stderr.write(
      `[agents-js] generate-config: wrote agent "${name}" into ${updatePath}. Launch it with:\n  ${launchHint}\n`,
    );
    return EXIT_OK;
  }

  // Print-only: clean JSON to stdout (redirectable); the how-to hint goes to stderr.
  stdout.write(serialized);
  stderr.write(
    `[agents-js] generate-config: validated config for "${name}" (print-only). Redirect stdout to a file, then:\n  agents-js onboard ${name} --config <file>\n`,
  );
  return EXIT_OK;
}
