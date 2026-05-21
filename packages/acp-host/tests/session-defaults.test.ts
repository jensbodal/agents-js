import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { configureLogging, Logger, resetLogging } from "../src/logger.ts";
import { applyAgentDefaults, trySetAgentMode } from "../src/session-defaults.ts";
import type { AgentConfig } from "../src/types/agent-config.ts";

// configureLogging mutates a module-level singleton (globalLogConfig). If we
// call it at file top-level, it leaks into every other test file that loads
// after this one — breaking tests that depend on default "debug" minLevel.
// Scope it to this file's lifetime with beforeAll/afterAll.
beforeAll(() => {
  configureLogging({ minLevel: "silent" });
});
afterAll(() => {
  resetLogging();
});

/** Minimal silent logger for tests */
const noopLog = new Logger("debug");

describe("trySetAgentMode", () => {
  test("returns protocol sync when mode exists and setMode succeeds", async () => {
    const ctx = {
      setMode: async (_id: string) => {},
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
      agentAdvertisedModes: true,
      modeFallbackReason: null,
      permLog: noopLog,
    };

    const result = await trySetAgentMode("default", "ok", ctx);
    expect(result).toEqual({ synced: true, hostManaged: false });
  });

  test('falls back to host-managed gating when "default" mode does not exist', async () => {
    const ctx = {
      setMode: async (_id: string) => {},
      modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] },
      agentAdvertisedModes: true,
      modeFallbackReason: null,
      permLog: noopLog,
    };

    const result = await trySetAgentMode("default", "ok", ctx);
    expect(result).toEqual({ synced: true, hostManaged: true });
  });

  test("falls back to host-managed gating when session modes are unavailable", async () => {
    const ctx = {
      setMode: async (_id: string) => {},
      modes: null,
      agentAdvertisedModes: false,
      modeFallbackReason: null,
      permLog: noopLog,
    };

    const result = await trySetAgentMode("default", "ok", ctx);
    expect(result).toEqual({ synced: true, hostManaged: true });
  });

  test("returns false when setMode throws", async () => {
    const ctx = {
      setMode: async (_id: string) => {
        throw new Error("mode set failed");
      },
      modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
      agentAdvertisedModes: true,
      modeFallbackReason: null,
      permLog: noopLog,
    };

    const result = await trySetAgentMode("default", "ok", ctx);
    expect(result).toEqual({ synced: false, hostManaged: false });
  });

  test("skips protocol setMode call when agent did not advertise modes", async () => {
    const calls: string[] = [];
    const ctx = {
      setMode: async (id: string) => {
        calls.push(`setMode:${id}`);
      },
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
      agentAdvertisedModes: false,
      modeFallbackReason: null,
      permLog: noopLog,
    };

    const result = await trySetAgentMode("default", "ok", ctx);
    expect(result).toEqual({ synced: true, hostManaged: true });
    expect(calls).not.toContain("setMode:default");
  });

  test("calls protocol setMode when agent DID advertise modes", async () => {
    const calls: string[] = [];
    const ctx = {
      setMode: async (id: string) => {
        calls.push(`setMode:${id}`);
      },
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "code", name: "Code" },
        ],
      },
      agentAdvertisedModes: true,
      modeFallbackReason: null,
      permLog: noopLog,
    };

    const result = await trySetAgentMode("default", "ok", ctx);
    expect(result).toEqual({ synced: true, hostManaged: false });
    expect(calls).toContain("setMode:default");
  });

  test("uses host-managed fallback when empty modes were repaired", async () => {
    const notices: Array<{ message: string; data: unknown }> = [];
    const captureLog = new Logger("debug");
    captureLog.info = (message: string, data?: Record<string, unknown>) => {
      notices.push({ message, data });
    };
    const ctx = {
      setMode: async (_id: string) => {},
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
      agentAdvertisedModes: false,
      modeFallbackReason: "empty" as const,
      permLog: captureLog,
    };

    const result = await trySetAgentMode("default", "ok", ctx);

    expect(result).toEqual({ synced: true, hostManaged: true });
    expect(notices.length).toBe(1);
    expect(notices[0]?.message).toContain("returned unusable modes");
    expect(notices[0]?.data).toEqual({
      requestedMode: "default",
      availableModes: ["default", "plan"],
      modeFallbackReason: "empty",
    });
  });
});

