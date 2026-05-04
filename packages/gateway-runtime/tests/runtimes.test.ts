import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  applyGatewayRuntimeProfile,
  buildExtendedPath,
  detectInstalledGatewayRuntimes,
  getGatewayRuntimeDefinition,
  listGatewayRuntimeIds,
  resolveAcpAgentEntryToRuntime,
  resolveGatewayRuntime,
  resolveGatewayRuntimeCommand,
  resolveGatewayRuntimeProfile,
  resolveGatewayRuntimeSelection,
  resolveRuntimeArgs,
  validateGatewayRuntimeProfileName,
} from "../src/runtimes.ts";
import { createAcpHarness, DEFAULT_EXTRA_BIN_PATHS } from "../src/runtimes-registry.ts";

describe("@agents-js/gateway-runtime", () => {
  test("lists curated runtime definitions", () => {
    expect(getGatewayRuntimeDefinition("claude")).toMatchObject({
      id: "claude",
      command: "claude-agent-acp",
    });
    expect(getGatewayRuntimeDefinition("codex")).toMatchObject({
      id: "codex",
      command: "codex-acp",
      args: [],
      resolvesFromWorkspaceBin: true,
      install: {
        owner: "zed",
        packageName: "@zed-industries/codex-acp",
      },
    });
    expect(getGatewayRuntimeDefinition("pi")).toMatchObject({
      id: "pi",
      command: "pi-acp",
      args: [],
      resolvesFromWorkspaceBin: true,
      install: {
        owner: "agents-js",
        packageName: "@agents-js/pi-acp",
      },
    });
    expect(getGatewayRuntimeDefinition("droid")).toMatchObject({
      id: "droid",
      command: "droid-acp",
      args: [],
      resolvesFromWorkspaceBin: true,
      install: {
        owner: "agents-js",
        packageName: "@agents-js/droid-acp",
      },
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

  test("codex runtime has no workspace flag and no resolveArgs hook", () => {
    // codex-acp's CLI surface does not expose a workspace/cwd flag — it
    // derives the working directory from the spawning process. The
    // registry entry intentionally leaves `workspaceFlag` undefined.
    const codex = getGatewayRuntimeDefinition("codex");
    expect(codex.workspaceFlag).toBeUndefined();
    expect(codex.resolveArgs).toBeUndefined();
    expect(resolveRuntimeArgs(codex, {})).toEqual([]);
    // Env toggles that affect opencode do not affect codex.
    expect(resolveRuntimeArgs(codex, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual([]);
  });

  test("codex runtime has no defaultEnv (auth env passthrough is the host's job)", async () => {
    const resolved = await resolveGatewayRuntime("codex", {
      resolver: {
        which(command) {
          return command === "codex-acp" ? "/usr/local/bin/codex-acp" : undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });
    expect(resolved.acp.env).toBeUndefined();
    expect(resolved.acp.workspaceFlag).toBeUndefined();
    expect(resolved.acp.autoRecoverOpencodeDefaultAgent).toBeUndefined();
  });

  test("codex resolves from PATH when available", async () => {
    const resolved = await resolveGatewayRuntime("codex", {
      resolver: {
        which(command) {
          return command === "codex-acp" ? "/usr/local/bin/codex-acp" : undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });
    expect(resolved.acp.command).toBe("/usr/local/bin/codex-acp");
    expect(resolved.acp.args).toEqual([]);
  });

  test("codex resolves from workspace bin fallback when PATH is missing", async () => {
    const definition = getGatewayRuntimeDefinition("codex");
    const command = await resolveGatewayRuntimeCommand(definition, {
      workspaceBinRoot: "/repo/apps/internal-gateway",
      resolver: {
        which() {
          return undefined;
        },
        async fileExists(filePath) {
          return filePath.endsWith("/apps/internal-gateway/node_modules/.bin/codex-acp");
        },
      },
    });
    expect(command.endsWith("/apps/internal-gateway/node_modules/.bin/codex-acp")).toBe(true);
  });

  test("pi runtime has no workspace flag and no resolveArgs hook", () => {
    // pi-acp's CLI surface does not expose a workspace/cwd flag — the
    // adapter derives its working directory from the spawning process,
    // same as codex. `workspaceFlag` is intentionally left undefined.
    const pi = getGatewayRuntimeDefinition("pi");
    expect(pi.workspaceFlag).toBeUndefined();
    expect(pi.resolveArgs).toBeUndefined();
    expect(resolveRuntimeArgs(pi, {})).toEqual([]);
    // Env toggles that affect opencode do not affect pi.
    expect(resolveRuntimeArgs(pi, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual([]);
  });

  test("pi runtime has no defaultEnv (provider auth is pi's own responsibility)", async () => {
    // Pi manages provider credentials internally via its "/login" TUI and
    // ~/.pi config. No API-key env vars are forwarded by the gateway; the
    // adapter layer is stateless with respect to auth.
    const resolved = await resolveGatewayRuntime("pi", {
      resolver: {
        which(command) {
          return command === "pi-acp" ? "/usr/local/bin/pi-acp" : undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });
    expect(resolved.acp.env).toBeUndefined();
    expect(resolved.acp.workspaceFlag).toBeUndefined();
    expect(resolved.acp.autoRecoverOpencodeDefaultAgent).toBeUndefined();
  });

  test("pi resolves from PATH when available", async () => {
    const resolved = await resolveGatewayRuntime("pi", {
      resolver: {
        which(command) {
          return command === "pi-acp" ? "/usr/local/bin/pi-acp" : undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });
    expect(resolved.acp.command).toBe("/usr/local/bin/pi-acp");
    expect(resolved.acp.args).toEqual([]);
  });

  test("pi resolves from workspace bin fallback when PATH is missing", async () => {
    const definition = getGatewayRuntimeDefinition("pi");
    const command = await resolveGatewayRuntimeCommand(definition, {
      workspaceBinRoot: "/repo/apps/internal-gateway",
      resolver: {
        which() {
          return undefined;
        },
        async fileExists(filePath) {
          return filePath.endsWith("/apps/internal-gateway/node_modules/.bin/pi-acp");
        },
      },
    });
    expect(command.endsWith("/apps/internal-gateway/node_modules/.bin/pi-acp")).toBe(true);
  });

  test("droid runtime has no workspace flag and no resolveArgs hook", () => {
    // droid-acp forwards ACP's NewSessionRequest cwd directly into each
    // per-turn `droid exec --cwd` invocation, so the runtime entry leaves
    // workspaceFlag undefined at the gateway layer (same rationale as codex / pi).
    const droid = getGatewayRuntimeDefinition("droid");
    expect(droid.workspaceFlag).toBeUndefined();
    expect(droid.resolveArgs).toBeUndefined();
    expect(resolveRuntimeArgs(droid, {})).toEqual([]);
    // Env toggles that affect opencode do not affect droid.
    expect(resolveRuntimeArgs(droid, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual([]);
  });

  test("droid runtime declares FACTORY_API_KEY as the auth env key", () => {
    const droid = getGatewayRuntimeDefinition("droid");
    expect(droid.authEnvKeys).toEqual(["FACTORY_API_KEY"]);
  });

  test("droid runtime has no defaultEnv (auth passthrough via authEnvKeys is the host's job)", async () => {
    const resolved = await resolveGatewayRuntime("droid", {
      resolver: {
        which(command) {
          return command === "droid-acp" ? "/usr/local/bin/droid-acp" : undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });
    expect(resolved.acp.env).toBeUndefined();
    expect(resolved.acp.workspaceFlag).toBeUndefined();
    expect(resolved.acp.autoRecoverOpencodeDefaultAgent).toBeUndefined();
  });

  test("droid resolves from PATH when available", async () => {
    const resolved = await resolveGatewayRuntime("droid", {
      resolver: {
        which(command) {
          return command === "droid-acp" ? "/usr/local/bin/droid-acp" : undefined;
        },
        async fileExists() {
          return false;
        },
      },
    });
    expect(resolved.acp.command).toBe("/usr/local/bin/droid-acp");
    expect(resolved.acp.args).toEqual([]);
  });

  test("droid resolves from workspace bin fallback when PATH is missing", async () => {
    const definition = getGatewayRuntimeDefinition("droid");
    const command = await resolveGatewayRuntimeCommand(definition, {
      workspaceBinRoot: "/repo/apps/internal-gateway",
      resolver: {
        which() {
          return undefined;
        },
        async fileExists(filePath) {
          return filePath.endsWith("/apps/internal-gateway/node_modules/.bin/droid-acp");
        },
      },
    });
    expect(command.endsWith("/apps/internal-gateway/node_modules/.bin/droid-acp")).toBe(true);
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
      // opencode seeds telemetry opt-outs via `GatewayRuntimeDefinition.defaultEnv`.
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

  test.each<{ runtimeId: "claude" | "codex"; expectedCommand: string }>([
    { runtimeId: "claude", expectedCommand: "claude-agent-acp" },
    { runtimeId: "codex", expectedCommand: "codex-acp" },
  ])("prefers packaged $runtimeId adapter over a machine PATH adapter", async ({
    runtimeId,
    expectedCommand,
  }) => {
    const definition = getGatewayRuntimeDefinition(runtimeId);
    const installRoot = "/tmp/agents-js-install";
    const expectedPath = path.join(installRoot, "node_modules", ".bin", expectedCommand);

    const command = await resolveGatewayRuntimeCommand(definition, {
      binSearchRoots: [path.join(installRoot, "node_modules", "@agents-js", "cli")],
      resolver: {
        which(commandName) {
          return commandName === expectedCommand ? `/usr/local/bin/${expectedCommand}` : undefined;
        },
        async fileExists(filePath) {
          return filePath === expectedPath;
        },
      },
    });

    expect(command).toBe(expectedPath);
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

  test.each<{ runtimeId: "pi" | "droid"; expectedCommand: string; expectedPackage: string }>([
    { runtimeId: "pi", expectedCommand: "pi-acp", expectedPackage: "@agents-js/pi-acp" },
    { runtimeId: "droid", expectedCommand: "droid-acp", expectedPackage: "@agents-js/droid-acp" },
  ])("resolves $runtimeId from the package bin path when workspace .bin link is absent", async ({
    runtimeId,
    expectedCommand,
    expectedPackage,
  }) => {
    const definition = getGatewayRuntimeDefinition(runtimeId);
    const installRoot = "/tmp/agents-js-install";
    const expectedPath = path.join(
      installRoot,
      "node_modules",
      expectedPackage,
      "dist",
      expectedCommand,
    );
    const seenPaths: string[] = [];
    const command = await resolveGatewayRuntimeCommand(definition, {
      workspaceBinRoot: installRoot,
      resolver: {
        which() {
          return undefined;
        },
        async fileExists(filePath) {
          seenPaths.push(filePath);
          return filePath === expectedPath;
        },
      },
    });

    expect(command).toBe(expectedPath);
    expect(seenPaths).toEqual([
      path.join(installRoot, "node_modules", ".bin", expectedCommand),
      expectedPath,
    ]);
  });

  test.each<{ runtimeId: "claude" | "codex"; expectedCommand: string }>([
    { runtimeId: "claude", expectedCommand: "claude-agent-acp" },
    { runtimeId: "codex", expectedCommand: "codex-acp" },
  ])("resolves $runtimeId from explicit package bin roots when PATH is missing", async ({
    runtimeId,
    expectedCommand,
  }) => {
    const definition = getGatewayRuntimeDefinition(runtimeId);
    const installRoot = "/tmp/agents-js-install";
    const expectedPath = path.join(installRoot, "node_modules", ".bin", expectedCommand);
    const command = await resolveGatewayRuntimeCommand(definition, {
      binSearchRoots: [path.join(installRoot, "node_modules", "@agents-js", "cli")],
      resolver: {
        which() {
          return undefined;
        },
        async fileExists(filePath) {
          return filePath === expectedPath;
        },
      },
    });

    expect(command).toBe(expectedPath);
  });

  test.each<{ runtimeId: "opencode" | "gemini"; expectedCommand: string }>([
    { runtimeId: "opencode", expectedCommand: "opencode" },
    { runtimeId: "gemini", expectedCommand: "gemini" },
  ])("does not package-bin fallback for $runtimeId", async ({ runtimeId, expectedCommand }) => {
    const definition = getGatewayRuntimeDefinition(runtimeId);
    const installRoot = "/tmp/agents-js-install";
    const seenPaths: string[] = [];

    await expect(
      resolveGatewayRuntimeCommand(definition, {
        binSearchRoots: [path.join(installRoot, "node_modules", "@agents-js", "cli")],
        resolver: {
          which() {
            return undefined;
          },
          async fileExists(filePath) {
            seenPaths.push(filePath);
            return filePath === path.join(installRoot, "node_modules", ".bin", expectedCommand);
          },
        },
      }),
    ).rejects.toThrow(`Runtime "${runtimeId}" could not resolve executable "${expectedCommand}"`);

    expect(seenPaths).toEqual([]);
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

  describe("resolveAcpAgentEntryToRuntime", () => {
    test("overlays args, env, and workspaceFlag onto a curated harness", async () => {
      const resolved = await resolveAcpAgentEntryToRuntime(
        {
          harness: "codex",
          args: ["--from-registry"],
          env: { CODEX_HOME: "/tmp/codex" },
          workspaceFlag: "--worktree",
        },
        {
          resolver: {
            which(command) {
              return command === "codex-acp" ? "/usr/local/bin/codex-acp" : undefined;
            },
            async fileExists() {
              return false;
            },
          },
        },
      );

      expect(resolved.definition.id).toBe("codex");
      expect(resolved.acp.command).toBe("/usr/local/bin/codex-acp");
      expect(resolved.acp.args).toEqual(["--from-registry"]);
      expect(resolved.acp.env).toEqual({ CODEX_HOME: "/tmp/codex" });
      expect(resolved.acp.workspaceFlag).toBe("--worktree");
    });

    test("selects a custom command entry without duplicating args", async () => {
      const resolved = await resolveAcpAgentEntryToRuntime(
        {
          harness: "partner-acp",
          name: "Partner ACP",
          command: "/tmp/partner-acp",
          args: ["--stdio"],
          env: { PARTNER_MODE: "registry" },
          workspaceFlag: "--project",
        },
        {
          resolver: {
            which() {
              return undefined;
            },
            async fileExists(filePath) {
              return filePath === "/tmp/partner-acp";
            },
          },
        },
      );

      expect(resolved.definition.id).toBe("custom");
      expect(resolved.definition.displayName).toBe("Partner ACP");
      expect(resolved.acp).toEqual({
        command: "/tmp/partner-acp",
        args: ["--stdio"],
        env: { PARTNER_MODE: "registry" },
        workspaceFlag: "--project",
      });
    });

    test("merges entry env while preserving curated default env and workspaceFlag", async () => {
      const resolved = await resolveAcpAgentEntryToRuntime(
        {
          harness: "opencode",
          env: {
            OMO_DISABLE_POSTHOG: "0",
            OPENCODE_PROFILE: "registry",
          },
        },
        {
          resolver: {
            which(command) {
              return command === "opencode" ? "/usr/local/bin/opencode" : undefined;
            },
            async fileExists() {
              return false;
            },
          },
        },
      );

      expect(resolved.acp.workspaceFlag).toBe("--cwd");
      expect(resolved.acp.env).toEqual({
        OMO_SEND_ANONYMOUS_TELEMETRY: "0",
        OMO_DISABLE_POSTHOG: "0",
        OPENCODE_PROFILE: "registry",
      });
    });

    test("throws when an unknown harness has no explicit command override", async () => {
      await expect(
        resolveAcpAgentEntryToRuntime({
          harness: "missing-harness",
        }),
      ).rejects.toThrow('ACP registry entry harness "missing-harness" is not a curated runtime');
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
      // the profile's XDG roots + explicit env merge on top. `OPENCODE_PROFILE`
      // and the XDG vars come from the profile; the OMO_* entries come from
      // the runtime definition.
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

  describe("opencode plugins-default + AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS opt-in", () => {
    test("omits --pure by default (plugins load normally)", () => {
      const definition = getGatewayRuntimeDefinition("opencode");
      expect(resolveRuntimeArgs(definition, {})).toEqual([
        "acp",
        "--print-logs",
        "--log-level",
        "INFO",
      ]);
    });

    test("appends --pure when AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS=1", () => {
      const definition = getGatewayRuntimeDefinition("opencode");
      expect(
        resolveRuntimeArgs(definition, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1" }),
      ).toEqual(["acp", "--pure", "--print-logs", "--log-level", "INFO"]);
    });

    test("appends --pure when AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS=true", () => {
      const definition = getGatewayRuntimeDefinition("opencode");
      expect(
        resolveRuntimeArgs(definition, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "true" }),
      ).toEqual(["acp", "--pure", "--print-logs", "--log-level", "INFO"]);
    });

    test("leaves --pure absent for other truthy-looking values (strict opt-in)", () => {
      // Only "1" and "true" activate --pure; other values keep the default behavior.
      const definition = getGatewayRuntimeDefinition("opencode");
      expect(
        resolveRuntimeArgs(definition, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "0" }),
      ).toEqual(["acp", "--print-logs", "--log-level", "INFO"]);
      expect(resolveRuntimeArgs(definition, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "" })).toEqual(
        ["acp", "--print-logs", "--log-level", "INFO"],
      );
    });

    test("does not affect non-opencode runtimes", () => {
      const claude = getGatewayRuntimeDefinition("claude");
      const codex = getGatewayRuntimeDefinition("codex");
      const pi = getGatewayRuntimeDefinition("pi");
      const droid = getGatewayRuntimeDefinition("droid");
      const gemini = getGatewayRuntimeDefinition("gemini");
      expect(resolveRuntimeArgs(claude, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1" })).toEqual(
        [],
      );
      expect(resolveRuntimeArgs(codex, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1" })).toEqual([]);
      expect(resolveRuntimeArgs(pi, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1" })).toEqual([]);
      expect(resolveRuntimeArgs(droid, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1" })).toEqual([]);
      expect(resolveRuntimeArgs(gemini, { AJS_OPENCODE_DISABLE_EXTERNAL_PLUGINS: "1" })).toEqual([
        "--acp",
      ]);
    });
  });

  describe("opencode runtime log flags via AJS_RUNTIME_LOG_LEVEL", () => {
    test("defaults to --print-logs --log-level INFO when env var is absent", () => {
      const definition = getGatewayRuntimeDefinition("opencode");
      expect(resolveRuntimeArgs(definition, {})).toEqual([
        "acp",
        "--print-logs",
        "--log-level",
        "INFO",
      ]);
    });

    test("AJS_RUNTIME_LOG_LEVEL=debug → --log-level DEBUG (case-insensitive)", () => {
      const definition = getGatewayRuntimeDefinition("opencode");
      expect(resolveRuntimeArgs(definition, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual([
        "acp",
        "--print-logs",
        "--log-level",
        "DEBUG",
      ]);
    });

    test("AJS_RUNTIME_LOG_LEVEL=silent omits both log flags", () => {
      const definition = getGatewayRuntimeDefinition("opencode");
      expect(resolveRuntimeArgs(definition, { AJS_RUNTIME_LOG_LEVEL: "silent" })).toEqual(["acp"]);
    });

    test("AJS_RUNTIME_LOG_LEVEL=off aliases to silent (no log flags)", () => {
      const definition = getGatewayRuntimeDefinition("opencode");
      expect(resolveRuntimeArgs(definition, { AJS_RUNTIME_LOG_LEVEL: "off" })).toEqual(["acp"]);
    });

    test("unknown AJS_RUNTIME_LOG_LEVEL value falls back to INFO without throwing", () => {
      const definition = getGatewayRuntimeDefinition("opencode");
      // Capture the fallback warning so the test output stays clean.
      const originalWrite = process.stderr.write.bind(process.stderr);
      const warnings: string[] = [];
      // biome-ignore lint/suspicious/noExplicitAny: test stub needs the overloaded signature
      (process.stderr as any).write = (chunk: string | Uint8Array) => {
        warnings.push(typeof chunk === "string" ? chunk : chunk.toString());
        return true;
      };
      try {
        expect(resolveRuntimeArgs(definition, { AJS_RUNTIME_LOG_LEVEL: "bogus" })).toEqual([
          "acp",
          "--print-logs",
          "--log-level",
          "INFO",
        ]);
        expect(warnings.some((line) => line.includes("Unknown AJS_RUNTIME_LOG_LEVEL"))).toBe(true);
      } finally {
        process.stderr.write = originalWrite;
      }
    });

    test("non-opencode runtimes ignore AJS_RUNTIME_LOG_LEVEL", () => {
      const claude = getGatewayRuntimeDefinition("claude");
      const codex = getGatewayRuntimeDefinition("codex");
      const pi = getGatewayRuntimeDefinition("pi");
      const droid = getGatewayRuntimeDefinition("droid");
      const gemini = getGatewayRuntimeDefinition("gemini");
      expect(resolveRuntimeArgs(claude, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual([]);
      expect(resolveRuntimeArgs(codex, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual([]);
      expect(resolveRuntimeArgs(pi, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual([]);
      expect(resolveRuntimeArgs(droid, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual([]);
      expect(resolveRuntimeArgs(gemini, { AJS_RUNTIME_LOG_LEVEL: "debug" })).toEqual(["--acp"]);
    });
  });

  describe("runtime hygiene defaults (defaultEnv + opencode auto-recovery flag)", () => {
    async function resolveWithStubPath(runtimeId: "opencode" | "claude" | "gemini") {
      const definition = getGatewayRuntimeDefinition(runtimeId);
      return await resolveGatewayRuntime(runtimeId, {
        resolver: {
          which(command) {
            return command === definition.command ? `/usr/local/bin/${command}` : undefined;
          },
          async fileExists() {
            return false;
          },
        },
      });
    }

    test("opencode seeds telemetry opt-out env + autoRecover flag", async () => {
      const resolved = await resolveWithStubPath("opencode");
      expect(resolved.acp.env).toEqual({
        OMO_SEND_ANONYMOUS_TELEMETRY: "0",
        OMO_DISABLE_POSTHOG: "1",
      });
      expect(resolved.acp.autoRecoverOpencodeDefaultAgent).toBe(true);
    });

    test("claude, codex, pi, droid, and gemini do not seed telemetry env and do not opt-in to auto-recovery", async () => {
      // claude needs to resolve from workspace bin — stub both which + fileExists.
      const claude = await resolveGatewayRuntime("claude", {
        resolver: {
          which(command) {
            return command === "claude-agent-acp" ? "/usr/local/bin/claude-agent-acp" : undefined;
          },
          async fileExists() {
            return false;
          },
        },
      });
      expect(claude.acp.env).toBeUndefined();
      expect(claude.acp.autoRecoverOpencodeDefaultAgent).toBeUndefined();

      const codex = await resolveGatewayRuntime("codex", {
        resolver: {
          which(command) {
            return command === "codex-acp" ? "/usr/local/bin/codex-acp" : undefined;
          },
          async fileExists() {
            return false;
          },
        },
      });
      expect(codex.acp.env).toBeUndefined();
      expect(codex.acp.autoRecoverOpencodeDefaultAgent).toBeUndefined();

      const pi = await resolveGatewayRuntime("pi", {
        resolver: {
          which(command) {
            return command === "pi-acp" ? "/usr/local/bin/pi-acp" : undefined;
          },
          async fileExists() {
            return false;
          },
        },
      });
      expect(pi.acp.env).toBeUndefined();
      expect(pi.acp.autoRecoverOpencodeDefaultAgent).toBeUndefined();

      const droid = await resolveGatewayRuntime("droid", {
        resolver: {
          which(command) {
            return command === "droid-acp" ? "/usr/local/bin/droid-acp" : undefined;
          },
          async fileExists() {
            return false;
          },
        },
      });
      expect(droid.acp.env).toBeUndefined();
      expect(droid.acp.autoRecoverOpencodeDefaultAgent).toBeUndefined();

      const gemini = await resolveWithStubPath("gemini");
      expect(gemini.acp.env).toBeUndefined();
      expect(gemini.acp.autoRecoverOpencodeDefaultAgent).toBeUndefined();
    });

    test("profile env merges on top of defaultEnv — profile wins on conflict", async () => {
      // Seed a profile that explicitly overrides one of opencode's telemetry
      // defaults. The resolver must allow profile-level intent to win.
      const resolved = await resolveWithStubPath("opencode");
      const profiled = applyGatewayRuntimeProfile(
        resolved,
        resolveGatewayRuntimeProfile(
          "override-telemetry",
          {
            runtime: "opencode",
            env: {
              // Operator explicitly re-enables telemetry for their environment.
              OMO_SEND_ANONYMOUS_TELEMETRY: "1",
              // And adds a fresh key that does not collide with defaultEnv.
              OPENCODE_CUSTOM_FLAG: "yes",
            },
          },
          "/tmp/agents-js-profiles",
        ),
      );

      // Profile value wins on conflict; non-conflicting defaultEnv entry
      // survives; profile-only key lands untouched.
      expect(profiled.acp.env?.OMO_SEND_ANONYMOUS_TELEMETRY).toBe("1");
      expect(profiled.acp.env?.OMO_DISABLE_POSTHOG).toBe("1");
      expect(profiled.acp.env?.OPENCODE_CUSTOM_FLAG).toBe("yes");
      // autoRecover flag survives the profile merge (not an env field).
      expect(profiled.acp.autoRecoverOpencodeDefaultAgent).toBe(true);
    });
  });

  test("profile with no optional fields does not throw", () => {
    const resolved = resolveGatewayRuntimeProfile(
      "minimal",
      { runtime: "opencode" },
      "/tmp/profiles",
    );

    expect(resolved.name).toBe("minimal");
  });

  describe("createAcpHarness factory", () => {
    test("returns a GatewayRuntimeDefinition with defaulted args and passthrough fields", () => {
      const definition = createAcpHarness({
        id: "fake",
        displayName: "Fake ACP",
        description: "Test harness",
        command: "fake-acp",
        install: {
          owner: "external",
          installHint: 'Install "fake-acp" on PATH.',
        },
        resolvesFromWorkspaceBin: true,
        authEnvKeys: ["FAKE_API_KEY"],
      });

      expect(definition).toEqual({
        id: "fake",
        displayName: "Fake ACP",
        description: "Test harness",
        command: "fake-acp",
        args: [],
        install: {
          owner: "external",
          installHint: 'Install "fake-acp" on PATH.',
        },
        resolvesFromWorkspaceBin: true,
        authEnvKeys: ["FAKE_API_KEY"],
      });
    });

    test("omits optional fields from the output shape rather than setting them to undefined", () => {
      const definition = createAcpHarness({
        id: "bare",
        displayName: "Bare",
        description: "Minimal harness",
        command: "bare-acp",
        install: { owner: "external", installHint: 'Install "bare-acp" on PATH.' },
        resolvesFromWorkspaceBin: false,
      });

      // Keys for optional fields should not be present at all, matching the
      // pre-refactor hand-written registry entries that simply omitted them.
      expect("workspaceFlag" in definition).toBe(false);
      expect("defaultEnv" in definition).toBe(false);
      expect("resolveArgs" in definition).toBe(false);
      expect("authEnvKeys" in definition).toBe(false);
    });

    test("copies args and defaultEnv so caller mutations do not leak into the definition", () => {
      const argsInput = ["--one"];
      const envInput = { FOO: "bar" };
      const definition = createAcpHarness({
        id: "copy",
        displayName: "Copy",
        description: "Copy test",
        command: "copy-acp",
        install: { owner: "external", installHint: "Install copy-acp." },
        resolvesFromWorkspaceBin: false,
        args: argsInput,
        defaultEnv: envInput,
      });

      argsInput.push("--mutated");
      (envInput as Record<string, string>).FOO = "mutated";

      expect(definition.args).toEqual(["--one"]);
      expect(definition.defaultEnv).toEqual({ FOO: "bar" });
    });
  });

  describe("per-harness authEnvKeys invariants", () => {
    test("codex declares CODEX_API_KEY and OPENAI_API_KEY", () => {
      // Regression guard: if someone forgets to re-declare the codex auth
      // keys when restructuring the registry, downstream host composition
      // silently stops forwarding credentials at spawn time.
      const codex = getGatewayRuntimeDefinition("codex");
      expect(codex.authEnvKeys).toEqual(["CODEX_API_KEY", "OPENAI_API_KEY"]);
    });

    test("droid declares FACTORY_API_KEY", () => {
      // Regression guard: droid-acp authenticates via FACTORY_API_KEY. If
      // the registry entry drops this, the host stops forwarding credentials
      // and droid fails to authenticate at spawn time.
      const droid = getGatewayRuntimeDefinition("droid");
      expect(droid.authEnvKeys).toEqual(["FACTORY_API_KEY"]);
    });

    test("pi declares no authEnvKeys (pi manages credentials out-of-band)", () => {
      // Pi stores credentials under ~/.pi via its /login TUI; no env-var
      // passthrough is intended. If this regresses (e.g. someone adds
      // `authEnvKeys: ["PI_API_KEY"]` to the pi entry), revisit the pi
      // architectural note in `packages/gateway-runtime/src/runtimes.ts`.
      const pi = getGatewayRuntimeDefinition("pi");
      expect(pi.authEnvKeys).toBeUndefined();
    });

    test("claude declares no harness-specific authEnvKeys", () => {
      // claude-agent-acp reads ANTHROPIC_API_KEY via the shared baseline
      // applied by the host composition layer; it does not need a
      // harness-specific key.
      const claude = getGatewayRuntimeDefinition("claude");
      expect(claude.authEnvKeys).toBeUndefined();
    });

    test("every curated harness's authEnvKeys (when set) are non-empty strings", () => {
      // Structural invariant: an empty array or empty-string entry would be
      // a registry mistake — it adds nothing to the host policy and only
      // fuels future confusion about whether a harness needs a credential.
      for (const id of listGatewayRuntimeIds()) {
        const def = getGatewayRuntimeDefinition(id);
        if (def.authEnvKeys === undefined) continue;
        expect(def.authEnvKeys.length).toBeGreaterThan(0);
        for (const key of def.authEnvKeys) {
          expect(typeof key).toBe("string");
          expect(key.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("PATH augmentation for runtime resolution", () => {
    // Regression: when the gateway was launched from a PATH-light context
    // (Dock / Spotlight / IDE child shell), Bun.which("codex-acp") and
    // Bun.which("gemini") returned null even though the binaries were
    // installed under `~/.local/share/mise/shims`. The fix extends the
    // lookup PATH with DEFAULT_EXTRA_BIN_PATHS so common tool roots are
    // always considered. Keeping this test ensures the list stays populated
    // and the helper continues to de-duplicate + preserve order.
    test("DEFAULT_EXTRA_BIN_PATHS includes mise shims + bun/homebrew roots", () => {
      expect(DEFAULT_EXTRA_BIN_PATHS).toContain("/opt/homebrew/bin");
      expect(DEFAULT_EXTRA_BIN_PATHS).toContain("/usr/local/bin");
      const asArray = [...DEFAULT_EXTRA_BIN_PATHS];
      expect(asArray.some((p) => p.endsWith("/.local/share/mise/shims"))).toBe(true);
      expect(asArray.some((p) => p.endsWith("/.local/bin"))).toBe(true);
      expect(asArray.some((p) => p.endsWith("/.bun/bin"))).toBe(true);
    });

    // biome-ignore lint/suspicious/noTemplateCurlyInString: describing the literal ${HOME} placeholder used in DEFAULT_EXTRA_BIN_PATHS
    test("buildExtendedPath resolves ${HOME} against process.env.HOME", () => {
      const home = process.env.HOME ?? "";
      const result = buildExtendedPath(undefined);
      if (home) {
        expect(result.split(":")).toContain(`${home}/.local/share/mise/shims`);
      }
      // Sanity: raw placeholder should never leak into the resolved PATH.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting the literal placeholder is absent from the resolved string
      expect(result).not.toContain("${HOME}");
    });

    test("buildExtendedPath preserves base PATH order and appends defaults", () => {
      const base = "/first:/second:/opt/homebrew/bin";
      const result = buildExtendedPath(base);
      const entries = result.split(":");
      // Base entries keep their leading position...
      expect(entries.slice(0, 3)).toEqual(["/first", "/second", "/opt/homebrew/bin"]);
      // ...and /opt/homebrew/bin is not duplicated even though DEFAULT_EXTRA_BIN_PATHS includes it.
      expect(entries.filter((p) => p === "/opt/homebrew/bin").length).toBe(1);
    });

    test("buildExtendedPath de-duplicates caller-supplied extras", () => {
      const result = buildExtendedPath("/a:/b", ["/b", "/c"]);
      const entries = result.split(":");
      expect(entries).toEqual(expect.arrayContaining(["/a", "/b", "/c"]));
      expect(entries.filter((p) => p === "/b").length).toBe(1);
    });

    test("buildExtendedPath drops empty segments from a malformed base PATH", () => {
      // Some launch contexts emit empty segments (":/usr/bin:"), which would
      // otherwise pollute the resolved PATH with `""` entries that Bun.which
      // silently treats as `cwd`.
      const result = buildExtendedPath(":/usr/bin:");
      expect(result.split(":")).not.toContain("");
    });
  });
});
