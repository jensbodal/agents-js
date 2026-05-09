import type { AgentsJsConfig, AgentsJsConfigPaths } from "./config.ts";
import { findConfiguredProfile } from "./profiles/lookup.ts";
import { validateGatewayRuntimeProfileName } from "./runtimes.ts";
import type {
  GatewayRuntimeId,
  GatewayRuntimeProfile,
  GatewayRuntimeSelection,
} from "./runtimes-registry.ts";

export interface RuntimeSelectionArgs {
  acpArgsJson?: string;
  acpCommand?: string;
  harness?: string;
  profile?: string;
}

export interface ProfileLookupContext {
  configPaths: AgentsJsConfigPaths;
  projectConfig?: AgentsJsConfig;
  userConfig?: AgentsJsConfig;
}

export function parseCustomArgsJson(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("[agents-js] --acp-args-json must be a JSON array of strings.");
  }
  return [...parsed];
}

export function createRuntimeSelectionFromArgs(
  args: RuntimeSelectionArgs,
): GatewayRuntimeSelection | undefined {
  const profile = args.profile ? validateGatewayRuntimeProfileName(args.profile) : undefined;

  if (!args.harness && !args.acpCommand) {
    return undefined;
  }

  if (args.acpCommand && args.harness && args.harness !== "custom") {
    throw new Error(
      "[agents-js] --acp-command can only be used with --harness custom (or without --harness).",
    );
  }

  if (args.acpCommand) {
    if (profile) {
      throw new Error("[agents-js] --profile is only supported with curated harnesses.");
    }
    return {
      kind: "custom",
      command: args.acpCommand,
      args: parseCustomArgsJson(args.acpArgsJson),
      displayName: "Custom ACP Runtime",
      description: "Operator-selected custom ACP runtime.",
    };
  }

  if (!args.harness) {
    return undefined;
  }

  if (args.harness === "custom") {
    if (profile) {
      throw new Error("[agents-js] --profile is not supported with --harness custom.");
    }
    throw new Error("[agents-js] --harness custom also requires --acp-command.");
  }

  return {
    kind: "curated",
    profile,
    runtime: args.harness as GatewayRuntimeId,
  };
}

/**
 * Wraps the internal profile lookup in the gateway-runtime config-paths shape
 * so existing callers do not have to unpack
 * `loaded.configPaths.{user,project}ConfigPath` themselves. The returned
 * profile is narrowed back to {@link GatewayRuntimeProfile}.
 */
export function getConfiguredProfile(
  profileName: string,
  loaded: ProfileLookupContext,
):
  | {
      profile: GatewayRuntimeProfile;
      profilesRoot: string;
      source: "project" | "user";
    }
  | undefined {
  const result = findConfiguredProfile(profileName, {
    userConfigPath: loaded.configPaths.userConfigPath,
    projectConfigPath: loaded.configPaths.projectConfigPath,
    projectConfig: loaded.projectConfig,
    userConfig: loaded.userConfig,
  });

  if (!result) {
    return undefined;
  }

  return {
    profile: result.profile as GatewayRuntimeProfile,
    profilesRoot: result.profilesRoot,
    source: result.source,
  };
}
