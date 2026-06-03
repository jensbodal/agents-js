/**
 * Profile management logic extracted from AcpChatApp.
 *
 * Encapsulates profile CRUD, preference persistence, and state sync.
 * The host component provides callbacks for cross-cutting concerns
 * (controller access, event dispatch, URL updates) and owns the
 * Lit @state() declarations.
 */

import {
  type ConnectPreferences,
  type ConnectProfile,
  deleteConnectProfile,
  loadConnectProfiles,
  saveConnectPreferences,
  setActiveConnectProfile,
} from "./connect-preferences-store.ts";

export interface ProfileManagerCallbacks {
  /** Get the ACP controller (null when unset). */
  getController(): unknown;
  /** Whether the component is currently connected. */
  isConnected(): boolean;
  /** Set the component's defaultUrl property. */
  setDefaultUrl(url: string): void;
  /** Set the ACP controller's target input. */
  setControllerTargetInput(input: { url: string }): void;
  /** Dispatch a CustomEvent from the host element. */
  dispatchEvent(event: Event): boolean;
}

export interface ProfileManagerState {
  profiles: ConnectProfile[];
  activeProfileId: string;
  hasSavedPreferences: boolean;
  savedPreferences: ConnectPreferences | null;
  profileDraftName: string;
}

export class ChatAppProfileManager {
  private _profiles: ConnectProfile[] = [];
  private _activeProfileId = "";
  private _hasSavedPreferences = false;
  private _savedPreferences: ConnectPreferences | null = null;
  private _profileDraftName = "Default profile";

  constructor(private readonly callbacks: ProfileManagerCallbacks) {}

  get state(): ProfileManagerState {
    return {
      profiles: this._profiles,
      activeProfileId: this._activeProfileId,
      hasSavedPreferences: this._hasSavedPreferences,
      savedPreferences: this._savedPreferences,
      profileDraftName: this._profileDraftName,
    };
  }

  getSavedPreferences(): ConnectPreferences | null {
    return this._savedPreferences;
  }

  /** Load profiles from localStorage and apply active profile preferences. */
  load(): { state: ProfileManagerState } {
    const stored = loadConnectProfiles();
    this._syncState(stored);
    if (this._savedPreferences) {
      this._applyPreferences(this._savedPreferences);
    }
    return { state: this.state };
  }

  /** Handle the acp-save-preferences event. */
  handleSave(detail: {
    url: string;
    runtimeId: string;
    profileId?: string;
    profileName?: string;
    harnessId?: string;
    saveMode?: "update" | "create";
  }): { state: ProfileManagerState } {
    const nextState = saveConnectPreferences(
      {
        url: detail.url,
        runtimeId: detail.runtimeId,
      },
      {
        profileId: detail.saveMode === "update" ? detail.profileId : undefined,
        profileName: detail.profileName || this._profileDraftName,
        harnessId: detail.harnessId,
      },
    );

    this._syncState(nextState);
    if (this._savedPreferences) {
      this._applyPreferences(this._savedPreferences);
    }
    return { state: this.state };
  }

  /** Handle profile selection. */
  handleSelect(profileId: string): { state: ProfileManagerState } {
    const nextState = setActiveConnectProfile(profileId);
    this._syncState(nextState);
    if (this._savedPreferences) {
      this._applyPreferences(this._savedPreferences, { notifyHost: true });
    }
    return { state: this.state };
  }

  /** Handle profile deletion. */
  handleDelete(profileId: string): { state: ProfileManagerState } {
    const deletedActiveProfile = profileId === this._activeProfileId;
    const nextState = deleteConnectProfile(profileId);
    this._syncState(nextState);
    if (deletedActiveProfile && this._savedPreferences) {
      this._applyPreferences(this._savedPreferences, { notifyHost: true });
    }
    return { state: this.state };
  }

  /** Handle draft profile name change. */
  handleNameChange(name: string): void {
    this._profileDraftName = name;
  }

  private _syncState(state: { activeProfileId: string; profiles: ConnectProfile[] }): void {
    this._profiles = state.profiles;
    this._activeProfileId = state.activeProfileId;
    this._hasSavedPreferences = state.profiles.length > 0;

    const activeProfile =
      state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;

    this._profileDraftName = activeProfile?.name ?? "Default profile";
    this._savedPreferences = activeProfile
      ? {
          url: activeProfile.url,
          runtimeId: activeProfile.runtimeId,
        }
      : null;
  }

  /** Apply preferences to the host component. */
  private _applyPreferences(prefs: ConnectPreferences, options?: { notifyHost?: boolean }): void {
    if (prefs.url) {
      this.callbacks.setDefaultUrl(prefs.url);
      if (this.callbacks.getController() && !this.callbacks.isConnected()) {
        this.callbacks.setControllerTargetInput({ url: prefs.url });
      }
    }

    if (options?.notifyHost && prefs.runtimeId) {
      this.callbacks.dispatchEvent(
        new CustomEvent("acp-runtime-change", {
          bubbles: true,
          composed: true,
          detail: { runtimeId: prefs.runtimeId },
        }),
      );
    }
  }
}
