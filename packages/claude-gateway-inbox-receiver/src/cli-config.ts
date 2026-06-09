import { join } from "node:path";
import { selectFetchImpl } from "@agents-js/gateway-inbox-runtime";
import { splitClaudeArgs } from "./claude-runner.ts";
import { parseSenderAllowlist, type SenderAllowlist } from "./sender-allowlist.ts";

export interface ClaudeReceiverCliConfig {
  readonly identity?: string;
  readonly gatewayUrl?: string;
  readonly workspace: string;
  readonly keyCommand?: string;
  readonly cursorPath?: string;
  readonly intervalMs?: number;
  readonly limit?: number;
  readonly fetchMode?: string;
  readonly fetchImpl?: typeof fetch;
  readonly claudeCommand?: string;
  readonly claudeArgs?: readonly string[];
  readonly mcpConfigPath: string;
  readonly mcpCommand?: string;
  readonly mcpArgs?: readonly string[];
  readonly senderAllowlist: SenderAllowlist;
}

export function readClaudeReceiverCliConfig(
  envSource: Record<string, string | undefined>,
  cwd: string,
): ClaudeReceiverCliConfig {
  const env = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = envSource[name];
      if (value) return value;
    }
    return undefined;
  };

  const identity = env("CW_IDENTITY", "CH_GATEWAY_IDENTITY", "AGENTS_GATEWAY_SUB", "MATRIX_AGENT");
  const workspace = env("CW_WORKSPACE", "PWD") ?? cwd;
  const mcpConfigPath =
    env("CW_CLAUDE_MCP_CONFIG") ??
    join(workspace, ".agents", identity ?? "claude", "gateway-mcp.json");
  const fetchMode = env("CH_GATEWAY_FETCH", "AGENTS_GATEWAY_FETCH");

  return {
    identity,
    gatewayUrl: env("CH_GATEWAY_URL", "AGENTS_GATEWAY_URL"),
    workspace,
    keyCommand: env("CH_GATEWAY_KEY_CMD", "AGENTS_GATEWAY_KEY_CMD"),
    cursorPath: env("CW_CURSOR_PATH", "CH_CURSOR_PATH"),
    intervalMs: numberEnv(envSource, "CW_POLL_INTERVAL_MS", "CH_POLL_INTERVAL_MS"),
    limit: numberEnv(envSource, "CW_POLL_LIMIT", "CH_POLL_LIMIT"),
    fetchMode,
    fetchImpl: selectFetchImpl(fetchMode),
    claudeCommand: env("CW_CLAUDE_CMD"),
    // CW_CLAUDE_ARGS is an explicit operator override. Supplying
    // bypassPermissions here is a sandbox-only opt-in, not the default.
    claudeArgs: splitClaudeArgs(env("CW_CLAUDE_ARGS")),
    mcpConfigPath,
    mcpCommand: env("CW_GATEWAY_MCP_COMMAND"),
    mcpArgs: splitClaudeArgs(env("CW_GATEWAY_MCP_ARGS")),
    senderAllowlist: parseSenderAllowlist(env("CW_SENDER_ALLOWLIST")),
  };
}

export function missingRequiredClaudeReceiverCliEnv(config: ClaudeReceiverCliConfig): boolean {
  return !config.identity || !config.gatewayUrl || !config.keyCommand;
}

function numberEnv(
  envSource: Record<string, string | undefined>,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const value = envSource[name];
    if (!value) continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
