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
 * Multi-harness arg shape (AJS-7 PR1). `harnesses` carries the
 * ordered list of curated harness ids gathered from `--harness`
 * (repeatable) and `--harnesses x,y` flags; index 0 is the primary
 * routing target. Other fields mirror {@link RuntimeSelectionArgs}.
 *
 * Single-harness invocations pass a 1-element `harnesses` array (or a
 * `harness` string, which {@link createRuntimeSelectionsFromArgs}
 * lifts into a 1-element list).
 */
export interface RuntimeSelectionsArgs {
  acpArgsJson?: string;
  acpCommand?: string;
  /** Multi-harness list, index 0 = primary. Mutually exclusive with `harness`. */
  harnesses?: readonly string[];
  /** Legacy single-harness form; equivalent to `harnesses: [harness]`. */
  harness?: string;
  profile?: string;
}

/**
 * Build an ordered list of {@link GatewayRuntimeSelection} from CLI
 * args. Returns `undefined` when no harness was specified (caller
 * falls through to interactive prompt or default).
 *
 * Single-harness invocations (`--harness x` or `harnesses: ["x"]`)
 * produce a 1-element list — byte-identical to the pre-AJS-7
 * single-harness path when consumers use `selections[0]` as the
 * primary.
 *
 * Multi-harness invocations (`--harnesses a,b,c`) produce an N-element
 * list with `a` as the primary. Duplicates are preserved here so the
 * downstream validation layer can reject them with a precise error
 * message; this function intentionally does not silently dedupe.
 *
 * AJS-7 PR1 ships only the data-structure plumbing; downstream
 * consumers in PR1 use `selections[0]` and ignore the rest. PR2 wires
 * lazy-spawned secondary lanes against the remaining entries.
 */
export function createRuntimeSelectionsFromArgs(
  args: RuntimeSelectionsArgs,
): GatewayRuntimeSelection[] | undefined {
  if (args.harnesses !== undefined && args.harnesses.length > 0 && args.harness !== undefined) {
    throw new Error(
      "[agents-js] Pass --harness or --harnesses, not both shapes simultaneously. Repeat --harness or use a comma-separated --harnesses value.",
    );
  }

  const harnessList: readonly string[] =
    args.harnesses && args.harnesses.length > 0
      ? args.harnesses
      : args.harness
        ? [args.harness]
        : [];

  if (harnessList.length === 0 && !args.acpCommand) {
    return undefined;
  }

  // Custom-command path is single-harness by construction; multiple
  // harness ids alongside --acp-command is incoherent.
  if (args.acpCommand && harnessList.length > 1) {
    throw new Error("[agents-js] --acp-command is only valid with a single harness selection.");
  }

  if (args.acpCommand) {
    const single = createRuntimeSelectionFromArgs({
      acpCommand: args.acpCommand,
      acpArgsJson: args.acpArgsJson,
      harness: harnessList[0],
      profile: args.profile,
    });
    return single ? [single] : undefined;
  }

  const selections: GatewayRuntimeSelection[] = [];
  for (const harness of harnessList) {
    const selection = createRuntimeSelectionFromArgs({
      harness,
      profile: args.profile,
    });
    if (selection !== undefined) selections.push(selection);
  }
  return selections.length > 0 ? selections : undefined;
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
