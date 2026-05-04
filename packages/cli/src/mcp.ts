import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createSharedAgentRegistry } from "@agents-js/a2a-client/node";
import { type AgentEndpoint, type BridgeConfig, createBridgeServer } from "@agents-js/mcp-bridge";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { EXIT_ERROR, EXIT_OK } from "./exit-codes.ts";
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

/** Top-level `agents-js mcp` flags (server-mode default). */
const MCP_ROOT_ARG_SPEC: ArgSpec<McpCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp },
  "-h": { kind: "flag", assign: setHelp },
};

/** `agents-js mcp setup` flags. */
const MCP_SETUP_ARG_SPEC: ArgSpec<McpCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp },
  "-h": { kind: "flag", assign: setHelp },
  "--global": {
    kind: "flag",
    assign: (a) => {
      a.global = true;
    },
  },
  "--claude": {
    kind: "flag",
    assign: (a) => {
      a.claude = true;
    },
  },
};

/** `agents-js mcp bridge` flags. */
const MCP_BRIDGE_ARG_SPEC: ArgSpec<McpCommandArgs> = {
  "--help": { kind: "flag", assign: setHelp },
  "-h": { kind: "flag", assign: setHelp },
  "--url": {
    kind: "value",
    assign: (a, v) => {
      a.url = v;
    },
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
      "  agents-js mcp setup --global       Write MCP config to ~/.claude/settings.json",
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
      "  agents-js mcp setup            Write MCP config to .mcp.json in cwd",
      "  agents-js mcp setup --global   Write MCP config to ~/.claude/settings.json",
      "  agents-js mcp setup --claude   Register with Claude Code via `claude mcp add`",
      "",
      "Options:",
      "  --help   Show this message",
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

function generateMcpServerConfig(): {
  mcpServers: Record<string, { command: string; args: string[] }>;
} {
  return {
    mcpServers: {
      "agents-js-mcp": {
        command: "agents-js",
        args: ["mcp"],
      },
    },
  };
}

async function loadBridgeConfig(env?: NodeJS.ProcessEnv): Promise<BridgeConfig> {
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
    return { agents };
  }

  const registry = createSharedAgentRegistry({ env });
  const entries = await registry.list();
  const agents: AgentEndpoint[] = [];
  for (const entry of entries) {
    if (entry.kind !== "a2a") continue; // ACP entries are not exposed via the MCP surface.
    agents.push({ name: entry.name, url: entry.url });
  }
  return { agents };
}

async function defaultStartServer(config: BridgeConfig): Promise<void> {
  const server = await createBridgeServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
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
  const execPath = process.execPath;
  const isCompiledBinary = typeof execPath === "string" && /(^|\/)agents-js$/.test(execPath);
  if (isCompiledBinary) {
    return { command: execPath, args: ["mcp"] };
  }
  const cliSource = resolve(dirname(new URL(import.meta.url).pathname), "cli.ts");
  return { command: execPath, args: [cliSource, "mcp"] };
}

function runSetup(
  args: McpCommandArgs,
  output: Pick<NodeJS.WriteStream, "write">,
  cwd: string,
): number {
  if (args.claude) {
    const { command, args: launchArgs } = resolveClaudeMcpCommand();
    try {
      execFileSync(
        "claude",
        ["mcp", "add", "-s", "local", "agents-js-mcp", "--", command, ...launchArgs],
        {
          stdio: "inherit",
        },
      );
      output.write("[agents-js] Registered agents-js-mcp with Claude Code\n");
      return EXIT_OK;
    } catch {
      output.write("[agents-js] Failed to register — is `claude` CLI on PATH?\n");
      return EXIT_ERROR;
    }
  }

  const mcpConfig = generateMcpServerConfig();
  const targetPath = args.global
    ? join(homedir(), ".claude", "settings.json")
    : join(cwd, ".mcp.json");
  writeMcpConfig(targetPath, mcpConfig.mcpServers, { mkdirParent: args.global === true });
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
