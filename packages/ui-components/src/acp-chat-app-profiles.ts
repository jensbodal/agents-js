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
  selectedModelId: string;
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
      selectedModelId: "",
    };
  }

  getSavedPreferences(): ConnectPreferences | null {
    return this._savedPreferences;
  }

  /** Load profiles from localStorage and apply active profile preferences. */
  load(): { state: ProfileManagerState; selectedModelId?: string } {
    const stored = loadConnectProfiles();
    this._syncState(stored);
    let selectedModelId: string | undefined;
    if (this._savedPreferences) {
      selectedModelId = this._applyPreferences(this._savedPreferences);
    }
    return { state: this.state, selectedModelId };
  }

  /** Handle the acp-save-preferences event. */
  handleSave(detail: {
    url: string;
    runtimeId: string;
    modelId: string;
    profileId?: string;
    profileName?: string;
    harnessId?: string;
    saveMode?: "update" | "create";
  }): { state: ProfileManagerState; selectedModelId?: string } {
    const nextState = saveConnectPreferences(
      {
        url: detail.url,
        runtimeId: detail.runtimeId,
        modelId: detail.modelId,
      },
      {
        profileId: detail.saveMode === "update" ? detail.profileId : undefined,
        profileName: detail.profileName || this._profileDraftName,
        harnessId: detail.harnessId,
      },
    );

    this._syncState(nextState);
    let selectedModelId: string | undefined;
    if (this._savedPreferences) {
      selectedModelId = this._applyPreferences(this._savedPreferences);
    }
    return { state: this.state, selectedModelId };
  }

  /** Handle profile selection. */
  handleSelect(profileId: string): { state: ProfileManagerState; selectedModelId?: string } {
    const nextState = setActiveConnectProfile(profileId);
    this._syncState(nextState);
    let selectedModelId: string | undefined;
    if (this._savedPreferences) {
      selectedModelId = this._applyPreferences(this._savedPreferences, { notifyHost: true });
    }
    return { state: this.state, selectedModelId };
  }

  /** Handle profile deletion. */
  handleDelete(profileId: string): { state: ProfileManagerState; selectedModelId?: string } {
    const deletedActiveProfile = profileId === this._activeProfileId;
    const nextState = deleteConnectProfile(profileId);
    this._syncState(nextState);
    let selectedModelId: string | undefined;
    if (deletedActiveProfile && this._savedPreferences) {
      selectedModelId = this._applyPreferences(this._savedPreferences, { notifyHost: true });
    }
    return { state: this.state, selectedModelId };
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
          modelId: activeProfile.modelId,
        }
      : null;
  }

  /**
   * Apply preferences to the host component.
   * Returns the modelId to set as selectedModelId (if present).
   */
  private _applyPreferences(prefs: ConnectPreferences, options?: { notifyHost?: boolean }): string {
    if (prefs.url) {
      this.callbacks.setDefaultUrl(prefs.url);
      if (this.callbacks.getController() && !this.callbacks.isConnected()) {
        this.callbacks.setControllerTargetInput({ url: prefs.url });
      }
    }

    if (options?.notifyHost) {
      if (prefs.runtimeId) {
        this.callbacks.dispatchEvent(
          new CustomEvent("acp-runtime-change", {
            bubbles: true,
            composed: true,
            detail: { runtimeId: prefs.runtimeId },
          }),
        );
      }
      if (prefs.modelId) {
        this.callbacks.dispatchEvent(
          new CustomEvent("acp-model-preselect", {
            bubbles: true,
            composed: true,
            detail: { modelId: prefs.modelId },
          }),
        );
      }
    }

    return prefs.modelId;
  }
}
