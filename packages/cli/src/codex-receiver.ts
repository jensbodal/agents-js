import {
  missingRequiredReceiverCliEnv,
  readReceiverCliConfig,
  runCodexGatewayInboxReceiver,
} from "@agents-js/codex-gateway-inbox-receiver";
import { EXIT_DATAERR, EXIT_OK } from "./exit-codes.ts";

function printCodexReceiverUsage(output: Pick<NodeJS.WriteStream, "write">): void {
  output.write(
    `${[
      "Usage:",
      "  agents-js codex-receiver",
      "",
      "Poll the signed gateway inbox and deliver rows into native Codex.",
      "",
      "Required env:",
      "  CODEX_GATEWAY_IDENTITY or AGENTS_GATEWAY_SUB",
      "  CODEX_GATEWAY_URL or AGENTS_GATEWAY_URL",
      "  CODEX_GATEWAY_KEY_CMD or AGENTS_GATEWAY_KEY_CMD",
    ].join("\n")}\n`,
  );
}

export async function runCodexReceiverCommand(
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
    printCodexReceiverUsage(output);
    return EXIT_OK;
  }
  if (argv.length > 0) {
    stderr.write(`[agents-js codex-receiver] unexpected arguments: ${argv.join(" ")}\n`);
    printCodexReceiverUsage(stderr);
    return EXIT_DATAERR;
  }

  // biome-ignore lint/style/noProcessEnv: CLI entry-point default; tests inject via dependencies.env.
  const env = dependencies.env ?? process.env;
  const config = readReceiverCliConfig(env, dependencies.cwd ?? process.cwd());
  const { gatewayUrl, identity, keyCommand } = config;
  if (missingRequiredReceiverCliEnv(config) || !identity || !gatewayUrl || !keyCommand) {
    stderr.write(
      "missing required env: CODEX_GATEWAY_IDENTITY/AGENTS_GATEWAY_SUB, CODEX_GATEWAY_URL/AGENTS_GATEWAY_URL, CODEX_GATEWAY_KEY_CMD/AGENTS_GATEWAY_KEY_CMD\n",
    );
    return EXIT_DATAERR;
  }

  const abort = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => abort.abort());
  }

  await runCodexGatewayInboxReceiver({
    identity,
    gatewayUrl,
    workspace: config.workspace,
    keyCommand,
    cursorPath: config.cursorPath,
    intervalMs: config.intervalMs,
    limit: config.limit,
    autoReply: config.autoReply,
    replyTarget: config.replyTarget,
    skipGitRepoCheck: config.skipGitRepoCheck,
    fetchImpl: config.fetchImpl,
    signal: abort.signal,
  });
  return EXIT_OK;
}
