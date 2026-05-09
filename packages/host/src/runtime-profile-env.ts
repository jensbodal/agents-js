import {
  applyGatewayRuntimeProfile,
  type GatewayRuntimeId,
  getConfiguredProfile,
  listGatewayRuntimeIds,
  type loadAgentsJsConfig,
  type ResolvedGatewayRuntime,
  resolveGatewayRuntimeProfile,
} from "@agents-js/gateway-runtime";

export const E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV = "AJS_E2E_RUNTIME_PROFILE_CONFIG_HOME";
export const E2E_RUNTIME_PROFILE_DATA_HOME_ENV = "AJS_E2E_RUNTIME_PROFILE_DATA_HOME";
export const E2E_RUNTIME_PROFILE_PREFIX_ENV = "AJS_E2E_RUNTIME_PROFILE_PREFIX";
export const E2E_RUNTIME_PROFILE_RUNTIMES_ENV = "AJS_E2E_RUNTIME_PROFILE_RUNTIMES";
export const E2E_RUNTIME_PROFILE_STATE_HOME_ENV = "AJS_E2E_RUNTIME_PROFILE_STATE_HOME";

export const CURATED_RUNTIME_IDS = new Set(listGatewayRuntimeIds());

export function buildRuntimeProfileConfigEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const configHome = env[E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV]?.trim();
  if (!configHome) {
    return env;
  }

  return {
    ...env,
    XDG_CONFIG_HOME: configHome,
  };
}

export function getEnvRuntimeProfileName(
  runtimeId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const profilePrefix = env[E2E_RUNTIME_PROFILE_PREFIX_ENV]?.trim();
  const isolatedRuntimeIds = env[E2E_RUNTIME_PROFILE_RUNTIMES_ENV]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!profilePrefix || !CURATED_RUNTIME_IDS.has(runtimeId as GatewayRuntimeId)) {
    return null;
  }
  if (isolatedRuntimeIds?.length && !isolatedRuntimeIds.includes(runtimeId)) {
    return null;
  }

  return `${profilePrefix}-${runtimeId}`;
}

export function applyEnvRuntimeProfile(
  runtime: ResolvedGatewayRuntime,
  loadedConfig: Awaited<ReturnType<typeof loadAgentsJsConfig>>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedGatewayRuntime {
  const profileName = getEnvRuntimeProfileName(runtime.definition.id, env);
  if (!profileName) {
    return runtime;
  }

  const configuredProfile = getConfiguredProfile(profileName, {
    configPaths: loadedConfig.paths,
    projectConfig: loadedConfig.projectConfig,
    userConfig: loadedConfig.userConfig,
  });
  if (!configuredProfile) {
    throw new Error(
      `[Gateway] Missing ephemeral runtime profile "${profileName}" for runtime "${runtime.definition.id}".`,
    );
  }

  return applyGatewayRuntimeProfile(
    runtime,
    resolveGatewayRuntimeProfile(
      profileName,
      configuredProfile.profile,
      configuredProfile.profilesRoot,
    ),
  );
}
