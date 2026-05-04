import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentsJsConfig } from "../src/config.ts";
import { resolveAndApplyGatewayRuntime } from "../src/resolve-and-apply.ts";
import type { RuntimeCommandResolver } from "../src/runtimes-registry.ts";

/**
 * The helper under test takes a ProfileLookupContext shaped after
 * `loadAgentsJsConfig` output. We don't need a fully loaded config — we just
 * need:
 *   - configPaths.userConfigPath / projectConfigPath (used by
 *     findConfiguredProfile to locate `<dir>/profiles/<name>` for asset
 *     resolution; the profile body itself is read from `userConfig` /
 *     `projectConfig`).
 *   - userConfig / projectConfig with `profiles[name]` entries, OR no
 *     entries (the missing-profile case).
 */

const opencodeResolver: RuntimeCommandResolver = {
  which(command) {
    if (command === "opencode") {
      return "/usr/local/bin/opencode";
    }
    return undefined;
  },
  async fileExists() {
    return false;
  },
};

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "agents-js-resolve-and-apply-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Defensive: clean any AJS_* env vars the test might have left behind.
  delete process.env.AJS_RUNTIME_LOG_LEVEL;
  delete process.env.AJS_DEFAULT_MODEL;
  delete process.env.AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS;
});

function writeConfig(filePath: string, config: AgentsJsConfig): void {
  writeFileSync(filePath, JSON.stringify(config, null, 2));
}

function makeConfigPaths(): { userConfigPath: string; projectConfigPath: string } {
  const userPath = path.join(tmpRoot, "user-config.json");
  const projectPath = path.join(tmpRoot, "project-config.json");
  writeConfig(userPath, {});
  writeConfig(projectPath, {});
  return { userConfigPath: userPath, projectConfigPath: projectPath };
}

