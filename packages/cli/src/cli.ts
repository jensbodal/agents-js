#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { runAcpCommand } from "./acp.ts";
import { runBridgeCommand } from "./bridge.ts";
import { runClientCommand } from "./client/command.ts";
import { EXIT_ERROR, EXIT_OK } from "./exit-codes.ts";
import { runMcpCommand } from "./mcp.ts";
import { runRegistryCommand } from "./registry.ts";
import { runSendCommand } from "./send.ts";
import { runServeCommand } from "./serve.ts";
import { runSkillCommand } from "./skill.ts";
import { formatVersionLine } from "./version.ts";

function printHelp(output: Pick<NodeJS.WriteStream, "write"> = process.stdout): void {
  output.write(
    `${[
      formatVersionLine(),
      "",
      "Usage:",
      "  agents-js <command> [options]",
      "",
      "Commands:",
      "  serve     Expose an ACP runtime over A2A",
      "  bridge    Spawn an ephemeral ACP gateway for a single harness",
      "  acp       Proxy stdio to an ACP runtime",
      "  mcp       Start MCP server for registered A2A agents",
      "  client    Open the A2A client TUI",
      "  send      Send a one-shot prompt to a running serve and print the response",
      "  registry  Manage the shared agent registry",
      "  skill     Print the installable agents-js SKILL.md document",
      "",
      "Global options:",
      "  --version, -v  Print version and exit",
      "  --help, -h     Show this message",
      "",
      "Run `agents-js serve --help` for serve-specific options.",
      "Run `agents-js bridge --help` for bridge-specific options.",
      "Run `agents-js acp --help` for acp-specific options.",
      "Run `agents-js mcp --help` for mcp-specific options.",
      "Run `agents-js client --help` for client-specific options.",
      "Run `agents-js send --help` for send-specific options.",
      "Run `agents-js skill --help` for skill-specific options.",
    ].join("\n")}\n`,
  );
}

export async function runAgentsJsCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--version" || command === "-v") {
    process.stdout.write(`${formatVersionLine()}\n`);
    return EXIT_OK;
  }

  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return EXIT_OK;
  }

  if (command === "serve") {
    const result = await runServeCommand(rest);
    return typeof result === "number" ? result : EXIT_OK;
  }

  if (command === "acp") {
    const result = await runAcpCommand(rest);
    return typeof result === "number" ? result : EXIT_OK;
  }

  if (command === "client") {
    const result = await runClientCommand(rest);
    return typeof result === "number" ? result : EXIT_OK;
  }

  if (command === "send") {
    return runSendCommand(rest);
  }

  if (command === "mcp") {
    return runMcpCommand(rest);
  }

  if (command === "bridge") {
    const result = await runBridgeCommand(rest);
    return typeof result === "number" ? result : EXIT_OK;
  }

  if (command === "registry") {
    return runRegistryCommand(rest);
  }

  if (command === "skill") {
    return runSkillCommand(rest);
  }

  // EXIT_USAGE = 64 — unknown command. Print top-level usage to stderr
  // and exit with the standard sysexits(3) usage code so scripts can
  // distinguish a misinvocation from a runtime failure.
  process.stderr.write(`[agents-js] Unknown command: ${command}\n`);
  printHelp(process.stderr);
  return 64;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const exitCode = await runAgentsJsCli(process.argv.slice(2));
    if (exitCode !== EXIT_OK) {
      process.exit(exitCode);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(EXIT_ERROR);
  }
}
