import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { createSharedAgentRegistry } from "@agents-js/a2a-client/node";
import { type AgentEndpoint, type BridgeConfig, createBridgeServer } from "@agents-js/mcp-bridge";
import { listSkills, type SkillMeta } from "@agents-js/skills";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { EXIT_ERROR, EXIT_OK } from "./exit-codes.ts";
import { skillSourceSearchPaths } from "./skill.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

/**
 * Shape returned by {@link parseMcpCommandArgs}. The parser dispatches a
 * positional subverb (`setup`, `bridge`) before delegating to a per-subverb
 * spec, so the resulting object captures both the chosen subverb and any
 * subverb flags that were parsed.
 */
export interface McpCommandArgs {
  help?: boolean;
  subcommand?: "setup" | "bridge";
  claude?: boolean;
  global?: boolean;
  name?: string;
  url?: string;
}

export interface McpCommandDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  output?: Pick<NodeJS.WriteStream, "write">;
  loadBridgeConfig?: () => Promise<BridgeConfig>;
  startServer?: (config: BridgeConfig) => Promise<void>;
}

const setHelp = (a: McpCommandArgs): void => {
  a.help = true;
};

/**
 * Top-level `agents-js mcp` flags (server-mode default). Exposed for the
 * docs governance generator.
 */
export const MCP_ROOT_ARG_SPEC: ArgSpec<McpCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp, description: "Show this message." },
  "-h": { kind: "flag", assign: setHelp, description: "Show this message." },
};

/**
 * `agents-js mcp setup` flags. Exposed for the docs governance generator.
 */
export const MCP_SETUP_ARG_SPEC: ArgSpec<McpCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp, description: "Show this message." },
  "-h": { kind: "flag", assign: setHelp, description: "Show this message." },
  "--global": {
    kind: "flag",
    assign: (a) => {
      a.global = true;
    },
    description:
      "[deprecated, removed next release] Was a silent no-op writing to ~/.claude/settings.json — use `--claude` for Claude Code user-scope or unflagged for project-scope .mcp.json.",
  },
  "--claude": {
    kind: "flag",
    assign: (a) => {
      a.claude = true;
    },
    description: "Register with Claude Code via `claude mcp add`.",
  },
  "--url": {
    kind: "value",
    assign: (a, v) => {
      a.url = v;
    },
    description:
      "Bridge a single A2A gateway through this MCP entry — the written server invokes `agents-js mcp bridge --url <gateway-url>` instead of the registry-backed default.",
    valueExample: "<gateway-url>",
  },
  "--name": {
    kind: "value",
    assign: (a, v) => {
      a.name = v;
    },
    description:
      "Override the MCP server name written to .mcp.json / passed to `claude mcp add`. Defaults to `agents-js-mcp-bridge` when `--url` is set, else `agents-js-mcp`.",
    valueExample: "<server-name>",
  },
};

/**
 * `agents-js mcp bridge` flags. Exposed for the docs governance generator.
 */
export const MCP_BRIDGE_ARG_SPEC: ArgSpec<McpCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp, description: "Show this message." },
  "-h": { kind: "flag", assign: setHelp, description: "Show this message." },
  "--url": {
    kind: "value",
    assign: (a, v) => {
      a.url = v;
    },
    description: "A2A gateway base URL.",
    valueExample: "<gateway-url>",
  },
};

/**
 * Parse the full `agents-js mcp ...` argv. The first positional, when
 * present, selects a subverb (`setup` or `bridge`); remaining tokens are
 * dispatched through the matching {@link ArgSpec}. Top-level flags
 * (`--help`/`-h`) are accepted directly when no subverb is given.
 */
export function parseMcpCommandArgs(argv: string[]): McpCommandArgs {
  const [first, ...rest] = argv;

  if (first === "setup") {
    const args = parseArgv<McpCommandArgs>(rest, MCP_SETUP_ARG_SPEC, {
      subcommandName: "mcp setup",
    });
    args.subcommand = "setup";
    return args;
  }

  if (first === "bridge") {
    const args = parseArgv<McpCommandArgs>(rest, MCP_BRIDGE_ARG_SPEC, {
      subcommandName: "mcp bridge",
    });
    args.subcommand = "bridge";
    return args;
  }

  return parseArgv<McpCommandArgs>(argv, MCP_ROOT_ARG_SPEC, { subcommandName: "mcp" });
}

function printMcpUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — mcp`,
      "",
      "Start an MCP server that exposes registered A2A agents as MCP tools.",
      "",
      "Usage:",
      "  agents-js mcp [options]            Start MCP server on stdio",
      "  agents-js mcp setup                Write MCP config to .mcp.json in cwd",
      "  agents-js mcp setup --claude       Register with Claude Code via `claude mcp add`",
      "  agents-js mcp setup --url <url>    Write MCP config for a single A2A gateway bridge",
      "  agents-js mcp setup --global       [removed] use `--claude` for Claude user-scope; unflagged for project-scope",
      "  agents-js mcp bridge --url <url>   Bridge a single external A2A gateway over stdio",
      "",
      "Options:",
      "  --version, -v  Print version and exit",
      "  --help, -h     Show this message",
      "",
      "Config resolution:",
      "  1. AGENTS_JS_BRIDGE_CONFIG env var (path to JSON file)",
      "  2. AGENTS_JS_BRIDGE_AGENTS env var (inline JSON array)",
      "  3. Shared agent registry (~/.agents-js/registry.json)",
    ].join("\n")}\n`,
  );
}

function printMcpSetupUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — mcp setup`,
      "",
      "Write or register the MCP server config so an MCP client can launch it.",
      "",
      "Usage:",
      "  agents-js mcp setup                              Write MCP config to .mcp.json in cwd",
      "  agents-js mcp setup --global                     [removed] use `--claude` for Claude user-scope; unflagged for project-scope",
      "  agents-js mcp setup --claude                     Register with Claude Code via `claude mcp add -s user`",
      "  agents-js mcp setup --url <url> [--name <name>]  Write a single-gateway bridge entry (server invokes `mcp bridge --url <url>`)",
      "",
      "Options:",
      "  --url <gateway-url>    Bridge a single A2A gateway through this MCP entry.",
      "  --name <server-name>   Override the MCP server name (default: `agents-js-mcp-bridge` with --url, else `agents-js-mcp`).",
      "  --help                 Show this message",
    ].join("\n")}\n`,
  );
}

function printMcpBridgeUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      `agents-js v${CLI_VERSION} — mcp bridge`,
      "",
      "Run an MCP stdio server that bridges a single external A2A gateway as MCP tools.",
      "Use this when an MCP host (Claude Code, Cursor, etc.) should reach an A2A endpoint",
      "that is not registered in the shared agent registry.",
      "",
      "Usage:",
      "  agents-js mcp bridge --url <gateway-url>",
      "",
      "Options:",
      "  --url <gateway-url>   Required. A2A gateway base URL.",
      "  --help, -h            Show this message",
    ].join("\n")}\n`,
  );
}

/**
 * Build the MCP server config block that `agents-js mcp setup` writes to
 * `.mcp.json` (and that the `--claude` path mirrors into Claude Code's
 * user-scope registration).
 *
 * Default branch (no `url`) is byte-identical to the historical
 * `{ command: "agents-js", args: ["mcp"] }` entry under the
 * `agents-js-mcp` key — i.e. registry-backed MCP server.
 *
 * Bridge branch (`url` set) emits a single-gateway entry whose server
 * command invokes `agents-js mcp bridge --url <url>`. The server name
 * defaults to `agents-js-mcp-bridge` when `--url` is set so the two
 * variants can coexist in the same `.mcp.json` without name collision;
 * an explicit `name` always wins.
 */
function generateMcpServerConfig(opts?: { name?: string; url?: string }): {
  mcpServers: Record<string, { command: string; args: string[] }>;
} {
  const url = opts?.url;
  const defaultName = url ? "agents-js-mcp-bridge" : "agents-js-mcp";
  const name = opts?.name ?? defaultName;
  const args = url ? ["mcp", "bridge", "--url", url] : ["mcp"];
  return {
    mcpServers: {
      [name]: {
        command: "agents-js",
        args,
      },
    },
  };
}

/**
 * Surface skills from a skills source (e.g. a skills-js checkout) through the
 * MCP bridge's `tool_search`, when `AGENTS_JS_SKILLS_DIR` is set (a
 * `path.delimiter`-separated list of source dirs). Skills are discoverable
 * references, not invocable tools. agents-js stays skills-js-free — sources are
 * plain directories read through the `@agents-js/skills` loader. This is how a
 * native pi (whose pi-extension spawns `agents-js mcp` in bridge mode)
 * discovers provisioned skills like grill-me.
 */
function loadSkillsFromEnv(env: NodeJS.ProcessEnv): SkillMeta[] {
  const dirs = env.AGENTS_JS_SKILLS_DIR;
  if (!dirs) return [];
  const searchPaths = dirs
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) => skillSourceSearchPaths(dir));
  try {
    return listSkills(searchPaths);
  } catch {
    return [];
  }
}

function withSkills(config: BridgeConfig, env: NodeJS.ProcessEnv): BridgeConfig {
  const skills = loadSkillsFromEnv(env);
  return skills.length > 0 ? { ...config, skills } : config;
}

export async function loadBridgeConfig(env?: NodeJS.ProcessEnv): Promise<BridgeConfig> {
  // biome-ignore lint/style/noProcessEnv: CLI entry point reads config env vars by design.
  const processEnv = env ?? process.env;
  const configPath = processEnv.AGENTS_JS_BRIDGE_CONFIG;
  const agentsJson = processEnv.AGENTS_JS_BRIDGE_AGENTS;

  if (configPath) {
    const raw = readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as BridgeConfig;
  }

  if (agentsJson) {
    // Accept the widened registry shape (discriminated union on `kind`). The
    // MCP surface only dispatches A2A agents; `kind: "acp"` entries raise a
    // clear error so operators can't silently mis-wire an ACP harness into
    // the MCP server.
    const raw = JSON.parse(agentsJson) as unknown;
    if (!Array.isArray(raw)) {
      throw new Error("[agents-js] AGENTS_JS_BRIDGE_AGENTS must be a JSON array of agent entries.");
    }
    const agents: AgentEndpoint[] = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (record.kind === "acp") {
        throw new Error(
          `[agents-js] AGENTS_JS_BRIDGE_AGENTS entry "${String(record.name ?? "<unnamed>")}" has kind "acp" — the MCP surface only bridges A2A endpoints.`,
        );
      }
      if (typeof record.name === "string" && typeof record.url === "string") {
        agents.push({ name: record.name, url: record.url });
      }
    }
    return withSkills({ agents }, processEnv);
  }

  const registry = createSharedAgentRegistry({ env });
  const entries = await registry.list();
  const agents: AgentEndpoint[] = [];
  for (const entry of entries) {
    if (entry.kind !== "a2a") continue; // ACP entries are not exposed via the MCP surface.
    agents.push({ name: entry.name, url: entry.url });
  }
  return withSkills({ agents }, processEnv);
}

async function defaultStartServer(config: BridgeConfig): Promise<void> {
  const server = await createBridgeServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Resolve the runnable CLI entry given the module URL of the calling
 * source. Pure helper — exported for unit testing because the bug class
 * here is "naively appended `cli.ts` to a `.mjs` module path." Tests
 * cover both modes (source and built dist) so a future bundling/layout
 * change can't silently regress.
 *
 *   - **Source mode** (`.ts` module): sibling file is `cli.ts`, the
 *     source entrypoint that `runAgentsJsCli` lives in.
 *   - **Built dist mode** (`.mjs` module): sibling file is `bin.mjs`,
 *     the package.json `bin` entry. `cli.mjs` ALSO exists in dist but
 *     is the bundled runtime module, NOT a CLI entry — invoking it
 *     directly would not run the CLI dispatcher.
 *
 * Returns an absolute filesystem path suitable for passing as the
 * script argument to `bun` / `node`.
 */
export function resolveCliEntryFromModuleUrl(moduleUrl: string): string {
  const url = new URL(moduleUrl);
  const moduleDir = dirname(url.pathname);
  const isBundledDist = url.pathname.endsWith(".mjs");
  return isBundledDist ? resolve(moduleDir, "bin.mjs") : resolve(moduleDir, "cli.ts");
}

function resolveClaudeMcpCommand(): { command: string; args: string[] } {
  // When running from the Bun-compiled standalone binary, `process.execPath`
  // points at the `agents-js` binary itself — invoke it directly with the
  // `mcp` subcommand. `import.meta.url` in that case resolves to a synthetic
  // `compile:/...` path that can't be re-executed, so the source-file branch
  // below would break.
  //
  // When running from source (`bun src/cli.ts`), `process.execPath` is the
  // Bun binary and we need to pass it our own `cli.ts` path as the script.
  // When running from the built dist (`bun packages/cli/dist/bin.mjs` or
  // an npm-installed copy), the sibling entry is `bin.mjs`, NOT `cli.ts`
  // (which only exists in source). See {@link resolveCliEntryFromModuleUrl}.
  const execPath = process.execPath;
  const isCompiledBinary = typeof execPath === "string" && /(^|\/)agents-js$/.test(execPath);
  if (isCompiledBinary) {
    return { command: execPath, args: ["mcp"] };
  }
  const cliSource = resolveCliEntryFromModuleUrl(import.meta.url);
  return { command: execPath, args: [cliSource, "mcp"] };
}

/**
 * Build the argv passed to `claude mcp add` for `agents-js mcp setup --claude`.
 *
 * Uses `-s user` so agents-js-mcp is available across ALL Claude Code
 * sessions on this machine — matches the `--claude` intent of "quickest
 * one-liner to register agents-js everywhere." `-s local` (the prior
 * default) was project-scope only and unhelpful as the primary register
 * path. Project-scope registration is still the right call for shared
 * team configs (`.mcp.json` via `agents-js mcp setup` without flags).
 *
 * Optional `serverName` lets callers override the registered name when
 * `agents-js mcp setup --url <gateway> [--name <name>] --claude` writes
 * a single-gateway bridge entry into Claude Code's user-scope registry
 * (default: `agents-js-mcp`).
 *
 * Exposed for unit-testing; the actual `execFileSync` side effect lives
 * in {@link runSetup}.
 */
export function buildClaudeMcpAddArgs(
  launchCommand: string,
  launchArgs: string[],
  serverName: string = "agents-js-mcp",
): string[] {
  return ["mcp", "add", "-s", "user", serverName, "--", launchCommand, ...launchArgs];
}

function runSetup(
  args: McpCommandArgs,
  output: Pick<NodeJS.WriteStream, "write">,
  cwd: string,
): number {
  if (args.claude) {
    const { command, args: launchArgs } = resolveClaudeMcpCommand();
    const defaultName = args.url ? "agents-js-mcp-bridge" : "agents-js-mcp";
    const serverName = args.name ?? defaultName;
    const effectiveLaunchArgs = args.url
      ? [...launchArgs, "bridge", "--url", args.url]
      : launchArgs;
    try {
      execFileSync("claude", buildClaudeMcpAddArgs(command, effectiveLaunchArgs, serverName), {
        stdio: "inherit",
      });
      output.write(`[agents-js] Registered ${serverName} with Claude Code\n`);
      return EXIT_OK;
    } catch {
      output.write("[agents-js] Failed to register — is `claude` CLI on PATH?\n");
      return EXIT_ERROR;
    }
  }

  if (args.global) {
    // `--global` is a leaky-abstraction flag: agents-js is a vendor-neutral
    // CLI but `--global` historically wrote a Claude Code-specific user-scope
    // config file. The flag was silently broken since the initial commit
    // (wrote to `~/.claude/settings.json` which Claude Code does not read for
    // MCP registration), so functional user-count is ~zero. Removed entirely;
    // accepting one release of explicit deprecation error to catch any cached
    // CI/blog/AI-suggestion references with an actionable message rather than
    // a generic "unknown flag" parser error.
    output.write(
      [
        "[agents-js] --global is removed.",
        "  Was a silent no-op (wrote to ~/.claude/settings.json which Claude Code does not read for MCP).",
        "  Use one of these explicit, vendor-named paths instead:",
        "    agents-js mcp setup            # write project-scope .mcp.json in cwd (vendor-neutral MCP convention)",
        "    agents-js mcp setup --claude   # register user-scope with Claude Code via `claude mcp add -s user`",
        "  Other MCP clients (Cursor, Zed, codex-app) get vendor-named flags as added on demand.",
        "",
      ].join("\n"),
    );
    return EXIT_ERROR;
  }

  const mcpConfig = generateMcpServerConfig({ name: args.name, url: args.url });
  const targetPath = join(cwd, ".mcp.json");
  writeMcpConfig(targetPath, mcpConfig.mcpServers, { mkdirParent: false });
  output.write(`[agents-js] Wrote MCP config to ${targetPath}\n`);
  return EXIT_OK;
}

function writeMcpConfig(
  filePath: string,
  incoming: Record<string, unknown>,
  opts: { mkdirParent: boolean },
): void {
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid — start fresh.
  }
  const existingMcpServers =
    typeof existing.mcpServers === "object" && existing.mcpServers !== null
      ? (existing.mcpServers as Record<string, unknown>)
      : {};
  existing.mcpServers = { ...existingMcpServers, ...incoming };
  if (opts.mkdirParent) mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(existing, null, 2)}\n`);
}

