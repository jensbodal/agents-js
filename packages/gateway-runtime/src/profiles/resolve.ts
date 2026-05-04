import path from "node:path";
import { validateRuntimeProfileName } from "./name.ts";
import type { ResolvedRuntimeProfile, RuntimeProfile, RuntimeProfileRoots } from "./types.ts";

function ensureStringRecord(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }
  return { ...value };
}

/**
 * Materialize a {@link RuntimeProfile} into a {@link ResolvedRuntimeProfile}.
 *
 * - Validates `profileName` against {@link validateRuntimeProfileName}.
 * - Computes the per-profile base directory at
 *   `<profilesRoot>/<profile.runtime>/<name>` and fills in any unset
 *   {@link RuntimeProfileRoots} entries from that base.
 * - Builds an env record that maps `HOME` and the four `XDG_*_HOME`
 *   variables onto the resolved roots, then layers the profile's `env`
 *   overrides on top so operators can override individual entries.
 *
 * @internal
 */
export function resolveRuntimeProfile(
  profileName: string,
  profile: RuntimeProfile,
  profilesRoot: string,
): ResolvedRuntimeProfile {
  const normalizedName = validateRuntimeProfileName(profileName);
  const baseRoot = path.join(profilesRoot, profile.runtime, normalizedName);
  const roots = {
    home: profile.roots?.home ?? baseRoot,
    config: profile.roots?.config ?? path.join(baseRoot, ".config"),
    data: profile.roots?.data ?? path.join(baseRoot, ".local", "share"),
    state: profile.roots?.state ?? path.join(baseRoot, ".local", "state"),
    cache: profile.roots?.cache ?? path.join(baseRoot, ".cache"),
  } satisfies Required<RuntimeProfileRoots>;

  return {
    definition: {
      runtime: profile.runtime,
      args: profile.args ? [...profile.args] : undefined,
      env: ensureStringRecord(profile.env),
      roots: { ...profile.roots },
    },
    env: {
      HOME: roots.home,
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      ...ensureStringRecord(profile.env),
    },
    name: normalizedName,
    roots,
  };
}
