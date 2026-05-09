import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  loadConnectPreferences,
  loadConnectProfiles,
  saveConnectPreferences,
} from "@agents-js/ui-components/connect-preferences";
import {
  repairActiveSavedRuntimePreference,
  shouldRepairSavedRuntimeRestore,
} from "../src/saved-runtime-restore.ts";

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

describe("saved-runtime-restore", () => {
  test("detects failed automatic restore attempts that recovered to the previous runtime", () => {
    expect(
      shouldRepairSavedRuntimeRestore(
        {
          runtime: { id: "claude", displayName: "Claude ACP" },
          runtimeSwitchState: {
            status: "failed",
            requestedRuntimeId: "sisyphus",
            message: "Failed to switch.",
            origin: "saved_restore",
          },
        },
        "sisyphus",
      ),
    ).toBe(true);

    expect(
      shouldRepairSavedRuntimeRestore(
        {
          runtime: { id: "claude", displayName: "Claude ACP" },
          runtimeSwitchState: {
            status: "failed",
            requestedRuntimeId: "sisyphus",
            message: "Failed to switch.",
          },
        },
        "sisyphus",
      ),
    ).toBe(true);

    expect(
      shouldRepairSavedRuntimeRestore(
        {
          runtime: { id: "claude", displayName: "Claude ACP" },
          runtimeSwitchState: {
            status: "failed",
            requestedRuntimeId: "sisyphus",
            message: "Failed to switch.",
            origin: "manual",
          },
        },
        "sisyphus",
      ),
    ).toBe(false);
  });

  test("repairs the active saved profile to the recovered runtime and compatible model", () => {
    saveConnectPreferences(
      {
        url: "http://localhost:4123",
        runtimeId: "sisyphus",
        modelId: "ultraworker",
      },
      {
        profileName: "Recovered browser profile",
      },
    );

    const result = repairActiveSavedRuntimePreference({
      hostState: {
        runtime: { id: "claude", displayName: "Claude ACP" },
        defaultModelId: "sonnet",
        models: {
          currentModelId: "sonnet",
          availableModels: [{ modelId: "sonnet", name: "Sonnet" }],
        },
        runtimeModels: [{ id: "sonnet", name: "Sonnet", provider: "anthropic" }],
        runtimeSwitchState: {
          status: "failed",
          requestedRuntimeId: "sisyphus",
          message: "Failed to switch.",
          origin: "saved_restore",
        },
      },
      fallbackUrl: "http://localhost:4123",
      pendingModelSelection: "ultraworker",
      selectedModelId: "",
    });

    expect(result).toEqual({
      repaired: true,
      savedPreferences: {
        url: "http://localhost:4123",
        runtimeId: "claude",
        modelId: "sonnet",
      },
    });
    expect(loadConnectPreferences()).toEqual({
      url: "http://localhost:4123",
      runtimeId: "claude",
      modelId: "sonnet",
    });
    expect(loadConnectProfiles()).toMatchObject({
      activeProfileId: "default",
      profiles: [
        {
          id: "default",
          harnessId: "claude",
          runtimeId: "claude",
          modelId: "sonnet",
        },
      ],
    });
  });

  test("does not repair when there is no active saved profile", () => {
    expect(
      repairActiveSavedRuntimePreference({
        hostState: {
          runtime: { id: "claude", displayName: "Claude ACP" },
        },
        fallbackUrl: "http://localhost:4123",
        pendingModelSelection: null,
        selectedModelId: "",
      }),
    ).toEqual({
      repaired: false,
      savedPreferences: null,
    });
  });
});
