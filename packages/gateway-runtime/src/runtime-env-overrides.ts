/**
 * runtime-env-overrides.ts — Apply CLI-flag overrides onto a process env bag.
 *
 * The gateway runtime helpers (`resolveRuntimeArgs`, `internal-gateway` config
 * loader, etc.) read AJS_* environment variables at resolution time. When a
 * CLI subcommand accepts equivalent flags (e.g. `--runtime-log-level`,
 * `--default-model`), we want the flag value to take precedence over any
 * pre-existing env var, which in turn takes precedence over the default.
 *
 * Precedence: CLI flag (overrides.*) > env var (base) > default.
 *
 * This helper returns a shallow copy of `base` with the override keys set only
 * when explicitly provided. Callers pass the merged bag downstream — typically
 * by assigning it back into `process.env` before invoking
 * `resolveGatewayRuntimeSelection`, which reads `process.env` via
 * `resolveRuntimeArgs`.
 */

export interface RuntimeEnvOverrides {
  disableExternalPlugins?: boolean;
  runtimeLogLevel?: string;
  defaultHarness?: string;
  defaultModel?: string;
}

export function mergeRuntimeEnvOverrides(
  base: NodeJS.ProcessEnv,
  overrides: RuntimeEnvOverrides,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...base };

  if (overrides.disableExternalPlugins !== undefined) {
    merged.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS = overrides.disableExternalPlugins ? "1" : "0";
  }

  if (overrides.runtimeLogLevel !== undefined) {
    merged.AJS_RUNTIME_LOG_LEVEL = overrides.runtimeLogLevel;
  }

  if (overrides.defaultHarness !== undefined) {
    merged.AJS_DEFAULT_HARNESS = overrides.defaultHarness;
  }

  if (overrides.defaultModel !== undefined) {
    merged.AJS_DEFAULT_MODEL = overrides.defaultModel;
  }

  return merged;
}

const MANAGED_KEYS = [
  "AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS",
  "AJS_RUNTIME_LOG_LEVEL",
  "AJS_DEFAULT_HARNESS",
  "AJS_DEFAULT_MODEL",
] as const;

/**
 * Apply merged overrides back into `process.env` so downstream helpers that
 * read `process.env` directly (e.g. `resolveRuntimeArgs`) observe the merged
 * values. Returns a restore function that reverts the mutated keys to their
 * original values — useful for tests.
 */
export function applyRuntimeEnvOverrides(
  target: NodeJS.ProcessEnv,
  overrides: RuntimeEnvOverrides,
): () => void {
  const originals: Partial<Record<(typeof MANAGED_KEYS)[number], string | undefined>> = {};
  for (const key of MANAGED_KEYS) {
    originals[key] = target[key];
  }

  const merged = mergeRuntimeEnvOverrides(target, overrides);
  for (const key of MANAGED_KEYS) {
    const value = merged[key];
    if (value === undefined) {
      delete target[key];
    } else {
      target[key] = value;
    }
  }

  return () => {
    for (const key of MANAGED_KEYS) {
      const original = originals[key];
      if (original === undefined) {
        delete target[key];
      } else {
        target[key] = original;
      }
    }
  };
}
