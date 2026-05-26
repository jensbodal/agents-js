/**
 * Auto-approve gate behavior for `workspace.shell.*` operations.
 *
 * Three-layer policy for read-only shell-command introspection:
 *
 *   classifyOperation()  →  workspace.shell.{read,search,list}  (Layer 1, policy package)
 *   evaluatePermission() →  syntactic workspace-boundary check    (Layer 2)
 *   fs.realpathSync      →  symlink-aware boundary check          (Layer 3, this PR adds)
 *
 * Layer 2 + Layer 3 must both pass for auto-approve. Out-of-workspace paths
 * (absolute, `..` traversal) fail Layer 2. In-workspace symlinks pointing
 * out-of-workspace fail Layer 3. Broken symlinks (ENOENT) fail closed at
 * Layer 3 (fall through to prompt, NOT crash).
 *
 * Tests use real tmp-dir filesystem fixtures so `realpathSync` resolves
 * actual symlinks, not mocked ones.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  evaluatePermission,
  type PermissionEvaluationContext,
} from "../src/session-permissions.ts";

// Real tmp-dir workspace fixture. Files referenced in test paths must exist on
// disk for `realpathSync` (Layer 3) to resolve them. Out-of-workspace files
// also exist on disk so symlink-escape tests use real symlinks.
let WORKSPACE = "";
let OUT_OF_WORKSPACE = "";

beforeAll(() => {
  WORKSPACE = mkdtempSync(join(tmpdir(), "ajs-pr15-workspace-"));
  OUT_OF_WORKSPACE = mkdtempSync(join(tmpdir(), "ajs-pr15-outside-"));
  mkdirSync(join(WORKSPACE, "src"), { recursive: true });
  writeFileSync(join(WORKSPACE, "AGENTS.md"), "test content");
  writeFileSync(join(WORKSPACE, "log.txt"), "log content");
  writeFileSync(join(WORKSPACE, "README.md"), "readme content");
  writeFileSync(join(WORKSPACE, "binary.bin"), "binary content");
  writeFileSync(join(WORKSPACE, "src", "index.ts"), "source content");
  writeFileSync(join(OUT_OF_WORKSPACE, "secret"), "out-of-workspace secret");

  // Layer 3 adversarial fixtures:
  //  - in-workspace symlink → in-workspace target (should auto-approve)
  symlinkSync(join(WORKSPACE, "AGENTS.md"), join(WORKSPACE, "symlink-to-in-workspace"));
  //  - in-workspace symlink → out-of-workspace target (should prompt)
  symlinkSync(join(OUT_OF_WORKSPACE, "secret"), join(WORKSPACE, "symlink-to-outside"));
  //  - in-workspace symlink → nonexistent target (should prompt — broken symlink)
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

describe("evaluatePermission: workspace.shell.* auto-approve gate (Layer 2 + Layer 3)", () => {
  // --- Layer 2 + Layer 3 positive path ---

  test("auto-approves cat with workspace-relative real path", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(makeRequest(`cat ${join(WORKSPACE, "AGENTS.md")}`), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("PR1 canary regression: auto-approves `cat AGENTS.md` (workspace-relative, no prefix)", async () => {
    // Regression test for cognee-codex's PR #65 BLOCKING review catch:
    // realpath baseline must be workspaceRoot, NOT process.cwd(). Without
    // the path.resolve(workspaceRoot, arg) baseline normalization, a
    // workspace-relative arg like `AGENTS.md` resolves against the host
    // gateway process's cwd (completely unrelated to the agent's
    // workspace), causing the Layer 3 realpath lookup to fail and
    // regressing PR1's canary case from auto-approve to prompt.
    //
    // This test explicitly does NOT prefix the arg with the workspace
    // path — `AGENTS.md` is purely workspace-relative. Auto-approve must
    // still hold.
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(makeRequest("cat AGENTS.md"), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("PR1 canary regression: structured rawInput.args with workspace-relative arg", async () => {
    // Same regression check but exercising the structured args fan-in
    // path through `extractShellCommandPathArgs` rather than title parsing.
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(makeRequest("cat", { args: ["AGENTS.md"] }), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("auto-approves cat with workspace-rooted absolute path + ACP cwd annotation", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(
      makeRequest(`cat ${join(WORKSPACE, "AGENTS.md")} [current working directory ${WORKSPACE}]`),
      ctx,
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("auto-approves cat using structured rawInput.args", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(
      makeRequest("cat", { args: [join(WORKSPACE, "AGENTS.md")] }),
      ctx,
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  // --- Layer 2 negative path (syntactic boundary) ---

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
    await evaluatePermission(makeRequest(`cat ${join(WORKSPACE, "AGENTS.md")} /etc/passwd`), ctx);
    expect(prompted.value).toBe(true);
  });

  // --- Layer 3 (realpath / symlink) cases ---

  test("auto-approves in-workspace symlink resolving to in-workspace target", async () => {
    const { ctx, prompted } = makeContext();
    const res = await evaluatePermission(
      makeRequest(`cat ${join(WORKSPACE, "symlink-to-in-workspace")}`),
      ctx,
    );
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });

  test("prompts on in-workspace symlink resolving to out-of-workspace target (CVE-class)", async () => {
    // This is the CVE-class gap that PR1 explicitly documented as a known
    // limitation. Layer 2 syntactic check accepts the in-workspace symlink
    // path; Layer 3 realpath check catches that it resolves to a target
    // outside the workspace and falls through to prompt.
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest(`cat ${join(WORKSPACE, "symlink-to-outside")}`), ctx);
    expect(prompted.value).toBe(true);
  });

  test("prompts on broken in-workspace symlink (ENOENT on realpath)", async () => {
    // Fail-closed on resolution error. Broken symlink (target doesn't exist)
    // throws ENOENT from realpathSync; the try/catch in the gate maps that
    // to "not in workspace" so the gate prompts rather than crashing.
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest(`cat ${join(WORKSPACE, "broken-symlink")}`), ctx);
    expect(prompted.value).toBe(true);
  });

  test("prompts on path that does not exist (ENOENT on realpath)", async () => {
    // We cannot verify the eventual target of a path that doesn't exist yet,
    // so fall-closed to prompt.
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest(`cat ${join(WORKSPACE, "nonexistent.md")}`), ctx);
    expect(prompted.value).toBe(true);
  });

  // --- Edge cases ---

  test("prompts when no path arguments are present (flags only)", async () => {
    const { ctx, prompted } = makeContext();
    // `cat -n` with no path: nothing to verify, must not auto-approve
    await evaluatePermission(makeRequest("cat -n"), ctx);
    expect(prompted.value).toBe(true);
  });

  test("prompts when workspaceIdentityPath is null (cannot verify)", async () => {
    const { ctx, prompted } = makeContext({ workspaceIdentityPath: null });
    await evaluatePermission(makeRequest(`cat ${join(WORKSPACE, "AGENTS.md")}`), ctx);
    expect(prompted.value).toBe(true);
  });

  test("auto-approves head, tail, wc, file, stat (workspace.shell.read category)", async () => {
    for (const cmd of ["head", "tail", "wc", "file", "stat"]) {
      const { ctx, prompted } = makeContext();
      const res = await evaluatePermission(
        makeRequest(`${cmd} ${join(WORKSPACE, "AGENTS.md")}`),
        ctx,
      );
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(prompted.value).toBe(false);
    }
  });

  test("auto-approves find, grep, rg, fd (workspace.shell.search category)", async () => {
    for (const cmd of ["find", "grep", "rg", "fd"]) {
      const { ctx, prompted } = makeContext();
      const res = await evaluatePermission(makeRequest(`${cmd} ${join(WORKSPACE, "src")}`), ctx);
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(prompted.value).toBe(false);
    }
  });

  test("auto-approves ls, tree (workspace.shell.list category)", async () => {
    for (const cmd of ["ls", "tree"]) {
      const { ctx, prompted } = makeContext();
      const res = await evaluatePermission(makeRequest(`${cmd} ${join(WORKSPACE, "src")}`), ctx);
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(prompted.value).toBe(false);
    }
  });

  test("does NOT auto-approve curl (not a read-only shell command)", async () => {
    const { ctx, prompted } = makeContext();
    await evaluatePermission(makeRequest(`curl ${join(WORKSPACE, "AGENTS.md")}`), ctx);
    expect(prompted.value).toBe(true);
  });

  test("bypassPermissions mode still bypasses gate (preserves existing semantics)", async () => {
    const { ctx, prompted } = makeContext({ permissionMode: "bypassPermissions" });
    const res = await evaluatePermission(makeRequest("cat /etc/passwd"), ctx);
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(prompted.value).toBe(false);
  });
});
