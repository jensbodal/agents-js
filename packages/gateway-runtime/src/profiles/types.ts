/**
 * XDG-aligned root directories for a runtime profile. Each entry redirects
 * a single XDG base-directory variable (or `HOME`) when the profile's env
 * is materialized. Omitted entries fall back to defaults derived from the
 * profile's base directory (`<profilesRoot>/<runtime>/<name>/...`).
 *
 * @internal
 */
export interface RuntimeProfileRoots {
  cache?: string;
  config?: string;
  data?: string;
  home?: string;
  state?: string;
}

/**
 * On-disk profile definition. Stored under the `profiles` key in the
 * agents-js config (user or project scope). The `runtime` field is the
 * harness id this profile targets (e.g. `"opencode"`, `"claude"`).
 *
 * The `runtime` field is intentionally typed as `string` here so this
 * package has zero dependencies on the curated runtime registry. Callers
 * that own a stricter `RuntimeId` union (e.g. `@agents-js/gateway-runtime`)
 * may narrow on read.
 *
 * @internal
 */
export interface RuntimeProfile {
  args?: string[];
  env?: Record<string, string>;
  roots?: RuntimeProfileRoots;
  runtime: string;
}

/**
 * Output of {@link resolveRuntimeProfile}: the profile's normalized name,
 * the materialized root directories (with defaults filled in), an env
 * record suitable for spawning a child process, and the original
 * definition for downstream merging.
 *
 * @internal
 */
export interface ResolvedRuntimeProfile {
  definition: RuntimeProfile;
  env: Record<string, string>;
  name: string;
  roots: Required<RuntimeProfileRoots>;
}
