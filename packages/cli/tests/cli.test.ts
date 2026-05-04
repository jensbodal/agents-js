import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pkg from "../package.json";
import { runAgentsJsCli } from "../src/cli.ts";
import { runClientCommand } from "../src/client/command.ts";
import {
  parseServeCommandArgs,
  runServeCommand,
  serveArgsToRuntimeEnvOverrides,
} from "../src/serve.ts";

function createFakePromptSession(answers: string[]) {
  return {
    close() {},
    async confirm() {
      return true;
    },
    async input(_message: string, defaultValue?: string) {
      const answer = answers.shift();
      return answer ?? defaultValue ?? "";
    },
    async select<T extends string>(_message: string, _options: { value: T }[]) {
      const answer = answers.shift();
      if (!answer) {
        throw new Error("missing prompt answer");
      }
      return answer as T;
    },
  };
}

async function withMockInteractiveTerminal(fn: () => Promise<void>) {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalStdoutIsTTY = process.stdout.isTTY;

  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: true,
  });

  try {
    await fn();
  } finally {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalStdinIsTTY,
      });
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        value: originalStdoutIsTTY,
      });
    }
  }
}

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
  const root = await mkdtemp(path.join(tmpdir(), "agents-js-cli-"));
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

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; captured: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let captured = "";
  (process.stdout.write as unknown as (chunk: string) => boolean) = (chunk: string) => {
    captured += chunk;
    return true;
  };
  return fn()
    .then((result) => ({ result, captured }))
    .finally(() => {
      process.stdout.write = original;
    });
}

