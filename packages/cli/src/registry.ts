import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import type { AgentEntry, AgentKind } from "@agents-js/a2a-client/node";
import { resolveSharedAgentRegistryPath } from "@agents-js/a2a-client/node";
import { normalizeAgentName } from "@agents-js/acp-host";
import { type ArgSpec, parseArgv } from "./argv-parser.ts";
import { EXIT_ERROR, EXIT_OK } from "./exit-codes.ts";
import { CLI_VERSION, handleVersionFlag } from "./version.ts";

/**
 * On-disk v2 registry file shape. `version: 2` is written on every save;
 * v1 files (no version field) are read transparently and rewritten as v2.
 */
interface RegistryFile {
  version?: 2;
  agents: Record<string, RegistryFileEntry>;
}

/** Stored entry; provenance + governance fields are optional to preserve v1 reads. */
interface RegistryFileEntry {
  kind?: AgentKind;
  name?: string;
  agent_id?: string;
  url?: string;
  harness?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  workspaceFlag?: string;
  actor_type?: "human" | "machine";
  gateway_id?: string;
  source?: "auto-reg" | "manual" | "sync";
  registered_at?: string;
  last_synced_at?: string;
  protocol_version?: string;
  card_cache_refreshed_at?: string;
  preferred_gateway_id?: string;
  expires_at?: string;
  health_check_url?: string;
  description?: string;
}

function loadRegistry(path: string): RegistryFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as RegistryFile;
    if (typeof parsed === "object" && parsed !== null && "agents" in parsed) {
      return parsed;
    }
    return { agents: {} };
  } catch {
    return { agents: {} };
  }
}

function saveRegistry(path: string, registry: RegistryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const out: RegistryFile = { version: 2, agents: registry.agents };
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
}

function printUsage(): void {
  process.stdout.write(
    `${[
      `agents-js v${CLI_VERSION} — registry`,
      "",
      "Usage:",
      "  agents-js registry add <name> <url>                    Add or update an A2A agent (default kind)",
      "  agents-js registry add <name> --kind a2a --url <url>   Add or update an A2A agent (explicit)",
      "  agents-js registry add <name> --kind acp --harness <id> [--command <cmd>]",
      "                                                         [--args-json <json>] [--env-json <json>]",
      "                                                         [--workspace-flag <flag>]",
      "                                                         Add or update an ACP agent",
      "  agents-js registry remove <name>                       Remove an agent",
      "  agents-js registry list                                List registered agents",
      "",
      "Run `agents-js registry <verb> --help` for verb-specific options.",
      "",
      "Options:",
      "  --version, -v  Print version and exit",
      "  --help, -h     Show this message",
      "",
    ].join("\n")}\n`,
  );
}

function printAddUsage(): void {
  process.stdout.write(
    `${[
      `agents-js v${CLI_VERSION} — registry add`,
      "",
      "Usage:",
      "  agents-js registry add <name> <url>",
      "  agents-js registry add <name> --kind a2a --url <url>",
      "  agents-js registry add <name> --kind acp --harness <id> [--command <cmd>]",
      "      [--args-json <json>] [--env-json <json>] [--workspace-flag <flag>]",
      "",
      "Options:",
      "  --kind <a2a|acp>          Entry kind (default: a2a)",
      "  --url <url>               A2A endpoint URL",
      "  --harness <id>            ACP harness id",
      "  --command <cmd>           Override the harness command",
      "  --args-json <json>        JSON array of extra command args",
      "  --env-json <json>         JSON object of env overrides",
      "  --workspace-flag <flag>   Flag the harness uses to receive cwd",
      "  --help                    Show this message",
    ].join("\n")}\n`,
  );
}

function printRemoveUsage(): void {
  process.stdout.write(
    `${[
      `agents-js v${CLI_VERSION} — registry remove`,
      "",
      "Usage:",
      "  agents-js registry remove <name>",
      "",
      "Options:",
      "  --help   Show this message",
    ].join("\n")}\n`,
  );
}

function printListUsage(): void {
  process.stdout.write(
    `${[
      `agents-js v${CLI_VERSION} — registry list`,
      "",
      "Usage:",
      "  agents-js registry list",
      "",
      "Options:",
      "  --help   Show this message",
    ].join("\n")}\n`,
  );
}

interface VerbHelpArgs {
  help?: boolean;
}

const setVerbHelp = (a: VerbHelpArgs): void => {
  a.help = true;
};

