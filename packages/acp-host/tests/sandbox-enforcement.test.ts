import { describe, expect, test } from "bun:test";
import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { validateTerminalRequest } from "@agents-js/policy";
import { buildMinimalEnv } from "../src/process.ts";

const WORKSPACE_PATH = "/tmp/test-workspace";

// ---------------------------------------------------------------------------
// A1: HOME sandboxing in buildMinimalEnv
// ---------------------------------------------------------------------------

describe("buildMinimalEnv: HOME sandboxing", () => {
  test("returns HOME that is NOT process.env.HOME", () => {
    const env = buildMinimalEnv({ workspaceRootPath: WORKSPACE_PATH });
    expect(env.HOME).toBeDefined();
    expect(env.HOME).not.toBe(process.env.HOME);
  });

  test("sets ACP_WORKSPACE_ROOT to workspacePath", () => {
    const env = buildMinimalEnv({ workspaceRootPath: WORKSPACE_PATH });
    expect(env.ACP_WORKSPACE_ROOT).toBe(WORKSPACE_PATH);
  });

  test("sets ACP_REAL_HOME to the original HOME", () => {
    const env = buildMinimalEnv({ workspaceRootPath: WORKSPACE_PATH });
    expect(env.ACP_REAL_HOME).toBe(process.env.HOME ?? "");
  });

  test("keeps real HOME when allowRealHome is true", () => {
    const env = buildMinimalEnv({ workspaceRootPath: WORKSPACE_PATH, allowRealHome: true });
    expect(env.HOME).toBe(process.env.HOME);
  });

  test("sandbox HOME is deterministic for the same workspace", () => {
    const env1 = buildMinimalEnv({ workspaceRootPath: WORKSPACE_PATH });
    const env2 = buildMinimalEnv({ workspaceRootPath: WORKSPACE_PATH });
    expect(env1.HOME).toBe(env2.HOME);
  });

  test("sandbox HOME differs for different workspaces", () => {
    const env1 = buildMinimalEnv({ workspaceRootPath: "/workspace/a" });
    const env2 = buildMinimalEnv({ workspaceRootPath: "/workspace/b" });
    expect(env1.HOME).not.toBe(env2.HOME);
  });
});

// ---------------------------------------------------------------------------
// A3: Terminal policy -- argument-level path checking (Rule 6)
// ---------------------------------------------------------------------------

describe("terminal-policy: argument path checking", () => {
  function makeRequest(
    overrides: Partial<CreateTerminalRequest> & { command: string },
  ): CreateTerminalRequest {
    return {
      sessionId: "test-session",
      command: overrides.command,
      args: overrides.args,
      cwd: overrides.cwd,
      env: overrides.env,
      outputByteLimit: overrides.outputByteLimit,
    } as CreateTerminalRequest;
  }

  test("rejects args with absolute paths outside workspace", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "cat", args: ["/etc/passwd"] }),
      WORKSPACE_PATH,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("outside workspace");
    }
  });

  test("accepts args with absolute paths inside workspace", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "cat", args: [`${WORKSPACE_PATH}/file.txt`] }),
      WORKSPACE_PATH,
    );
    expect(result.valid).toBe(true);
  });

  test("accepts args that are not absolute paths", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "git", args: ["--flag", "relative/path"] }),
      WORKSPACE_PATH,
    );
    expect(result.valid).toBe(true);
  });
});

// Ungated write detection removed — tool use is allowed freely.
// Sandbox enforcement is via process-level --directory flag and HOME sandboxing.
