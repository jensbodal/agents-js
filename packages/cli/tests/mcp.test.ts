import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeMcpAddArgs,
  parseMcpCommandArgs,
  resolveCliEntryFromModuleUrl,
  runMcpCommand,
} from "../src/mcp.ts";

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

function withTempDir(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "agents-js-mcp-test-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("parseMcpCommandArgs", () => {
  test("returns empty args for no arguments", () => {
    const args = parseMcpCommandArgs([]);
    expect(args).toEqual({});
  });

  test("parses --help", () => {
    const args = parseMcpCommandArgs(["--help"]);
    expect(args.help).toBe(true);
  });

  test("parses -h", () => {
    const args = parseMcpCommandArgs(["-h"]);
    expect(args.help).toBe(true);
  });

  test("parses setup subcommand", () => {
    const args = parseMcpCommandArgs(["setup"]);
    expect(args.subcommand).toBe("setup");
  });

  test("parses setup --global", () => {
    const args = parseMcpCommandArgs(["setup", "--global"]);
    expect(args.subcommand).toBe("setup");
    expect(args.global).toBe(true);
  });

  test("parses setup --claude", () => {
    const args = parseMcpCommandArgs(["setup", "--claude"]);
    expect(args.subcommand).toBe("setup");
    expect(args.claude).toBe(true);
  });

  test("parses setup with --global and --claude in either order", () => {
    const a = parseMcpCommandArgs(["setup", "--global", "--claude"]);
    expect(a.subcommand).toBe("setup");
    expect(a.global).toBe(true);
    expect(a.claude).toBe(true);

    const b = parseMcpCommandArgs(["setup", "--claude", "--global"]);
    expect(b.subcommand).toBe("setup");
    expect(b.claude).toBe(true);
    expect(b.global).toBe(true);
  });

  test("parses setup --help", () => {
    const args = parseMcpCommandArgs(["setup", "--help"]);
    expect(args.subcommand).toBe("setup");
    expect(args.help).toBe(true);
  });

  test("parses setup --url and --name", () => {
    const args = parseMcpCommandArgs([
      "setup",
      "--url",
      "http://localhost:4000",
      "--name",
      "hostname-null-codex",
    ]);
    expect(args.subcommand).toBe("setup");
    expect(args.url).toBe("http://localhost:4000");
    expect(args.name).toBe("hostname-null-codex");
  });

  test("throws on unknown top-level argument with helpful message", () => {
    expect(() => parseMcpCommandArgs(["--bogus"])).toThrow(
      "[agents-js] Unknown mcp argument: --bogus",
    );
  });

  test("throws on unknown subverb", () => {
    expect(() => parseMcpCommandArgs(["teardown"])).toThrow(
      "[agents-js] Unknown mcp argument: teardown",
    );
  });

  test("throws on unknown flag passed to setup", () => {
    expect(() => parseMcpCommandArgs(["setup", "--bogus"])).toThrow(
      "[agents-js] Unknown mcp setup argument: --bogus",
    );
  });

  test("parses bridge subverb with --url", () => {
    const args = parseMcpCommandArgs(["bridge", "--url", "http://localhost:4000"]);
    expect(args.subcommand).toBe("bridge");
    expect(args.url).toBe("http://localhost:4000");
  });

  test("parses bridge --help", () => {
    const args = parseMcpCommandArgs(["bridge", "--help"]);
    expect(args.subcommand).toBe("bridge");
    expect(args.help).toBe(true);
  });

  test("throws on unknown flag passed to bridge", () => {
    expect(() => parseMcpCommandArgs(["bridge", "--bogus"])).toThrow(
      "[agents-js] Unknown mcp bridge argument: --bogus",
    );
  });
});

