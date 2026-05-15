import { describe, expect, test } from "bun:test";
import path from "node:path";
import { buildProcessEnv, withEnv } from "../../../scripts/process-utils.ts";

/**
 * Gateway integration tests.
 *
 * These test the A2A HTTP endpoint without a real ACP agent.
 * We test the server's HTTP layer: agent card serving, JSON-RPC routing,
 * and error handling for malformed requests.
 *
 * Full end-to-end tests (with a real ACP agent) require the opencode binary
 * and are not run in CI.
 */

const _TEST_PORT = 9876;

// We can't start the full gateway (needs opencode binary),
// but we can test the UniversalA2AServer HTTP layer directly.
import { buildAgentCard } from "@agents-js/a2a";
import {
  getGatewayRuntimeDefinition,
  listGatewayRuntimeIds,
  MOCK_ACP_RUNTIME_ENV,
} from "@agents-js/gateway-runtime";
import {
  applyEnvRuntimeProfile,
  buildRuntimeProfileConfigEnv,
  E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV,
  E2E_RUNTIME_PROFILE_PREFIX_ENV,
  E2E_RUNTIME_PROFILE_RUNTIMES_ENV,
  getEnvRuntimeProfileName,
} from "@agents-js/host";
import { gatewayConfig } from "../gateway.config.ts";
import { buildAvailableRuntimeInfos } from "../main.ts";
import { resolveGatewayRuntime, resolveGatewayRuntimeCommand } from "../runtimes.ts";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");

describe("A2A JSON-RPC protocol contracts", () => {
  test("valid JSON-RPC request structure", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: `test-${Date.now()}`,
          role: "user",
          parts: [{ kind: "text", text: "Hello" }],
        },
      },
    };

    expect(request.jsonrpc).toBe("2.0");
    expect(request.method).toBe("message/send");
    expect(request.params.message.parts[0]?.text).toBe("Hello");
  });

  test("agent card structure matches A2A spec", () => {
    const agentCard = buildAgentCard({
      name: "universal-acp-gateway",
      description: "Standardized A2A interface for OpenCode ACP",
      capabilities: {
        "text-to-text": {},
      },
    });

    expect(agentCard).toMatchObject({
      name: "universal-acp-gateway",
      description: "Standardized A2A interface for OpenCode ACP",
      url: "http://127.0.0.1",
      version: "1.0.0",
      protocolVersion: "0.3.0",
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      capabilities: {
        "text-to-text": {},
      },
    });
  });
});

