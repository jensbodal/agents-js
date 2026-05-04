/**
 * resolve-and-apply.ts — Shared helper for the CLI subcommands (`acp`, `serve`,
 * `bridge`) that need to:
 *
 *   1. Apply CLI-flag-derived env overrides onto the live process env.
 *   2. Resolve a `GatewayRuntimeSelection` against the runtime registry.
 *   3. Optionally apply a configured runtime profile on top of the result.
 *   4. Always restore the env overrides — even when resolution throws.
 *
 * The three call sites differ in two small ways, both expressed as options:
 *
 *   - bridge has no `--profile` flag, so `profileLookup` is omitted entirely
 *     and the profile-application step is skipped.
 *   - acp tolerates a missing configured profile (silently skips the profile
 *     application), while serve treats it as an invariant violation because
 *     `resolveServeInputs` already created/validated the profile earlier in
 *     the same command. Callers express the desired behavior via
 *     `onMissingProfile: "skip" | "throw"`.
 *
 * Latent design tension (tracked, not yet resolved): this path mutates
 * `process.env` because `resolveRuntimeArgs` in @agents-js/gateway-runtime
 * accepts env implicitly (reads `process.env` inside the hook contract)
 * rather than taking it as an argument. The lower-level programmatic gateway
 * API threads env through explicitly. Converging on the explicit shape would
 * eliminate the apply/restore dance but requires touching every registered
 * `resolveArgs` hook signature at once, so it's deferred to a dedicated pass
 * (not a cross-review cleanup). For now: the mutation is bounded by
 * try/finally, the env keys touched are a known AJS_* allowlist, and
 * concurrent invocations within one process are not supported (which is true
 * for CLI entry points anyway).
 */

import { applyRuntimeEnvOverrides, type RuntimeEnvOverrides } from "./runtime-env-overrides.ts";
import {
  applyGatewayRuntimeProfile,
  resolveGatewayRuntimeProfile,
  resolveGatewayRuntimeSelection,
} from "./runtimes.ts";
import type {
  GatewayRuntimeSelection,
  ResolvedGatewayRuntime,
  RuntimeCommandResolver,
  RuntimeResolutionOptions,
} from "./runtimes-registry.ts";
import { getConfiguredProfile, type ProfileLookupContext } from "./shared-runtime-helpers.ts";

export interface ResolveAndApplyGatewayRuntimeOptions {
  /** Runtime selection to resolve (curated or custom). */
  selection: GatewayRuntimeSelection;
  /** CLI-flag-derived env overrides applied for the duration of resolution. */
  envOverrides: RuntimeEnvOverrides;
  /**
   * Env bag to mutate with overrides (default: `process.env`). The helper
   * always restores the bag before returning, including when the underlying
   * resolution or profile application throws.
   */
  env?: NodeJS.ProcessEnv;
  /** Custom command resolver (for tests / sandboxed installs). */
  resolver?: RuntimeCommandResolver;
  /** Runtime command resolution roots/options supplied by a concrete CLI entrypoint. */
  runtimeResolution?: Omit<RuntimeResolutionOptions, "resolver">;
  /**
   * Profile lookup context. When omitted, profile application is skipped
   * regardless of whether the selection has a `profile` field. Bridge passes
   * `undefined`; acp/serve pass the loaded config paths + parsed configs.
   */
  profileLookup?: ProfileLookupContext;
  /**
   * Behavior when `selection` has a profile but no configured profile is
   * found via `profileLookup`. Defaults to `"skip"` (acp's behavior); serve
   * passes `"throw"` because its earlier setup phase guarantees the profile
   * exists.
   */
  onMissingProfile?: "skip" | "throw";
}

/**
 * Apply env overrides, resolve a runtime selection, optionally apply a
 * configured runtime profile, and restore env. Returns the (optionally
 * profile-merged) `ResolvedGatewayRuntime`.
 *
 * Errors thrown by `resolveGatewayRuntimeSelection`, profile lookup, or
 * `applyGatewayRuntimeProfile` propagate to the caller. The env overrides
 * are restored before the error is rethrown.
 */
export async function resolveAndApplyGatewayRuntime(
  options: ResolveAndApplyGatewayRuntimeOptions,
): Promise<ResolvedGatewayRuntime> {
  const { selection, envOverrides, resolver, profileLookup, runtimeResolution } = options;
  const onMissingProfile = options.onMissingProfile ?? "skip";
  // biome-ignore lint/style/noProcessEnv: CLI-flag override path mutates live env for downstream resolvers (resolveRuntimeArgs reads process.env). See file-level docblock for the latent design tension.
  const env = options.env ?? process.env;

  const restoreEnv = applyRuntimeEnvOverrides(env, envOverrides);

  try {
    let runtime = await resolveGatewayRuntimeSelection(selection, {
      ...runtimeResolution,
      resolver,
    });

    if (selection.kind === "curated" && selection.profile && profileLookup) {
      const configuredProfile = getConfiguredProfile(selection.profile, profileLookup);

      if (!configuredProfile) {
        if (onMissingProfile === "throw") {
          throw new Error(
            `[agents-js] Runtime profile "${selection.profile}" could not be resolved after setup.`,
          );
        }
        // skip: leave runtime as-is.
      } else {
        runtime = applyGatewayRuntimeProfile(
          runtime,
          resolveGatewayRuntimeProfile(
            selection.profile,
            configuredProfile.profile,
            configuredProfile.profilesRoot,
          ),
        );
      }
    }

    return runtime;
  } finally {
    restoreEnv();
  }
}