describe("runMcpCommand", () => {
  test("prints help and exits 0", async () => {
    const output = makeOutputBuffer();
    const exitCode = await runMcpCommand(["--help"], { output });
    expect(exitCode).toBe(0);
    expect(output.value).toContain("agents-js mcp");
    expect(output.value).toContain("setup");
  });

  test("prints setup help and exits 0", async () => {
    const output = makeOutputBuffer();
    const exitCode = await runMcpCommand(["setup", "--help"], { output });
    expect(exitCode).toBe(0);
    expect(output.value).toContain("agents-js v");
    expect(output.value).toContain("mcp setup");
  });

  test("setup --help marks --global as removed and does NOT claim a target file (AJS-74 regression)", async () => {
    // Regression guard for the leaky-abstraction `--global` flag (Jens
    // design critique + cluster consensus → A2 removal). Help text must not
    // claim `--global` writes anywhere — it errors out at runtime with a
    // replacement-pointing message.
    const output = makeOutputBuffer();
    await runMcpCommand(["setup", "--help"], { output });
    expect(output.value).not.toContain("--global   Write MCP config");
    expect(output.value).not.toContain("settings.json");
    expect(output.value).not.toContain("--global       Write MCP config");
    // Should still describe --global as removed-with-pointer (deprecation window)
    expect(output.value).toMatch(/--global[^\n]*removed/);
    expect(output.value).toContain("--claude");
  });

  test("top-level mcp --help also marks --global as removed (no stale `Write MCP config` claim)", async () => {
    const output = makeOutputBuffer();
    await runMcpCommand(["--help"], { output });
    expect(output.value).not.toContain("--global       Write MCP config");
    expect(output.value).not.toContain("settings.json");
    expect(output.value).toMatch(/--global[^\n]*removed/);
  });

  test("returns 1 when no agents are configured", async () => {
    const output = makeOutputBuffer();
    const exitCode = await runMcpCommand([], {
      output,
      loadBridgeConfig: async () => ({ agents: [] }),
    });
    expect(exitCode).toBe(1);
    expect(output.value).toContain("No agents found");
  });

  test("starts server with agents from config loader", async () => {
    let receivedConfig: { agents: Array<{ name: string; url: string }> } | undefined;
    const output = makeOutputBuffer();

    const exitCode = await runMcpCommand([], {
      output,
      loadBridgeConfig: async () => ({
        agents: [{ name: "test-agent", url: "http://localhost:3001" }],
      }),
      startServer: async (config) => {
        receivedConfig = config;
      },
    });

    expect(exitCode).toBe(0);
    expect(receivedConfig?.agents).toHaveLength(1);
    expect(receivedConfig?.agents[0]).toEqual({
      name: "test-agent",
      url: "http://localhost:3001",
    });
  });

  test(
    "setup writes .mcp.json in cwd",
    withTempDir(async (dir) => {
      const output = makeOutputBuffer();
      const exitCode = await runMcpCommand(["setup"], { output, cwd: dir });

      expect(exitCode).toBe(0);
      expect(output.value).toContain(".mcp.json");

      const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(written.mcpServers["agents-js-mcp"]).toEqual({
        command: "agents-js",
        args: ["mcp"],
      });
    }),
  );

  test(
    "setup merges into existing .mcp.json",
    withTempDir(async (dir) => {
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "existing-server": { command: "existing", args: [] },
          },
        }),
      );

      const output = makeOutputBuffer();
      const exitCode = await runMcpCommand(["setup"], { output, cwd: dir });

      expect(exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(written.mcpServers["existing-server"]).toBeDefined();
      expect(written.mcpServers["agents-js-mcp"]).toEqual({
        command: "agents-js",
        args: ["mcp"],
      });
    }),
  );

  test(
    "setup --url --name writes a single-gateway bridge entry to .mcp.json",
    withTempDir(async (dir) => {
      const output = makeOutputBuffer();
      const exitCode = await runMcpCommand(
        ["setup", "--url", "http://localhost:4000", "--name", "hostname-null-codex"],
        { output, cwd: dir },
      );

      expect(exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(written.mcpServers["hostname-null-codex"]).toEqual({
        command: "agents-js",
        args: ["mcp", "bridge", "--url", "http://localhost:4000"],
      });
    }),
  );

  test(
    "setup --url without --name defaults the server name to `agents-js-mcp-bridge`",
    withTempDir(async (dir) => {
      const output = makeOutputBuffer();
      const exitCode = await runMcpCommand(["setup", "--url", "http://localhost:4321"], {
        output,
        cwd: dir,
      });

      expect(exitCode).toBe(0);
      const written = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8")) as {
        mcpServers: Record<string, { command: string; args: string[] }>;
      };
      expect(written.mcpServers["agents-js-mcp-bridge"]).toEqual({
        command: "agents-js",
        args: ["mcp", "bridge", "--url", "http://localhost:4321"],
      });
      // Default-name path must not also write the registry-backed `agents-js-mcp` key.
      expect(written.mcpServers["agents-js-mcp"]).toBeUndefined();
    }),
  );

  test("setup --global parses (flag is still accepted for one-release deprecation window)", () => {
    const args = parseMcpCommandArgs(["setup", "--global"]);
    expect(args.global).toBe(true);
    expect(args.subcommand).toBe("setup");
  });

  test("setup --global runtime emits removal error + EXIT_ERROR with replacement pointers", async () => {
    // Was a silent no-op writing to ~/.claude/settings.json (Claude Code does
    // not read MCP from that file). Bug fix to ~/.claude.json (PR #67 prior
    // amend) was correct code but wrong abstraction — `--global` in a
    // vendor-neutral CLI silently named a Claude-specific target.
    // (A2) one-release deprecation error path: parse the flag, emit
    // actionable error, exit non-zero; full removal next release.
    const output = makeOutputBuffer();
    const exitCode = await runMcpCommand(["setup", "--global"], { output });
    expect(exitCode).toBe(1);
    expect(output.value).toContain("--global is removed");
    expect(output.value).toContain("mcp setup --claude");
    expect(output.value).toContain(".mcp.json");
  });
});

