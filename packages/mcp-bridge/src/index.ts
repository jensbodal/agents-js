/**
 * @agents-js/mcp-bridge — MCP server that exposes A2A agents as MCP tools.
 *
 * Public API barrel. The CLI entry point lives in `./cli.ts`.
 */

export type { DiscoveryEntry, DiscoveryEntrySource, SearchOptions } from "./discovery.ts";
export { DiscoveryIndex } from "./discovery.ts";
export { bridgeConfigFromRegistry } from "./registry-adapter.ts";
export type { AgentEndpoint, BridgeConfig } from "./server.ts";
export { createBridgeServer } from "./server.ts";
