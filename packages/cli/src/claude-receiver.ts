import {
  missingRequiredClaudeReceiverCliEnv,
  readClaudeReceiverCliConfig,
  readMcpSendServerEnv,
  runClaudeGatewayInboxReceiver,
  runMcpSendServer,
} from "@agents-js/claude-gateway-inbox-receiver";
import { EXIT_DATAERR, EXIT_OK } from "./exit-codes.ts";

function printClaudeReceiverUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      "Usage:",
      "  agents-js claude-receiver",
      "",
      "Poll the signed gateway inbox and spawn Claude for each accepted row.",
      "",
      "Required env:",
      "  CW_IDENTITY or CH_GATEWAY_IDENTITY or AGENTS_GATEWAY_SUB",
      "  CH_GATEWAY_URL or AGENTS_GATEWAY_URL",
      "  CH_GATEWAY_KEY_CMD or AGENTS_GATEWAY_KEY_CMD",
    ].join("\n")}\n`,
  );
}

export async function runClaudeReceiverCommand(
  argv: string[],
  dependencies: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    output?: Pick<NodeJS.WriteStream, "write">;
    stderr?: Pick<NodeJS.WriteStream, "write">;
  } = {},
): Promise<number> {
  const output = dependencies.output ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  if (argv.includes("--help") || argv.includes("-h")) {
    printClaudeReceiverUsage(output);
    return EXIT_OK;
  }
  if (argv.length > 0) {
    stderr.write(`[agents-js claude-receiver] unexpected arguments: ${argv.join(" ")}\n`);
    printClaudeReceiverUsage(stderr);
    return EXIT_DATAERR;
  }

  // biome-ignore lint/style/noProcessEnv: CLI entry-point default; tests inject via dependencies.env.
  const env = dependencies.env ?? process.env;
  const config = readClaudeReceiverCliConfig(env, dependencies.cwd ?? process.cwd());
  const { gatewayUrl, identity, keyCommand } = config;
  if (missingRequiredClaudeReceiverCliEnv(config) || !identity || !gatewayUrl || !keyCommand) {
    stderr.write(
      "missing required env: CW_IDENTITY/CH_GATEWAY_IDENTITY/AGENTS_GATEWAY_SUB, CH_GATEWAY_URL/AGENTS_GATEWAY_URL, CH_GATEWAY_KEY_CMD/AGENTS_GATEWAY_KEY_CMD\n",
    );
    return EXIT_DATAERR;
  }

  const abort = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => abort.abort());
  }

  await runClaudeGatewayInboxReceiver({
    identity,
    gatewayUrl,
    workspace: config.workspace,
    keyCommand,
    cursorPath: config.cursorPath,
    intervalMs: config.intervalMs,
    limit: config.limit,
    fetchMode: config.fetchMode,
    fetchImpl: config.fetchImpl,
    claudeCommand: config.claudeCommand,
    claudeArgs: config.claudeArgs,
    mcpConfigPath: config.mcpConfigPath,
    mcpCommand: config.mcpCommand,
    mcpArgs: config.mcpArgs,
    senderAllowlist: config.senderAllowlist,
    signal: abort.signal,
  });
  return EXIT_OK;
}

export async function runClaudeReceiverMcpSendCommand(
  argv: string[],
  dependencies: {
    env?: NodeJS.ProcessEnv;
    stderr?: Pick<NodeJS.WriteStream, "write">;
  } = {},
): Promise<number> {
  const stderr = dependencies.stderr ?? process.stderr;
  if (argv.length > 0) {
    stderr.write(`[agents-js claude-receiver-mcp-send] unexpected arguments: ${argv.join(" ")}\n`);
    return EXIT_DATAERR;
  }
  // biome-ignore lint/style/noProcessEnv: CLI entry-point default; tests inject via dependencies.env.
  const env = dependencies.env ?? process.env;
  try {
    await runMcpSendServer(readMcpSendServerEnv(env));
    return EXIT_OK;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_DATAERR;
  }
}
