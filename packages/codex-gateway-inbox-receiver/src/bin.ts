#!/usr/bin/env bun
import { missingRequiredReceiverCliEnv, readReceiverCliConfig } from "./cli-config.ts";
import { runCodexGatewayInboxReceiver } from "./receiver.ts";

const config = readReceiverCliConfig(Bun.env, process.cwd());
const { gatewayUrl, identity, keyCommand } = config;

if (missingRequiredReceiverCliEnv(config) || !identity || !gatewayUrl || !keyCommand) {
  console.error(
    "missing required env: CODEX_GATEWAY_IDENTITY/AGENTS_GATEWAY_SUB, CODEX_GATEWAY_URL/AGENTS_GATEWAY_URL, CODEX_GATEWAY_KEY_CMD/AGENTS_GATEWAY_KEY_CMD",
  );
  process.exit(2);
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
