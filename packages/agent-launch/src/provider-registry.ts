/**
 * Provider → credential env-var registry. Single source of truth for which
 * secret env keys an agent's LLM provider needs, shared by BOTH launch paths:
 *
 * - standalone `agents-js launch` (this package) derives the keys and lifts them
 *   into the launched agent's exported session env, so a native agent with no
 *   gateway and no `/login` TUI still authenticates from the launch env.
 * - the gateway runtime registry (`@agents-js/gateway-runtime`) imports these to
 *   derive each runtime's `authEnvKeys` fail-closed allowlist.
 *
 * The cred requirement is a property of the PROVIDER, not the harness/runtime: a
 * multi-provider harness (pi: zai|anthropic|…) needs a different key per
 * provider. The registry declares key NAMES only; values come from the
 * environment at launch.
 */

/** Semantic LLM provider an agent authenticates against. */
export type ProviderId = "anthropic" | "openai" | "zai" | "factory" | "google";

/**
 * Provider → credential env-var NAMES. Declared ONCE here. `google` is empty by
 * design — the gemini CLI self-authenticates (OAuth/gcloud) with no env
 * passthrough.
 */
export const PROVIDER_CRED_ENV: Readonly<Record<ProviderId, readonly string[]>> = Object.freeze({
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  zai: ["ZAI_API_KEY"],
  factory: ["FACTORY_API_KEY"],
  google: [],
});

/**
 * Resolve a provider's credential env-key names. Fail-closed: an absent or
 * unrecognized provider yields NO keys (never a wildcard), so a misconfigured
 * provider can only ever NARROW the secret-env surface, never widen it.
 */
export function resolveProviderCredEnvKeys(provider: string | undefined): readonly string[] {
  if (!provider) return [];
  return PROVIDER_CRED_ENV[provider as ProviderId] ?? [];
}
