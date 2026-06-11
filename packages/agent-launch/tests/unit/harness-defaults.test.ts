/**
 * Tests for harness-default loading, merging, and identity-derived env.
 *
 * Three layers tested:
 * 1. Harness defaults (static, from JSON files) — `loadHarnessDefaults`
 * 2. Plan-level merging — defaults layered under baseEnv, operator wins
 * 3. Identity-derived env — `AGENT_ACP_MODE`, `AGENT_PROFILE` computed
 *    from agent name convention, NOT from defaults files
 *
 * Architecture:
 * - defaults/*.json = harness-intrinsic static env only
 * - AGENT_ACP_MODE / AGENT_PROFILE = identity-derived, computed in plan.ts
 * - AGENTS_JS_PI_* = agents-js A2A integration, computed in pi builder
 * - Merge: defaults → baseEnv → identity → computed (A2A, provider)
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHarnessDefaults } from "../../src/harness-defaults.ts";
import { buildLaunchPlan } from "../../src/plan.ts";

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Harness defaults loading
// ---------------------------------------------------------------------------

describe("loadHarnessDefaults — well-formed defaults", () => {
  test("claude-code defaults load with harness-intrinsic env only", () => {
    const defaults = loadHarnessDefaults("claude-code");
    expect(defaults.env.AGENT_HARNESS).toBe("claude-code");
    expect(defaults.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
    // NOT identity-derived — these are NOT in defaults
    expect(defaults.env.AGENT_ACP_MODE).toBeUndefined();
    expect(defaults.env.AGENT_PROFILE).toBeUndefined();
  });

  test("pi defaults load with harness-intrinsic env only", () => {
    const defaults = loadHarnessDefaults("pi");
    expect(defaults.env.AGENT_HARNESS).toBe("pi");
    // No ACP, no A2A keys in defaults
    expect(defaults.env.AGENT_ACP_MODE).toBeUndefined();
    expect(defaults.env.AGENT_PROFILE).toBeUndefined();
    expect(defaults.env.AGENTS_JS_PI_NATIVE).toBeUndefined();
  });

  test("codex defaults load with harness-intrinsic env", () => {
    const defaults = loadHarnessDefaults("codex");
    expect(defaults.env.AGENT_HARNESS).toBe("codex");
    expect(defaults.env.AGENTS_GATEWAY_SUB).toBe("1");
  });

  test("sessionEnvKeys match env keys in each defaults file", () => {
    for (const harness of ["claude-code", "pi", "codex"]) {
      const defaults = loadHarnessDefaults(harness);
      for (const key of Object.keys(defaults.env)) {
        expect(defaults.sessionEnvKeys).toContain(key);
      }
    }
  });
});

describe("loadHarnessDefaults — missing files", () => {
  test("missing harness returns empty (no throw)", () => {
    const defaults = loadHarnessDefaults("nonexistent-harness");
    expect(defaults.env).toEqual({});
    expect(defaults.sessionEnvKeys).toEqual([]);
  });

  test("defaults directory contains expected files", () => {
    const defaultsDir = path.resolve(SELF_DIR, "../../defaults");
    expect(existsSync(path.join(defaultsDir, "claude-code.json"))).toBe(true);
    expect(existsSync(path.join(defaultsDir, "pi.json"))).toBe(true);
    expect(existsSync(path.join(defaultsDir, "codex.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Plan-level defaults merge
// ---------------------------------------------------------------------------

describe("buildLaunchPlan — harness defaults merge into plan", () => {
  const claudeEntry = {
    tmuxSession: "test-claude",
    harness: "claude-code" as const,
    binary: "claude",
    workspace: "/tmp",
    freshFlags: "--agent test",
    extra: {},
  };

  test("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS reaches plan.env", () => {
    const plan = buildLaunchPlan(claudeEntry, { baseEnv: { PATH: "/usr/bin" } });
    expect(plan.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("1");
  });

  test("AGENT_HARNESS is set to claude-code in plan.env", () => {
    const plan = buildLaunchPlan(claudeEntry, { baseEnv: { PATH: "/usr/bin" } });
    expect(plan.env.AGENT_HARNESS).toBe("claude-code");
  });

  test("baseEnv overrides default (operator wins)", () => {
    const plan = buildLaunchPlan(claudeEntry, {
      baseEnv: { PATH: "/usr/bin", CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" },
    });
    expect(plan.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe("0");
  });

  test("claude-code defaults do NOT leak into pi plan", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "test-pi",
        harness: "pi",
        binary: "pi",
        workspace: "/tmp",
        freshFlags: "",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Identity-derived env (AGENT_ACP_MODE, AGENT_PROFILE)
// ---------------------------------------------------------------------------

describe("buildLaunchPlan — AGENT_ACP_MODE derived from agent name", () => {
  test("ajs-fronted name → ACP_MODE=true", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "hostname-null-ajs-pi-0",
        harness: "pi",
        binary: "pi",
        workspace: "/tmp",
        freshFlags: "",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.env.AGENT_ACP_MODE).toBe("true");
  });

  test("native name (no ajs) → ACP_MODE=false", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "hostname-null-pi-0",
        harness: "pi",
        binary: "pi",
        workspace: "/tmp",
        freshFlags: "",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.env.AGENT_ACP_MODE).toBe("false");
  });

  test("tmux-wired name → ACP_MODE=false", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "hostname-null-tmux-pi-0",
        harness: "pi",
        binary: "pi",
        workspace: "/tmp",
        freshFlags: "",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.env.AGENT_ACP_MODE).toBe("false");
  });

  test("ACP_MODE is in sessionEnv", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "hostname-null-ajs-pi-0",
        harness: "pi",
        binary: "pi",
        workspace: "/tmp",
        freshFlags: "",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.sessionEnv.AGENT_ACP_MODE).toBe("true");
  });
});

describe("buildLaunchPlan — AGENT_PROFILE derived from agent name", () => {
  test("ajs-fronted name → profile=ajs-fronted", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "hostname-null-ajs-pi-0",
        harness: "pi",
        binary: "pi",
        workspace: "/tmp",
        freshFlags: "",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.env.AGENT_PROFILE).toBe("ajs-fronted");
  });

  test("native name → profile=native", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "hostname-null-pi-0",
        harness: "pi",
        binary: "pi",
        workspace: "/tmp",
        freshFlags: "",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.env.AGENT_PROFILE).toBe("native");
  });

  test("tmux-wired name → profile=tmux-wired", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "hostname-null-tmux-pi-0",
        harness: "pi",
        binary: "pi",
        workspace: "/tmp",
        freshFlags: "",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.env.AGENT_PROFILE).toBe("tmux-wired");
  });

  test("AGENT_PROFILE is in sessionEnv", () => {
    const plan = buildLaunchPlan(
      {
        tmuxSession: "hostname-null-ajs-claude-0",
        harness: "claude-code",
        binary: "claude",
        workspace: "/tmp",
        freshFlags: "--agent x",
        extra: {},
      },
      { baseEnv: {} },
    );
    expect(plan.sessionEnv.AGENT_PROFILE).toBe("ajs-fronted");
  });
});

// ---------------------------------------------------------------------------
// Pi: harness defaults + identity + agents-js A2A all compose correctly
// ---------------------------------------------------------------------------

describe("buildLaunchPlan — pi full composition", () => {
  const piEntry = {
    tmuxSession: "hostname-null-ajs-pi-0",
    harness: "pi" as const,
    binary: "pi",
    workspace: "/tmp",
    freshFlags: "",
    envSetup: "export MATRIX_AGENT=hostname-null-ajs-pi-0",
    extra: {},
  };

  test("pi plan.env has all three layers: defaults + identity + A2A", () => {
    const plan = buildLaunchPlan(piEntry, { baseEnv: {} });
    // Harness default
    expect(plan.env.AGENT_HARNESS).toBe("pi");
    // Identity-derived
    expect(plan.env.AGENT_ACP_MODE).toBe("true");
    expect(plan.env.AGENT_PROFILE).toBe("ajs-fronted");
    // Agents-js A2A
    expect(plan.env.AGENTS_JS_PI_NATIVE).toBe("1");
    expect(plan.env.AGENTS_JS_PI_NAME).toBe("hostname-null-ajs-pi-0");
  });

  test("sessionEnv has all three layers", () => {
    const plan = buildLaunchPlan(piEntry, { baseEnv: {} });
    expect(plan.sessionEnv.AGENT_HARNESS).toBe("pi");
    expect(plan.sessionEnv.AGENT_ACP_MODE).toBe("true");
    expect(plan.sessionEnv.AGENT_PROFILE).toBe("ajs-fronted");
    expect(plan.sessionEnv.AGENTS_JS_PI_NATIVE).toBe("1");
  });
});
