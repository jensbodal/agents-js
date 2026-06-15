/**
 * Tests for `agents-js onboard`.
 *
 * LT-1: pure parsing + mesh-join dispatch helpers keep the post-launch artifact
 *       stable.
 * LT-2: --help short-circuits before launch.
 * LT-3: native Pi onboarding bootstraps an identity workspace before launch:
 *       create the workspace, initialize git only when absent, seed README,
 *       HANDOFF, and `.agents/<name>/identity.md`, then start tmux.
 * LT-4: bootstrap is idempotent and never overwrites operator-authored seed
 *       files.
 * LT-5: an unsafe existing non-directory workspace path fails before tmux side
 *       effects.
 * LT-6: fixed-port dispatch output uses the same pi_host semantics as launch,
 *       so an explicit loopback/local-only peer never emits a LAN gateway entry.
 * LT-7: non-Pi agents are still launchable through onboard, but native-Pi
 *       identity workspace bootstrap and fixed-port dispatch output are Pi-only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildMeshJoinDispatchEntry,
  parseOnboardTarget,
  runOnboardCommand,
} from "../src/onboard.ts";

describe("parseOnboardTarget", () => {
  test("takes the first non-flag token as the agent name", () => {
    expect(parseOnboardTarget(["cognee-claude"]).agentName).toBe("cognee-claude");
    expect(parseOnboardTarget(["cognee-claude", "--bg"]).agentName).toBe("cognee-claude");
    expect(parseOnboardTarget(["--bg", "cognee-claude"]).agentName).toBe("cognee-claude");
  });

  test("extracts an explicit --config value without mistaking it for the agent", () => {
    const before = parseOnboardTarget(["--config", "/tmp/agents.json", "mdg-pi-0"]);
    expect(before.agentName).toBe("mdg-pi-0");
    expect(before.configPath).toBe("/tmp/agents.json");

    const after = parseOnboardTarget(["mdg-pi-0", "--config", "/tmp/agents.json"]);
    expect(after.agentName).toBe("mdg-pi-0");
    expect(after.configPath).toBe("/tmp/agents.json");
  });

  test("returns undefined agent when no positional is present", () => {
    expect(parseOnboardTarget(["--help"]).agentName).toBeUndefined();
    expect(parseOnboardTarget([]).agentName).toBeUndefined();
  });
});

describe("buildMeshJoinDispatchEntry", () => {
  test("builds an FQDN-based a2a url when a fixed port + host resolve", () => {
    const entry = buildMeshJoinDispatchEntry("mdg-pi-0", "3199", "mdg.q4m.dev");
    expect(entry).toEqual({ name: "mdg-pi-0", url: "http://mdg.q4m.dev:3199" });
  });

  test("returns null without a fixed A2A port (ephemeral peers self-register locally)", () => {
    expect(buildMeshJoinDispatchEntry("mdg-pi-0", undefined, "mdg.q4m.dev")).toBeNull();
    expect(buildMeshJoinDispatchEntry("mdg-pi-0", "", "mdg.q4m.dev")).toBeNull();
  });

  test("returns null when no advertise host resolves", () => {
    expect(buildMeshJoinDispatchEntry("mdg-pi-0", "3199", undefined)).toBeNull();
  });
});

describe("runOnboardCommand --help", () => {
  function capture(): { sink: { write: (s: string) => boolean }; text: () => string } {
    const chunks: string[] = [];
    return {
      sink: {
        write: (s: string) => {
          chunks.push(s);
          return true;
        },
      },
      text: () => chunks.join(""),
    };
  }

  // Regression: --help must short-circuit BEFORE the launch path, so it prints
  // onboard's own usage — not launch's help wrapped in launching/launched
  // banners (and never actually launching a session).
  for (const flag of ["--help", "-h"]) {
    test(`\`onboard ${flag}\` prints onboard usage and skips the launch path`, async () => {
      const out = capture();
      const code = await runOnboardCommand([flag], {
        output: out.sink as unknown as Pick<NodeJS.WriteStream, "write">,
      });
      const text = out.text();
      expect(code).toBe(0);
      expect(text).toContain("agents-js onboard <agent-name>");
      expect(text).toContain("mesh-join dispatch entry");
      expect(text).not.toContain("launching agent onto the mesh");
      expect(text).not.toContain("harness launched");
    });
  }
});

interface FakeRunnerCalls {
  hasSession: string[];
  newSessionDetached: Array<[string, string]>;
  setEnvironment: Array<[string, string, string]>;
  sendKeys: Array<[string, string]>;
}

function fakeRunner(): {
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
        return false;
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

function capture(): { sink: { write: (s: string) => boolean }; text: () => string } {
  const chunks: string[] = [];
  return {
    sink: {
      write: (s: string) => {
        chunks.push(s);
        return true;
      },
    },
    text: () => chunks.join(""),
  };
}

async function writePiConfig(root: string, workspace: string, name = "olthoi0-pi-jensbodal") {
  const configPath = path.join(root, "agent-launch-config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: "0.1.0",
        agents: {
          [name]: {
            tmux_session: name,
            harness: "pi",
            binary: "pi",
            workspace,
            fresh_flags: "--approve",
            env_setup: `export MATRIX_AGENT=${name}`,
            pi_port: "3199",
            pi_host: "127.0.0.1",
          },
        },
      },
      null,
      2,
    ),
  );
  return configPath;
}

async function writeCodexConfig(root: string, workspace: string, name = "olthoi0-codex-0") {
  const configPath = path.join(root, "agent-launch-config.json");
  await writeFile(
    configPath,
    JSON.stringify(
      {
        version: "0.1.0",
        agents: {
          [name]: {
            tmux_session: name,
            harness: "codex",
            binary: "codex",
            workspace,
            fresh_flags: "--sandbox workspace-write",
            env_setup: `export MATRIX_AGENT=${name}`,
            pi_port: "3199",
            pi_host: "127.0.0.1",
          },
        },
      },
      null,
      2,
    ),
  );
  return configPath;
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ajs-onboard-"));
  tempRoots.push(root);
  return root;
}

describe("runOnboardCommand workspace bootstrap", () => {
  test("creates a missing identity workspace and seeds files before launch", async () => {
    const root = await makeTempRoot();
    const workspace = path.join(root, "workspaces", "agents", "olthoi0-pi-jensbodal");
    const configPath = await writePiConfig(root, workspace);
    const { runner, calls } = fakeRunner();
    const out = capture();

    const code = await runOnboardCommand(["olthoi0-pi-jensbodal", "--bg", "--config", configPath], {
      output: out.sink,
      env: { PATH: "/usr/bin" },
      home: root,
      cwd: root,
      createRunner: () => runner,
    });

    expect(code).toBe(0);
    expect((await stat(workspace)).isDirectory()).toBe(true);
    expect((await stat(path.join(workspace, ".git"))).isDirectory()).toBe(true);
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toContain(
      "olthoi0-pi-jensbodal",
    );
    expect(await readFile(path.join(workspace, "HANDOFF.md"), "utf8")).toContain("Current Status");
    expect(
      await readFile(
        path.join(workspace, ".agents", "olthoi0-pi-jensbodal", "identity.md"),
        "utf8",
      ),
    ).toContain("MATRIX_AGENT=olthoi0-pi-jensbodal");
    expect(calls.newSessionDetached).toEqual([["olthoi0-pi-jensbodal", workspace]]);
    expect(out.text()).toContain("workspace ready");
  });

  test("emits loopback dispatch when pi_host explicitly forces local-only advertise", async () => {
    const root = await makeTempRoot();
    const workspace = path.join(root, "workspaces", "agents", "olthoi0-pi-jensbodal");
    const configPath = await writePiConfig(root, workspace);
    const { runner } = fakeRunner();
    const out = capture();

    const code = await runOnboardCommand(["olthoi0-pi-jensbodal", "--bg", "--config", configPath], {
      output: out.sink,
      env: { PATH: "/usr/bin", AGENTS_JS_LAN_DOMAIN: "q4m.dev" },
      home: root,
      cwd: root,
      createRunner: () => runner,
    });

    expect(code).toBe(0);
    expect(out.text()).toContain("http://127.0.0.1:3199");
    expect(out.text()).not.toContain("q4m.dev:3199");
  });

  test("does not overwrite existing seed files or reinitialize an existing git repo", async () => {
    const root = await makeTempRoot();
    const workspace = path.join(root, "ws");
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await mkdir(path.join(workspace, ".agents", "olthoi0-pi-jensbodal"), { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "custom readme");
    await writeFile(path.join(workspace, "HANDOFF.md"), "custom handoff");
    await writeFile(
      path.join(workspace, ".agents", "olthoi0-pi-jensbodal", "identity.md"),
      "custom identity",
    );
    const configPath = await writePiConfig(root, workspace);
    const { runner } = fakeRunner();

    const code = await runOnboardCommand(["olthoi0-pi-jensbodal", "--bg", "--config", configPath], {
      output: capture().sink,
      env: { PATH: "/usr/bin" },
      home: root,
      cwd: root,
      createRunner: () => runner,
    });

    expect(code).toBe(0);
    expect(await readFile(path.join(workspace, "README.md"), "utf8")).toBe("custom readme");
    expect(await readFile(path.join(workspace, "HANDOFF.md"), "utf8")).toBe("custom handoff");
    expect(
      await readFile(
        path.join(workspace, ".agents", "olthoi0-pi-jensbodal", "identity.md"),
        "utf8",
      ),
    ).toBe("custom identity");
  });

  test("fails before launch when the configured workspace path is an existing file", async () => {
    const root = await makeTempRoot();
    const workspace = path.join(root, "not-a-directory");
    await writeFile(workspace, "not a dir");
    const configPath = await writePiConfig(root, workspace);
    const { runner, calls } = fakeRunner();
    const out = capture();

    const code = await runOnboardCommand(["olthoi0-pi-jensbodal", "--bg", "--config", configPath], {
      output: out.sink,
      env: { PATH: "/usr/bin" },
      home: root,
      cwd: root,
      createRunner: () => runner,
    });

    expect(code).toBe(1);
    expect(calls.newSessionDetached).toEqual([]);
    expect(calls.sendKeys).toEqual([]);
    expect(out.text()).toContain("workspace path is not a directory");
  });

  test("does not bootstrap a workspace for non-Pi agents", async () => {
    const root = await makeTempRoot();
    const workspace = path.join(root, "workspaces", "agents", "olthoi0-codex-0");
    const configPath = await writeCodexConfig(root, workspace);
    const { runner, calls } = fakeRunner();

    const code = await runOnboardCommand(["olthoi0-codex-0", "--bg", "--config", configPath], {
      output: capture().sink,
      env: { PATH: "/usr/bin" },
      home: root,
      cwd: root,
      createRunner: () => runner,
    });

    expect(code).toBe(0);
    await expect(stat(workspace)).rejects.toThrow();
    expect(calls.newSessionDetached).toEqual([["olthoi0-codex-0", workspace]]);
  });

  test("does not emit fixed-port dispatch for non-Pi agents even if stale pi fields exist", async () => {
    const root = await makeTempRoot();
    const workspace = path.join(root, "workspaces", "agents", "olthoi0-codex-0");
    const configPath = await writeCodexConfig(root, workspace);
    const { runner } = fakeRunner();
    const out = capture();

    const code = await runOnboardCommand(["olthoi0-codex-0", "--bg", "--config", configPath], {
      output: out.sink,
      env: { PATH: "/usr/bin", AGENTS_JS_LAN_DOMAIN: "q4m.dev" },
      home: root,
      cwd: root,
      createRunner: () => runner,
    });

    expect(code).toBe(0);
    expect(out.text()).not.toContain("mesh-join dispatch entry");
    expect(out.text()).not.toContain("http://127.0.0.1:3199");
  });
});
