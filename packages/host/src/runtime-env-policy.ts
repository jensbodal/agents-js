import type { HostEnvPolicyInput } from "@agents-js/acp-host";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";

/**
 * Baseline secret keys forwarded to every ACP runtime regardless of harness.
 *
 * **Empty by design.** Earlier revisions forwarded `ANTHROPIC_API_KEY` and
 * `MATRIX_ACCESS_TOKEN` to every runtime as a convenience, but that gave
 * any harness — including ones that have no business reading those keys —
 * implicit access to their values. Each harness now declares only the
 * env keys it legitimately needs via `authEnvKeys` on its
 * `GatewayRuntimeDefinition`.
 *
 * This export is retained as `readonly string[]` (rather than `[]`) so
 * the release-preflight guard can assert the array is empty without
 * changing its import surface.
 */
export const BASELINE_AGENT_SECRET_ENV_KEYS: readonly string[] = Object.freeze([]);

/**
 * Build the {@link HostEnvPolicyInput} for the gateway host. With no
 * baseline keys, the policy is exactly the runtime's declared
 * `authEnvKeys` (or empty when the runtime declares none). The host has
 * the harness identity in scope here, so it owns this composition;
 * `@agents-js/acp-host` itself stays harness-agnostic.
 */
export function buildHostRuntimeEnvPolicy(runtime: ResolvedGatewayRuntime): HostEnvPolicyInput {
  const authEnvKeys = runtime.definition.authEnvKeys ?? [];
  return { agentSecretEnvKeys: [...authEnvKeys] };
}
