#!/usr/bin/env bun

/**
 * CLI entrypoint for the MCP bus bridge.
 *
 * Designed to be spawned by an MCP client (Claude Code, Claude
 * Desktop) as a stdio subprocess. The client speaks JSON-RPC over
 * stdin/stdout; this process subscribes to the gateway bus and
 * dispatches each event as a server-initiated notification.
 *
 * Example MCP client config (Claude Code):
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "gateway-bus": {
 *       "command": "bun",
 *       "args": ["/path/to/packages/mcp-bus-bridge/src/bin.ts"],
 *       "env": {
 *         "GATEWAY_BUS_URL": "http://localhost:8080",
 *         "GATEWAY_BUS_FILTER": "gateway.matrix.,gateway.audit."
 *       }
 *     }
 *   }
 * }
 * ```
 */

import { runMcpBusBridge } from "./bridge.ts";
import { resolveBridgeConfigFromEnv } from "./env.ts";

async function main(): Promise<void> {
  const config = resolveBridgeConfigFromEnv(Bun.env);

  // SIGINT / SIGTERM trigger graceful shutdown: subscriber loop sees
  // the abort, closes the SSE reader, then runMcpBusBridge closes
  // the MCP transport on the way out.
  const controller = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => controller.abort());
  }

  await runMcpBusBridge({
    config,
    serverInfo: { name: "@agents-js/mcp-bus-bridge", version: "0.4.0" },
    signal: controller.signal,
  });
}

main().catch((err) => {
  console.error("[mcp-bus-bridge] fatal", err);
  process.exit(1);
});
