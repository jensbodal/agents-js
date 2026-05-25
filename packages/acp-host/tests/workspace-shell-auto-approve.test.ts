/**
 * Auto-approve gate behavior for `workspace.shell.*` operations.
 *
 * Layer 2 of the three-layer policy for read-only shell-command introspection:
 *
 *   classifyOperation()  →  workspace.shell.{read,search,list}  (Layer 1, policy package)
 *   evaluatePermission() →  syntactic workspace-boundary check    (Layer 2, this test)
 *   host filesystem      →  realpath/symlink resolution           (Layer 3, follow-up)
 *
 * Layer 2 must auto-approve only when every extracted path argument resolves
 * inside the workspace root. Out-of-workspace paths (absolute or `..`
 * traversal) must fall through to the user prompt.
 */

import { describe, expect, test } from "bun:test";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  evaluatePermission,
  type PermissionEvaluationContext,
} from "../src/session-permissions.ts";

const WORKSPACE = "/opt/agents-js";

function makeRequest(title: string, args?: Record<string, unknown>): RequestPermissionRequest {
  return {
    sessionId: "test-session",
    toolCall: {
      toolCallId: "tc-1",
      title,
      rawInput: args,
    },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
  };
}

function makeContext(overrides: Partial<PermissionEvaluationContext> = {}): {
  ctx: PermissionEvaluationContext;
  prompted: { value: boolean };
} {
  const prompted = { value: false };
  const noopLog = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const ctx: PermissionEvaluationContext = {
    permissionMode: "default",
    hooks: null,
    permissionEngine: null,
    permissionStore: null,
    agentName: "test-agent",
    workspaceIdentityPath: WORKSPACE,
    sessionId: "test-session",
    log: noopLog as never,
    permLog: noopLog as never,
    handlePermissionRequest: async (): Promise<RequestPermissionResponse> => {
      prompted.value = true;
      return { outcome: { outcome: "cancelled" } };
    },
    ...overrides,
  };
  return { ctx, prompted };
}

describe("evaluatePermission: workspace.shell.* auto-approve gate", () => {
  test("auto-approves cat with workspace-relative path", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(makeRequest("cat AGENTS.md"), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("auto-approves cat with workspace-rooted absolute path", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(
      makeRequest("cat /opt/agents-js/AGENTS.md [current working directory /opt/agents-js]"),
      ctx,
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("auto-approves cat using structured rawInput.args", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(makeRequest("cat", { args: ["AGENTS.md"] }), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("prompts when path is absolute and outside workspace (/etc/passwd)", async () => {
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest("cat /etc/passwd"), ctx);
    expect(prompted.value).toBe(true);
  });

  test("prompts when path uses traversal segments to escape workspace", async () => {
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest("cat ../../../etc/passwd"), ctx);
    expect(prompted.value).toBe(true);
  });

  test("prompts when mixed args contain one out-of-workspace path", async () => {
    const { ctx, prompted } = makeContext();
    // Fail-closed: any single out-of-workspace path forces prompt
    await evaluatePermission(makeRequest("cat AGENTS.md /etc/passwd"), ctx);
    expect(prompted.value).toBe(true);
  });

  test("prompts when no path arguments are present (flags only)", async () => {
    const { ctx, prompted } = makeContext();
    // `cat -n` with no path: nothing to verify, must not auto-approve
    await evaluatePermission(makeRequest("cat -n"), ctx);
    expect(prompted.value).toBe(true);
  });

  test("prompts when workspaceIdentityPath is null (cannot verify)", async () => {
    const { ctx, prompted } = makeContext({ workspaceIdentityPath: null });
    await evaluatePermission(makeRequest("cat AGENTS.md"), ctx);
    expect(prompted.value).toBe(true);
  });

  test("auto-approves head, tail, wc, file, stat (workspace.shell.read category)", async () => {
    for (const cmd of ["head", "tail", "wc", "file", "stat"]) {
      const { ctx, prompted } = makeContext();
      const res = await evaluatePermission(makeRequest(`${cmd} AGENTS.md`), ctx);
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(prompted.value).toBe(false);
    }
  });

  test("auto-approves find, grep, rg, fd (workspace.shell.search category)", async () => {
    for (const cmd of ["find", "grep", "rg", "fd"]) {
      const { ctx, prompted } = makeContext();
      const res = await evaluatePermission(makeRequest(`${cmd} src`), ctx);
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(prompted.value).toBe(false);
    }
  });

  test("auto-approves ls, tree (workspace.shell.list category)", async () => {
    for (const cmd of ["ls", "tree"]) {
      const { ctx, prompted } = makeContext();
      const res = await evaluatePermission(makeRequest(`${cmd} src`), ctx);
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(prompted.value).toBe(false);
    }
  });

  test("does NOT auto-approve curl (not a read-only shell command)", async () => {
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest("curl AGENTS.md"), ctx);
    expect(prompted.value).toBe(true);
  });

  test("bypassPermissions mode still bypasses gate (preserves existing semantics)", async () => {
    const { ctx, prompted } = makeContext({ permissionMode: "bypassPermissions" });
    const res = await evaluatePermission(makeRequest("cat /etc/passwd"), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });
});
