/**
 * Tests for `agents-js launch` command. Mocks the tmux runner so tests
 * don't need a real tmux binary; the agent-launch package owns the
 * runner-internal tests.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfigPath, runLaunchCommand } from "../src/launch.ts";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-launch/tests/fixtures/cognee-claude-only.json",
);

const CHANNEL_ENV_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-launch/tests/fixtures/channel-env-agent.json",
);

const CODEX_RECEIVER_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-launch/tests/fixtures/codex-with-receiver.json",
);

const CODEX_MISSING_RECEIVER_ENV_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-launch/tests/fixtures/codex-missing-receiver-env.json",
);

const COLLISION_FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agent-launch/tests/fixtures/matrix-agent-collision.json",
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

  test("codex --with-receiver launches a companion gateway inbox receiver", async () => {
    const { runner, calls } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand(
      ["olthoi0-codex-0", "--with-receiver", "--bg", "--config", CODEX_RECEIVER_FIXTURE_PATH],
      {
        output: out,
        env: { PATH: "/usr/bin" },
        home: "/home/test",
        cwd: "/tmp",
        createRunner: () => runner,
      },
    );
    expect(code).toBe(0);
    expect(calls.newSessionDetached).toEqual([
      ["olthoi0-codex-0", "/Users/jensbodal/workspaces/agents/olthoi0-codex-0"],
      ["olthoi0-codex-0-receiver", "/Users/jensbodal/workspaces/agents/olthoi0-codex-0"],
    ]);

    const mainCmd = calls.sendKeys[0]?.[1] ?? "";
    expect(mainCmd).toContain("codex --sandbox workspace-write");

    const receiverCmd = calls.sendKeys[1]?.[1] ?? "";
    expect(receiverCmd).toContain("agents-js codex-receiver");
    expect(receiverCmd).toContain('export CODEX_GATEWAY_IDENTITY="olthoi0-codex-0"');
    expect(receiverCmd).toContain('export CODEX_GATEWAY_URL="https://ajs-gateway.q4m.dev"');
    expect(receiverCmd).toContain(
      'export CODEX_GATEWAY_KEY_CMD="gopass show --noparsing services/agents-js/identity/olthoi0-codex-0/key"',
    );
    expect(receiverCmd).toContain('export CODEX_GATEWAY_FETCH="curl"');
    expect(receiverCmd).toContain('export CODEX_GATEWAY_SKIP_GIT_REPO_CHECK="true"');
    expect(receiverCmd).toContain(
      'export CODEX_GATEWAY_CURSOR_PATH="/Users/jensbodal/workspaces/agents/olthoi0-codex-0/.agents/olthoi0-codex-0/gateway-inbox-cursor.json"',
    );

    const receiverSessionEnvKeys = calls.setEnvironment
      .filter(([session]) => session === "olthoi0-codex-0-receiver")
      .map(([_, key]) => key)
      .sort();
    expect(receiverSessionEnvKeys).toEqual([
      "AGENTS_GATEWAY_SUB",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
      "MATRIX_AGENT",
    ]);
    expect(calls.setEnvironment.map(([_, key]) => key)).not.toContain("CODEX_GATEWAY_KEY_CMD");
  });

  test("codex --with-receiver fails before tmux side effects when receiver env is missing", async () => {
    const { runner, calls } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand(
      [
        "olthoi0-codex-0",
        "--with-receiver",
        "--bg",
        "--config",
        CODEX_MISSING_RECEIVER_ENV_FIXTURE_PATH,
      ],
      {
        output: out,
        env: { PATH: "/usr/bin" },
        home: "/home/test",
        cwd: "/tmp",
        createRunner: () => runner,
      },
    );
    expect(code).toBe(65);
    expect(calls.hasSession).toEqual([]);
    expect(calls.newSessionDetached).toEqual([]);
    expect(calls.sendKeys).toEqual([]);
  });
});

describe("runLaunchCommand — MATRIX_AGENT uniqueness (#37 / ADR #75 Phase 1)", () => {
  test("rejects a co-claimant launch with EXIT_DATAERR and creates no session", async () => {
    const { runner, calls } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand(
      ["agent-dup-a", "--bg", "--config", COLLISION_FIXTURE_PATH],
      {
        output: out,
        env: { PATH: "/usr/bin" },
        home: "/home/test",
        cwd: "/tmp",
        createRunner: () => runner,
      },
    );
    expect(code).toBe(65); // EXIT_DATAERR
    // The guard runs before any tmux side effect.
    expect(calls.newSessionDetached).toEqual([]);
    expect(calls.sendKeys).toEqual([]);
  });

  test("a uniquely-named agent in the same config still launches", async () => {
    const { runner, calls } = fakeRunner();
    const out = captureOutput();
    const code = await runLaunchCommand(
      ["agent-unique", "--bg", "--config", COLLISION_FIXTURE_PATH],
      {
        output: out,
        env: { PATH: "/usr/bin" },
        home: "/home/test",
        cwd: "/tmp",
        createRunner: () => runner,
      },
    );
    expect(code).toBe(0);
    expect(calls.newSessionDetached).toEqual([["agent-unique", "/tmp/c"]]);
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

describe("resolveConfigPath — $XDG_CONFIG_HOME honoring", () => {
  const tmpDirs: string[] = [];
  async function makeConfigDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "ajs-xdg-"));
    tmpDirs.push(dir);
    return dir;
  }
  async function writeLaunchConfig(root: string): Promise<string> {
    const dir = path.join(root, "agents-js");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "agent-launch-config.json");
    await writeFile(file, "{}");
    return file;
  }
  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  test("resolves the config under $XDG_CONFIG_HOME when set", async () => {
    const xdg = await makeConfigDir();
    const expected = await writeLaunchConfig(xdg);
    const got = resolveConfigPath(
      {},
      { XDG_CONFIG_HOME: xdg },
      "/nonexistent-home",
      "/nonexistent-cwd",
    );
    expect(got).toBe(expected);
  });

  test("$XDG_CONFIG_HOME takes priority over ~/.config when both exist", async () => {
    const xdg = await makeConfigDir();
    const home = await makeConfigDir();
    const xdgFile = await writeLaunchConfig(xdg);
    await writeLaunchConfig(path.join(home, ".config"));
    const got = resolveConfigPath({}, { XDG_CONFIG_HOME: xdg }, home, "/nonexistent-cwd");
    expect(got).toBe(xdgFile);
  });

  test("falls back to ~/.config when $XDG_CONFIG_HOME is unset (existing layouts unchanged)", async () => {
    const home = await makeConfigDir();
    const expected = await writeLaunchConfig(path.join(home, ".config"));
    const got = resolveConfigPath({}, {}, home, "/nonexistent-cwd");
    expect(got).toBe(expected);
  });
});
