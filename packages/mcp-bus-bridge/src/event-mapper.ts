/**
 * Pure-function translator: gateway-bus `GatewayBusEvent` → MCP
 * server-initiated JSON-RPC notification frame.
 *
 * The bridge subscribes to the gateway's `/events` SSE endpoint, then
 * for each event constructs an MCP notification and forwards it to
 * every attached MCP client transport. This module owns the wire
 * mapping; the orchestrator handles fan-out + transport plumbing.
 *
 * Server-initiated notifications are JSON-RPC frames with **no `id`**
 * field — clients route them through their notification handler
 * (which a Claude Code harness wires into `appendToNextTurnContext`),
 * not their request/response dispatcher.
 */

import type { GatewayBusEvent } from "@agents-js/host";

/**
 * MCP server-initiated notification frame. Subset of the JSON-RPC
 * notification shape — `method` + `params` only, no `id`. The MCP SDK
 * adds the `jsonrpc: "2.0"` prefix when serializing.
 */
export interface McpNotification {
  method: string;
  params: Record<string, unknown>;
}

/** Options controlling event → notification mapping. */
export interface MapEventToNotificationOptions {
  /**
   * Notification method namespace. The bus event's `type` is appended
   * via the method-name policy (see {@link methodForBusEvent}).
   * Default: `notifications/gateway-bus`.
   */
  methodNamespace?: string;
}

const DEFAULT_METHOD_NAMESPACE = "notifications/gateway-bus";

/**
 * Map a bus event's `type` to an MCP notification method name.
 *
 * Strategy: single method per namespace with the bus topic in
 * `params.type`. This avoids registering a dynamic method-per-topic on
 * the MCP client side; clients add ONE notification handler for the
 * namespace and route on `params.type`.
 *
 * Example: bus event `{ type: "gateway.matrix.event-received", ... }`
 * → notification method `notifications/gateway-bus/event`.
 */
export function methodForBusEvent(options: MapEventToNotificationOptions = {}): string {
  const namespace = options.methodNamespace ?? DEFAULT_METHOD_NAMESPACE;
  return `${namespace}/event`;
}

/**
 * Translate one bus envelope into a notification frame.
 *
 * Optional fields (`sourcePrincipal`, `correlationId`) are only
 * included when present, matching the bus envelope's optional-field
 * convention.
 */
export function mapBusEventToNotification(
  event: GatewayBusEvent<unknown>,
  options: MapEventToNotificationOptions = {},
): McpNotification {
  const params: Record<string, unknown> = {
    id: event.id,
    type: event.type,
    ts: event.ts,
    payload: event.payload,
  };
  if (event.sourcePrincipal !== undefined) {
    params.sourcePrincipal = event.sourcePrincipal;
  }
  if (event.correlationId !== undefined) {
    params.correlationId = event.correlationId;
  }
  return {
    method: methodForBusEvent(options),
    params,
  };
}

/**
 * Filter primitive: caller-supplied topic-prefix list decides which
 * bus events become MCP notifications. `["*"]` (or empty list) means
 * "forward everything"; otherwise an event is forwarded iff its
 * `type` starts with at least one of the prefixes.
 *
 * Filter sits at the bridge boundary, NOT at the gateway. Gateway
 * stays dumb — it sends every event; the bridge drops what its
 * config says to drop.
 */
export function shouldForwardBusEvent(
  event: GatewayBusEvent<unknown>,
  filterPrefixes: string[],
): boolean {
  if (filterPrefixes.length === 0) return true;
  if (filterPrefixes.includes("*")) return true;
  return filterPrefixes.some((prefix) => event.type.startsWith(prefix));
}
