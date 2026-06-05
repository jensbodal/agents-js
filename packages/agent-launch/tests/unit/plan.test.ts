/**
 * Tests for buildLaunchPlan. Phase 1: claude-code, fresh mode only.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLaunchConfig, resolveAgentEntry } from "../../src/config.ts";
import { buildLaunchPlan, LaunchPlanError } from "../../src/plan.ts";

const FIXTURE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/cognee-claude-only.json",
);

describe("buildLaunchPlan — happy path", () => {
  test("cognee-claude fixture produces expected structured plan", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    const entry = resolveAgentEntry(config, "cognee-claude");
    const plan = buildLaunchPlan(entry, { baseEnv: { PATH: "/usr/bin" } });

    expect(plan.tmuxSession).toBe("cognee-claude");
    expect(plan.cwd).toBe("/Users/jensbodal/workspace/dot-cognee");
    expect(plan.command).toBe("claude");
    expect(plan.args).toEqual([
      "--agent",
      "cognee-claude",
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
    ]);
    expect(plan.harness).toBe("claude-code");
    expect(plan.mode).toBe("fresh");
  });

  test("env carries git + MATRIX_AGENT identity", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    const entry = resolveAgentEntry(config, "cognee-claude");
    const plan = buildLaunchPlan(entry, { baseEnv: { PATH: "/usr/bin" } });

    expect(plan.env.GIT_AUTHOR_NAME).toBe("cognee-claude");
    expect(plan.env.GIT_AUTHOR_EMAIL).toBe("cognee-claude@agents.example");
    expect(plan.env.GIT_COMMITTER_NAME).toBe("cognee-claude");
    expect(plan.env.GIT_COMMITTER_EMAIL).toBe("cognee-claude@agents.example");
    expect(plan.env.MATRIX_AGENT).toBe("cognee-claude");
    expect(plan.env.PATH).toBe("/usr/bin");
  });

  test("sessionEnv subset includes git + MATRIX_AGENT only (PATH is NOT in session env)", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    const entry = resolveAgentEntry(config, "cognee-claude");
    const plan = buildLaunchPlan(entry, { baseEnv: { PATH: "/usr/bin" } });

    expect(plan.sessionEnv.GIT_AUTHOR_NAME).toBe("cognee-claude");
    expect(plan.sessionEnv.MATRIX_AGENT).toBe("cognee-claude");
    expect(plan.sessionEnv.PATH).toBeUndefined();
  });

  test("plan + sessionEnv are frozen", async () => {
    const config = await loadLaunchConfig(FIXTURE_PATH);
    const entry = resolveAgentEntry(config, "cognee-claude");
    const plan = buildLaunchPlan(entry, { baseEnv: {} });
    expect(Object.isFrozen(plan.env)).toBe(true);
    expect(Object.isFrozen(plan.sessionEnv)).toBe(true);
  });
});

describe("buildLaunchPlan — rejection paths", () => {
  test("unsupported harness throws LaunchPlanError", () => {
    expect(() =>
      buildLaunchPlan(
        {
          tmuxSession: "x",
          harness: "future-harness",
          binary: "x",
          workspace: "/tmp",
          freshFlags: "--y",
          extra: {},
        },
        { baseEnv: {} },
      ),
    ).toThrow(LaunchPlanError);
    try {
      buildLaunchPlan(
        {
          tmuxSession: "x",
          harness: "future-harness",
          binary: "x",
          workspace: "/tmp",
          freshFlags: "--y",
          extra: {},
        },
        { baseEnv: {} },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchPlanError);
      expect((err as Error).message).toContain('harness "future-harness" not supported');
      expect((err as Error).message).toContain("supported: claude-code");
    }
  });

  test("unsupported mode throws", () => {
    expect(() =>
      buildLaunchPlan(
        {
          tmuxSession: "x",
          harness: "claude-code",
          binary: "x",
          workspace: "/tmp",
          freshFlags: "--y",
          extra: {},
        },
        // @ts-expect-error — testing runtime guard on invalid LaunchMode
        { baseEnv: {}, mode: "resume" },
      ),
    ).toThrow(/mode "resume" not supported in Phase 1/);
  });

  test("empty fresh_flags throws", () => {
    expect(() =>
      buildLaunchPlan(
        {
          tmuxSession: "x",
          harness: "claude-code",
          binary: "x",
          workspace: "/tmp",
          freshFlags: "   ",
          extra: {},
        },
        { baseEnv: {} },
      ),
    ).toThrow(/fresh_flags is empty/);
  });
});

describe("buildLaunchPlan — flag splitting", () => {
  test("whitespace-separated flags split correctly", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "x",
        harness: "claude-code",
        binary: "claude",
        workspace: "/tmp",
        freshFlags: "--foo  bar\t--baz\nqux",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.args).toEqual(["--foo", "bar", "--baz", "qux"]);
  });
});

describe("buildLaunchPlan — channel_env propagation", () => {
  const entryWithChannelEnv = {
    tmuxSession: "x",
    harness: "claude-code",
    binary: "claude",
    workspace: "/tmp",
    freshFlags: "--agent x",
    channelEnv:
      "export CH_GATEWAY_URL=https://ajs-gateway.q4m.dev && export CH_GATEWAY_IDENTITY=olthoi0-ajs-claude-0",
    extra: {},
  };

  test("channel_env vars reach plan.env and plan.channelEnv", () => {
    const plan = buildLaunchPlan(entryWithChannelEnv, { baseEnv: { PATH: "/usr/bin" } });
    expect(plan.env.CH_GATEWAY_URL).toBe("https://ajs-gateway.q4m.dev");
    expect(plan.env.CH_GATEWAY_IDENTITY).toBe("olthoi0-ajs-claude-0");
    expect(plan.channelEnv.CH_GATEWAY_URL).toBe("https://ajs-gateway.q4m.dev");
    expect(plan.channelEnv.CH_GATEWAY_IDENTITY).toBe("olthoi0-ajs-claude-0");
  });

  test("channel_env vars are NOT in sessionEnv (not pushed session-wide)", () => {
    const plan = buildLaunchPlan(entryWithChannelEnv, { baseEnv: {} });
    expect(plan.sessionEnv.CH_GATEWAY_URL).toBeUndefined();
    expect(plan.sessionEnv.CH_GATEWAY_IDENTITY).toBeUndefined();
  });

  test("channelEnv is an empty frozen object when channel_env is unset", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "x",
        harness: "claude-code",
        binary: "claude",
        workspace: "/tmp",
        freshFlags: "--y",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.channelEnv).toEqual({});
    expect(Object.isFrozen(plan.channelEnv)).toBe(true);
  });
});

describe("buildLaunchPlan — allowed_tools", () => {
  test("appends a comma-joined --allowedTools flag after fresh_flags", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "x",
        harness: "claude-code",
        binary: "claude",
        workspace: "/tmp",
        freshFlags: "--agent x --permission-mode dontAsk",
        allowedTools: [
          "mcp__claude-channel-adapter__agents_js_send",
          "mcp__claude-channel-adapter__agents_js_reply",
        ],
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.args).toEqual([
      "--agent",
      "x",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "mcp__claude-channel-adapter__agents_js_send,mcp__claude-channel-adapter__agents_js_reply",
    ]);
    expect(plan.allowedTools).toEqual([
      "mcp__claude-channel-adapter__agents_js_send",
      "mcp__claude-channel-adapter__agents_js_reply",
    ]);
  });

  test("no --allowedTools flag when allowed_tools is unset", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "x",
        harness: "claude-code",
        binary: "claude",
        workspace: "/tmp",
        freshFlags: "--agent x",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.args).toEqual(["--agent", "x"]);
    expect(plan.allowedTools).toEqual([]);
  });
});

describe("buildLaunchPlan — pi harness (Phase 2, native peer)", () => {
  const piEntry = {
    tmuxSession: "malar-pi-0",
    harness: "pi",
    binary: "pi",
    workspace: "/tmp/malar",
    freshFlags: "",
    envSetup: "export MATRIX_AGENT=malar-pi-0",
    piExtension: "./extras/pi-extension/src/index.ts",
    piPort: "3199",
    gitAuthorName: "malar-pi-0",
    gitAuthorEmail: "malar-pi-0@agents.example",
    extra: {},
  };

  test("emits `pi -e <extension>` and reports the pi harness", () => {
    const plan = buildLaunchPlan(piEntry, { baseEnv: { PATH: "/usr/bin" } });
    expect(plan.command).toBe("pi");
    expect(plan.args).toEqual(["-e", "./extras/pi-extension/src/index.ts"]);
    expect(plan.harness).toBe("pi");
    expect(plan.mode).toBe("fresh");
    expect(plan.allowedTools).toEqual([]);
  });

  test("injects AGENTS_JS_PI_* env (native flag + name from MATRIX_AGENT + port)", () => {
    const plan = buildLaunchPlan(piEntry, { baseEnv: {} });
    expect(plan.env.AGENTS_JS_PI_NATIVE).toBe("1");
    expect(plan.env.AGENTS_JS_PI_NAME).toBe("malar-pi-0");
    expect(plan.env.AGENTS_JS_PI_PORT).toBe("3199");
  });

  test("AGENTS_JS_PI_* are in sessionEnv so launch.ts exports them to the pi process", () => {
    const plan = buildLaunchPlan(piEntry, { baseEnv: {} });
    expect(plan.sessionEnv.AGENTS_JS_PI_NATIVE).toBe("1");
    expect(plan.sessionEnv.AGENTS_JS_PI_NAME).toBe("malar-pi-0");
    expect(plan.sessionEnv.AGENTS_JS_PI_PORT).toBe("3199");
  });

  test("empty fresh_flags is allowed for pi (`-e <ext>` is the base invocation)", () => {
    const plan = buildLaunchPlan({ ...piEntry, freshFlags: "   " }, { baseEnv: {} });
    expect(plan.args).toEqual(["-e", "./extras/pi-extension/src/index.ts"]);
  });

  test("fresh_flags append after `-e <ext>`", () => {
    const plan = buildLaunchPlan({ ...piEntry, freshFlags: "--provider zai" }, { baseEnv: {} });
    expect(plan.args).toEqual(["-e", "./extras/pi-extension/src/index.ts", "--provider", "zai"]);
  });

  test("AGENTS_JS_PI_NAME falls back to tmux_session when MATRIX_AGENT is absent", () => {
    const plan = buildLaunchPlan(
      { ...piEntry, tmuxSession: "fallback-pi", envSetup: undefined },
      { baseEnv: {} },
    );
    expect(plan.env.AGENTS_JS_PI_NAME).toBe("fallback-pi");
  });

  test("defaults extension to @agents-js/pi-extension; omits port when pi_port unset", () => {
    const plan = buildLaunchPlan(
      { ...piEntry, piExtension: undefined, piPort: undefined },
      { baseEnv: {} },
    );
    expect(plan.args).toEqual(["-e", "@agents-js/pi-extension"]);
    expect(plan.env.AGENTS_JS_PI_PORT).toBeUndefined();
  });
});
