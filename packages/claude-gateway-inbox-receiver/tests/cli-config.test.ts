import { describe, expect, test } from "bun:test";
import {
  missingRequiredClaudeReceiverCliEnv,
  readClaudeReceiverCliConfig,
} from "../src/cli-config.ts";

describe("readClaudeReceiverCliConfig", () => {
  test("reads the Claude wake env contract and keeps curl fetch per launcher", () => {
    const config = readClaudeReceiverCliConfig(
      {
        CW_IDENTITY: "hostname-null-claude-0",
        CH_GATEWAY_URL: "https://ajs-gateway.q4m.dev",
        CH_GATEWAY_KEY_CMD: "bash keycmd.sh",
        CH_GATEWAY_FETCH: "curl",
        CW_WORKSPACE: "/work",
        CW_CLAUDE_ARGS: "-p --permission-mode bypassPermissions",
        CW_SENDER_ALLOWLIST: "ajs-claude hostname-null-claude-0",
        CW_POLL_INTERVAL_MS: "15000",
      },
      "/cwd",
    );

    expect(missingRequiredClaudeReceiverCliEnv(config)).toBe(false);
    expect(config.identity).toBe("hostname-null-claude-0");
    expect(config.gatewayUrl).toBe("https://ajs-gateway.q4m.dev");
    expect(config.keyCommand).toBe("bash keycmd.sh");
    expect(config.fetchMode).toBe("curl");
    expect(config.workspace).toBe("/work");
    expect(config.claudeArgs).toEqual(["-p", "--permission-mode", "bypassPermissions"]);
    expect(config.intervalMs).toBe(15000);
    expect(config.mcpConfigPath).toBe("/work/.agents/hostname-null-claude-0/gateway-mcp.json");
  });
});