const HELP_ONLY_ARG_SPEC: ArgSpec<VerbHelpArgs> = {
  "--help": { kind: "flag", assign: setVerbHelp },
  "-h": { kind: "flag", assign: setVerbHelp },
};

interface ParsedAddArgs {
  name: string;
  kind: AgentKind;
  url?: string;
  harness?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  workspaceFlag?: string;
}

/**
 * Mutable scratch type consumed by the table-driven parser. The final
 * `ParsedAddArgs` result is derived from this after the parser completes
 * so that positional-vs-flag URL collisions can be resolved once.
 */
interface AddArgsScratch {
  kind: AgentKind;
  url?: string;
  harness?: string;
  command?: string;
  argsJson?: string;
  envJson?: string;
  workspaceFlag?: string;
  positionalUrl?: string;
  positionalOverflow?: string;
}

const ADD_ARG_SPEC: ArgSpec<AddArgsScratch> = {
  "--kind": {
    kind: "value",
    assign: (a, v) => {
      if (v !== "a2a" && v !== "acp") {
        throw new Error(`[agents-js] --kind must be one of a2a|acp (got "${v}")`);
      }
      a.kind = v;
    },
  },
  "--url": {
    kind: "value",
    assign: (a, v) => {
      a.url = v;
    },
  },
  "--harness": {
    kind: "value",
    assign: (a, v) => {
      a.harness = v;
    },
  },
  "--command": {
    kind: "value",
    assign: (a, v) => {
      a.command = v;
    },
  },
  "--args-json": {
    kind: "value",
    assign: (a, v) => {
      a.argsJson = v;
    },
  },
  "--env-json": {
    kind: "value",
    assign: (a, v) => {
      a.envJson = v;
    },
  },
  "--workspace-flag": {
    kind: "value",
    assign: (a, v) => {
      a.workspaceFlag = v;
    },
  },
};

/**
 * Walk the `registry add <name> ...` argv, dispatching flag tokens
 * through {@link ADD_ARG_SPEC} and accumulating non-flag tokens as a
 * positional URL (back-compat: `registry add <name> <url>` still works).
 *
 * Missing-value errors for `--kind`, `--url`, etc. are raised at parse
 * time via the shared {@link consumeValue} path inside `parseArgv`, so
 * operators see a clear diagnostic instead of a delayed "a2a entries
 * require <url>" after the fact.
 */
function parseAddArgvTokens(tokens: string[]): AddArgsScratch {
  const positional: { url?: string; overflow?: string } = {};
  const flagTokens: string[] = [];

  // First pass: separate positional tokens from flag sequences so the
  // shared parser (which doesn't know about positionals) sees a clean
  // `--flag value` stream.
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token in ADD_ARG_SPEC) {
      flagTokens.push(token);
      // Value flags consume the next token.
      const entry = ADD_ARG_SPEC[token];
      if (entry?.kind === "value") {
        const next = tokens[i + 1];
        if (next !== undefined) {
          flagTokens.push(next);
          i += 1;
        }
        // else: fall through; parseArgv will raise the missing-value error.
      }
      continue;
    }
    if (token.startsWith("--") || token === "-h") {
      throw new Error(`[agents-js] Unknown flag "${token}"`);
    }
    // Positional URL slot (back-compat for a2a entries).
    if (positional.url === undefined) {
      positional.url = token;
    } else if (positional.overflow === undefined) {
      positional.overflow = token;
    }
  }

  const scratch = parseArgv<AddArgsScratch>(flagTokens, ADD_ARG_SPEC, {
    subcommandName: "registry add",
    defaults: { kind: "a2a" },
  });

  if (positional.url !== undefined) scratch.positionalUrl = positional.url;
  if (positional.overflow !== undefined) scratch.positionalOverflow = positional.overflow;

  return scratch;
}

