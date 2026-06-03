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

  test("repairs the active saved profile to the recovered runtime", () => {
    saveConnectPreferences(
      {
        url: "http://localhost:4123",
        runtimeId: "sisyphus",
      },
      {
        profileName: "Recovered browser profile",
      },
    );

    const result = repairActiveSavedRuntimePreference({
      hostState: {
        runtime: { id: "claude", displayName: "Claude ACP" },
        runtimeSwitchState: {
          status: "failed",
          requestedRuntimeId: "sisyphus",
          message: "Failed to switch.",
          origin: "saved_restore",
        },
      },
      fallbackUrl: "http://localhost:4123",
    });

    expect(result).toEqual({
      repaired: true,
      savedPreferences: {
        url: "http://localhost:4123",
        runtimeId: "claude",
      },
    });
    expect(loadConnectPreferences()).toEqual({
      url: "http://localhost:4123",
      runtimeId: "claude",
    });
    expect(loadConnectProfiles()).toMatchObject({
      activeProfileId: "default",
      profiles: [
        {
          id: "default",
          harnessId: "claude",
          runtimeId: "claude",
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
      }),
    ).toEqual({
      repaired: false,
      savedPreferences: null,
    });
  });
});
