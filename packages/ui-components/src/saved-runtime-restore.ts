import {
  type ConnectPreferences,
  loadConnectProfiles,
  saveConnectPreferences,
} from "./connect-preferences-store.ts";
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

export function repairActiveSavedRuntimePreference(params: {
  hostState: HostState;
  fallbackUrl: string;
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
