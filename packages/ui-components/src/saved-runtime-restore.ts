import {
  type ConnectPreferences,
  loadConnectProfiles,
  saveConnectPreferences,
} from "./connect-preferences-store.ts";
import {
  deriveFallbackModelId,
  isKnownModelId,
  reconcileModelSelection,
} from "./model-selection.ts";
import type { HostState } from "./ws-types.ts";

export function shouldRepairSavedRuntimeRestore(
  hostState: HostState,
  pendingRequestedRuntimeId: string | null,
): boolean {
  const runtimeSwitchState = hostState.runtimeSwitchState;
  return (
    pendingRequestedRuntimeId !== null &&
    runtimeSwitchState?.status === "failed" &&
    runtimeSwitchState.requestedRuntimeId === pendingRequestedRuntimeId &&
    (runtimeSwitchState.origin === undefined || runtimeSwitchState.origin === "saved_restore") &&
    typeof hostState.runtime?.id === "string" &&
    hostState.runtime.id !== runtimeSwitchState.requestedRuntimeId
  );
}

function resolveCompatibleModelId(params: {
  hostState: HostState;
  pendingModelSelection: string | null;
  selectedModelId: string;
  savedModelId: string;
}): string {
  const { hostState, pendingModelSelection, selectedModelId, savedModelId } = params;

  if (isKnownModelId(hostState, savedModelId)) {
    return savedModelId;
  }

  const selection = reconcileModelSelection({
    hostState,
    pendingModelSelection: pendingModelSelection ?? savedModelId,
    selectedModelId: selectedModelId || savedModelId,
  });

  return selection.selectedModelId || deriveFallbackModelId(hostState) || savedModelId;
}

export function repairActiveSavedRuntimePreference(params: {
  hostState: HostState;
  fallbackUrl: string;
  pendingModelSelection: string | null;
  selectedModelId: string;
}): {
  repaired: boolean;
  savedPreferences: ConnectPreferences | null;
} {
  const activeRuntimeId = params.hostState.runtime?.id;
  if (!activeRuntimeId) {
    return { repaired: false, savedPreferences: null };
  }

  const profilesState = loadConnectProfiles();
  const activeProfile = profilesState.profiles.find(
    (profile) => profile.id === profilesState.activeProfileId,
  );
  if (!activeProfile) {
    return { repaired: false, savedPreferences: null };
  }

  const nextPreferences: ConnectPreferences = {
    url: activeProfile.url || params.fallbackUrl,
    runtimeId: activeRuntimeId,
    modelId: resolveCompatibleModelId({
      hostState: params.hostState,
      pendingModelSelection: params.pendingModelSelection,
      selectedModelId: params.selectedModelId,
      savedModelId: activeProfile.modelId,
    }),
  };

  saveConnectPreferences(nextPreferences, {
    profileId: activeProfile.id,
    profileName: activeProfile.name,
    harnessId: activeRuntimeId,
  });

  return {
    repaired: true,
    savedPreferences: nextPreferences,
  };
}
