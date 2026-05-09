import path from "node:path";
import type { RuntimeProfile } from "./types.ts";

/**
 * Minimal config shape used by {@link findConfiguredProfile}. Mirrors the
 * `profiles` field of the `agents-js` config object so this package
 * doesn't depend on `@agents-js/gateway-runtime`'s config schema.
 *
 * Callers typically pass an `AgentsJsConfig` directly — the structural
 * shape is compatible.
 *
 * @internal
 */
export interface ProfilesContainer {
  profiles?: Record<string, RuntimeProfile>;
}

/** @internal */
export interface ConfiguredProfile {
  profile: RuntimeProfile;
  profilesRoot: string;
  source: "project" | "user";
}

/** @internal */
export interface ProfileLookupContext {
  /** Path to the user-scope agents-js config.json. */
  userConfigPath: string;
  /** Path to the project-scope agents-js config.json. */
  projectConfigPath: string;
  projectConfig?: ProfilesContainer;
  userConfig?: ProfilesContainer;
}

/**
 * Convention: profiles for a given config live alongside it in a
 * sibling `profiles` directory. e.g. for
 * `~/.config/agents-js/config.json` the profiles root is
 * `~/.config/agents-js/profiles/`.
 */
function profilesRootForConfig(configPath: string): string {
  return path.join(path.dirname(configPath), "profiles");
}

/**
 * Look up a configured profile by name. Project scope wins over user
 * scope, matching the rest of the agents-js config layering. Returns
 * `undefined` if no scope contains the requested profile.
 *
 * @internal
 */
export function findConfiguredProfile(
  profileName: string,
  context: ProfileLookupContext,
): ConfiguredProfile | undefined {
  const projectProfile = context.projectConfig?.profiles?.[profileName];
  if (projectProfile) {
    return {
      profile: projectProfile,
      profilesRoot: profilesRootForConfig(context.projectConfigPath),
      source: "project",
    };
  }

  const userProfile = context.userConfig?.profiles?.[profileName];
  if (userProfile) {
    return {
      profile: userProfile,
      profilesRoot: profilesRootForConfig(context.userConfigPath),
      source: "user",
    };
  }

  return undefined;
}
