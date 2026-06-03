/**
 * Persists and restores connection preferences (agent URL, runtime, model)
 * using browser localStorage.
 *
 * The current schema supports named profiles while remaining backward
 * compatible with the original single-profile payload.
 */

const STORAGE_KEY = "acp-connect-preferences";
const CURRENT_VERSION = "2";
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_NAME = "Default profile";

export interface ConnectPreferences {
  url: string;
  runtimeId: string;
}

export interface ConnectProfile extends ConnectPreferences {
  id: string;
  name: string;
  harnessId: string;
}

export interface ConnectProfilesState {
  version: typeof CURRENT_VERSION;
  activeProfileId: string;
  profiles: ConnectProfile[];
}

export interface SaveConnectPreferencesOptions {
  profileId?: string;
  profileName?: string;
  harnessId?: string;
}

function emptyState(): ConnectProfilesState {
  return {
    version: CURRENT_VERSION,
    activeProfileId: "",
    profiles: [],
  };
}

function trimString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePreferences(raw: unknown): ConnectPreferences | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.url !== "string") return null;
  return {
    url: trimString(obj.url),
    runtimeId: trimString(obj.runtimeId),
  };
}

function normalizeProfile(raw: unknown, fallbackId: string): ConnectProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const prefs = normalizePreferences(obj);
  if (!prefs) return null;

  return {
    id: trimString(obj.id) || fallbackId,
    name: trimString(obj.name) || DEFAULT_PROFILE_NAME,
    harnessId: trimString(obj.harnessId) || prefs.runtimeId || "default",
    ...prefs,
  };
}

function resolveActiveProfileId(profiles: ConnectProfile[], preferredId: string): string {
  if (profiles.length === 0) return "";
  if (preferredId && profiles.some((profile) => profile.id === preferredId)) {
    return preferredId;
  }
  const firstProfile = profiles[0];
  return firstProfile ? firstProfile.id : "";
}

function normalizeProfilesState(raw: unknown): ConnectProfilesState | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const profilesRaw = Array.isArray(obj.profiles) ? obj.profiles : null;
  if (trimString(obj.version) !== CURRENT_VERSION || !profilesRaw) {
    return null;
  }

  const profiles = profilesRaw
    .map((profile, index) => normalizeProfile(profile, `profile-${index + 1}`))
    .filter((profile): profile is ConnectProfile => profile !== null);

  return {
    version: CURRENT_VERSION,
    activeProfileId: resolveActiveProfileId(profiles, trimString(obj.activeProfileId)),
    profiles,
  };
}

function buildProfileId(name: string, existingIds: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "profile";

  if (!existingIds.has(base)) return base;

  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}

function persistState(state: ConnectProfilesState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable — ignore silently
  }
}

function migrateLegacyState(raw: unknown): ConnectProfilesState | null {
  const prefs = normalizePreferences(raw);
  if (!prefs) return null;

  return {
    version: CURRENT_VERSION,
    activeProfileId: DEFAULT_PROFILE_ID,
    profiles: [
      {
        id: DEFAULT_PROFILE_ID,
        name: DEFAULT_PROFILE_NAME,
        harnessId: prefs.runtimeId || "default",
        ...prefs,
      },
    ],
  };
}

function activeProfileFromState(state: ConnectProfilesState): ConnectProfile | null {
  if (state.profiles.length === 0) return null;
  const matchingProfile = state.profiles.find((profile) => profile.id === state.activeProfileId);
  return matchingProfile ?? state.profiles[0] ?? null;
}

export function loadConnectProfiles(): ConnectProfilesState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();

    const parsed: unknown = JSON.parse(raw);
    const state = normalizeProfilesState(parsed) ?? migrateLegacyState(parsed);
    if (!state) return emptyState();

    persistState(state);
    return state;
  } catch {
    return emptyState();
  }
}

/**
 * Load previously saved connection preferences.
 * Returns the active profile's preferences, or `null` if nothing valid was saved.
 */
export function loadConnectPreferences(): ConnectPreferences | null {
  const state = loadConnectProfiles();
  const activeProfile = activeProfileFromState(state);
  if (!activeProfile) return null;

  return {
    url: activeProfile.url,
    runtimeId: activeProfile.runtimeId,
  };
}

/**
 * Save connection preferences into a named profile.
 * If `profileId` is omitted, a new profile is created unless the store is empty,
 * in which case the default profile ID is used.
 */
export function saveConnectPreferences(
  prefs: ConnectPreferences,
  options?: SaveConnectPreferencesOptions,
): ConnectProfilesState {
  const normalized = normalizePreferences(prefs);
  if (!normalized) {
    return loadConnectProfiles();
  }

  const current = loadConnectProfiles();
  const existingIds = new Set(current.profiles.map((profile) => profile.id));
  const requestedName = trimString(options?.profileName) || DEFAULT_PROFILE_NAME;
  const requestedId =
    trimString(options?.profileId) || (current.profiles.length === 0 ? DEFAULT_PROFILE_ID : "");

  const existingProfile = requestedId
    ? current.profiles.find((profile) => profile.id === requestedId)
    : null;
  const profileId = requestedId || buildProfileId(requestedName, existingIds);

  const nextProfile: ConnectProfile = {
    id: profileId,
    name: requestedName,
    harnessId:
      trimString(options?.harnessId) ||
      existingProfile?.harnessId ||
      normalized.runtimeId ||
      "default",
    ...normalized,
  };

  const profiles = existingProfile
    ? current.profiles.map((profile) => (profile.id === profileId ? nextProfile : profile))
    : [...current.profiles, nextProfile];

  const nextState: ConnectProfilesState = {
    version: CURRENT_VERSION,
    activeProfileId: profileId,
    profiles,
  };

  persistState(nextState);
  return nextState;
}

export function setActiveConnectProfile(profileId: string): ConnectProfilesState {
  const current = loadConnectProfiles();
  const trimmedId = trimString(profileId);
  if (!trimmedId || !current.profiles.some((profile) => profile.id === trimmedId)) {
    return current;
  }

  const nextState: ConnectProfilesState = {
    ...current,
    activeProfileId: trimmedId,
  };
  persistState(nextState);
  return nextState;
}

export function deleteConnectProfile(profileId: string): ConnectProfilesState {
  const current = loadConnectProfiles();
  const trimmedId = trimString(profileId);
  if (!trimmedId) return current;

  const profiles = current.profiles.filter((profile) => profile.id !== trimmedId);
  const nextState: ConnectProfilesState = {
    version: CURRENT_VERSION,
    activeProfileId: resolveActiveProfileId(profiles, current.activeProfileId),
    profiles,
  };

  persistState(nextState);
  return nextState;
}

/**
 * Clear stored connection preferences and profiles.
 */
export function clearConnectPreferences(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable — ignore silently
  }
}
