/**
 * Tests for the tmux wrapper. Uses a mock spawner to avoid the real
 * tmux binary; real-binary smoke is integration-tier (not Phase 1).
 */
import { describe, expect, test } from "bun:test";
import { createTmuxRunner, type TmuxSpawnResult } from "../../src/tmux.ts";

interface CallRecord {
  readonly args: readonly string[];
}

function mockSpawner(responses: readonly TmuxSpawnResult[]): {
  spawner: (args: readonly string[]) => TmuxSpawnResult;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let i = 0;
  const spawner = (args: readonly string[]): TmuxSpawnResult => {
    calls.push({ args });
    const r = responses[i++];
    if (!r) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return r;
  };
  return { spawner, calls };
}

describe("createTmuxRunner — hasSession", () => {
  test("returns true when tmux exits 0", () => {
    const { spawner, calls } = mockSpawner([{ status: 0, stdout: "", stderr: "" }]);
    const runner = createTmuxRunner({ spawner });
    expect(runner.hasSession("foo")).toBe(true);
    expect(calls[0]?.args).toEqual(["has-session", "-t", "=foo"]);
  });

  test("returns false when tmux exits non-zero", () => {
    const { spawner } = mockSpawner([{ status: 1, stdout: "", stderr: "no session" }]);
    const runner = createTmuxRunner({ spawner });
    expect(runner.hasSession("ghost")).toBe(false);
  });
});

describe("createTmuxRunner — newSessionDetached", () => {
  test("invokes new-session with -d -s name -c cwd", () => {
    const { spawner, calls } = mockSpawner([{ status: 0, stdout: "", stderr: "" }]);
    const runner = createTmuxRunner({ spawner });
    runner.newSessionDetached("session-x", "/work/dir");
    expect(calls[0]?.args).toEqual(["new-session", "-d", "-s", "session-x", "-c", "/work/dir"]);
  });

  test("throws when tmux returns non-zero", () => {
    const { spawner } = mockSpawner([{ status: 2, stdout: "", stderr: "duplicate session" }]);
    const runner = createTmuxRunner({ spawner });
    expect(() => runner.newSessionDetached("session-x", "/work/dir")).toThrow(/new-session failed/);
  });
});

describe("createTmuxRunner — setEnvironment", () => {
  test("invokes set-environment with -t session key value", () => {
    const { spawner, calls } = mockSpawner([{ status: 0, stdout: "", stderr: "" }]);
    const runner = createTmuxRunner({ spawner });
    runner.setEnvironment("session-x", "MATRIX_AGENT", "cognee-claude");
    expect(calls[0]?.args).toEqual([
      "set-environment",
      "-t",
      "session-x",
      "MATRIX_AGENT",
      "cognee-claude",
    ]);
  });

  test("key + value pass through as separate argv tokens (no shell quoting)", () => {
    const { spawner, calls } = mockSpawner([{ status: 0, stdout: "", stderr: "" }]);
    const runner = createTmuxRunner({ spawner });
    runner.setEnvironment("s", "TRICKY", "value with spaces and 'quotes'");
    expect(calls[0]?.args[4]).toBe("value with spaces and 'quotes'");
  });
});

describe("createTmuxRunner — sendKeys", () => {
  test("invokes send-keys with -t session: payload Enter", () => {
    const { spawner, calls } = mockSpawner([{ status: 0, stdout: "", stderr: "" }]);
    const runner = createTmuxRunner({ spawner });
    runner.sendKeys("session-x", "claude --agent foo");
    expect(calls[0]?.args).toEqual([
      "send-keys",
      "-t",
      "session-x:",
      "claude --agent foo",
      "Enter",
    ]);
  });
});
