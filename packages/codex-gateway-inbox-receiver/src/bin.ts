#!/usr/bin/env bun
import { runCodexGatewayInboxReceiver } from "./receiver.ts";

const identity = env("CODEX_GATEWAY_IDENTITY", "AGENTS_GATEWAY_SUB");
const gatewayUrl = env("CODEX_GATEWAY_URL", "AGENTS_GATEWAY_URL");
const workspace = env("CODEX_WORKSPACE", "PWD") ?? process.cwd();
const keyCommand = env("CODEX_GATEWAY_KEY_CMD", "AGENTS_GATEWAY_KEY_CMD");

if (!identity || !gatewayUrl || !keyCommand) {
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
  workspace,
  keyCommand,
  cursorPath: env("CODEX_GATEWAY_CURSOR_PATH"),
  intervalMs: numberEnv("CODEX_GATEWAY_POLL_INTERVAL_MS"),
  limit: numberEnv("CODEX_GATEWAY_POLL_LIMIT"),
  autoReply: env("CODEX_GATEWAY_AUTO_REPLY") === "true",
  replyTarget: env("CODEX_GATEWAY_REPLY_TARGET"),
  signal: abort.signal,
});

function env(...names: string[]): string | undefined {
  for (const name of names) {
    // biome-ignore lint/style/noProcessEnv: this CLI is configured by launch-time environment.
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function numberEnv(name: string): number | undefined {
  const value = env(name);
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
