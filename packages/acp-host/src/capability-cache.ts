import type { AgentCapabilities } from "@agentclientprotocol/sdk";

/**
 * Parses and caches agent capabilities from InitializeResponse.
 * Provides boolean helpers for capability-gating UI and behavior.
 *
 * "Advertised" flags reflect what the CLIENT advertises to the agent.
 * These are set by the controller based on what's implemented.
 *
 * Workspace capability flags are tied to whether the local MCP server is
 * actually running -- they are false by default and set to true by the
 * controller when the MCP server URL is available.
 */
export class CapabilityCache {
  private capabilities: AgentCapabilities | null = null;

  // Client-side capability flags (what we advertise to the agent)
  advertisedFileRead = true;
  advertisedFileWrite = true;
  advertisedTerminal = true;

  // Workspace capability flags -- reflect whether the MCP server is running
  // and exposing these tools. Set by the session controller based on
  // actual MCP server availability, not aspirational.
  advertisedWorkspaceSearch = false;
  advertisedCommandExecution = false;
  advertisedNavigation = false;
  advertisedOptionalExtension = false;

  /**
   * Update workspace capability flags based on MCP server state.
   * Called by the session controller when the MCP server URL is known.
   *
   * @param available Whether the MCP server is running
   * @param extensionAvailable Whether an optional extension (e.g., data-query) is available
   */
  setMcpServerAvailable(available: boolean, extensionAvailable: boolean): void {
    this.advertisedWorkspaceSearch = available;
    this.advertisedCommandExecution = available;
    this.advertisedNavigation = available;
    this.advertisedOptionalExtension = available && extensionAvailable;
  }

  update(capabilities: AgentCapabilities | undefined | null): void {
    this.capabilities = capabilities ?? null;
  }

  clear(): void {
    this.capabilities = null;
    this.advertisedWorkspaceSearch = false;
    this.advertisedCommandExecution = false;
    this.advertisedNavigation = false;
    this.advertisedOptionalExtension = false;
  }

  get raw(): AgentCapabilities | null {
    return this.capabilities;
  }

  supportsLoadSession(): boolean {
    return this.capabilities?.loadSession === true;
  }

  supportsListSessions(): boolean {
    return this.capabilities?.sessionCapabilities?.list != null;
  }

  supportsTerminal(): boolean {
    return this.advertisedTerminal;
  }

  supportsFileRead(): boolean {
    return this.advertisedFileRead;
  }

  supportsFileWrite(): boolean {
    return this.advertisedFileWrite;
  }

  supportsMcp(): boolean {
    return this.capabilities?.mcpCapabilities != null;
  }

  supportsEmbeddedContext(): boolean {
    return this.capabilities?.promptCapabilities?.embeddedContext === true;
  }

  supportsCloseSession(): boolean {
    return this.capabilities?.sessionCapabilities?.close != null;
  }

  supportsForkSession(): boolean {
    return this.capabilities?.sessionCapabilities?.fork != null;
  }

  supportsResumeSession(): boolean {
    return this.capabilities?.sessionCapabilities?.resume != null;
  }

  supportsLogout(): boolean {
    return this.capabilities?.auth?.logout != null;
  }

  supportsSetConfigOption(): boolean {
    return this.capabilities?.sessionCapabilities != null;
  }
}
