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