describe("resolveAndApplyGatewayRuntime", () => {
  test("resolves a curated runtime when no env override is present", async () => {
    const env: NodeJS.ProcessEnv = {};
    const runtime = await resolveAndApplyGatewayRuntime({
      selection: { kind: "curated", runtime: "opencode" },
      envOverrides: {},
      env,
      resolver: opencodeResolver,
    });

    expect(runtime.definition.id).toBe("opencode");
    expect(runtime.acp.command).toBe("/usr/local/bin/opencode");
    // env was untouched (no overrides) and is empty after the helper returns.
    expect(env.AJS_RUNTIME_LOG_LEVEL).toBeUndefined();
    expect(env.AJS_DEFAULT_MODEL).toBeUndefined();
  });

  test("env override is applied during resolution and restored before returning", async () => {
    const env: NodeJS.ProcessEnv = {
      AJS_RUNTIME_LOG_LEVEL: "info",
    };
    let observedDuringResolve: string | undefined;

    const observingResolver: RuntimeCommandResolver = {
      which(command) {
        if (command === "opencode") {
          observedDuringResolve = env.AJS_RUNTIME_LOG_LEVEL;
          return "/usr/local/bin/opencode";
        }
        return undefined;
      },
      async fileExists() {
        return false;
      },
    };

    await resolveAndApplyGatewayRuntime({
      selection: { kind: "curated", runtime: "opencode" },
      envOverrides: { runtimeLogLevel: "debug" },
      env,
      resolver: observingResolver,
    });

    // Override in effect during resolution.
    expect(observedDuringResolve).toBe("debug");
    // Restored to original after the helper returns.
    expect(env.AJS_RUNTIME_LOG_LEVEL).toBe("info");
  });

  test("env is restored even when resolution throws", async () => {
    const env: NodeJS.ProcessEnv = {};
    const failingResolver: RuntimeCommandResolver = {
      which() {
        return undefined;
      },
      async fileExists() {
        return false;
      },
    };

    await expect(
      resolveAndApplyGatewayRuntime({
        selection: { kind: "curated", runtime: "opencode" },
        envOverrides: { defaultModel: "ephemeral" },
        env,
        resolver: failingResolver,
      }),
    ).rejects.toThrow();

    // Override was applied then restored to undefined.
    expect(env.AJS_DEFAULT_MODEL).toBeUndefined();
  });

  test("applies a configured profile when profileLookup is provided", async () => {
    const { userConfigPath, projectConfigPath } = makeConfigPaths();
    const projectConfig: AgentsJsConfig = {
      profiles: {
        "clean-room": {
          runtime: "opencode",
          args: ["--isolated"],
          env: { OPENCODE_PROFILE: "clean-room" },
        },
      },
    };
    writeConfig(projectConfigPath, projectConfig);

    const runtime = await resolveAndApplyGatewayRuntime({
      selection: {
        kind: "curated",
        runtime: "opencode",
        profile: "clean-room",
      },
      envOverrides: {},
      env: {},
      resolver: opencodeResolver,
      profileLookup: {
        configPaths: {
          userConfigPath,
          projectConfigPath,
          projectExamplePath: path.join(tmpRoot, "example.json"),
        },
        projectConfig,
      },
    });

    // Profile args appended after the runtime's base args.
    expect(runtime.acp.args).toContain("--isolated");
    // Profile env merged on top.
    expect(runtime.acp.env?.OPENCODE_PROFILE).toBe("clean-room");
  });

  test("onMissingProfile=skip leaves runtime unmodified when profile is unknown", async () => {
    const { userConfigPath, projectConfigPath } = makeConfigPaths();

    const runtime = await resolveAndApplyGatewayRuntime({
      selection: {
        kind: "curated",
        runtime: "opencode",
        profile: "nonexistent",
      },
      envOverrides: {},
      env: {},
      resolver: opencodeResolver,
      profileLookup: {
        configPaths: {
          userConfigPath,
          projectConfigPath,
          projectExamplePath: path.join(tmpRoot, "example.json"),
        },
      },
      onMissingProfile: "skip",
    });

    // No profile-specific args/env applied.
    expect(runtime.acp.args).not.toContain("--isolated");
    expect(runtime.acp.env?.OPENCODE_PROFILE).toBeUndefined();
  });

  test("onMissingProfile=throw raises when profile is unknown", async () => {
    const { userConfigPath, projectConfigPath } = makeConfigPaths();

    await expect(
      resolveAndApplyGatewayRuntime({
        selection: {
          kind: "curated",
          runtime: "opencode",
          profile: "nonexistent",
        },
        envOverrides: {},
        env: {},
        resolver: opencodeResolver,
        profileLookup: {
          configPaths: {
            userConfigPath,
            projectConfigPath,
            projectExamplePath: path.join(tmpRoot, "example.json"),
          },
        },
        onMissingProfile: "throw",
      }),
    ).rejects.toThrow(/Runtime profile "nonexistent" could not be resolved after setup\./);
  });

  test("env is restored even when applyGatewayRuntimeProfile throws on a runtime mismatch", async () => {
    const { userConfigPath, projectConfigPath } = makeConfigPaths();
    // Profile targets claude but the selection is opencode — resolveGatewayRuntimeProfile
    // / applyGatewayRuntimeProfile must reject the mismatch.
    const projectConfig: AgentsJsConfig = {
      profiles: {
        mismatched: {
          runtime: "claude",
        },
      },
    };
    writeConfig(projectConfigPath, projectConfig);

    const env: NodeJS.ProcessEnv = {};

    await expect(
      resolveAndApplyGatewayRuntime({
        selection: {
          kind: "curated",
          runtime: "opencode",
          profile: "mismatched",
        },
        envOverrides: { defaultModel: "x" },
        env,
        resolver: opencodeResolver,
        profileLookup: {
          configPaths: {
            userConfigPath,
            projectConfigPath,
            projectExamplePath: path.join(tmpRoot, "example.json"),
          },
          projectConfig,
        },
      }),
    ).rejects.toThrow();

    expect(env.AJS_DEFAULT_MODEL).toBeUndefined();
  });

  test("skips profile application when profileLookup is omitted", async () => {
    // bridge's call shape: selection has no `profile`, and no profileLookup.
    const runtime = await resolveAndApplyGatewayRuntime({
      selection: { kind: "curated", runtime: "opencode" },
      envOverrides: {},
      env: {},
      resolver: opencodeResolver,
    });
    expect(runtime.acp.args).not.toContain("--isolated");
  });
});
