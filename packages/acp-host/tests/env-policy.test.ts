import { describe, expect, test } from "bun:test";
import {
  buildForbiddenEnvKeys,
  DEFAULT_INHERITED_ENV_KEYS,
  DEFAULT_TERMINAL_ENV_KEYS,
  resolveHostEnvPolicy,
  SYSTEM_FORBIDDEN_ENV_KEYS,
} from "../src/index.ts";
import { buildMinimalEnv } from "../src/process.ts";

describe("HostEnvPolicy defaults", () => {
  test("inheritedEnvKeys defaults to PATH/HOME/USER/LANG/TERM/SHELL", () => {
    const resolved = resolveHostEnvPolicy();
    expect([...resolved.inheritedEnvKeys]).toEqual([...DEFAULT_INHERITED_ENV_KEYS]);
    expect(resolved.inheritedEnvKeys).toContain("PATH");
    expect(resolved.inheritedEnvKeys).toContain("HOME");
  });

  test("terminalEnvKeys defaults to inheritedEnvKeys minus SHELL", () => {
    const resolved = resolveHostEnvPolicy();
    expect([...resolved.terminalEnvKeys]).toEqual([...DEFAULT_TERMINAL_ENV_KEYS]);
    expect(resolved.terminalEnvKeys).not.toContain("SHELL");
    expect(resolved.terminalEnvKeys).toContain("PATH");
  });

  test("agentSecretEnvKeys defaults to empty (acp-host has no harness knowledge)", () => {
    const resolved = resolveHostEnvPolicy();
    expect([...resolved.agentSecretEnvKeys]).toEqual([]);
  });

  test("forbiddenExtraEnvKeys always includes the system loader guards", () => {
    const resolved = resolveHostEnvPolicy();
    for (const key of SYSTEM_FORBIDDEN_ENV_KEYS) {
      expect(resolved.forbiddenExtraEnvKeys.has(key)).toBe(true);
    }
  });
});

describe("buildForbiddenEnvKeys", () => {
  test("returns the system loader guards when called with no policy", () => {
    const forbidden = buildForbiddenEnvKeys();
    for (const key of SYSTEM_FORBIDDEN_ENV_KEYS) {
      expect(forbidden.has(key)).toBe(true);
    }
  });

  test("merges agentSecretEnvKeys into the forbidden set", () => {
    const forbidden = buildForbiddenEnvKeys({
      agentSecretEnvKeys: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    });
    expect(forbidden.has("CODEX_API_KEY")).toBe(true);
    expect(forbidden.has("OPENAI_API_KEY")).toBe(true);
    // System guards are still present.
    expect(forbidden.has("LD_PRELOAD")).toBe(true);
  });

  test("merges caller-supplied forbiddenExtraEnvKeys with system + secret keys", () => {
    const forbidden = buildForbiddenEnvKeys({
      agentSecretEnvKeys: ["FOO"],
      forbiddenExtraEnvKeys: ["BAR"],
    });
    expect(forbidden.has("FOO")).toBe(true);
    expect(forbidden.has("BAR")).toBe(true);
    expect(forbidden.has("PATH")).toBe(true);
  });
});

describe("buildMinimalEnv shape", () => {
  test("strips forbidden keys from extraEnv", () => {
    const env = buildMinimalEnv({
      workspaceRootPath: "/tmp/ws",
      extraEnv: {
        ALLOWED: "yes",
        LD_PRELOAD: "evil.so",
        BLOCKED: "should-not-appear",
      },
      envPolicy: {
        agentSecretEnvKeys: ["BLOCKED"],
      },
    });
    expect(env.ALLOWED).toBe("yes");
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.BLOCKED).toBeUndefined();
  });

  test("forwards caller-supplied extraBinPaths into PATH", () => {
    const env = buildMinimalEnv({
      workspaceRootPath: "/tmp/ws",
      extraBinPaths: ["/opt/custom/bin"],
    });
    expect(env.PATH).toContain("/opt/custom/bin");
  });

  test("populates ACP_WORKSPACE_ROOT and a sandbox HOME by default", () => {
    const env = buildMinimalEnv({ workspaceRootPath: "/tmp/wsroot" });
    expect(env.ACP_WORKSPACE_ROOT).toBe("/tmp/wsroot");
    expect(env.HOME).toBeDefined();
    expect(env.HOME).not.toBe(process.env.HOME);
  });

  test("respects allowRealHome=true", () => {
    const env = buildMinimalEnv({
      workspaceRootPath: "/tmp/wsroot",
      allowRealHome: true,
    });
    // When allowRealHome is true, HOME comes from the inherited env (real HOME)
    // rather than the per-workspace sandbox.
    expect(env.HOME).toBe(process.env.HOME);
  });
});
