/**
 * `unattendedGateway` permission mode — auto-approve KNOWN operation classes,
 * fail-closed (cancel) on UNKNOWN. This is the typed-plumbing PR's runtime
 * surface for the new mode; the v1 matrix is intentionally minimal (all
 * KNOWN → auto-approve), with per-class tightening deferred to follow-up PRs.
 *
 * Mirrors the makeContext/makeRequest helpers from
 * `workspace-shell-auto-approve.test.ts` so the fixture shape stays
 * consistent across permission-mode test suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  evaluatePermission,
  logPermissionDecision,
  type PermissionEvaluationContext,
} from "../src/session-permissions.ts";
import { normalizePermissionMode } from "../src/session-state.ts";

// Real tmp-dir workspace fixture for the workspace.shell.* cases — the
// boundary-check helper resolves paths through realpath, so files must
// exist on disk.
let WORKSPACE = "";
let OUT_OF_WORKSPACE = "";

beforeAll(() => {
  WORKSPACE = mkdtempSync(join(tmpdir(), "ajs-pr2-workspace-"));
  OUT_OF_WORKSPACE = mkdtempSync(join(tmpdir(), "ajs-pr2-outside-"));
  writeFileSync(join(WORKSPACE, "README.md"), "readme");
  writeFileSync(join(OUT_OF_WORKSPACE, "secret"), "out-of-workspace secret");
  // Adversarial symlinks for the unattended-gateway boundary tests.
  symlinkSync(join(OUT_OF_WORKSPACE, "secret"), join(WORKSPACE, "symlink-to-outside"));
  symlinkSync(join(WORKSPACE, "nonexistent-target"), join(WORKSPACE, "broken-symlink"));
});

afterAll(() => {
  rmSync(WORKSPACE, { recursive: true, force: true });
  rmSync(OUT_OF_WORKSPACE, { recursive: true, force: true });
});

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

interface ContextHandle {
  ctx: PermissionEvaluationContext;
  prompted: { value: boolean };
  permLogs: Array<{ message: string; meta?: Record<string, unknown> }>;
}

function makeContext(overrides: Partial<PermissionEvaluationContext> = {}): ContextHandle {
  const prompted = { value: false };
  const permLogs: Array<{ message: string; meta?: Record<string, unknown> }> = [];
  const noopLog = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  const permLog = {
    debug: () => {},
    info: (message: string, meta?: Record<string, unknown>) => {
      permLogs.push({ message, meta });
    },
    warn: () => {},
    error: () => {},
  };
  const ctx: PermissionEvaluationContext = {
    permissionMode: "unattendedGateway",
    hooks: null,
    permissionEngine: null,
    permissionStore: null,
    agentName: "test-agent",
    workspaceIdentityPath: WORKSPACE,
    sessionId: "test-session",
    log: noopLog as never,
    permLog: permLog as never,
    handlePermissionRequest: async (): Promise<RequestPermissionResponse> => {
      prompted.value = true;
      return { outcome: { outcome: "cancelled" } };
    },
    ...overrides,
  };
  return { ctx, prompted, permLogs };
}

describe("normalizePermissionMode — unattended-gateway", () => {
  test("kebab-case CLI form `unattended-gateway` normalises to canonical camelCase", () => {
    expect(normalizePermissionMode("unattended-gateway")).toBe("unattendedGateway");
  });

  test("canonical camelCase `unattendedGateway` passes through unchanged", () => {
    expect(normalizePermissionMode("unattendedGateway")).toBe("unattendedGateway");
  });
});

describe("evaluatePermission — unattendedGateway: KNOWN operation classes auto-approve", () => {
  test("auto-approves a file.read request", async () => {
    const { ctx, prompted } = makeContext();
    // `readFile` matches the `read` + `file` branch in classifyOperation.
    const res = await evaluatePermission(makeRequest("readFile", { path: "src/index.ts" }), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("auto-approves a file.write request", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(makeRequest("writeFile", { path: "src/index.ts" }), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("auto-approves a workspace.shell.read request inside workspace (passes AJS-77 boundary check)", async () => {
    const { ctx, prompted } = makeContext();
    // `cat README.md` classifies to workspace.shell.read. The unattended-gateway
    // branch fires the same AJS-77 PR1.5 boundary check (realpath/symlink
    // defense) as default mode — the CVE-class symlink-escape defense is an
    // auto-approve safety property, NOT a mode-specific concern. README.md
    // exists in the WORKSPACE tmp fixture so realpathSync resolves cleanly.
    const res = await evaluatePermission(makeRequest("cat README.md"), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("auto-approves a terminal.create request (KNOWN class in v1 minimal matrix)", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(
      makeRequest("execute terminal command", { command: "echo hi" }),
      ctx,
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });
});

describe("evaluatePermission — unattendedGateway: UNKNOWN operation classes fail closed", () => {
  test("cancels a request that classifies to `tool.<name>` fallback", async () => {
    const { ctx, prompted } = makeContext();
    // `custom-probe` does not contain any classifier keyword and is not in
    // the read-only-shell-commands list, so it falls through to
    // `tool.custom-probe`.
    const res = await evaluatePermission(makeRequest("custom-probe"), ctx);
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
    // Did NOT prompt the user (gateway mode never falls through to prompt).
    expect(prompted.value).toBe(false);
  });

  test("fail-closed log includes structured `failureReason` payload", async () => {
    const { ctx, permLogs } = makeContext();
    await evaluatePermission(makeRequest("custom-probe"), ctx);

    const cancelLog = permLogs.find((entry) => entry.meta?.decision === "cancelled");
    expect(cancelLog).toBeDefined();
    expect(cancelLog?.meta?.operationClass).toBe("tool.custom-probe");
    expect(cancelLog?.meta?.reason).toBe(
      "unattended-gateway: unknown operation class (fail-closed)",
    );
    expect(cancelLog?.meta?.failureReason).toEqual({
      kind: "unknown_operation_class",
      operationClass: "tool.custom-probe",
    });
  });

  test("cancels a request with no tool title (`tool.unknown` fallback)", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(makeRequest(""), ctx);
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
    expect(prompted.value).toBe(false);
  });
});

describe("evaluatePermission — unattendedGateway: workspace.shell.* boundary check (AJS-77 carry-over)", () => {
  test("fails closed on in-workspace symlink → out-of-workspace target (CVE-class defense)", async () => {
    const { ctx, prompted, permLogs } = makeContext();
    const res = await evaluatePermission(makeRequest("cat symlink-to-outside"), ctx);
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
    expect(prompted.value).toBe(false);

    const cancelLog = permLogs.find((entry) => entry.meta?.decision === "cancelled");
    expect(cancelLog?.meta?.operationClass).toBe("workspace.shell.read");
    expect(cancelLog?.meta?.failureReason).toEqual({
      kind: "workspace_boundary_violation",
      operationClass: "workspace.shell.read",
    });
  });

  test("fails closed on broken symlink (ENOENT realpath)", async () => {
    const { ctx, prompted, permLogs } = makeContext();
    const res = await evaluatePermission(makeRequest("cat broken-symlink"), ctx);
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
    expect(prompted.value).toBe(false);

    const cancelLog = permLogs.find((entry) => entry.meta?.decision === "cancelled");
    expect(cancelLog?.meta?.failureReason).toEqual({
      kind: "workspace_boundary_violation",
      operationClass: "workspace.shell.read",
    });
  });

  test("fails closed when workspaceIdentityPath is null", async () => {
    const { ctx, prompted, permLogs } = makeContext({ workspaceIdentityPath: null });
    const res = await evaluatePermission(makeRequest("cat README.md"), ctx);
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
    expect(prompted.value).toBe(false);

    const cancelLog = permLogs.find((entry) => entry.meta?.decision === "cancelled");
    expect(cancelLog?.meta?.failureReason).toEqual({
      kind: "no_workspace_identity_path",
      operationClass: "workspace.shell.read",
    });
  });

  test("fails closed on absolute out-of-workspace path (Layer 2 catches before realpath)", async () => {
    const { ctx, prompted, permLogs } = makeContext();
    const res = await evaluatePermission(makeRequest("cat /etc/passwd"), ctx);
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
    expect(prompted.value).toBe(false);

    const cancelLog = permLogs.find((entry) => entry.meta?.decision === "cancelled");
    expect(cancelLog?.meta?.failureReason).toEqual({
      kind: "workspace_boundary_violation",
      operationClass: "workspace.shell.read",
    });
  });
});

describe("evaluatePermission — unattendedGateway: never falls through to user prompt", () => {
  test("does not prompt on KNOWN class", async () => {
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest("readFile", { path: "a.md" }), ctx);
    expect(prompted.value).toBe(false);
  });

  test("does not prompt on UNKNOWN class (cancels instead)", async () => {
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest("mystery-tool"), ctx);
    expect(prompted.value).toBe(false);
  });
});

// Tiny smoke for the public re-export — `logPermissionDecision` is the entry
// the unattended-gateway branch reuses, ensure importing it from the new
// module still resolves alongside the new branch.
describe("logPermissionDecision is still exported from session-permissions", () => {
  test("function is callable", () => {
    expect(typeof logPermissionDecision).toBe("function");
  });
});
