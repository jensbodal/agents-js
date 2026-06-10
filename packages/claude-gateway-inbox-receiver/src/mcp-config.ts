import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ClaudeGatewayMcpConfigOptions {
  readonly path: string;
  readonly identity: string;
  readonly gatewayUrl: string;
  readonly keyCommand: string;
  readonly fetchMode?: string;
  readonly command?: string;
  readonly args?: readonly string[];
}

export interface ClaudeGatewayMcpConfig {
  readonly mcpServers: {
    readonly agents_gateway: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    };
  };
}

export function buildClaudeGatewayMcpConfig(
  options: ClaudeGatewayMcpConfigOptions,
): ClaudeGatewayMcpConfig {
  const env: Record<string, string> = {
    AGENTS_GATEWAY_DEFAULT_IDENTITY: options.identity,
    AGENTS_GATEWAY_URL: options.gatewayUrl,
    AGENTS_GATEWAY_KEY_CMD: options.keyCommand,
  };
  if (options.fetchMode) env.AGENTS_GATEWAY_FETCH = options.fetchMode;
  return {
    mcpServers: {
      agents_gateway: {
        command: options.command ?? "agents-js",
        args: options.args ?? ["claude-receiver-mcp-send"],
        env,
      },
    },
  };
}

export async function writeClaudeGatewayMcpConfig(
  options: ClaudeGatewayMcpConfigOptions,
): Promise<void> {
  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(
    options.path,
    `${JSON.stringify(buildClaudeGatewayMcpConfig(options), null, 2)}\n`,
    "utf8",
  );
}