function parseAddArgs(args: string[]): ParsedAddArgs | { error: string } {
  if (args.length === 0) {
    return { error: "Missing <name>" };
  }

  const rawName = args[0];
  if (!rawName) {
    return { error: "Missing <name>" };
  }
  // Strip zero-width / default-ignorable code points from the user-typed
  // name so the registry key matches the ACP session controller's
  // normalized view. Without this, `agents-js registry add <ZWSP-prefixed>`
  // would silently persist a key the gateway can never look up.
  const { name, normalized } = normalizeAgentName(rawName);
  if (name.length === 0) {
    return { error: "Agent name is empty after stripping invisible characters" };
  }
  if (normalized) {
    console.warn(
      `[agents-js] Stripped invisible characters from agent name. Using normalized name: ${JSON.stringify(name)}`,
    );
  }

  let scratch: AddArgsScratch;
  try {
    scratch = parseAddArgvTokens(args.slice(1));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Strip the `[agents-js] ` prefix the callers re-add.
    return { error: message.replace(/^\[agents-js\]\s*/, "") };
  }

  if (scratch.positionalOverflow !== undefined) {
    return { error: `Unexpected positional argument "${scratch.positionalOverflow}"` };
  }

  const result: ParsedAddArgs = { name, kind: scratch.kind };

  if (scratch.kind === "a2a") {
    const resolvedUrl = scratch.url ?? scratch.positionalUrl;
    if (!resolvedUrl) {
      return { error: "a2a entries require <url> (positional) or --url <url>" };
    }
    result.url = resolvedUrl;
    return result;
  }

  // kind === "acp"
  if (!scratch.harness) {
    return { error: "acp entries require --harness <id>" };
  }
  if (scratch.positionalUrl !== undefined) {
    return { error: "acp entries do not accept a positional <url>" };
  }
  result.harness = scratch.harness;
  if (scratch.command !== undefined) result.command = scratch.command;
  if (scratch.argsJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(scratch.argsJson);
    } catch {
      return { error: "--args-json must be valid JSON" };
    }
    if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === "string")) {
      return { error: "--args-json must be a JSON array of strings" };
    }
    result.args = parsed as string[];
  }
  if (scratch.envJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(scratch.envJson);
    } catch {
      return { error: "--env-json must be valid JSON" };
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Object.values(parsed as Record<string, unknown>).every((v) => typeof v === "string")
    ) {
      return { error: "--env-json must be a JSON object of string values" };
    }
    result.env = parsed as Record<string, string>;
  }
  if (scratch.workspaceFlag !== undefined) result.workspaceFlag = scratch.workspaceFlag;
  return result;
}

function describeEntry(entry: AgentEntry): string {
  if (entry.kind === "a2a") return `a2a → ${entry.url}`;
  const extras: string[] = [];
  if (entry.command) extras.push(`cmd=${entry.command}`);
  if (entry.args && entry.args.length > 0) extras.push(`args=${entry.args.length}`);
  if (entry.env && Object.keys(entry.env).length > 0)
    extras.push(`env=${Object.keys(entry.env).length}`);
  if (entry.workspaceFlag) extras.push(`workspace=${entry.workspaceFlag}`);
  const suffix = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return `acp → harness=${entry.harness}${suffix}`;
}

/**
 * Dispatch table for `agents-js registry <verb>`. Each verb owns its own
 * argument-parsing strategy and `--help` rendering; `runRegistryCommand`
 * reads the first positional and delegates without fall-through.
 */
const REGISTRY_VERBS = {
  add: runAddVerb,
  remove: runRemoveVerb,
  list: runListVerb,
} as const;

function runAddVerb(args: string[], registryPath: string): number {
  // Detect `--help` before name validation so `registry add --help` works
  // even though `add` requires a positional name afterward.
  if (args[0] === "--help" || args[0] === "-h") {
    printAddUsage();
    return EXIT_OK;
  }

  const parsed = parseAddArgs(args);
  if ("error" in parsed) {
    console.error(`[agents-js] ${parsed.error}`);
    printAddUsage();
    return EXIT_ERROR;
  }
  const registry = loadRegistry(registryPath);
  const existed = parsed.name in registry.agents;
  const gatewayId = hostname();
  const registeredAt = new Date().toISOString();
  const provenance: RegistryFileEntry = {
    name: parsed.name,
    agent_id: `${gatewayId}.${parsed.name}`,
    gateway_id: gatewayId,
    source: "manual",
    registered_at: registeredAt,
    actor_type: "machine",
  };
  if (parsed.kind === "a2a") {
    registry.agents[parsed.name] = {
      ...provenance,
      kind: "a2a",
      url: parsed.url as string,
    };
  } else {
    const entry: RegistryFileEntry = {
      ...provenance,
      kind: "acp",
      harness: parsed.harness as string,
    };
    if (parsed.command !== undefined) entry.command = parsed.command;
    if (parsed.args !== undefined) entry.args = parsed.args;
    if (parsed.env !== undefined) entry.env = parsed.env;
    if (parsed.workspaceFlag !== undefined) entry.workspaceFlag = parsed.workspaceFlag;
    registry.agents[parsed.name] = entry;
  }
  saveRegistry(registryPath, registry);
  const summary = parsed.kind === "a2a" ? `a2a → ${parsed.url}` : `acp → harness=${parsed.harness}`;
  console.log(`${existed ? "Updated" : "Added"} ${parsed.name} (${summary})`);
  console.log(`Registry: ${registryPath}`);
  return EXIT_OK;
}

