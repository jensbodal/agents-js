#!/usr/bin/env bun
import { missingRequiredClaudeReceiverCliEnv, readClaudeReceiverCliConfig } from "./cli-config.ts";
import { runClaudeGatewayInboxReceiver } from "./receiver.ts";

const config = readClaudeReceiverCliConfig(Bun.env, process.cwd());
const { gatewayUrl, identity, keyCommand } = config;

if (missingRequiredClaudeReceiverCliEnv(config) || !identity || !gatewayUrl || !keyCommand) {
  console.error(
    "missing required env: CW_IDENTITY/CH_GATEWAY_IDENTITY/AGENTS_GATEWAY_SUB, CH_GATEWAY_URL/AGENTS_GATEWAY_URL, CH_GATEWAY_KEY_CMD/AGENTS_GATEWAY_KEY_CMD",
  );
  process.exit(2);
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
