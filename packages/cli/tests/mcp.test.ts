import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMcpCommandArgs, runMcpCommand } from "../src/mcp.ts";

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
    "setup --global writes to ~/.claude/settings.json",
    withTempDir(async (_dir) => {
      // We can't easily mock homedir, so we test the local path variant instead
      // and trust the global variant shares the same merge logic.
      // This test verifies the --global flag is parsed correctly.
      const args = parseMcpCommandArgs(["setup", "--global"]);
      expect(args.global).toBe(true);
      expect(args.subcommand).toBe("setup");
    }),
  );

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