function runRemoveVerb(args: string[], registryPath: string): number {
  // `remove` has a single positional <name>; remaining tokens are flags
  // dispatched through the shared parser so `--help`/`-h` and unknown
  // flag diagnostics behave consistently with the other verbs.
  const [rawRemoveName, ...rest] = args;
  if (rawRemoveName === "--help" || rawRemoveName === "-h") {
    printRemoveUsage();
    return EXIT_OK;
  }
  if (!rawRemoveName) {
    console.error("[agents-js] Usage: agents-js registry remove <name>");
    return EXIT_ERROR;
  }
  let parsed: VerbHelpArgs;
  try {
    parsed = parseArgv<VerbHelpArgs>(rest, HELP_ONLY_ARG_SPEC, {
      subcommandName: "registry remove",
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printRemoveUsage();
    return EXIT_ERROR;
  }
  if (parsed.help) {
    printRemoveUsage();
    return EXIT_OK;
  }
  // Normalize the remove target the same way add does so users can remove
  // an entry whose key was normalized during add without having to
  // reproduce the original (potentially invisible) characters.
  const { name } = normalizeAgentName(rawRemoveName);
  const registry = loadRegistry(registryPath);
  if (!(name in registry.agents)) {
    console.error(`[agents-js] Agent "${name}" not found in registry.`);
    return EXIT_ERROR;
  }
  delete registry.agents[name];
  saveRegistry(registryPath, registry);
  console.log(`Removed ${name}`);
  return EXIT_OK;
}

function runListVerb(args: string[], registryPath: string): number {
  let parsed: VerbHelpArgs;
  try {
    parsed = parseArgv<VerbHelpArgs>(args, HELP_ONLY_ARG_SPEC, {
      subcommandName: "registry list",
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printListUsage();
    return EXIT_ERROR;
  }
  if (parsed.help) {
    printListUsage();
    return EXIT_OK;
  }
  const registry = loadRegistry(registryPath);
  const entries = Object.entries(registry.agents);
  if (entries.length === 0) {
    console.log(`No agents registered. (${registryPath})`);
    return EXIT_OK;
  }
  console.log(`Registry: ${registryPath}\n`);
  const maxName = Math.max(...entries.map(([n]) => n.length));
  for (const [name, fileEntry] of entries) {
    const entry: AgentEntry =
      fileEntry.kind === "acp"
        ? {
            kind: "acp",
            name,
            harness: fileEntry.harness ?? "",
            ...(fileEntry.command !== undefined ? { command: fileEntry.command } : {}),
            ...(fileEntry.args !== undefined ? { args: fileEntry.args } : {}),
            ...(fileEntry.env !== undefined ? { env: fileEntry.env } : {}),
            ...(fileEntry.workspaceFlag !== undefined
              ? { workspaceFlag: fileEntry.workspaceFlag }
              : {}),
          }
        : { kind: "a2a", name, url: fileEntry.url ?? "" };
    console.log(`  ${name.padEnd(maxName)}  ${describeEntry(entry)}`);
  }
  return EXIT_OK;
}

export function runRegistryCommand(argv: string[]): number {
  const versionExit = handleVersionFlag(argv, process.stdout);
  if (versionExit !== undefined) return versionExit;

  const registryPath = resolveSharedAgentRegistryPath();
  const [verb, ...rest] = argv;

  if (!verb || verb === "--help" || verb === "-h") {
    printUsage();
    return EXIT_OK;
  }

  const handler = (REGISTRY_VERBS as Record<string, (args: string[], path: string) => number>)[
    verb
  ];
  if (handler) {
    return handler(rest, registryPath);
  }

  console.error(`[agents-js] Unknown registry command: ${verb}`);
  printUsage();
  return EXIT_ERROR;
}
