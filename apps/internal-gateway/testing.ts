/**
 * Test helpers for the `@agents-js/gateway` agents-MCP mount.
 *
 * Lives in the gateway app (not `@agents-js/host/testing`) because
 * {@link AgentsMcpEnvConfig} is owned by this app and `@agents-js/gateway`
 * depends on `@agents-js/host` — putting it in host would invert the layer
 * and create a dependency cycle. Both the gateway's own mount test and the
 * `examples/mint-redeem-smoke` learning test import it from here so there is
 * a single source for the base config builder.
 */
import type { AgentsMcpEnvConfig } from "./agents-mcp-mount.ts";

const DEFAULT_SIGNING_KEY = new TextEncoder().encode("test-signing-key-32bytes-or-more-abcdef");

/**
 * Minimal {@link AgentsMcpEnvConfig} for mounting the agents-MCP handler in
 * tests. Sensible defaults for every field; callers override the dimensions
 * their test cares about (`signingKey`, `issuer`, `audience`, `targets`, ...).
 */
export function createTestAgentsMcpConfig(
  overrides: Partial<AgentsMcpEnvConfig> = {},
): AgentsMcpEnvConfig {
  return {
    signingKey: DEFAULT_SIGNING_KEY,
    issuer: "test-gateway",
    audience: "agents-js-mcp",
    sendScript: "/unused-in-tests",
    targets: {},
    jwtTtlSeconds: 900,
    ...overrides,
  };
}
