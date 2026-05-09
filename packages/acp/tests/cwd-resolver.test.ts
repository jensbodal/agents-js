import { describe, expect, test } from "bun:test";
import {
  type ACPWorkspaceRootPolicy,
  CwdResolutionError,
  resolveSessionCwd,
} from "../src/cwd-resolver.ts";

// Pin the contract: each rejection condition produces a distinct `code`
// from the CwdResolutionError union. Callers (e.g. the host gateway)
// route on `code`, so we assert on that — not on the message string.

const VAULT = "/vault";

function policy(overrides: Partial<ACPWorkspaceRootPolicy> = {}): ACPWorkspaceRootPolicy {
  return {
    resolveWorkspaceRoot: () => VAULT,
    ...overrides,
  };
}

describe("resolveSessionCwd — happy paths", () => {
  test("returns the workspace root when requestedCwd is undefined", async () => {
    const result = await resolveSessionCwd(undefined, policy());
    expect(result).toBe(VAULT);
  });

  test("returns the resolved candidate when requestedCwd is within the workspace", async () => {
    const result = await resolveSessionCwd("/vault/sub/dir", policy());
    expect(result).toBe("/vault/sub/dir");
  });

  test("normalizes traversal that ultimately stays inside the workspace", async () => {
    const result = await resolveSessionCwd("/vault/sub/../sub/dir", policy());
    expect(result).toBe("/vault/sub/dir");
  });

  test("calls validateCwd with the resolved cwd and accepted workspace root", async () => {
    let observed: { cwd?: string; root?: string } = {};
    const result = await resolveSessionCwd(
      "/vault/x",
      policy({
        validateCwd: (cwd, root) => {
          observed = { cwd, root };
          return true;
        },
      }),
    );
    expect(result).toBe("/vault/x");
    expect(observed).toEqual({ cwd: "/vault/x", root: VAULT });
  });
});

describe("resolveSessionCwd — error codes", () => {
  test("relative workspaceRoot rejects with code=invalid_workspace_root", async () => {
    const promise = resolveSessionCwd(undefined, policy({ resolveWorkspaceRoot: () => "vault" }));
    await expect(promise).rejects.toBeInstanceOf(CwdResolutionError);
    await expect(promise).rejects.toMatchObject({ code: "invalid_workspace_root" });
  });

  test("relative requestedCwd rejects with code=relative_cwd", async () => {
    const promise = resolveSessionCwd("relative/path", policy());
    await expect(promise).rejects.toBeInstanceOf(CwdResolutionError);
    await expect(promise).rejects.toMatchObject({ code: "relative_cwd" });
  });

  test("absolute requestedCwd outside workspace rejects with code=cwd_outside_workspace_root", async () => {
    const promise = resolveSessionCwd("/other-root/project", policy());
    await expect(promise).rejects.toBeInstanceOf(CwdResolutionError);
    await expect(promise).rejects.toMatchObject({ code: "cwd_outside_workspace_root" });
  });

  test("validateCwd returning false rejects with code=workspace_root_rejected", async () => {
    const promise = resolveSessionCwd("/vault/x", policy({ validateCwd: () => false }));
    await expect(promise).rejects.toBeInstanceOf(CwdResolutionError);
    await expect(promise).rejects.toMatchObject({ code: "workspace_root_rejected" });
  });

  test("the four error codes are distinct so callers can route on them", () => {
    const codes = new Set<CwdResolutionError["code"]>([
      "invalid_workspace_root",
      "relative_cwd",
      "cwd_outside_workspace_root",
      "workspace_root_rejected",
    ]);
    expect(codes.size).toBe(4);
  });
});
