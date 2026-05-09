import type { GatewayCardInput } from "@agents-js/a2a";
import { validateRuntimeProfileName } from "./profiles/name.ts";
import { resolveRuntimeProfile as resolveRuntimeProfileImpl } from "./profiles/resolve.ts";
import {
  defaultRuntimeCommandResolver,
  resolveExistingCommandPath,
  resolveGatewayRuntimeCommand,
} from "./runtime-command-resolution.ts";
import {
  GATEWAY_RUNTIME_REGISTRY,
  type GatewayRuntimeDefinition,
  type GatewayRuntimeId,
  type GatewayRuntimeProfile,
  type GatewayRuntimeSelection,
  MOCK_ACP_RUNTIME_ENV,
  type ResolvedGatewayRuntime,
  type ResolvedGatewayRuntimeProfile,
  type RuntimeResolutionOptions,
} from "./runtimes-registry.ts";

function makeRuntimeAgentCard(definition: GatewayRuntimeDefinition): GatewayCardInput {
  return {
    name: "universal-acp-gateway",
    description: `Standardized A2A interface for ${definition.displayName}`,
    capabilities: {
      "text-to-text": {},
    },
  };
}

function makeCustomRuntimeSelectionError(command: string): Error {
  return new Error(
    `[Gateway] Custom runtime could not resolve executable "${command}". Provide an absolute path or install it on PATH.`,
  );
}

export function listGatewayRuntimeIds(): GatewayRuntimeId[] {
  const allIds = Object.keys(GATEWAY_RUNTIME_REGISTRY) as GatewayRuntimeId[];
  // biome-ignore lint/style/noProcessEnv: mock-acp guard reads live process env at listing time.
  if (process.env[MOCK_ACP_RUNTIME_ENV] !== "1") {
    return allIds.filter((id) => id !== "mock-acp");
  }
  return allIds;
}

export function getGatewayRuntimeDefinition(runtimeId: string): GatewayRuntimeDefinition {
  const definition = GATEWAY_RUNTIME_REGISTRY[runtimeId as GatewayRuntimeId];
  if (!definition) {
    throw new Error(
      `[Gateway] Unknown runtime "${runtimeId}". Supported runtimes: ${listGatewayRuntimeIds().join(", ")}`,
    );
  }
  return definition;
}

/**
 * Re-export of {@link validateRuntimeProfileName} from the internal profile
 * resolver. The gateway-runtime alias is preserved for callers that import
 * via this package's barrel.
 */
export const validateGatewayRuntimeProfileName = validateRuntimeProfileName;

/**
 * Materialize a {@link GatewayRuntimeProfile} via the internal profile
 * resolver.
 * The narrower {@link GatewayRuntimeId} is preserved on the returned
 * {@link ResolvedGatewayRuntimeProfile}.
 */
export function resolveGatewayRuntimeProfile(
  profileName: string,
  profile: GatewayRuntimeProfile,
  profilesRoot: string,
): ResolvedGatewayRuntimeProfile {
  const resolved = resolveRuntimeProfileImpl(profileName, profile, profilesRoot);
  return resolved as ResolvedGatewayRuntimeProfile;
}

export function applyGatewayRuntimeProfile(
  runtime: ResolvedGatewayRuntime,
  profile: ResolvedGatewayRuntimeProfile,
): ResolvedGatewayRuntime {
  if (runtime.definition.id !== profile.definition.runtime) {
    throw new Error(
      `[agents-js] Runtime profile "${profile.name}" targets "${profile.definition.runtime}" but the selected harness is "${runtime.definition.id}".`,
    );
  }

  return {
    ...runtime,
    acp: {
      ...runtime.acp,
      args: [...(runtime.acp.args ?? []), ...(profile.definition.args ?? [])],
      env: {
        ...(runtime.acp.env ?? {}),
        ...profile.env,
      },
    },
  };
}

/**
 * Resolve the runtime argv for a curated definition, honoring env-based
 * overrides.
 */
export function resolveRuntimeArgs(
  definition: GatewayRuntimeDefinition,
  env: Record<string, string | undefined> = defaultRuntimeArgsEnv(),
): string[] {
  const baseArgs = [...definition.args];

  if (definition.resolveArgs) {
    return definition.resolveArgs({ baseArgs, env });
  }

  return baseArgs;
}

function defaultRuntimeArgsEnv(): Record<string, string | undefined> {
  // biome-ignore lint/style/noProcessEnv: intentionally reads the live process environment for the Node entrypoint.
  return process.env;
}

export async function resolveGatewayRuntime(
  runtimeId: string,
  options: RuntimeResolutionOptions = {},
): Promise<ResolvedGatewayRuntime> {
  const definition = getGatewayRuntimeDefinition(runtimeId);
  const command = await resolveGatewayRuntimeCommand(definition, options);
  const env = definition.defaultEnv ? { ...definition.defaultEnv } : undefined;

  return {
    definition,
    acp: {
      command,
      args: resolveRuntimeArgs(definition),
      workspaceFlag: definition.workspaceFlag,
      ...(env ? { env } : {}),
      ...(runtimeId === "opencode" ? { autoRecoverOpencodeDefaultAgent: true } : {}),
    },
    agentCard: makeRuntimeAgentCard(definition),
  };
}

export async function resolveGatewayRuntimeSelection(
  selection: GatewayRuntimeSelection,
  options: RuntimeResolutionOptions = {},
): Promise<ResolvedGatewayRuntime> {
  if (selection.kind === "curated") {
    return resolveGatewayRuntime(selection.runtime, options);
  }

  const resolver = options.resolver ?? defaultRuntimeCommandResolver;
  const command = await resolveExistingCommandPath(selection.command, resolver);
  if (!command) {
    throw makeCustomRuntimeSelectionError(selection.command);
  }

  const definition: GatewayRuntimeDefinition = {
    id: "custom",
    displayName: selection.displayName?.trim() || "Custom ACP Runtime",
    description:
      selection.description?.trim() || "Custom ACP runtime launched from the operator CLI.",
    command: selection.command,
    args: [...(selection.args ?? [])],
    install: {
      owner: "custom",
      installHint:
        'Provide an executable command or install it on PATH before running "agents-js serve".',
    },
    resolvesFromWorkspaceBin: false,
  };

  return {
    definition,
    acp: {
      command,
      args: [...(selection.args ?? [])],
    },
    agentCard: makeRuntimeAgentCard(definition),
  };
}

export async function detectInstalledGatewayRuntimes(
  options: RuntimeResolutionOptions = {},
): Promise<GatewayRuntimeId[]> {
  const runtimeIds = listGatewayRuntimeIds();
  const results = await Promise.allSettled(
    runtimeIds.map((runtimeId) => resolveGatewayRuntime(runtimeId, options)),
  );

  return runtimeIds.filter((_, index) => results[index]?.status === "fulfilled");
}