describe("agents-js CLI", () => {
  test("prints top-level help", async () => {
    const exitCode = await runAgentsJsCli(["--help"]);
    expect(exitCode).toBe(0);
  });

  test("--version prints version and exits 0", async () => {
    const { result, captured } = await captureStdout(() => runAgentsJsCli(["--version"]));
    expect(result).toBe(0);
    // Output shape: "agents-js <semver> (source)" in dev, or
    // "agents-js <semver> (<sha>[-dirty], built <iso-date>)" in compiled binary.
    expect(captured.trim()).toMatch(new RegExp(`^agents-js ${pkg.version} \\(`));
  });

  test("-v prints version and exits 0", async () => {
    const { result, captured } = await captureStdout(() => runAgentsJsCli(["-v"]));
    expect(result).toBe(0);
    expect(captured.trim()).toMatch(new RegExp(`^agents-js ${pkg.version} \\(`));
  });

  test("--help output starts with versioned banner", async () => {
    const { result, captured } = await captureStdout(() => runAgentsJsCli(["--help"]));
    expect(result).toBe(0);
    // --help banner uses the same formatVersionLine() output as --version.
    expect(captured.split("\n")[0]).toMatch(new RegExp(`^agents-js ${pkg.version} \\(`));
  });

  test("prints client help", async () => {
    const output = makeOutputBuffer();
    const exitCode = await runClientCommand(["--help"], { output });

    expect(exitCode).toBe(0);
    expect(output.value).toMatch(/agents-js v[0-9]/);
    expect(output.value).toContain("— client");
    expect(output.value).toContain("--no-poll");
  });

  test("dispatches the client subcommand from the top-level CLI", async () => {
    const exitCode = await runAgentsJsCli(["client", "--help"]);
    expect(exitCode).toBe(0);
  });

  test("serve help exits without starting the gateway", async () => {
    const output = makeOutputBuffer();
    const result = await runServeCommand(["--help"], {
      output,
    });

    expect(result).toBe(0);
    expect(output.value).toMatch(/agents-js v[0-9]/);
    expect(output.value).toContain("— serve");
    expect(output.value).toContain(".agents-js/config.json");
  });

  test("runs non-interactively with complete custom flags", async () => {
    const output = makeOutputBuffer();
    const result = await runServeCommand(
      [
        "--harness",
        "custom",
        "--acp-command",
        "node",
        "--acp-args-json",
        JSON.stringify(["tests/mock-acp-agent.cjs"]),
        "--host",
        "127.0.0.1",
        "--port",
        "0",
      ],
      {
        output,
        serveGateway: async (options) => {
          expect(path.basename(options.acp?.command ?? "")).toBe("node");
          expect(options.acp?.args).toEqual(["tests/mock-acp-agent.cjs"]);
          expect(options.host).toBe("127.0.0.1");
          expect(options.port).toBe(0);
          return {
            port: 40123,
            server: {} as never,
            stop() {},
          };
        },
      },
    );

    expect(typeof result).not.toBe("number");
    expect(output.value).toContain("Serving Custom ACP Runtime");
    expect(output.value).toContain(
      "Agent card: http://127.0.0.1:40123/.well-known/agent-card.json",
    );
  });

  test("runs non-interactively with a curated harness and wildcard host", async () => {
    const output = makeOutputBuffer();
    const result = await runServeCommand(
      ["--harness", "opencode", "--host", "0.0.0.0", "--port", "0"],
      {
        output,
        runtimeResolver: {
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
        serveGateway: async (options) => {
          expect(options.acp?.command).toBe("/usr/local/bin/opencode");
          expect(options.acp?.args).toEqual(["acp", "--print-logs", "--log-level", "INFO"]);
          // opencode now seeds telemetry opt-outs via GatewayRuntimeDefinition.defaultEnv.
          expect(options.acp?.env).toEqual({
            OMO_SEND_ANONYMOUS_TELEMETRY: "0",
            OMO_DISABLE_POSTHOG: "1",
          });
          expect(options.host).toBe("0.0.0.0");
          return {
            port: 40124,
            server: {} as never,
            stop() {},
          };
        },
      },
    );

    expect(typeof result).not.toBe("number");
    expect(output.value).toContain("Serving OpenCode ACP on 0.0.0.0:40124");
    expect(output.value).toContain(
      "Agent card: http://127.0.0.1:40124/.well-known/agent-card.json",
    );
  });

  test("accepts --profile for curated harnesses and auto-creates missing project profiles", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      const result = await runServeCommand(
        ["--harness", "opencode", "--profile", "clean-room", "--host", "127.0.0.1", "--port", "0"],
        {
          cwd,
          env: {
            HOME: homeDir,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
          output,
          runtimeResolver: {
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
          serveGateway: async (options) => {
            expect(options.acp?.command).toBe("/usr/local/bin/opencode");
            expect(options.acp?.args).toEqual(["acp", "--print-logs", "--log-level", "INFO"]);
            expect(options.acp?.env).toEqual({
              // defaultEnv seeds telemetry opt-outs; profile XDG roots merge on top.
              OMO_SEND_ANONYMOUS_TELEMETRY: "0",
              OMO_DISABLE_POSTHOG: "1",
              HOME: path.join(cwd, ".agents-js", "profiles", "opencode", "clean-room"),
              XDG_CONFIG_HOME: path.join(
                cwd,
                ".agents-js",
                "profiles",
                "opencode",
                "clean-room",
                ".config",
              ),
              XDG_DATA_HOME: path.join(
                cwd,
                ".agents-js",
                "profiles",
                "opencode",
                "clean-room",
                ".local",
                "share",
              ),
              XDG_STATE_HOME: path.join(
                cwd,
                ".agents-js",
                "profiles",
                "opencode",
                "clean-room",
                ".local",
                "state",
              ),
              XDG_CACHE_HOME: path.join(
                cwd,
                ".agents-js",
                "profiles",
                "opencode",
                "clean-room",
                ".cache",
              ),
            });
            return {
              port: 40126,
              server: {} as never,
              stop() {},
            };
          },
        },
      );

      expect(typeof result).not.toBe("number");
      expect(output.value).toContain('Created runtime profile "clean-room"');

      const persisted = JSON.parse(
        await readFile(path.join(cwd, ".agents-js", "config.json"), "utf8"),
      ) as {
        profiles: Record<string, { runtime: string }>;
      };
      expect(persisted.profiles["clean-room"]).toEqual({ runtime: "opencode" });
    });
  });

  test("formats IPv6 agent card URLs correctly", async () => {
    const output = makeOutputBuffer();
    await runServeCommand(
      [
        "--harness",
        "custom",
        "--acp-command",
        "node",
        "--acp-args-json",
        JSON.stringify(["tests/mock-acp-agent.cjs"]),
        "--host",
        "::1",
        "--port",
        "0",
      ],
      {
        output,
        serveGateway: async () => ({
          port: 40125,
          server: {} as never,
          stop() {},
        }),
      },
    );

    expect(output.value).toContain("Serving Custom ACP Runtime on [::1]:40125");
    expect(output.value).toContain("Agent card: http://[::1]:40125/.well-known/agent-card.json");
  });

  test("falls back to the interactive wizard when config is missing", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      const result = await runServeCommand([], {
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
        output,
        createPromptSession: () => createFakePromptSession(["claude", "127.0.0.1", "", "none"]),
        runtimeResolver: {
          which(command) {
            if (command === "claude-agent-acp") {
              return "/usr/local/bin/claude-agent-acp";
            }
            return undefined;
          },
          async fileExists() {
            return false;
          },
        },
        serveGateway: async (options) => ({
          port: options.port ?? 0,
          server: {} as never,
          stop() {},
        }),
      });

      expect(typeof result).not.toBe("number");
      if (typeof result !== "number") {
        expect(result.runtime.definition.id).toBe("claude");
      }
    });
  });

  test("persists ask-each-time without saving a harness default", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();
      await runServeCommand([], {
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
        output,
        createPromptSession: () =>
          createFakePromptSession(["opencode", "0.0.0.0", "0", "ask-each-time"]),
        runtimeResolver: {
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
        serveGateway: async () => ({
          port: 0,
          server: {} as never,
          stop() {},
        }),
      });

      const userConfigPath = path.join(xdgConfigHome, "agents-js", "config.json");
      const persisted = JSON.parse(await readFile(userConfigPath, "utf8")) as {
        serve: { harness?: unknown; selectionPolicy: string };
      };

      expect(persisted.serve.selectionPolicy).toBe("ask-each-time");
      expect(persisted.serve.harness).toBeUndefined();
    });
  });

  test("reuses a saved curated harness when --profile is provided", async () => {
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
          profiles: {
            "clean-room": {
              runtime: "opencode",
              args: ["--isolated"],
            },
          },
        }),
        "utf8",
      );

      const result = await runServeCommand(["--profile", "clean-room", "--host", "127.0.0.1"], {
        cwd,
        env: {
          HOME: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
        runtimeResolver: {
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
        serveGateway: async (options) => {
          expect(options.acp?.args).toEqual([
            "acp",
            "--print-logs",
            "--log-level",
            "INFO",
            "--isolated",
          ]);
          return {
            port: 0,
            server: {} as never,
            stop() {},
          };
        },
      });

      expect(typeof result).not.toBe("number");
      if (typeof result !== "number") {
        expect(result.runtime.definition.id).toBe("opencode");
      }
    });
  });

  test("persists curated harness profiles when saving defaults", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      await withMockInteractiveTerminal(async () => {
        await runServeCommand(["--harness", "opencode", "--profile", "clean-room"], {
          cwd,
          env: {
            HOME: homeDir,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
          createPromptSession: () => createFakePromptSession(["127.0.0.1", "", "project"]),
          runtimeResolver: {
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
          serveGateway: async () => ({
            port: 0,
            server: {} as never,
            stop() {},
          }),
        });
      });

      const persisted = JSON.parse(
        await readFile(path.join(cwd, ".agents-js", "config.json"), "utf8"),
      ) as {
        serve: {
          harness: { kind: string; runtime: string; profile?: string };
        };
      };

      expect(persisted.serve.harness).toEqual({
        kind: "curated",
        runtime: "opencode",
        profile: "clean-room",
      });
    });
  });

  test("copies a user-scoped profile into project config when saving project defaults", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      await mkdir(path.join(xdgConfigHome, "agents-js"), { recursive: true });
      await writeFile(
        path.join(xdgConfigHome, "agents-js", "config.json"),
        JSON.stringify({
          profiles: {
            "clean-room": {
              runtime: "opencode",
              args: ["--isolated"],
              env: {
                OPENCODE_PROFILE: "clean-room",
              },
            },
          },
        }),
        "utf8",
      );

      await withMockInteractiveTerminal(async () => {
        await runServeCommand(["--harness", "opencode", "--profile", "clean-room"], {
          cwd,
          env: {
            HOME: homeDir,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
          createPromptSession: () => createFakePromptSession(["127.0.0.1", "", "project"]),
          runtimeResolver: {
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
          serveGateway: async (options) => {
            expect(options.acp?.args).toEqual([
              "acp",
              "--print-logs",
              "--log-level",
              "INFO",
              "--isolated",
            ]);
            expect(options.acp?.env?.OPENCODE_PROFILE).toBe("clean-room");
            return {
              port: 0,
              server: {} as never,
              stop() {},
            };
          },
        });
      });

      const persisted = JSON.parse(
        await readFile(path.join(cwd, ".agents-js", "config.json"), "utf8"),
      ) as {
        profiles: Record<
          string,
          {
            runtime: string;
            args?: string[];
            env?: Record<string, string>;
          }
        >;
        serve: {
          harness: { kind: string; runtime: string; profile?: string };
        };
      };

      expect(persisted.serve.harness).toEqual({
        kind: "curated",
        runtime: "opencode",
        profile: "clean-room",
      });
      expect(persisted.profiles["clean-room"]).toEqual({
        runtime: "opencode",
        args: ["--isolated"],
        env: {
          OPENCODE_PROFILE: "clean-room",
        },
      });
    });
  });

  test("errors when --profile is used without a curated harness", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      await expect(
        runServeCommand(["--profile", "clean-room", "--host", "127.0.0.1", "--port", "0"], {
          cwd,
          env: {
            HOME: homeDir,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
        }),
      ).rejects.toThrow(
        "--profile clean-room requires an explicit curated --harness or a saved curated harness.",
      );
    });
  });

  test("serve does NOT wire the sync endpoint handler by default", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();

      const result = await runServeCommand(
        [
          "--harness",
          "custom",
          "--acp-command",
          "node",
          "--acp-args-json",
          JSON.stringify(["tests/mock-acp-agent.cjs"]),
          "--host",
          "127.0.0.1",
          "--port",
          "0",
        ],
        {
          cwd,
          env: {
            HOME: homeDir,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
          output,
          serveGateway: async (options) => {
            // Default-off: the additionalFetch hook should be absent so
            // /.well-known/agents-js-registry.json returns 404 from the
            // server's own routing instead of leaking the registry.
            expect(options.additionalFetch).toBeUndefined();
            return {
              port: 40127,
              server: {} as never,
              stop() {},
            };
          },
        },
      );

      expect(typeof result).not.toBe("number");
    });
  });

  test("--registry-sync wires the sync endpoint handler into additionalFetch", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();

      const result = await runServeCommand(
        [
          "--harness",
          "custom",
          "--acp-command",
          "node",
          "--acp-args-json",
          JSON.stringify(["tests/mock-acp-agent.cjs"]),
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--registry-sync",
        ],
        {
          cwd,
          env: {
            HOME: homeDir,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
          output,
          serveGateway: async (options) => {
            expect(options.additionalFetch).toBeDefined();
            const req = new Request("http://127.0.0.1:40127/.well-known/agents-js-registry.json");
            const response = await options.additionalFetch?.(req);
            expect(response?.status).toBe(200);

            return {
              port: 40127,
              server: {} as never,
              stop() {},
            };
          },
        },
      );

      expect(typeof result).not.toBe("number");
    });
  });

  test("AGENTS_JS_REGISTRY_SYNC=true also wires the sync endpoint handler", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      const output = makeOutputBuffer();

      const result = await runServeCommand(
        [
          "--harness",
          "custom",
          "--acp-command",
          "node",
          "--acp-args-json",
          JSON.stringify(["tests/mock-acp-agent.cjs"]),
          "--host",
          "127.0.0.1",
          "--port",
          "0",
        ],
        {
          cwd,
          env: {
            HOME: homeDir,
            XDG_CONFIG_HOME: xdgConfigHome,
            AGENTS_JS_REGISTRY_SYNC: "true",
          },
          output,
          serveGateway: async (options) => {
            expect(options.additionalFetch).toBeDefined();
            return {
              port: 40127,
              server: {} as never,
              stop() {},
            };
          },
        },
      );

      expect(typeof result).not.toBe("number");
    });
  });

  test("errors when --profile is used with custom harness mode", async () => {
    await expect(
      runServeCommand(["--harness", "custom", "--acp-command", "node", "--profile", "clean-room"]),
    ).rejects.toThrow("--profile is only supported with curated harnesses.");
  });

  test("errors when a profile targets a different runtime", async () => {
    await withTempWorkspace(async ({ cwd, homeDir, xdgConfigHome }) => {
      await mkdir(path.join(cwd, ".agents-js"), { recursive: true });
      await writeFile(
        path.join(cwd, ".agents-js", "config.json"),
        JSON.stringify({
          profiles: {
            "clean-room": {
              runtime: "claude",
            },
          },
        }),
        "utf8",
      );

      await expect(
        runServeCommand(
          [
            "--harness",
            "opencode",
            "--profile",
            "clean-room",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
          ],
          {
            cwd,
            env: {
              HOME: homeDir,
              XDG_CONFIG_HOME: xdgConfigHome,
            },
            output: makeOutputBuffer(),
            createPromptSession: () => createFakePromptSession([]),
          },
        ),
      ).rejects.toThrow(
        '[agents-js] Runtime profile "clean-room" targets "claude" but the selected harness is "opencode".',
      );
    });
  });

  describe("runtime env override flags", () => {
    test("parses --opencode-disable-external-plugins as a boolean", () => {
      const args = parseServeCommandArgs([
        "--harness",
        "opencode",
        "--opencode-disable-external-plugins",
      ]);
      expect(args.opencodeDisableExternalPlugins).toBe(true);
    });

    test("parses --runtime-log-level and normalizes casing", () => {
      const args = parseServeCommandArgs(["--harness", "opencode", "--runtime-log-level", "DEBUG"]);
      expect(args.runtimeLogLevel).toBe("debug");
    });

    test("rejects an unknown --runtime-log-level value", () => {
      expect(() =>
        parseServeCommandArgs(["--harness", "opencode", "--runtime-log-level", "bogus"]),
      ).toThrow("--runtime-log-level must be one of");
    });

    test("parses --default-model", () => {
      const args = parseServeCommandArgs([
        "--harness",
        "opencode",
        "--default-model",
        "anthropic/claude-3-5-sonnet",
      ]);
      expect(args.defaultModel).toBe("anthropic/claude-3-5-sonnet");
    });

    test("serveArgsToRuntimeEnvOverrides extracts the runtime-env fields", () => {
      const overrides = serveArgsToRuntimeEnvOverrides({
        opencodeDisableExternalPlugins: true,
        runtimeLogLevel: "debug",
        defaultModel: "foo/bar",
      });
      expect(overrides).toEqual({
        disableExternalPlugins: true,
        runtimeLogLevel: "debug",
        defaultModel: "foo/bar",
      });
    });
  });
});
