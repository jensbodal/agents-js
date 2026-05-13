/**
 * MCP server wrapper that turns bus events into server-initiated
 * notifications.
 *
 * Holds an MCP `Server` (low-level — `McpServer` is the high-level
 * tool-registering API; we only need the notification side). Each
 * call to {@link McpBusBridgeServer.dispatchNotification} forwards
 * the frame to the attached transport.
 *
 * stdio is the v1 transport: Claude Code spawns the bridge as a
 * subprocess, so there is exactly one MCP client per process and the
 * transport is `process.stdin`/`process.stdout`. HTTP+SSE transport
 * is deferred to v2.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpNotification } from "./event-mapper.ts";

/** Options for {@link createMcpBusBridgeServer}. */
export interface CreateMcpBusBridgeServerOptions {
  /** Server identity advertised on the MCP `initialize` handshake. */
  serverInfo: { name: string; version: string };
}

/** Handle returned from {@link createMcpBusBridgeServer}. */
export interface McpBusBridgeServer {
  /** Connect to the supplied transport. Default: stdio. */
  connect(transport?: Transport): Promise<void>;
  /** Dispatch a notification to the attached transport. */
  dispatchNotification(notification: McpNotification): Promise<void>;
  /** Close the transport and release resources. */
  close(): Promise<void>;
}

/**
 * Build the MCP bridge server. Caller invokes `connect()` to attach
 * a transport, then `dispatchNotification(...)` for every bus event
 * that passes the bridge filter.
 */
export function createMcpBusBridgeServer(
  options: CreateMcpBusBridgeServerOptions,
): McpBusBridgeServer {
  const server = new Server(options.serverInfo, {
    capabilities: {
      // No tools, no resources, no prompts — this bridge is
      // notification-emit-only. Capabilities object is intentionally
      // empty; clients still receive notifications on whichever
      // method namespace the event mapper produces.
    },
  });

  let connected = false;

  return {
    async connect(transport?: Transport): Promise<void> {
      if (connected) return;
      const actual = transport ?? new StdioServerTransport();
      await server.connect(actual);
      connected = true;
    },
    async dispatchNotification(notification: McpNotification): Promise<void> {
      if (!connected) {
        throw new Error(
          "createMcpBusBridgeServer.dispatchNotification: connect() must be called first",
        );
      }
      // Send a one-way JSON-RPC notification — the Protocol layer
      // serializes it without an `id` field, which is what the MCP
      // client uses to route it through its notification handler.
      await server.notification(notification);
    },
    async close(): Promise<void> {
      if (!connected) return;
      await server.close();
      connected = false;
    },
  };
}
