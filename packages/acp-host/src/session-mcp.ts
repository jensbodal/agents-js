/**
 * MCP server list construction for session creation / loading.
 */
import type { McpServer } from "@agentclientprotocol/sdk";
import type { Logger } from "./logger.ts";

/**
 * Build the list of MCP servers to pass when creating or loading a session.
 */
export function buildMcpServersList(
  mcpServerUrl: string | null,
  mcpServerName: string | null,
  log: Logger,
): McpServer[] {
  const mcpServers: McpServer[] = [];
  if (mcpServerUrl) {
    mcpServers.push({
      type: "http" as const,
      name: mcpServerName ?? "workspace",
      url: mcpServerUrl,
      headers: [],
    });
    log.info("Including MCP server in session", { url: mcpServerUrl });
  }
  return mcpServers;
}