describe("applyAgentDefaults", () => {
  function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
      name: "Test",
      command: "unused",
      args: [],
      env: {},
      authHints: [],
      workspacePolicy: "workspace-root-only",
      ...overrides,
    };
  }

  function makeCtx(
    overrides: {
      permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
      modes?: { currentModeId: string; availableModes: { id: string; name: string }[] } | null;
      agentAdvertisedModes?: boolean;
      modeFallbackReason?: "missing" | "empty" | null;
    } = {},
  ) {
    const calls: string[] = [];
    return {
      calls,
      ctx: {
        setMode: async (id: string) => {
          calls.push(`setMode:${id}`);
        },
        setModel: async (id: string) => {
          calls.push(`setModel:${id}`);
        },
        modes: overrides.modes ?? null,
        models: null,
        permissionMode: overrides.permissionMode ?? "default",
        agentAdvertisedModes: overrides.agentAdvertisedModes ?? true,
        modeFallbackReason: overrides.modeFallbackReason ?? null,
        log: noopLog,
        permLog: noopLog,
      },
    };
  }

  test("syncs to default mode when permissionMode is default and mode exists", async () => {
    const { calls, ctx } = makeCtx({
      permissionMode: "default",
      agentAdvertisedModes: true,
      modes: {
        currentModeId: "code",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "code", name: "Code" },
        ],
      },
    });

    const result = await applyAgentDefaults(makeConfig(), ctx);

    expect(result.permissionGatingSynced).toBe(true);
    expect(result.permissionGatingHostManaged).toBe(false);
    expect(calls).toContain("setMode:default");
  });

  test('uses host-managed gating when the runtime does not advertise "default" mode', async () => {
    const { ctx } = makeCtx({
      permissionMode: "default",
      agentAdvertisedModes: true,
      modes: { currentModeId: "code", availableModes: [{ id: "code", name: "Code" }] },
    });

    const result = await applyAgentDefaults(makeConfig(), ctx);

    expect(result).toEqual({
      permissionGatingSynced: true,
      permissionGatingHostManaged: true,
    });
  });

  test("syncs to default mode when permissionMode is acceptEdits", async () => {
    const { calls, ctx } = makeCtx({
      permissionMode: "acceptEdits",
      agentAdvertisedModes: true,
      modes: { currentModeId: "code", availableModes: [{ id: "default", name: "Default" }] },
    });

    const result = await applyAgentDefaults(makeConfig(), ctx);

    expect(result.permissionGatingSynced).toBe(true);
    expect(result.permissionGatingHostManaged).toBe(false);
    expect(calls).toContain("setMode:default");
  });

  test("syncs to plan mode when permissionMode is plan", async () => {
    const { calls, ctx } = makeCtx({
      permissionMode: "plan",
      agentAdvertisedModes: true,
      modes: { currentModeId: "code", availableModes: [{ id: "plan", name: "Plan" }] },
    });

    await applyAgentDefaults(makeConfig(), ctx);

    expect(calls).toContain("setMode:plan");
  });

  test("does not attempt mode sync for bypassPermissions", async () => {
    const { calls, ctx } = makeCtx({
      permissionMode: "bypassPermissions",
      agentAdvertisedModes: true,
      modes: { currentModeId: "code", availableModes: [{ id: "default", name: "Default" }] },
    });

    const result = await applyAgentDefaults(makeConfig(), ctx);

    expect(result.permissionGatingSynced).toBe(true);
    expect(result.permissionGatingHostManaged).toBe(false);
    expect(calls).not.toContain("setMode:default");
  });

  test("returns host-managed permission gating when agent did not advertise modes", async () => {
    const { calls, ctx } = makeCtx({
      permissionMode: "default",
      agentAdvertisedModes: false,
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan" },
        ],
      },
    });

    const result = await applyAgentDefaults(makeConfig(), ctx);

    expect(result).toEqual({
      permissionGatingSynced: true,
      permissionGatingHostManaged: true,
    });
    // Should NOT call setMode since agent didn't advertise modes
    expect(calls).not.toContain("setMode:default");
  });
});