describe("buildClaudeMcpAddArgs", () => {
  test("uses -s user scope so agents-js-mcp is available across all Claude Code sessions", () => {
    const args = buildClaudeMcpAddArgs("agents-js", ["mcp"]);
    expect(args[0]).toBe("mcp");
    expect(args[1]).toBe("add");
    expect(args[2]).toBe("-s");
    expect(args[3]).toBe("user");
  });

  test("includes the server name `agents-js-mcp` after the scope flag", () => {
    const args = buildClaudeMcpAddArgs("agents-js", ["mcp"]);
    expect(args[4]).toBe("agents-js-mcp");
  });

  test("appends launch command + launch args after the `--` separator", () => {
    const args = buildClaudeMcpAddArgs("/usr/local/bin/agents-js", ["mcp"]);
    const dashDashIndex = args.indexOf("--");
    expect(dashDashIndex).toBeGreaterThan(-1);
    expect(args.slice(dashDashIndex + 1)).toEqual(["/usr/local/bin/agents-js", "mcp"]);
  });

  test("preserves launch args order (Bun-from-source case: ['cli.ts', 'mcp'])", () => {
    const args = buildClaudeMcpAddArgs("/opt/homebrew/bin/bun", ["/path/to/cli.ts", "mcp"]);
    const dashDashIndex = args.indexOf("--");
    expect(args.slice(dashDashIndex + 1)).toEqual([
      "/opt/homebrew/bin/bun",
      "/path/to/cli.ts",
      "mcp",
    ]);
  });

  test("never uses `-s local` (regression guard for AJS-74 bug #4)", () => {
    const args = buildClaudeMcpAddArgs("agents-js", ["mcp"]);
    expect(args).not.toContain("local");
  });

  test("accepts an optional serverName override (used by setup --claude --name)", () => {
    const args = buildClaudeMcpAddArgs("agents-js", ["mcp"], "hostname-null-codex");
    expect(args[4]).toBe("hostname-null-codex");
    // Scope stays at -s user regardless of server name.
    expect(args[2]).toBe("-s");
    expect(args[3]).toBe("user");
  });
});

describe("resolveCliEntryFromModuleUrl", () => {
  // Regression guard for the consumer-side bug where `agents-js mcp setup
  // --claude` registered `<dist>/cli.ts` (non-existent) instead of
  // `<dist>/bin.mjs` when invoked from the built dist. The naive prior
  // impl unconditionally appended "cli.ts" to the module dir.

  test("source mode (.ts module) → sibling cli.ts", () => {
    const entry = resolveCliEntryFromModuleUrl("file:///workspace/packages/cli/src/mcp.ts");
    expect(entry).toBe("/workspace/packages/cli/src/cli.ts");
  });

  test("built dist mode (.mjs module) → sibling bin.mjs (NOT cli.ts)", () => {
    const entry = resolveCliEntryFromModuleUrl(
      "file:///workspace/packages/cli/dist/cli-CFaPARTq.mjs",
    );
    expect(entry).toBe("/workspace/packages/cli/dist/bin.mjs");
    expect(entry).not.toContain("cli.ts");
  });

  test("dist mode points at bin.mjs even when module is named mcp.mjs", () => {
    const entry = resolveCliEntryFromModuleUrl(
      "file:///opt/homebrew/lib/node_modules/@agents-js/cli/dist/mcp.mjs",
    );
    expect(entry).toBe("/opt/homebrew/lib/node_modules/@agents-js/cli/dist/bin.mjs");
  });

  test("dist mode does NOT pick cli.mjs (it's the runtime, not the bin entry)", () => {
    // cli.mjs exists in dist but is the bundled runtime module, not the
    // CLI dispatcher. The package.json "bin" field points at bin.mjs.
    const entry = resolveCliEntryFromModuleUrl("file:///x/packages/cli/dist/cli.mjs");
    expect(entry).toBe("/x/packages/cli/dist/bin.mjs");
  });
});

describe("runMcpCommand bridge subcommand", () => {
  test("bridge --help prints bridge usage and exits 0", async () => {
    const output = makeOutputBuffer();
    const exitCode = await runMcpCommand(["bridge", "--help"], { output });
    expect(exitCode).toBe(0);
    expect(output.value).toContain("mcp bridge");
    expect(output.value).toContain("--url");
  });

  test("bridge without --url returns 1 with helpful message", async () => {
    const output = makeOutputBuffer();
    const exitCode = await runMcpCommand(["bridge"], { output });
    expect(exitCode).toBe(1);
    expect(output.value).toContain("Missing required --url");
  });

  test("bridge --url passes a single agent endpoint to the bridge server", async () => {
    let receivedConfig: { agents: Array<{ name: string; url: string }> } | undefined;
    const output = makeOutputBuffer();

    const exitCode = await runMcpCommand(["bridge", "--url", "http://localhost:4321"], {
      output,
      startServer: async (config) => {
        receivedConfig = config;
      },
    });

    expect(exitCode).toBe(0);
    expect(receivedConfig?.agents).toHaveLength(1);
    expect(receivedConfig?.agents[0]?.url).toBe("http://localhost:4321");
    expect(receivedConfig?.agents[0]?.name).toBe("localhost");
  });
});