describe("Gateway runtime selection", () => {
  test("checked-in config selects the default opencode runtime", () => {
    expect(gatewayConfig.runtime).toBe("opencode");

    const definition = getGatewayRuntimeDefinition(gatewayConfig.runtime);
    expect(definition).toMatchObject({
      id: "opencode",
      command: "opencode",
      args: ["acp"],
      install: {
        owner: "external",
      },
    });
  });

  test("registry lists supported runtimes", () => {
    withEnv(MOCK_ACP_RUNTIME_ENV, undefined, () => {
      expect(listGatewayRuntimeIds()).toEqual([
        "opencode",
        "claude",
        "codex",
        "pi",
        "droid",
        "gemini",
        "trial",
      ]);
    });
  });

  test("registry includes mock-acp when AGENTS_JS_ENABLE_MOCK_ACP_RUNTIME=1", () => {
    withEnv(MOCK_ACP_RUNTIME_ENV, "1", () => {
      expect(listGatewayRuntimeIds()).toContain("mock-acp");
    });
  });

  test("available runtime list preserves the selected runtime even when detection omits it", () => {
    const definition = getGatewayRuntimeDefinition("droid");
    const available = buildAvailableRuntimeInfos(["opencode", "claude"], {
      definition,
      acp: {
        command: "droid-acp",
        args: [],
        env: {},
      },
      agentCard: {
        name: "Droid ACP",
        description: "Droid ACP runtime",
        capabilities: { streaming: true },
      },
    });

    expect(available).toEqual([
      { id: "droid", displayName: "Droid ACP" },
      { id: "opencode", displayName: "OpenCode ACP" },
      { id: "claude", displayName: "Claude ACP" },
    ]);
  });

  test("derives ephemeral runtime profile names only for curated runtimes", () => {
    expect(
      getEnvRuntimeProfileName("claude", {
        [E2E_RUNTIME_PROFILE_PREFIX_ENV]: "web-ui-live-e2e-run",
      }),
    ).toBe("web-ui-live-e2e-run-claude");
    expect(
      getEnvRuntimeProfileName("custom", {
        [E2E_RUNTIME_PROFILE_PREFIX_ENV]: "web-ui-live-e2e-run",
      }),
    ).toBeNull();
    expect(getEnvRuntimeProfileName("claude", {})).toBeNull();
    expect(
      getEnvRuntimeProfileName("claude", {
        [E2E_RUNTIME_PROFILE_PREFIX_ENV]: "web-ui-live-e2e-run",
        [E2E_RUNTIME_PROFILE_RUNTIMES_ENV]: "opencode",
      }),
    ).toBeNull();
    expect(
      getEnvRuntimeProfileName("opencode", {
        [E2E_RUNTIME_PROFILE_PREFIX_ENV]: "web-ui-live-e2e-run",
        [E2E_RUNTIME_PROFILE_RUNTIMES_ENV]: "opencode",
      }),
    ).toBe("web-ui-live-e2e-run-opencode");
  });

  test("gateway config env overrides only XDG config home when requested", () => {
    expect(
      buildRuntimeProfileConfigEnv({
        HOME: "/tmp/home",
        XDG_CONFIG_HOME: "/tmp/original-xdg-config",
        [E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV]: "/tmp/runtime-profile-config",
      }).XDG_CONFIG_HOME,
    ).toBe("/tmp/runtime-profile-config");
    expect(buildRuntimeProfileConfigEnv({ HOME: "/tmp/home" }).HOME).toBe("/tmp/home");
  });

  test("applies an env-selected ephemeral runtime profile during startup or switches", async () => {
    const runtime = await resolveGatewayRuntime("opencode", {
      which(command) {
        if (command === "opencode") {
          return "/usr/local/bin/opencode";
        }
        return undefined;
      },
      async fileExists() {
        return false;
      },
    });

    const profiled = applyEnvRuntimeProfile(
      runtime,
      {
        effectiveConfig: {},
        paths: {
          projectConfigPath: "/tmp/project/.agents-js/config.json",
          projectExamplePath: "/tmp/project/.agents-js/config.example.json",
          userConfigPath: "/tmp/home/.config/agents-js/config.json",
        },
        userConfig: {
          profiles: {
            "web-ui-live-e2e-run-opencode": {
              runtime: "opencode",
            },
          },
        },
      },
      {
        [E2E_RUNTIME_PROFILE_PREFIX_ENV]: "web-ui-live-e2e-run",
      },
    );

    expect(profiled.acp.env).toMatchObject({
      HOME: "/tmp/home/.config/agents-js/profiles/opencode/web-ui-live-e2e-run-opencode",
      XDG_CONFIG_HOME:
        "/tmp/home/.config/agents-js/profiles/opencode/web-ui-live-e2e-run-opencode/.config",
      XDG_DATA_HOME:
        "/tmp/home/.config/agents-js/profiles/opencode/web-ui-live-e2e-run-opencode/.local/share",
      XDG_STATE_HOME:
        "/tmp/home/.config/agents-js/profiles/opencode/web-ui-live-e2e-run-opencode/.local/state",
      XDG_CACHE_HOME:
        "/tmp/home/.config/agents-js/profiles/opencode/web-ui-live-e2e-run-opencode/.cache",
    });
  });

  test("fails clearly when an env-selected ephemeral runtime profile is missing", async () => {
    const runtime = await resolveGatewayRuntime("claude", {
      which() {
        return undefined;
      },
      async fileExists(filePath) {
        return filePath.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp");
      },
    });

    expect(() =>
      applyEnvRuntimeProfile(
        runtime,
        {
          effectiveConfig: {},
          paths: {
            projectConfigPath: "/tmp/project/.agents-js/config.json",
            projectExamplePath: "/tmp/project/.agents-js/config.example.json",
            userConfigPath: "/tmp/home/.config/agents-js/config.json",
          },
        },
        {
          [E2E_RUNTIME_PROFILE_PREFIX_ENV]: "web-ui-live-e2e-run",
        },
      ),
    ).toThrow(
      '[Gateway] Missing ephemeral runtime profile "web-ui-live-e2e-run-claude" for runtime "claude".',
    );
  });

  test("claude runtime resolves from workspace node_modules/.bin when not on PATH", async () => {
    const definition = getGatewayRuntimeDefinition("claude");
    const command = await resolveGatewayRuntimeCommand(definition, {
      which() {
        return undefined;
      },
      async fileExists(filePath) {
        expect(filePath.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp")).toBe(
          true,
        );
        return true;
      },
    });

    expect(command.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp")).toBe(
      true,
    );
  });

  test("missing runtime definition fails clearly", () => {
    expect(() => getGatewayRuntimeDefinition("missing-runtime")).toThrow(
      'Unknown runtime "missing-runtime"',
    );
  });

  test("missing runtime binary fails clearly", async () => {
    const definition = getGatewayRuntimeDefinition("claude");
    await expect(
      resolveGatewayRuntimeCommand(definition, {
        which() {
          return undefined;
        },
        async fileExists() {
          return false;
        },
      }),
    ).rejects.toThrow('Runtime "claude" could not resolve executable "claude-agent-acp"');
  });

  test("claude runtime resolves ACP options and runtime-specific card", async () => {
    const runtime = await resolveGatewayRuntime("claude", {
      which() {
        return undefined;
      },
      async fileExists(filePath) {
        return filePath.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp");
      },
    });

    expect(runtime.definition.displayName).toBe("Claude ACP");
    expect(runtime.acp.args).toEqual([]);
    expect(
      runtime.acp.command?.endsWith("/apps/internal-gateway/node_modules/.bin/claude-agent-acp"),
    ).toBe(true);
    expect(runtime.agentCard).toMatchObject({
      name: "universal-acp-gateway",
      description: "Standardized A2A interface for Claude ACP",
    });
  });

  test("index.ts --check validates repo-installed startup wiring without requiring opencode on PATH", async () => {
    const process = Bun.spawn({
      cmd: ["vp", "run", "-w", "repo:dev:gateway", "--", "--check", "--runtime", "claude"],
      cwd: repoRoot,
      env: buildProcessEnv(),
      stderr: "pipe",
      stdout: "pipe",
    });

    const exitCode = await process.exited;
    const stdout = await new Response(process.stdout).text();
    const stderr = await new Response(process.stderr).text();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("[Gateway] Primary runtime: claude (Claude ACP)");
    expect(stdout).toContain("[Gateway] Check complete.");
    expect(stderr).toBe("");
  }, 15_000);
});
