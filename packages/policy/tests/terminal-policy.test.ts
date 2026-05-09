import { describe, expect, test } from "bun:test";
import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { type TerminalValidationResult, validateTerminalRequest } from "../src/terminal-policy.ts";

const WORKSPACE_ROOT = "/tmp/test-workspace";

function expectInvalid(
  result: TerminalValidationResult,
): asserts result is Extract<TerminalValidationResult, { valid: false }> {
  if (result.valid) throw new Error("expected invalid result");
}

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

describe("terminal-policy: shell command rejection", () => {
  const shellCommands = [
    "sh",
    "bash",
    "zsh",
    "fish",
    "csh",
    "tcsh",
    "dash",
    "ksh",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
  ];

  for (const cmd of shellCommands) {
    test(`rejects shell command: ${cmd}`, () => {
      const result = validateTerminalRequest(makeRequest({ command: cmd }), WORKSPACE_ROOT);
      expectInvalid(result);
      expect(result.jsonRpcCode).toBe(-32602);
      expect(result.reason).toContain("Shell command rejected");
    });
  }

  test("rejects shell commands case-insensitively", () => {
    const result = validateTerminalRequest(makeRequest({ command: "BASH" }), WORKSPACE_ROOT);
    expectInvalid(result);
    expect(result.jsonRpcCode).toBe(-32602);
  });
});

describe("terminal-policy: empty/invalid command", () => {
  test("rejects empty string command", () => {
    const result = validateTerminalRequest(makeRequest({ command: "" }), WORKSPACE_ROOT);
    expectInvalid(result);
    expect(result.jsonRpcCode).toBe(-32602);
    expect(result.reason).toContain("non-empty string");
  });
});

describe("terminal-policy: path separator rejection", () => {
  test("rejects command with forward slash (/bin/sh)", () => {
    const result = validateTerminalRequest(makeRequest({ command: "/bin/sh" }), WORKSPACE_ROOT);
    expectInvalid(result);
    expect(result.jsonRpcCode).toBe(-32602);
    expect(result.reason).toContain("path separator");
  });

  test("rejects command with backslash (C:\\Windows\\cmd.exe)", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "C:\\Windows\\cmd.exe" }),
      WORKSPACE_ROOT,
    );
    expectInvalid(result);
    expect(result.jsonRpcCode).toBe(-32602);
  });

  test("rejects relative path command (./script)", () => {
    const result = validateTerminalRequest(makeRequest({ command: "./script" }), WORKSPACE_ROOT);
    expectInvalid(result);
    expect(result.jsonRpcCode).toBe(-32602);
  });
});

describe("terminal-policy: disallowed character rejection in args", () => {
  const metacharArgs = [
    "foo | bar",
    "foo || bar",
    "foo > out.txt",
    "foo < in.txt",
    "foo >> out.txt",
    "foo && bar",
    "foo ; bar",
    "foo `whoami`",
  ];

  for (const arg of metacharArgs) {
    test(`rejects arg with disallowed character: ${arg}`, () => {
      const result = validateTerminalRequest(
        makeRequest({ command: "echo", args: [arg] }),
        WORKSPACE_ROOT,
      );
      expectInvalid(result);
      expect(result.jsonRpcCode).toBe(-32602);
      expect(result.reason).toContain("disallowed character");
    });
  }

  test("rejects when any arg has disallowed character (not just first)", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "git", args: ["commit", "-m", "msg; rm -rf /"] }),
      WORKSPACE_ROOT,
    );
    expect(result.valid).toBe(false);
  });

  const newlyRejectedArgs = [
    "$(whoami)",
    "foo{bar}",
    "*.ts",
    "file?.txt",
    "arr[0]",
    "~/.ssh/id_rsa",
    "path\\to\\file",
    "!important",
  ];

  for (const arg of newlyRejectedArgs) {
    test(`rejects newly-blocked arg: ${arg}`, () => {
      const result = validateTerminalRequest(
        makeRequest({ command: "echo", args: [arg] }),
        WORKSPACE_ROOT,
      );
      expectInvalid(result);
      expect(result.jsonRpcCode).toBe(-32602);
      expect(result.reason).toContain("disallowed character");
    });
  }
});

