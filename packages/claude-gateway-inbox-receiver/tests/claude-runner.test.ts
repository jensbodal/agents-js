import { describe, expect, test } from "bun:test";
import { DEFAULT_CLAUDE_ARGS } from "../src/claude-runner.ts";

describe("DEFAULT_CLAUDE_ARGS", () => {
  test("defaults to least-privilege reply tooling without bypassPermissions", () => {
    expect(DEFAULT_CLAUDE_ARGS).toEqual([
      "-p",
      "--disallowedTools",
      "Bash,Edit,Write,WebFetch",
      "--allowedTools",
      "mcp__agents_gateway__agents_send_message",
    ]);
    expect(DEFAULT_CLAUDE_ARGS).not.toContain("--permission-mode");
    expect(DEFAULT_CLAUDE_ARGS).not.toContain("bypassPermissions");
  });
});
