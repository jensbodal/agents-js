import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeSpawnRunner,
  DEFAULT_CLAUDE_ARGS,
  type SpawnImpl,
  splitClaudeArgs,
} from "../src/claude-runner.ts";

describe("DEFAULT_CLAUDE_ARGS", () => {
  test("defaults to least-privilege reply tooling without bypassPermissions", () => {
    expect(DEFAULT_CLAUDE_ARGS).toEqual([
      "-p",
      "--disallowedTools",
      "Bash,Edit,Write,WebFetch",
      "--allowedTools",
      "Read,Grep,Glob,mcp__agents_gateway__agents_send_message",
    ]);
    expect(DEFAULT_CLAUDE_ARGS).not.toContain("--permission-mode");
    expect(DEFAULT_CLAUDE_ARGS).not.toContain("bypassPermissions");
  });
});

const ENFORCED_DISALLOWED_TOOLS = "Bash,Edit,Write,WebFetch";

function recordingSpawn() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnImpl: SpawnImpl = ((command: string, args: readonly string[]) => {
    calls.push({ command, args: [...args] });
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter & { setEncoding(encoding: string): void };
      stdin: { end(input?: string): void };
    };
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stdin = {
      end() {
        queueMicrotask(() => child.emit("close", 0));
      },
    };
    return child;
  }) as SpawnImpl;
  return { calls, spawnImpl };
}

function receiverOptions(
  overrides: Partial<ConstructorParameters<typeof ClaudeSpawnRunner>[0]> = {},
) {
  return {
    mcpConfigPath: join(tmpdir(), "claude-gateway-test-mcp.json"),
    identity: "receiver-test",
    gatewayUrl: "https://gateway.test",
    keyCommand: "cat key.pem",
    ...overrides,
  };
}

describe("ClaudeSpawnRunner", () => {
  test("appends the receiver disallowed-tools guard after custom args", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "claude-runner-"));
    const { calls, spawnImpl } = recordingSpawn();
    try {
      const runner = new ClaudeSpawnRunner(
        receiverOptions({
          args: ["-p", "--model", "claude-test"],
          mcpConfigPath: join(tmp, "mcp.json"),
          spawnImpl,
        }),
      );

      await runner.run("hello");

      const args = calls[0]?.args ?? [];
      const disallowedIndex = args.lastIndexOf("--disallowedTools");
      expect(disallowedIndex).toBeGreaterThan(-1);
      expect(args[disallowedIndex + 1]).toBe(ENFORCED_DISALLOWED_TOOLS);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("custom disallowedTools cannot replace the receiver guard", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "claude-runner-"));
    const { calls, spawnImpl } = recordingSpawn();
    try {
      const runner = new ClaudeSpawnRunner(
        receiverOptions({
          args: ["-p", "--disallowedTools", "Read"],
          mcpConfigPath: join(tmp, "mcp.json"),
          spawnImpl,
        }),
      );

      await runner.run("hello");

      const args = calls[0]?.args ?? [];
      expect(args).toContain("Read");
      const disallowedIndex = args.lastIndexOf("--disallowedTools");
      expect(args[disallowedIndex + 1]).toBe(ENFORCED_DISALLOWED_TOOLS);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test("rejects bypassPermissions from direct runner args", () => {
    expect(
      () =>
        new ClaudeSpawnRunner(
          receiverOptions({ args: ["-p", "--permission-mode", "bypassPermissions"] }),
        ),
    ).toThrow("bypassPermissions is not allowed");
    expect(
      () =>
        new ClaudeSpawnRunner(
          receiverOptions({ args: ["-p", "--permission-mode=bypassPermissions"] }),
        ),
    ).toThrow("bypassPermissions is not allowed");
  });

  test("default args also end with the receiver disallowed-tools guard", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "claude-runner-"));
    const { calls, spawnImpl } = recordingSpawn();
    try {
      const runner = new ClaudeSpawnRunner(
        receiverOptions({ mcpConfigPath: join(tmp, "mcp.json"), spawnImpl }),
      );

      await runner.run("hello");

      const args = calls[0]?.args ?? [];
      const disallowedIndex = args.lastIndexOf("--disallowedTools");
      expect(disallowedIndex).toBeGreaterThan(-1);
      expect(args[disallowedIndex + 1]).toBe(ENFORCED_DISALLOWED_TOOLS);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("splitClaudeArgs", () => {
  test("rejects bypassPermissions from env-supplied args", () => {
    expect(() => splitClaudeArgs("-p --permission-mode bypassPermissions")).toThrow(
      "bypassPermissions is not allowed",
    );
    expect(() => splitClaudeArgs("-p --permission-mode=bypassPermissions")).toThrow(
      "bypassPermissions is not allowed",
    );
  });
});
