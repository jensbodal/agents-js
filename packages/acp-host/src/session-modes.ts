import type { SessionModeState } from "@agentclientprotocol/sdk";
import type { Logger } from "./logger.ts";

export type ModeFallbackReason = "missing" | "empty";

export function createFallbackModes(): SessionModeState {
  return {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ],
  };
}

export function normalizeSessionModes(
  modes: SessionModeState | null | undefined,
  context: {
    sessionId: string;
    sessionSource: "new" | "load";
    log: Logger;
  },
): {
  modes: SessionModeState;
  agentAdvertisedModes: boolean;
  fallbackReason: ModeFallbackReason | null;
} {
  if (!modes) {
    const repairedModes = createFallbackModes();
    context.log.debug("Agent omitted session modes; using host-managed fallback modes", {
      sessionId: context.sessionId,
      sessionSource: context.sessionSource,
      rawModes: null,
      repairedModes,
    });
    return {
      modes: repairedModes,
      agentAdvertisedModes: false,
      fallbackReason: "missing",
    };
  }

  if (modes.availableModes.length === 0) {
    const repairedModes = createFallbackModes();
    context.log.warn(
      "Agent/session returned unusable modes; applying host-managed fallback modes",
      {
        sessionId: context.sessionId,
        sessionSource: context.sessionSource,
        rawModes: modes,
        repairedModes,
      },
    );
    return {
      modes: repairedModes,
      agentAdvertisedModes: false,
      fallbackReason: "empty",
    };
  }

  return {
    modes,
    agentAdvertisedModes: true,
    fallbackReason: null,
  };
}

export function getHostManagedPermissionReason(
  modes: SessionModeState | null,
  modeFallbackReason: ModeFallbackReason | null,
): string {
  if (!modes) {
    return "Host-managed permission gating active (session modes are unavailable before session start).";
  }
  if (modeFallbackReason === "empty") {
    return "Host-managed permission gating active (agent/session returned unusable modes; host applied fallback defaults).";
  }
  if (!modes.availableModes.some((mode) => mode.id === "default")) {
    return 'Host-managed permission gating active (runtime does not advertise a compatible "default" mode).';
  }
  return "Host-managed permission gating active (agent does not advertise modes).";
}
