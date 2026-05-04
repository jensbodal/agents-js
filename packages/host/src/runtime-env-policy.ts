import type { HostEnvPolicyInput } from "@agents-js/acp-host";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";

/**
 * Baseline secret keys forwarded to every ACP runtime, regardless of which
 * harness is selected. These cover shared infra (`MATRIX_ACCESS_TOKEN`) and
 * the Anthropic default (`ANTHROPIC_API_KEY`) that several SDKs read for
 * out-of-band auth even when the curated harness doesn't declare its own
 * `authEnvKeys`.
 */
export const BASELINE_AGENT_SECRET_ENV_KEYS: readonly string[] = Object.freeze([
  "MATRIX_ACCESS_TOKEN",
  "ANTHROPIC_API_KEY",
]);

/**
 * Build the {@link HostEnvPolicyInput} for the gateway host: baseline
 * secrets plus the per-harness `authEnvKeys` declared on the resolved
 * runtime. The host has the harness identity in scope here, so it owns
 * this composition; `@agents-js/acp-host` itself stays harness-agnostic.
 */
export function buildHostRuntimeEnvPolicy(runtime: ResolvedGatewayRuntime): HostEnvPolicyInput {
  const authEnvKeys = runtime.definition.authEnvKeys ?? [];
  const merged = [...new Set([...BASELINE_AGENT_SECRET_ENV_KEYS, ...authEnvKeys])];
  return { agentSecretEnvKeys: merged };
}