/**
 * Derive a stable, MCP-tool-safe name from a gateway URL. We prefer the
 * hostname (sanitized), falling back to a static label for unparseable
 * inputs. The bridge server applies its own sanitization, but producing
 * a clean name here keeps the agent card identity readable.
 */
function deriveBridgeAgentName(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host.length > 0 ? host : "gateway";
  } catch {
    return "gateway";
  }
}

export async function runMcpCommand(
  argv: string[],
  deps?: McpCommandDependencies,
): Promise<number> {
  const output = deps?.output ?? process.stderr;
  const cwd = deps?.cwd ?? process.cwd();

  const versionExit = handleVersionFlag(argv, output);
  if (versionExit !== undefined) return versionExit;

  const args = parseMcpCommandArgs(argv);

  if (args.subcommand === "setup") {
    if (args.help) {
      printMcpSetupUsage(output);
      return EXIT_OK;
    }
    return runSetup(args, output, cwd);
  }

  if (args.subcommand === "bridge") {
    if (args.help) {
      printMcpBridgeUsage(output);
      return EXIT_OK;
    }
    if (!args.url) {
      output.write(
        "[agents-js] Missing required --url. Usage: agents-js mcp bridge --url <gateway-url>\n",
      );
      return EXIT_ERROR;
    }
    const config: BridgeConfig = {
      agents: [{ name: deriveBridgeAgentName(args.url), url: args.url }],
    };
    const serverStarter = deps?.startServer ?? defaultStartServer;
    await serverStarter(config);
    return EXIT_OK;
  }

  if (args.help) {
    printMcpUsage(output);
    return EXIT_OK;
  }

  // Default: start MCP server on stdio.
  const configLoader = deps?.loadBridgeConfig ?? (() => loadBridgeConfig(deps?.env));
  const config = await configLoader();

  if (config.agents.length === 0) {
    output.write(
      "[agents-js] No agents found. Register agents with `agents-js registry add` " +
        "or set AGENTS_JS_BRIDGE_CONFIG / AGENTS_JS_BRIDGE_AGENTS.\n",
    );
    return EXIT_ERROR;
  }

  const serverStarter = deps?.startServer ?? defaultStartServer;
  await serverStarter(config);
  return EXIT_OK;
}
