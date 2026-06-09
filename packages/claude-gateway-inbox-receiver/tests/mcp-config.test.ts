import { describe, expect, test } from "bun:test";
import { buildClaudeGatewayMcpConfig } from "../src/mcp-config.ts";

describe("buildClaudeGatewayMcpConfig", () => {
  test("generates a send-only agents_gateway MCP config with identity derived from CW_IDENTITY", () => {
    const config = buildClaudeGatewayMcpConfig({
      path: "/tmp/gateway-mcp.json",
      identity: "hostname-null-claude-0",
      gatewayUrl: "https://ajs-gateway.q4m.dev",
      keyCommand: "bash ~/.config/agents-js/keycmd.sh",
      fetchMode: "curl",
    });

    expect(config.mcpServers.agents_gateway.command).toBe("agents-js");
    expect(config.mcpServers.agents_gateway.args).toEqual(["claude-receiver-mcp-send"]);
    expect(config.mcpServers.agents_gateway.env).toEqual({
      AGENTS_GATEWAY_DEFAULT_IDENTITY: "hostname-null-claude-0",
      AGENTS_GATEWAY_URL: "https://ajs-gateway.q4m.dev",
      AGENTS_GATEWAY_KEY_CMD: "bash ~/.config/agents-js/keycmd.sh",
      AGENTS_GATEWAY_FETCH: "curl",
    });
  });
});
