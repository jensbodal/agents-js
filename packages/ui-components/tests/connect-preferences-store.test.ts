import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearConnectPreferences,
  deleteConnectProfile,
  loadConnectPreferences,
  loadConnectProfiles,
  saveConnectPreferences,
  setActiveConnectProfile,
} from "../src/connect-preferences-store.ts";

let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  globalThis.localStorage = {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

describe("connect-preferences-store", () => {
  test("loadConnectPreferences returns null when nothing is saved", () => {
    expect(loadConnectPreferences()).toBeNull();
  });

  test("saveConnectPreferences + loadConnectPreferences round-trips", () => {
    const prefs = {
      url: "http://localhost:9999",
      runtimeId: "opencode",
      modelId: "glm-5-turbo",
    };
    saveConnectPreferences(prefs);
    expect(loadConnectPreferences()).toEqual(prefs);
  });

  test("loadConnectProfiles migrates legacy flat payload into default profile", () => {
    store["acp-connect-preferences"] = JSON.stringify({
      url: "http://localhost:9000",
      runtimeId: "opencode",
      modelId: "glm-5-turbo",
    });

    expect(loadConnectProfiles()).toEqual({
      version: "2",
      activeProfileId: "default",
      profiles: [
        {
          id: "default",
          name: "Default profile",
          harnessId: "opencode",
          url: "http://localhost:9000",
          runtimeId: "opencode",
          modelId: "glm-5-turbo",
        },
      ],
    });
  });

  test("saveConnectPreferences creates named profiles and tracks the latest active profile", () => {
    saveConnectPreferences(
      {
        url: "http://localhost:1111",
        runtimeId: "opencode",
        modelId: "glm",
      },
      { profileName: "OpenCode local" },
    );

    saveConnectPreferences(
      {
        url: "http://localhost:2222",
        runtimeId: "claude",
        modelId: "haiku",
      },
      { profileName: "Claude local" },
    );

    const profiles = loadConnectProfiles();
    expect(profiles.activeProfileId).toBe("claude-local");
    expect(profiles.profiles.map((profile) => profile.name)).toEqual([
      "OpenCode local",
      "Claude local",
    ]);
    expect(loadConnectPreferences()).toEqual({
      url: "http://localhost:2222",
      runtimeId: "claude",
      modelId: "haiku",
    });
  });

  test("setActiveConnectProfile switches the active profile", () => {
    saveConnectPreferences(
      { url: "http://localhost:1111", runtimeId: "opencode", modelId: "glm" },
      { profileName: "One" },
    );
    saveConnectPreferences(
      { url: "http://localhost:2222", runtimeId: "claude", modelId: "haiku" },
      { profileName: "Two" },
    );

    const firstProfileId = loadConnectProfiles().profiles[0].id;
    setActiveConnectProfile(firstProfileId);
    expect(loadConnectPreferences()).toEqual({
      url: "http://localhost:1111",
      runtimeId: "opencode",
      modelId: "glm",
    });
  });

  test("deleteConnectProfile removes a profile and falls back to another active profile", () => {
    const first = saveConnectPreferences(
      { url: "http://localhost:1111", runtimeId: "opencode", modelId: "glm" },
      { profileName: "One" },
    );
    const second = saveConnectPreferences(
      { url: "http://localhost:2222", runtimeId: "claude", modelId: "haiku" },
      { profileName: "Two" },
    );

    deleteConnectProfile(second.activeProfileId);

    expect(loadConnectProfiles()).toEqual({
      version: "2",
      activeProfileId: first.activeProfileId,
      profiles: first.profiles,
    });
  });

  test("clearConnectPreferences removes saved data", () => {
    saveConnectPreferences({
      url: "http://localhost:9999",
      runtimeId: "claude",
      modelId: "haiku",
    });
    clearConnectPreferences();
    expect(loadConnectPreferences()).toBeNull();
  });

  test("loadConnectPreferences returns null for malformed JSON", () => {
    store["acp-connect-preferences"] = "not-valid-json{{{";
    expect(loadConnectPreferences()).toBeNull();
  });

  test("loadConnectPreferences returns null for non-object JSON", () => {
    store["acp-connect-preferences"] = '"just a string"';
    expect(loadConnectPreferences()).toBeNull();
  });

  test("loadConnectPreferences returns null when url is missing", () => {
    store["acp-connect-preferences"] = JSON.stringify({
      runtimeId: "foo",
      modelId: "bar",
    });
    expect(loadConnectPreferences()).toBeNull();
  });

  test("loadConnectProfiles returns empty state for malformed profile schema", () => {
    store["acp-connect-preferences"] = JSON.stringify({
      version: "2",
      profiles: "invalid",
    });

    expect(loadConnectProfiles()).toEqual({
      version: "2",
      activeProfileId: "",
      profiles: [],
    });
  });

  test("saveConnectPreferences no-ops when localStorage is unavailable", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(() => {
      saveConnectPreferences({
        url: "http://localhost:1234",
        runtimeId: "test",
        modelId: "test",
      });
    }).not.toThrow();
  });

  test("loadConnectPreferences returns null when localStorage is unavailable", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(loadConnectPreferences()).toBeNull();
  });

  test("clearConnectPreferences no-ops when localStorage is unavailable", () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(() => clearConnectPreferences()).not.toThrow();
  });
});
