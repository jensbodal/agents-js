import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";

export type PermissionLifetime = "once" | "session" | "persistent";

export interface PermissionDecision {
  response: RequestPermissionResponse;
  remember: PermissionLifetime;
}

export interface WorkspaceContext {
  summary: string;
  openFiles: Array<{ path: string; name: string; basename: string }>;
}

export interface WorkspaceContextProvider {
  getContext(): Promise<WorkspaceContext> | WorkspaceContext;
}

export interface IntegrationStatus {
  capabilityKey: string;
  displayName: string;
  description: string;
  available: boolean;
  api: unknown;
}

/**
 * Registry for querying host-provided integrations and capabilities at runtime.
 *
 * This is an **Adapter** interface that host platforms can implement to
 * advertise available services (MCP servers, external APIs, feature flags)
 * to the session controller and its adapters. The controller can conditionally
 * enable features based on what the registry reports as available.
 *
 * @example
 * ```ts ignore
 * const registry: DependencyRegistry = {
 *   isAvailable: (key) => key === "mcp-server",
 *   getApi: (key) => key === "mcp-server" ? mcpApi : undefined,
 *   getAllStatuses: () => [{ capabilityKey: "mcp-server", ... }],
 *   onChange: (listener) => { ... },
 * };
 * ```
 */
export interface DependencyRegistry {
  /** Check whether a capability is currently available. */
  isAvailable(capabilityKey: string): boolean;
  /** Get the API object for a capability, or undefined if not available. */
  getApi(capabilityKey: string): unknown;
  /** List all registered capabilities and their current availability. */
  getAllStatuses(): IntegrationStatus[];
  /** Subscribe to capability availability changes. Returns an unsubscribe function. */
  onChange(listener: (event: { capabilityKey: string; available: boolean }) => void): () => void;
}
