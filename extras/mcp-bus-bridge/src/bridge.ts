/**
 * Bridge orchestrator: wires the bus subscriber and MCP server
 * together. For each bus event that passes the configured filter,
 * dispatches one MCP notification.
 */

import type { GatewayBusEvent } from "@agents-js/host";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BusSubscriberLogger } from "./bus-subscriber.ts";
import { runBusSubscriber } from "./bus-subscriber.ts";
import type { BridgeConfig } from "./env.ts";
import { mapBusEventToNotification, shouldForwardBusEvent } from "./event-mapper.ts";
import { createMcpBusBridgeServer, type McpBusBridgeServer } from "./mcp-server.ts";

/** Options for {@link runMcpBusBridge}. */
export interface RunMcpBusBridgeOptions {
  /** Resolved bridge config (env-driven; see `./env.ts`). */
  config: BridgeConfig;
  /** Identity advertised on the MCP `initialize` handshake. */
  serverInfo: { name: string; version: string };
  /** AbortSignal that ends the bridge cleanly. */
  signal: AbortSignal;
  /** Optional logger. Defaults to `console`. */
  logger?: BusSubscriberLogger;
  /**
   * Optional MCP transport override (for tests). Defaults to the
   * MCP server's built-in stdio transport.
   */
  transport?: Transport;
  /**
   * Optional pre-built bridge server (for tests). When supplied,
   * `serverInfo` is ignored.
   */
  server?: McpBusBridgeServer;
  /** Optional fetch override (forwarded to the bus subscriber). */
  fetchImpl?: typeof fetch;
  /** Optional sleep override (forwarded to the bus subscriber). */
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Start the bridge. Returns when `signal` aborts. Always closes the
 * MCP server before returning, including on error paths.
 */
export async function runMcpBusBridge(options: RunMcpBusBridgeOptions): Promise<void> {
  const logger = options.logger ?? console;
  const server = options.server ?? createMcpBusBridgeServer({ serverInfo: options.serverInfo });

  await server.connect(options.transport);

  const onEvent = async (event: GatewayBusEvent<unknown>): Promise<void> => {
    if (!shouldForwardBusEvent(event, options.config.filterPrefixes)) return;
    try {
      await server.dispatchNotification(mapBusEventToNotification(event));
    } catch (err) {
      logger.warn("[mcp-bus-bridge] dispatch failed", {
        error: err instanceof Error ? err.message : String(err),
        eventId: event.id,
        eventType: event.type,
      });
    }
  };

  try {
    // Join gatewayUrl + subscribePath safely: strip trailing slashes
    // from the host portion, then ensure the path starts with a
    // single leading slash. Without this, a path supplied without a
    // leading slash collapses into the hostname (e.g. `http://gw.local`
    // + `events` would yield `http://gw.localevents`).
    const host = options.config.gatewayUrl.replace(/\/+$/, "");
    const path = options.config.subscribePath.startsWith("/")
      ? options.config.subscribePath
      : `/${options.config.subscribePath}`;
    const subscribeUrl = `${host}${path}`;
    await runBusSubscriber({
      url: subscribeUrl,
      onEvent,
      signal: options.signal,
      reconnectMinMs: options.config.reconnectMinMs,
      reconnectMaxMs: options.config.reconnectMaxMs,
      logger,
      fetchImpl: options.fetchImpl,
      sleepImpl: options.sleepImpl,
    });
  } finally {
    await server.close();
  }
}
