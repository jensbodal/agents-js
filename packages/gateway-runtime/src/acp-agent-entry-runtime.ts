import {
  listGatewayRuntimeIds,
  resolveGatewayRuntime,
  resolveGatewayRuntimeSelection,
} from "./runtime-selection.ts";
import type {
  AcpAgentEntryInput,
  ResolvedGatewayRuntime,
  RuntimeResolutionOptions,
} from "./runtimes-registry.ts";

/**
 * Bridge an ACP registry entry to a {@link ResolvedGatewayRuntime} suitable
 * for passing to `ACPSessionController.start()`. Used by the gateway's
 * ACP-kind `@@dispatch` path to spawn an ephemeral per-dispatch runtime.
 */
export async function resolveAcpAgentEntryToRuntime(
  entry: AcpAgentEntryInput,
  options: RuntimeResolutionOptions = {},
): Promise<ResolvedGatewayRuntime> {
  const curatedIds = listGatewayRuntimeIds();
  const harnessIsCurated = (curatedIds as readonly string[]).includes(entry.harness);

  let base: ResolvedGatewayRuntime;
  if (entry.command) {
    base = await resolveGatewayRuntimeSelection(
      {
        kind: "custom",
        command: entry.command,
        args: entry.args,
        displayName: entry.name,
      },
      options,
    );
  } else if (harnessIsCurated) {
    base = await resolveGatewayRuntime(entry.harness, options);
  } else {
    throw new Error(
      `[Gateway] ACP registry entry harness "${entry.harness}" is not a curated runtime ` +
        `(supported: ${curatedIds.join(", ")}) and has no explicit command override.`,
    );
  }

  const mergedArgs = entry.command
    ? (base.acp.args ?? [])
    : [...(base.acp.args ?? []), ...(entry.args ?? [])];
  const mergedEnv = entry.env ? { ...(base.acp.env ?? {}), ...entry.env } : base.acp.env;
  const mergedWorkspaceFlag = entry.workspaceFlag ?? base.acp.workspaceFlag;

  return {
    ...base,
    acp: {
      ...base.acp,
      args: mergedArgs,
      ...(mergedEnv ? { env: mergedEnv } : {}),
      ...(mergedWorkspaceFlag !== undefined ? { workspaceFlag: mergedWorkspaceFlag } : {}),
    },
  };
}
