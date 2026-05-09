import {
  createSharedAgentRegistry,
  resolveSharedAgentRegistryPath,
} from "@agents-js/a2a-client/node";
import type { AgentEndpoint, BridgeConfig } from "./server.ts";

/**
 * Build a {@link BridgeConfig} from the shared agent registry file.
 *
 * Reads the registry at the given path (or the default
 * `~/.agents-js/registry.json` / `$AGENTS_JS_REGISTRY`), maps every A2A
 * entry to an {@link AgentEndpoint}, and returns the result.
 *
 * `kind: "acp"` entries are silently skipped — the MCP bridge only
 * exposes A2A-addressable agents as MCP tools; ACP-spawn entries are
 * handled elsewhere (see Commit D2).
 *
 * Returns `{ agents: [] }` when the file is missing, unreadable, or empty.
 * Never throws.
 */
export async function bridgeConfigFromRegistry(registryPath?: string): Promise<BridgeConfig> {
  const resolvedPath = registryPath ?? resolveSharedAgentRegistryPath();
  const registry = createSharedAgentRegistry({ configPath: resolvedPath });
  const agents = await registry.list();
  const endpoints: AgentEndpoint[] = [];
  for (const agent of agents) {
    if (agent.kind !== "a2a") {
      console.debug(
        `[mcp-bridge] Skipping non-A2A agent "${agent.name}" (kind=${agent.kind}) — MCP bridge only exposes A2A targets.`,
      );
      continue;
    }
    endpoints.push({ name: agent.name, url: agent.url });
  }
  return { agents: endpoints };
}