describe("terminal-policy: cwd validation", () => {
  test("rejects cwd outside workspace root", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "ls", cwd: "/etc" }),
      WORKSPACE_ROOT,
    );
    expectInvalid(result);
    expect(result.jsonRpcCode).toBe(-32602);
    expect(result.reason).toContain("outside workspace root");
  });

  test("rejects cwd that is a sibling with shared prefix", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "ls", cwd: "/tmp/test-workspace-evil" }),
      WORKSPACE_ROOT,
    );
    expect(result.valid).toBe(false);
  });

  test("accepts cwd equal to workspace root", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "ls", cwd: WORKSPACE_ROOT }),
      WORKSPACE_ROOT,
    );
    expect(result.valid).toBe(true);
  });

  test("accepts cwd under workspace root", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "ls", cwd: `${WORKSPACE_ROOT}/subdir` }),
      WORKSPACE_ROOT,
    );
    expect(result.valid).toBe(true);
  });

  test("accepts Windows child cwd under workspace root", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "ls", cwd: "C:\\workspace\\subdir" }),
      "C:\\workspace",
    );
    expect(result.valid).toBe(true);
  });

  test("rejects Windows sibling cwd with shared prefix", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "ls", cwd: "C:\\workspace-evil" }),
      "C:\\workspace",
    );
    expect(result.valid).toBe(false);
  });

  test("accepts null cwd (defaults to workspace root)", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "ls", cwd: null }),
      WORKSPACE_ROOT,
    );
    expect(result.valid).toBe(true);
  });

  test("accepts undefined cwd", () => {
    const result = validateTerminalRequest(makeRequest({ command: "ls" }), WORKSPACE_ROOT);
    expect(result.valid).toBe(true);
  });
});

describe("terminal-policy: valid commands", () => {
  test("accepts git with status args", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "git", args: ["status"] }),
      WORKSPACE_ROOT,
    );
    expect(result.valid).toBe(true);
  });

  test("accepts npm with test args", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "npm", args: ["test"] }),
      WORKSPACE_ROOT,
    );
    expect(result.valid).toBe(true);
  });

  test("accepts command with no args", () => {
    const result = validateTerminalRequest(makeRequest({ command: "ls" }), WORKSPACE_ROOT);
    expect(result.valid).toBe(true);
  });

  test("accepts args with hyphens and equals", () => {
    const result = validateTerminalRequest(
      makeRequest({ command: "git", args: ["log", "--oneline", "-n=5"] }),
      WORKSPACE_ROOT,
    );
    expect(result.valid).toBe(true);
  });
});

describe("terminal-policy: allowed special characters in args", () => {
  const allowedArgs: Array<{ label: string; arg: string }> = [
    { label: "long flag", arg: "--flag" },
    { label: "key=value flag", arg: "--key=value" },
    { label: "short flag", arg: "-n" },
    { label: "dotted filename", arg: "file.ts" },
    { label: "absolute path within workspace", arg: "/tmp/test-workspace/subdir/file" },
    { label: "relative path", arg: "./relative" },
    { label: "at sign", arg: "user@host" },
    { label: "hash", arg: "#comment" },
    { label: "percent", arg: "100%" },
    { label: "plus", arg: "c++" },
    { label: "colon", arg: "key:value" },
    { label: "comma", arg: "a,b,c" },
    { label: "underscore", arg: "snake_case" },
    { label: "spaces", arg: "hello world" },
    { label: "mixed", arg: "--output=/tmp/file.ts" },
    { label: "double-quoted value", arg: 'commit message with "quotes"' },
    { label: "single-quoted value", arg: "it's a test" },
  ];

  for (const { label, arg } of allowedArgs) {
    test(`accepts arg with ${label}: ${arg}`, () => {
      const result = validateTerminalRequest(
        makeRequest({ command: "echo", args: [arg] }),
        WORKSPACE_ROOT,
      );
      expect(result.valid).toBe(true);
    });
  }
});
