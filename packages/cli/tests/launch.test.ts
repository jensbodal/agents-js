/**
 * Tests for `agents-js launch` command. Mocks the tmux runner so tests
 * don't need a real tmux binary; the agent-launch package owns the
 * runner-internal tests.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLaunchCommand } from "../src/launch.ts";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-launch/tests/fixtures/cognee-claude-only.json",
);

const CHANNEL_ENV_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-launch/tests/fixtures/channel-env-agent.json",
);

interface FakeRunnerCalls {
  hasSession: string[];
  newSessionDetached: Array<[string, string]>;
  setEnvironment: Array<[string, string, string]>;
  sendKeys: Array<[string, string]>;
}

function fakeRunner(sessionExists = false): {
  runner: ReturnType<typeof createRunner>;
  calls: FakeRunnerCalls;
} {
  const calls: FakeRunnerCalls = {
    hasSession: [],
    newSessionDetached: [],
    setEnvironment: [],
    sendKeys: [],
  };
  function createRunner() {
    return {
      hasSession(s: string): boolean {
        calls.hasSession.push(s);
        return sessionExists;
      },
      newSessionDetached(s: string, cwd: string): void {
        calls.newSessionDetached.push([s, cwd]);
      },
      setEnvironment(s: string, k: string, v: string): void {
        calls.setEnvironment.push([s, k, v]);
      },
      sendKeys(s: string, payload: string): void {
        calls.sendKeys.push([s, payload]);
      },
    };
  }
  return { runner: createRunner(), calls };
}

function captureOutput() {
  const chunks: string[] = [];
  return {
    write: (s: string): boolean => {
      chunks.push(s);
      return true;
    },
    get text(): string {
      return chunks.join("");
    },
  };
}

describe("runLaunchCommand — happy path with fake tmux runner", () => {
  test("launches cognee-claude with --bg + --config", async () => {
    const { runner, calls } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand(["cognee-claude", "--bg", "--config", FIXTURE_PATH], {
      output: out,
      env: { PATH: "/usr/bin" },
      home: "/home/test",
      cwd: "/tmp",
      createRunner: () => runner,
    });
    expect(code).toBe(0);
    expect(calls.hasSession).toEqual(["cognee-claude"]);
    expect(calls.newSessionDetached).toEqual([
      ["cognee-claude", "/Users/jensbodal/workspace/dot-cognee"],
    ]);
    // Identity env pushed onto session
    const envKeys = calls.setEnvironment.map(([_, k]) => k).sort();
    expect(envKeys).toEqual([
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
      "MATRIX_AGENT",
    ]);
    // send-keys ran once with the composed cmd line
    expect(calls.sendKeys).toHaveLength(1);
    const sentCmd = calls.sendKeys[0]?.[1] ?? "";
    expect(sentCmd).toContain("cd ");
    expect(sentCmd).toContain("claude --agent cognee-claude");
    expect(out.text).toContain('launch: session "cognee-claude" created');
  });

  test("channel_env vars are exported into the harness command but NOT set session-wide", async () => {
    const { runner, calls } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand(
      ["olthoi0-ajs-claude-0", "--bg", "--config", CHANNEL_ENV_FIXTURE_PATH],
      {
        output: out,
        env: { PATH: "/usr/bin" },
        home: "/home/test",
        cwd: "/tmp",
        createRunner: () => runner,
      },
    );
    expect(code).toBe(0);

    // CH_GATEWAY_* are exported in the launch command so the harness (and its
    // child channel-adapter MCP) inherit them.
    const sentCmd = calls.sendKeys[0]?.[1] ?? "";
    expect(sentCmd).toContain("export CH_GATEWAY_URL=");
    expect(sentCmd).toContain("export CH_GATEWAY_IDENTITY=");

    // But they are NOT pushed via tmux set-environment (only identity vars are).
    const sessionEnvKeys = calls.setEnvironment.map(([_, k]) => k);
    expect(sessionEnvKeys).not.toContain("CH_GATEWAY_URL");
    expect(sessionEnvKeys).not.toContain("CH_GATEWAY_IDENTITY");
    expect(sessionEnvKeys).toContain("MATRIX_AGENT");
  });

  test("session-exists branch does not re-create + suggests manual attach", async () => {
    const { runner, calls } = fakeRunner(true);
    const out = captureOutput();
    const code = await runLaunchCommand(["cognee-claude", "--bg", "--config", FIXTURE_PATH], {
      output: out,
      env: {},
      home: "/home/test",
      cwd: "/tmp",
      createRunner: () => runner,
    });
    expect(code).toBe(0);
    expect(calls.newSessionDetached).toEqual([]);
    expect(calls.sendKeys).toEqual([]);
    expect(out.text).toContain('session "cognee-claude" already exists');
  });
});

describe("runLaunchCommand — argument errors", () => {
  test("missing agent name returns EXIT_USAGE=64", async () => {
    const { runner } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand([], {
      output: out,
      env: {},
      home: "/home/test",
      cwd: "/tmp",
      createRunner: () => runner,
    });
    expect(code).toBe(64);
  });

  test("unknown flag returns EXIT_USAGE=64", async () => {
    const { runner } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand(["cognee-claude", "--bogus"], {
      output: out,
      env: {},
      home: "/home/test",
      cwd: "/tmp",
      createRunner: () => runner,
    });
    expect(code).toBe(64);
  });

  test("--help prints usage and returns OK", async () => {
    const out = captureOutput();
    const code = await runLaunchCommand(["--help"], {
      output: out,
      env: {},
      home: "/home/test",
      cwd: "/tmp",
    });
    expect(code).toBe(0);
    expect(out.text).toContain("Usage:");
    expect(out.text).toContain("agents-js launch");
  });

  test("missing config (all 4 candidates absent) returns EXIT_ERROR=1", async () => {
    const { runner } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand(["cognee-claude"], {
      output: out,
      env: {},
      home: "/nonexistent-home",
      cwd: "/nonexistent-cwd",
      createRunner: () => runner,
    });
    expect(code).toBe(1);
  });
});
