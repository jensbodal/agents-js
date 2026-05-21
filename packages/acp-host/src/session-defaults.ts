/**
 * Agent default mode/model application logic.
 *
 * Extracted from session-controller to keep mode-setting concerns
 * in one place. The two trySetMode branches (plan / default) are
 * unified into a single parameterised helper.
 */
import type { SessionModelState, SessionModeState } from "@agentclientprotocol/sdk";
import type { Logger } from "./logger.ts";
import type { PermissionMode } from "./session-state.ts";
import type { AgentConfig } from "./types/agent-config.ts";

interface DefaultsContext {
  setMode(modeId: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  modes: SessionModeState | null;
  models: SessionModelState | null;
  permissionMode: PermissionMode;
  agentAdvertisedModes: boolean;
  modeFallbackReason: "missing" | "empty" | null;
  log: Logger;
  permLog: Logger;
}

export interface ApplyDefaultsResult {
  /** Whether permission-gating mode sync succeeded (relevant for default/acceptEdits modes). */
  permissionGatingSynced: boolean;
  /** Whether the host is enforcing permission gating without a protocol mode sync. */
  permissionGatingHostManaged: boolean;
}

export interface ModeSyncResult {
  synced: boolean;
  hostManaged: boolean;
}

export async function applyAgentDefaults(
  config: AgentConfig,
  ctx: DefaultsContext,
): Promise<ApplyDefaultsResult> {
  if (config.defaultMode && ctx.modes) {
    const hasMode = ctx.modes.availableModes.some((m) => m.id === config.defaultMode);
    if (hasMode && ctx.agentAdvertisedModes) {
      await ctx.setMode(config.defaultMode);
      ctx.permLog.info("Applied default agent mode", { mode: config.defaultMode });
    } else if (hasMode && !ctx.agentAdvertisedModes) {
      ctx.log.debug("Skipping defaultMode protocol call — agent did not advertise modes", {
        defaultMode: config.defaultMode,
      });
    } else {
      ctx.log.warn("Configured defaultMode not found in available modes", {
        defaultMode: config.defaultMode,
        availableModes: ctx.modes.availableModes.map((m) => m.id),
      });
    }
  }

  if (config.defaultModel && ctx.models) {
    const hasModel = ctx.models.availableModels.some((m) => m.modelId === config.defaultModel);
    if (hasModel) {
      await ctx.setModel(config.defaultModel);
      ctx.permLog.info("Applied default agent model", { model: config.defaultModel });
    } else {
      ctx.log.warn("Configured defaultModel not found in available models", {
        defaultModel: config.defaultModel,
        availableModels: ctx.models.availableModels.map((m) => m.modelId),
      });
    }
  }

  // After per-agent defaults, sync permission mode to runtime
  let permissionGatingSynced = true;
  let permissionGatingHostManaged = false;
  if (ctx.permissionMode === "default" || ctx.permissionMode === "acceptEdits") {
    const result = await trySetAgentMode(
      "default",
      "Agent default mode activated for permission gating",
      ctx,
    );
    permissionGatingSynced = result.synced;
    permissionGatingHostManaged = result.hostManaged;
  } else if (ctx.permissionMode === "plan") {
    await trySetAgentMode("plan", "Agent plan mode activated", ctx);
  }

  return { permissionGatingSynced, permissionGatingHostManaged };
}

export async function trySetAgentMode(
  modeId: string,
  successMessage: string,
  ctx: Pick<
    DefaultsContext,
    "setMode" | "modes" | "agentAdvertisedModes" | "modeFallbackReason" | "permLog"
  >,
): Promise<ModeSyncResult> {
  const hasMode = ctx.modes?.availableModes.some((m) => m.id === modeId);
  const availableModes = ctx.modes?.availableModes.map((m) => m.id) ?? [];

  if (!hasMode) {
    if (modeId === "default") {
      if (!ctx.modes) {
        ctx.permLog.info(
          'Session modes are unavailable before session start — using host-managed "default" permission gating.',
          { requestedMode: modeId },
        );
        return { synced: true, hostManaged: true };
      }

      ctx.permLog.info(
        `Agent/runtime does not advertise a compatible "${modeId}" mode — using host-managed permission gating.`,
        { requestedMode: modeId, availableModes },
      );
      return { synced: true, hostManaged: true };
    }

    ctx.permLog.warn(
      `Agent does not advertise "${modeId}" mode — permission gating may be degraded${modeId === "plan" ? ", using host-only plan semantics" : ""}`,
      { requestedMode: modeId, availableModes },
    );
    return { synced: false, hostManaged: false };
  }

  // When the agent didn't advertise modes (host synthesized them),
  // skip the protocol setMode call -- the agent wouldn't understand it.
  if (!ctx.agentAdvertisedModes) {
    if (ctx.modeFallbackReason === "empty") {
      ctx.permLog.info(
        `Agent/session returned unusable modes (empty availableModes) — using host-managed "${modeId}" fallback${modeId === "plan" ? " and host-only plan semantics" : " for permission gating"}`,
        {
          requestedMode: modeId,
          availableModes,
          modeFallbackReason: ctx.modeFallbackReason,
        },
      );
      return { synced: true, hostManaged: true };
    }

    ctx.permLog.debug("Agent does not advertise modes — using host-managed mode", {
      modeId,
    });
    return { synced: true, hostManaged: true };
  }

  try {
    await ctx.setMode(modeId);
    ctx.permLog.info(successMessage);
    return { synced: true, hostManaged: false };
  } catch (err) {
    ctx.permLog.warn(`Failed to set agent ${modeId} mode`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { synced: false, hostManaged: false };
  }
}
