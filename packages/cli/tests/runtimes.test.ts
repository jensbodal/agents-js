import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  applyGatewayRuntimeProfile,
  detectInstalledGatewayRuntimes,
  getGatewayRuntimeDefinition,
  resolveGatewayRuntime,
  resolveGatewayRuntimeCommand,
  resolveGatewayRuntimeProfile,
  resolveGatewayRuntimeSelection,
  validateGatewayRuntimeProfileName,
} from "@agents-js/gateway-runtime";
import { getCliRuntimeBinSearchRoots } from "../src/runtime-resolution.ts";

describe("agents-js runtime resolution", () => {
  test("derives the package root from a compiled CLI binary path", () => {
    const installRoot = "/tmp/agents-js-install";
    const cliPackageRoot = path.join(installRoot, "node_modules", "@agents-js", "cli");

    expect(
      getCliRuntimeBinSearchRoots({
        execPath: path.join(cliPackageRoot, "dist", "agents-js"),
        moduleUrl: "bun:compiled",
      }),
    ).toEqual([cliPackageRoot]);
  });

  test("derives the package root from source module execution", () => {
    const cliPackageRoot = path.join(import.meta.dir, "..");

    expect(
      getCliRuntimeBinSearchRoots({
        execPath: "/usr/local/bin/bun",
        moduleUrl: new URL("../src/runtime-resolution.ts", import.meta.url).href,
      }),
    ).toEqual([cliPackageRoot]);
  });

  test("lists curated runtime definitions", () => {
    expect(getGatewayRuntimeDefinition("claude")).toMatchObject({
      id: "claude",
      command: "claude-agent-acp",
    });
    expect(getGatewayRuntimeDefinition("opencode")).toMatchObject({
      id: "opencode",
      command: "opencode",
      args: ["acp"],
    });
    expect(getGatewayRuntimeDefinition("gemini")).toMatchObject({
      id: "gemini",
      command: "gemini",
      args: ["--acp"],
    });
  });

  test("detects installed curated runtimes with an injected resolver", async () => {
    const installed = await detectInstalledGatewayRuntimes({
      workspaceBinRoot: "/repo/apps/internal-gateway",
      resolver: {
        which(command) {
          if (command === "opencode") {
            return "/usr/local/bin/opencode";
          }
          return undefined;
        },
        async fileExists(filePath) {
          return filePath.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp");
        },
      },
    });

    expect(installed).toEqual(["opencode", "claude"]);
  });

  test.each<{
    runtimeId: "opencode" | "gemini";
    expectedArgs: string[];
    expectedWorkspaceFlag: string | undefined;
    expectedEnv: Record<string, string> | undefined;
  }>([
    {
      runtimeId: "opencode",
      expectedArgs: ["acp", "--print-logs", "--log-level", "INFO"],
      expectedWorkspaceFlag: "--cwd",
      // opencode now seeds telemetry opt-outs via `GatewayRuntimeDefinition.defaultEnv`.
      expectedEnv: {
        OMO_SEND_ANONYMOUS_TELEMETRY: "0",
        OMO_DISABLE_POSTHOG: "1",
      },
    },
    {
      runtimeId: "gemini",
      expectedArgs: ["--acp"],
      expectedWorkspaceFlag: undefined,
      expectedEnv: undefined,
    },
  ])("resolves $runtimeId from PATH with correct defaults", async ({
    runtimeId,
    expectedArgs,
    expectedWorkspaceFlag,
    expectedEnv,
  }) => {
    const definition = getGatewayRuntimeDefinition(runtimeId);
    const mockPath = `/usr/local/bin/${definition.command}`;

    const resolved = await resolveGatewayRuntime(runtimeId, {
      resolver: {
        which(command) {
          if (command === definition.command) {
            return mockPath;
          }
          return undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });

    expect(resolved.acp.command).toBe(mockPath);
    expect(resolved.acp.args).toEqual(expectedArgs);
    expect(resolved.acp.env).toEqual(expectedEnv as Record<string, string> | undefined);
    expect(resolved.acp.workspaceFlag).toBe(expectedWorkspaceFlag);
  });

  test("resolves claude from an explicit workspace bin root when PATH is missing", async () => {
    const definition = getGatewayRuntimeDefinition("claude");
    const seenPaths: string[] = [];
    const command = await resolveGatewayRuntimeCommand(definition, {
      workspaceBinRoot: "/repo/apps/internal-gateway",
      resolver: {
        which() {
          return undefined;
        },
        async fileExists(filePath) {
          seenPaths.push(filePath);
          return filePath.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp");
        },
      },
    });

    expect(
      seenPaths.some((filePath) =>
        filePath.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp"),
      ),
    ).toBe(true);
    expect(command.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp")).toBe(
      true,
    );
  });

  test("resolves claude from a hoisted install layout when PATH is missing", async () => {
    const definition = getGatewayRuntimeDefinition("claude");
    const installRoot = "/tmp/agents-js-install";
    const command = await resolveGatewayRuntimeCommand(definition, {
      modulePath: path.join(
        installRoot,
        "node_modules",
        "@agents-js",
        "cli",
        "dist",
        "runtimes.mjs",
      ),
      resolver: {
        which() {
          return undefined;
        },
        async fileExists(filePath) {
          return filePath === path.join(installRoot, "node_modules", ".bin", "claude-agent-acp");
        },
      },
    });

    expect(command).toBe(path.join(installRoot, "node_modules", ".bin", "claude-agent-acp"));
  });

  test("compiled binaries fall back to PATH-only resolution", async () => {
    const definition = getGatewayRuntimeDefinition("claude");
    const seenPaths: string[] = [];

    await expect(
      resolveGatewayRuntimeCommand(definition, {
        modulePath: "/tmp/build-cli/agents-js",
        resolver: {
          which() {
            return undefined;
          },
          async fileExists(filePath) {
            seenPaths.push(filePath);
            return false;
          },
        },
      }),
    ).rejects.toThrow('Runtime "claude" could not resolve executable "claude-agent-acp"');

    expect(seenPaths).toEqual([]);
  });

  test("supports advanced custom command selection", async () => {
    const resolved = await resolveGatewayRuntimeSelection(
      {
        kind: "custom",
        command: "/tmp/mock-acp",
        args: ["--stdio"],
      },
      {
        resolver: {
          which() {
            return undefined;
          },
          async fileExists(filePath) {
            return filePath === "/tmp/mock-acp";
          },
        },
      },
    );

    expect(resolved.definition.id).toBe("custom");
    expect(resolved.acp).toEqual({
      command: "/tmp/mock-acp",
      args: ["--stdio"],
    });
  });

  test("applies runtime profiles as explicit isolated contexts", async () => {
    const resolved = await resolveGatewayRuntime("opencode", {
      resolver: {
        which(command) {
          if (command === "opencode") {
            return "/usr/local/bin/opencode";
          }
          return undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });

    const profiled = applyGatewayRuntimeProfile(
      resolved,
      resolveGatewayRuntimeProfile(
        "clean-room",
        {
          runtime: "opencode",
          args: ["--isolated"],
          env: {
            OPENCODE_PROFILE: "clean-room",
          },
        },
        "/tmp/agents-js-profiles",
      ),
    );

    expect(profiled.acp.args).toEqual(["acp", "--print-logs", "--log-level", "INFO", "--isolated"]);
    expect(profiled.acp.env).toEqual({
      // `defaultEnv` from the opencode definition flows through first, then
      // the profile's XDG roots + explicit env merge on top.
      OMO_SEND_ANONYMOUS_TELEMETRY: "0",
      OMO_DISABLE_POSTHOG: "1",
      HOME: path.join("/tmp/agents-js-profiles", "opencode", "clean-room"),
      XDG_CONFIG_HOME: path.join("/tmp/agents-js-profiles", "opencode", "clean-room", ".config"),
      XDG_DATA_HOME: path.join(
        "/tmp/agents-js-profiles",
        "opencode",
        "clean-room",
        ".local",
        "share",
      ),
      XDG_STATE_HOME: path.join(
        "/tmp/agents-js-profiles",
        "opencode",
        "clean-room",
        ".local",
        "state",
      ),
      XDG_CACHE_HOME: path.join("/tmp/agents-js-profiles", "opencode", "clean-room", ".cache"),
      OPENCODE_PROFILE: "clean-room",
    });
  });

  test("validates profile names before applying them", () => {
    expect(validateGatewayRuntimeProfileName("clean-room")).toBe("clean-room");
    expect(() => validateGatewayRuntimeProfileName("Bad Name")).toThrow(
      'Profile names must contain only lowercase letters, numbers, "_" or "-".',
    );
  });

  test("profile with no optional fields does not throw", () => {
    const resolved = resolveGatewayRuntimeProfile(
      "minimal",
      { runtime: "opencode" },
      "/tmp/profiles",
    );

    expect(resolved.name).toBe("minimal");
    expect(resolved.definition.runtime).toBe("opencode");
    expect(resolved.definition.args).toBeUndefined();
    expect(resolved.definition.env).toBeUndefined();
    expect(resolved.roots.home).toBe(path.join("/tmp/profiles", "opencode", "minimal"));
    expect(resolved.env.HOME).toBe(resolved.roots.home);
  });

  test("profile env overrides merge correctly with base runtime env", async () => {
    const resolved = await resolveGatewayRuntime("opencode", {
      resolver: {
        which(command) {
          if (command === "opencode") return "/usr/local/bin/opencode";
          return undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });

    const profile = resolveGatewayRuntimeProfile(
      "custom-env",
      {
        runtime: "opencode",
        env: {
          MY_CUSTOM_VAR: "custom-value",
          OPENCODE_DEBUG: "true",
        },
      },
      "/tmp/profiles",
    );

    const applied = applyGatewayRuntimeProfile(resolved, profile);

    // Profile env should include both XDG vars and custom vars
    expect(applied.acp.env).toBeDefined();
    expect(applied.acp.env?.HOME).toBe(profile.roots.home);
    expect(applied.acp.env?.XDG_CONFIG_HOME).toBe(profile.roots.config);
    expect(applied.acp.env?.MY_CUSTOM_VAR).toBe("custom-value");
    expect(applied.acp.env?.OPENCODE_DEBUG).toBe("true");
  });
});
