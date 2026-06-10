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
 *   agents-js generate-config --name <name> --harness <claude-code|codex|pi> \
 *     --workspace <path> [options]            # emits a full config to stdout
 *   agents-js generate-config ... --merge <config-path>   # inserts + writes back
 *
 * Two output modes:
 *   - default: a complete `{version, agents:{<name>:<entry>}}` config is printed
 *     to stdout (redirect to a file, then `agents-js onboard <name> --config
 *     <file>`). Hints go to stderr so stdout stays clean JSON.
 *   - `--merge <path>`: the entry is inserted into the existing config at
 *     `<path>` (preserving other agents + top-level fields) and written back.
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

import { writeFile } from "node:fs/promises";
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
  dualWindow: boolean;
  merge?: string;
  configVersion?: string;
}

export interface GenerateConfigDependencies {
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
  /** Load an existing config for `--merge`. Tests inject an in-memory config. */
  loadConfig?: (path: string) => Promise<LaunchConfig>;
  /** Persist a config file for `--merge`. Tests capture the written text. */
  writeConfig?: (path: string, text: string) => Promise<void>;
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
    description: "Working directory the harness launches from. Required.",
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
    description: "Flags passed to a fresh harness launch (whitespace-split). Defaults to empty.",
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
  "--dual-window": {
    kind: "flag",
    assign: (a) => {
      a.dualWindow = true;
    },
    description: "pi harness only: TUI in window :0 + runtime in :1.",
  },
  "--merge": {
    kind: "value",
    assign: (a, v) => {
      a.merge = v;
    },
    description: "Insert the entry into the existing config at <path> and write it back.",
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
    defaults: { dualWindow: false },
  });
}

export function printGenerateConfigUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — generate-config`,
      "",
      "Author a launch-config agent entry from CLI flags, validated through the",
      "same schema + validators the launch/onboard path uses, then emit it. The",
      "generator refuses to emit an entry that would not launch.",
      "",
      "Usage:",
      "  agents-js generate-config --name <name> --harness <kind> --workspace <path> [options]",
      "",
      "Required:",
      "  --name <name>          Agent name (config key + default tmux session).",
      "  --harness <kind>       claude-code | codex | pi.",
      "  --workspace <path>     Working directory the harness launches from.",
      "",
      "Common options:",
      "  --binary <bin>         Binary; defaults to the harness's native binary.",
      "  --tmux-session <name>  tmux session name; defaults to --name.",
      "  --fresh-flags <flags>  Fresh-launch flags (whitespace-split).",
      "  --provider <id>        LLM provider (cred env var required at launch).",
      "  --matrix-agent <name>  Fleet MATRIX_AGENT identity (env_setup export).",
      "  --matrix-mxid <mxid>   Matrix user id.",
      "  --git-author-name <n>  / --git-author-email <e>  Commit identity.",
      "",
      "pi-harness options:",
      "  --pi-port <port>       Fixed A2A port (AGENTS_JS_PI_PORT).",
      "  --pi-host <host>       Advertise host; explicit IP or `lan`/`auto`.",
      "  --pi-extension <spec>  `pi -e <spec>`; defaults to @agents-js/pi-extension.",
      "  --dual-window          TUI in window :0 + runtime in :1 (pi only).",
      "",
      "Output:",
      "  (default)              Print a full config to stdout (redirect to a file).",
      "  --merge <config-path>  Insert into the existing config and write it back.",
      "  --config-version <v>   Schema version for a fresh config (default 0.1.0).",
      "",
      "Examples:",
      "  agents-js generate-config --name demo --harness pi --workspace /work \\",
      "    --provider zai --pi-port 3101 --dual-window > demo.json",
      "  agents-js onboard demo --config demo.json",
      "",
      "  agents-js generate-config --name demo --harness codex --workspace /work \\",
      "    --merge ~/.config/agents-js/agent-launch-config.json",
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
  if (args.dualWindow) entry.dual_window = true;
  return entry;
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

  const missing = (["name", "harness", "workspace"] as const).filter((k) => !args[k]?.trim());
  if (missing.length > 0) {
    stderr.write(
      `[agents-js] generate-config: missing required ${missing.map((m) => `--${m}`).join(", ")}. Run \`agents-js generate-config --help\`.\n`,
    );
    return EXIT_USAGE;
  }

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

  // Assemble the config to validate + emit. For --merge, layer the new entry
  // onto the existing file's agents + top-level fields; otherwise emit a fresh
  // single-agent config.
  let configObject: Record<string, unknown>;
  let existingConfig: LaunchConfig | undefined;
  if (args.merge) {
    const loadConfig = dependencies.loadConfig ?? loadLaunchConfig;
    try {
      existingConfig = await loadConfig(args.merge);
    } catch (error) {
      stderr.write(
        `[agents-js] generate-config: failed to read --merge config "${args.merge}": ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return EXIT_ERROR;
    }
    configObject = {
      version: existingConfig.version,
      ...(existingConfig.description !== undefined
        ? { description: existingConfig.description }
        : {}),
      ...(existingConfig.lanDomain !== undefined ? { lan_domain: existingConfig.lanDomain } : {}),
      agents: { ...existingConfig.agents, [name]: rawEntry },
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

  if (args.merge) {
    const writeConfig =
      dependencies.writeConfig ?? ((path: string, text: string) => writeFile(path, text, "utf8"));
    try {
      await writeConfig(args.merge, serialized);
    } catch (error) {
      stderr.write(
        `[agents-js] generate-config: failed to write "${args.merge}": ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return EXIT_ERROR;
    }
    stderr.write(
      `[agents-js] generate-config: wrote agent "${name}" into ${args.merge}. Launch it with:\n  agents-js onboard ${name} --config ${args.merge}\n`,
    );
    return EXIT_OK;
  }

  // Default: clean JSON to stdout (redirectable); the how-to hint goes to stderr.
  stdout.write(serialized);
  stderr.write(
    `[agents-js] generate-config: validated config for "${name}". Redirect stdout to a file, then:\n  agents-js onboard ${name} --config <file>\n`,
  );
  return EXIT_OK;
}
