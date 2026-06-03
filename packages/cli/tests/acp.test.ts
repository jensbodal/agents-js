import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { getGatewayRuntimeDefinition } from "@agents-js/gateway-runtime";
import type { AcpChildProcess } from "../src/acp.ts";
import { acpArgsToRuntimeEnvOverrides, parseAcpCommandArgs, runAcpCommand } from "../src/acp.ts";
import { runAgentsJsCli } from "../src/cli.ts";

function makeOutputBuffer() {
  let content = "";
  return {
    get value() {
      return content;
    },
    write(chunk: string) {
      content += chunk;
      return true;
    },
  };
}

async function withTempWorkspace(
  fn: (context: { cwd: string; homeDir: string; xdgConfigHome: string }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "agents-js-acp-"));
  const cwd = path.join(root, "workspace");
  const homeDir = path.join(root, "home");
  const xdgConfigHome = path.join(root, "xdg");

  await mkdir(cwd, { recursive: true });

  try {
    await fn({ cwd, homeDir, xdgConfigHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type SpawnCall = { command: string; args: string[]; env: NodeJS.ProcessEnv };

function firstCall(calls: SpawnCall[]): SpawnCall {
  const [first] = calls;
  if (!first) throw new Error("expected at least one spawn call");
  return first;
}

function makeMockSpawnProcess(exitCode: number) {
  const calls: SpawnCall[] = [];
  const spawnProcess = (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ): AcpChildProcess => {
    calls.push({ command, args, env: options.env });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.end(); // close immediately for unit tests
    return {
      stdin,
      stdout,
      exitPromise: Promise.resolve(exitCode),
      kill: () => {},
    };
  };
  return { spawnProcess, calls };
}

function createMockResolver(installed: Record<string, string>) {
  return {
    which: (command: string) => installed[command] ?? undefined,
    fileExists: async (filePath: string) => Object.values(installed).includes(filePath),
  };
}

describe("parseAcpCommandArgs", () => {
  test("parses --harness opencode correctly", () => {
    const result = parseAcpCommandArgs(["--harness", "opencode"]);
    expect(result.harness).toBe("opencode");
  });

  test("parses --profile clean-room correctly", () => {
    const result = parseAcpCommandArgs(["--profile", "clean-room"]);
    expect(result.profile).toBe("clean-room");
  });

  test("parses --acp-command /bin/custom correctly", () => {
    const result = parseAcpCommandArgs(["--acp-command", "/bin/custom"]);
    expect(result.acpCommand).toBe("/bin/custom");
  });

  test("parses --acp-args-json '[\"acp\"]' correctly", () => {
    const result = parseAcpCommandArgs(["--acp-args-json", '["acp"]']);
    expect(result.acpArgsJson).toBe('["acp"]');
  });

  test("sets help: true for --help", () => {
    const result = parseAcpCommandArgs(["--help"]);
    expect(result.help).toBe(true);
  });

  test("sets help: true for -h", () => {
    const result = parseAcpCommandArgs(["-h"]);
    expect(result.help).toBe(true);
  });

  test("throws on unknown flag like --unknown", () => {
    expect(() => parseAcpCommandArgs(["--unknown"])).toThrow("Unknown acp argument: --unknown");
  });

  test("throws on --harness with missing value", () => {
    expect(() => parseAcpCommandArgs(["--harness"])).toThrow("Missing value for --harness");
  });

  test("parses --opencode-disable-external-plugins as a boolean", () => {
    const args = parseAcpCommandArgs([
      "--harness",
      "opencode",
      "--opencode-disable-external-plugins",
    ]);
    expect(args.opencodeDisableExternalPlugins).toBe(true);
  });

  test("parses --runtime-log-level and normalizes casing", () => {
    const args = parseAcpCommandArgs(["--harness", "opencode", "--runtime-log-level", "WARN"]);
    expect(args.runtimeLogLevel).toBe("warn");
  });

  test("rejects an unknown --runtime-log-level value", () => {
    expect(() =>
      parseAcpCommandArgs(["--harness", "opencode", "--runtime-log-level", "verbose"]),
    ).toThrow("--runtime-log-level must be one of");
  });

  test("acpArgsToRuntimeEnvOverrides extracts runtime-env fields", () => {
    const overrides = acpArgsToRuntimeEnvOverrides({
      opencodeDisableExternalPlugins: true,
      runtimeLogLevel: "silent",
    });
    expect(overrides).toEqual({
      disableExternalPlugins: true,
      runtimeLogLevel: "silent",
    });
  });
});

describe("runAcpCommand", () => {
  test("--help returns 0 and includes the versioned banner on stdout (helpOutput)", async () => {
    const output = makeOutputBuffer();
    const helpOutput = makeOutputBuffer();
    const exitCode = await runAcpCommand(["--help"], { output, helpOutput });

    expect(exitCode).toBe(0);
    // Help routes to the stdout-bound helpOutput stream so users running
    // `agents-js acp --help` see the banner on stdout — diagnostics never
    // mix with the help banner.
    expect(helpOutput.value).toMatch(/agents-js v[0-9]/);
    expect(helpOutput.value).toContain("— acp");
    expect(output.value).toBe("");
  });

  test("no args with no config defaults to claude harness", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      const { spawnProcess, calls } = makeMockSpawnProcess(0);
      const exitCode = await runAcpCommand([], {
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
        output,
        runtimeResolver: createMockResolver({ "claude-agent-acp": "/usr/bin/claude-agent-acp" }),
        spawnProcess,
      });

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(firstCall(calls).command).toBe("/usr/bin/claude-agent-acp");
    });
  });

  test("default claude harness resolves from CLI package bins when PATH is missing", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      const { spawnProcess, calls } = makeMockSpawnProcess(0);
      const seenPaths: string[] = [];
      const exitCode = await runAcpCommand([], {
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
        output,
        runtimeResolver: {
          which() {
            return undefined;
          },
          async fileExists(filePath) {
            seenPaths.push(filePath);
            return filePath.endsWith("/node_modules/.bin/claude-agent-acp");
          },
        },
        spawnProcess,
      });

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(firstCall(calls).command.endsWith("/node_modules/.bin/claude-agent-acp")).toBe(true);
      expect(seenPaths.some((filePath) => filePath.includes("/packages/cli/"))).toBe(true);
    });
  });

  test.each<{ runtimeId: string; expectedArgs: string[] }>([
    { runtimeId: "opencode", expectedArgs: ["acp", "--print-logs", "--log-level", "INFO"] },
    { runtimeId: "gemini", expectedArgs: ["--acp"] },
  ])("--harness $runtimeId resolves correctly and calls spawnProcess", async ({
    runtimeId,
    expectedArgs,
  }) => {
    const definition = getGatewayRuntimeDefinition(runtimeId);

    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      const { spawnProcess, calls } = makeMockSpawnProcess(0);
      const mockPath = `/usr/bin/${definition.command}`;

      const exitCode = await runAcpCommand(["--harness", runtimeId], {
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
        output,
        runtimeResolver: createMockResolver({ [definition.command]: mockPath }),
        spawnProcess,
      });

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(firstCall(calls).command).toBe(mockPath);
      expect(firstCall(calls).args).toEqual(expectedArgs);
    });
  });

  test("--harness opencode with mock resolver returning exit code 2 returns 2", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      const { spawnProcess } = makeMockSpawnProcess(2);

      const exitCode = await runAcpCommand(["--harness", "opencode"], {
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
        output,
        runtimeResolver: createMockResolver({ opencode: "/usr/bin/opencode" }),
        spawnProcess,
      });

      expect(exitCode).toBe(2);
    });
  });

  test("--acp-command /bin/custom-acp calls spawnProcess with /bin/custom-acp", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      const { spawnProcess, calls } = makeMockSpawnProcess(0);

      const exitCode = await runAcpCommand(["--acp-command", "/bin/custom-acp"], {
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
        output,
        runtimeResolver: createMockResolver({ "/bin/custom-acp": "/bin/custom-acp" }),
        spawnProcess,
      });

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(firstCall(calls).command).toBe("/bin/custom-acp");
    });
  });

  test("config file fallback reads serve.harness from config", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      await mkdir(path.join(cwd, ".agents-js"), { recursive: true });
      await writeFile(
        path.join(cwd, ".agents-js", "config.json"),
        JSON.stringify({
          serve: {
            harness: {
              kind: "curated",
              runtime: "opencode",
            },
          },
        }),
        "utf8",
      );

      const output = makeOutputBuffer();
      const { spawnProcess, calls } = makeMockSpawnProcess(0);

      const exitCode = await runAcpCommand([], {
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
        output,
        runtimeResolver: createMockResolver({ opencode: "/usr/bin/opencode" }),
        spawnProcess,
      });

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(firstCall(calls).command).toBe("/usr/bin/opencode");
      expect(firstCall(calls).args).toEqual(["acp", "--print-logs", "--log-level", "INFO"]);
    });
  });

  test("--harness opencode --profile applies profile from config", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      await mkdir(path.join(cwd, ".agents-js"), { recursive: true });
      await writeFile(
        path.join(cwd, ".agents-js", "config.json"),
        JSON.stringify({
          profiles: {
            "test-profile": {
              runtime: "opencode",
              args: ["--isolated"],
            },
          },
        }),
        "utf8",
      );

      const output = makeOutputBuffer();
      const { spawnProcess, calls } = makeMockSpawnProcess(0);

      const exitCode = await runAcpCommand(["--harness", "opencode", "--profile", "test-profile"], {
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
        output,
        runtimeResolver: createMockResolver({ opencode: "/usr/bin/opencode" }),
        spawnProcess,
      });

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(firstCall(calls).command).toBe("/usr/bin/opencode");
      expect(firstCall(calls).args).toEqual([
        "acp",
        "--print-logs",
        "--log-level",
        "INFO",
        "--isolated",
      ]);
      // Profile should set HOME and XDG env vars
      expect(firstCall(calls).env.HOME).toContain("profiles");
      expect(firstCall(calls).env.HOME).toContain("test-profile");
    });
  });

  test("--directory uses the runtime-specific workspace flag", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      const { spawnProcess, calls } = makeMockSpawnProcess(0);

      const exitCode = await runAcpCommand(["--harness", "opencode", "--directory", cwd], {
        cwd,
        env: { HOME: homeDir, XDG_CONFIG_HOME: xdgConfigHome },
        output,
        runtimeResolver: createMockResolver({ opencode: "/usr/bin/opencode" }),
        spawnProcess,
      });

      expect(exitCode).toBe(0);
      expect(calls).toHaveLength(1);
      expect(firstCall(calls).args).toEqual([
        "acp",
        "--print-logs",
        "--log-level",
        "INFO",
        "--cwd",
        cwd,
      ]);
    });
  });
});

describe("agents-js acp dispatch", () => {
  test("runAgentsJsCli(['acp', '--help']) returns 0", async () => {
    const exitCode = await runAgentsJsCli(["acp", "--help"]);
    expect(exitCode).toBe(0);
  });
});
