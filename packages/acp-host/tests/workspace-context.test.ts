import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { PermissionEngine } from "../src/permission-engine.ts";
import { ACPSessionController } from "../src/session-controller.ts";
import { createMockAgent } from "../src/testing/mock-acp-agent.ts";
import type { HostFileAdapters, StartConfig } from "../src/types/adapters.ts";
import type { ACPSessionEvent } from "../src/types/session.ts";
import { resolveWorkspaceContext } from "../src/workspace-context.ts";

function createMockFileAdapters(): HostFileAdapters {
  return {
    readTextFile: async (params) => ({
      content: `mock content of ${params.path}`,
    }),
    writeTextFile: async (_params, _requestApproval) => ({}),
  };
}

function makeStartConfig(overrides: Partial<StartConfig> = {}): StartConfig {
  return {
    agentConfig: {
      name: "Test",
      command: "unused",
      args: [],
      env: {},
      authHints: [],
      workspacePolicy: "workspace-root-only",
    },
    workspacePath: "/workspace/root",
    fileAdapters: createMockFileAdapters(),
    ...overrides,
  };
}

describe("workspace context normalization", () => {
  test("maps legacy workspacePath into identity root, session cwd, read/write roots, and .tmp scratch", () => {
    const context = resolveWorkspaceContext({ workspacePath: "/workspace/root" });

    expect(context.workspaceIdentityPath).toBe("/workspace/root");
    expect(context.sessionCwd).toBe("/workspace/root");
    expect(context.approvedReadRoots).toEqual(["/workspace/root"]);
    expect(context.approvedWriteRoots).toEqual(["/workspace/root"]);
    expect(context.scratchRoots).toEqual(["/workspace/root/.tmp"]);
  });

  test("preserves split workspace identity, session cwd, and explicit roots", () => {
    const context = resolveWorkspaceContext({
      workspacePath: "/workspace/root",
      workspaceIdentityPath: "/workspace/root",
      sessionCwd: "/workspace/root/projects/alpha",
      approvedReadRoots: ["/workspace/root"],
      approvedWriteRoots: ["/workspace/root/projects/alpha"],
      scratchRoots: ["/workspace/root/.scratch"],
    });

    expect(context.workspaceIdentityPath).toBe("/workspace/root");
    expect(context.sessionCwd).toBe("/workspace/root/projects/alpha");
    expect(context.approvedReadRoots).toEqual(["/workspace/root"]);
    expect(context.approvedWriteRoots).toEqual(["/workspace/root/projects/alpha"]);
    expect(context.scratchRoots).toEqual(["/workspace/root/.scratch"]);
  });

  test("accepts grouped directoryPolicy alongside session cwd", () => {
    const context = resolveWorkspaceContext({
      workspacePath: "/workspace/root",
      sessionCwd: "/workspace/root/projects/alpha",
      directoryPolicy: {
        approvedReadRoots: ["/workspace/root"],
        approvedWriteRoots: ["/workspace/root/projects/alpha"],
        scratchRoots: ["/workspace/root/.scratch"],
        autoApprovedWriteFolders: ["projects/alpha/scratch"],
      },
    });

    expect(context.workspaceIdentityPath).toBe("/workspace/root");
    expect(context.sessionCwd).toBe("/workspace/root/projects/alpha");
    expect(context.approvedReadRoots).toEqual(["/workspace/root"]);
    expect(context.approvedWriteRoots).toEqual(["/workspace/root/projects/alpha"]);
    expect(context.scratchRoots).toEqual(["/workspace/root/.scratch"]);
    expect(context.autoApprovedWriteFolders).toEqual(["projects/alpha/scratch"]);
  });

  test("grouped directoryPolicy fields override inline fields when both are provided", () => {
    const context = resolveWorkspaceContext({
      workspacePath: "/workspace/root",
      // Inline values that should be shadowed by directoryPolicy
      approvedWriteRoots: ["/workspace/root/legacy"],
      autoApprovedWriteFolders: ["legacy"],
      directoryPolicy: {
        approvedWriteRoots: ["/workspace/root/projects/alpha"],
        autoApprovedWriteFolders: ["projects/alpha/scratch"],
      },
    });

    expect(context.approvedWriteRoots).toEqual(["/workspace/root/projects/alpha"]);
    expect(context.autoApprovedWriteFolders).toEqual(["projects/alpha/scratch"]);
  });

  test("rejects auto-approved write folders that contain traversal segments or absolute paths", () => {
    expect(() =>
      resolveWorkspaceContext({
        workspacePath: "/workspace/root",
        autoApprovedWriteFolders: ["../escape"],
      }),
    ).toThrow(/traversal/);

    expect(() =>
      resolveWorkspaceContext({
        workspacePath: "/workspace/root",
        autoApprovedWriteFolders: ["/abs/path"],
      }),
    ).toThrow(/traversal/);

    expect(() =>
      resolveWorkspaceContext({
        workspacePath: "/workspace/root",
        autoApprovedWriteFolders: [""],
      }),
    ).toThrow(/non-empty/);
  });

  test("normalizes auto-approved write folders (strip trailing slash, dedupe)", () => {
    const context = resolveWorkspaceContext({
      workspacePath: "/workspace/root",
      autoApprovedWriteFolders: ["projects/alpha/", "projects/alpha", "projects/beta"],
    });

    expect(context.autoApprovedWriteFolders).toEqual(["projects/alpha", "projects/beta"]);
  });

  test("defaults autoApprovedWriteFolders to an empty array when nothing is supplied", () => {
    const context = resolveWorkspaceContext({ workspacePath: "/workspace/root" });
    expect(context.autoApprovedWriteFolders).toEqual([]);
  });
});

describe("ACPSessionController workspace context", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    controller = new ACPSessionController();
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(() => {
    controller.destroy();
  });

  test("uses session cwd for ACP session lifecycle methods while keeping workspace identity separate", async () => {
    const sessionCwd = "/workspace/root/projects/alpha";
    const {
      createProcess,
      newSessionRequests,
      listSessionRequests,
      loadSessionRequests,
      forkSessionRequests,
      resumeSessionRequests,
    } = createMockAgent({
      initialize: {
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            list: {},
            fork: {},
            resume: {},
          },
        },
      },
      listSessions: { sessions: [] },
      loadSession: {},
      forkSession: {},
      resumeSession: {},
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        workspaceIdentityPath: "/workspace/root",
        sessionCwd,
      }),
    );

    expect(controller.workspacePath).toBe(sessionCwd);
    expect(controller.getWorkspaceContext()?.workspaceIdentityPath).toBe("/workspace/root");
    expect(controller.getWorkspaceContext()?.sessionCwd).toBe(sessionCwd);

    await controller.newSession();
    await controller.listSessions("cursor-1");
    await controller.loadSession("session-load-1");
    await controller.forkSession();
    await controller.resumeSession("session-resume-1");

    expect(newSessionRequests[0]?.cwd).toBe(sessionCwd);
    expect(listSessionRequests[0]?.cwd).toBe(sessionCwd);
    expect(loadSessionRequests[0]?.cwd).toBe(sessionCwd);
    expect(forkSessionRequests[0]?.cwd).toBe(sessionCwd);
    expect(resumeSessionRequests[0]?.cwd).toBe(sessionCwd);
  });

  test("uses workspace identity for permission-engine evaluation even when session cwd is narrower", async () => {
    const permissionEngine = new PermissionEngine();
    const evaluateSpy = spyOn(permissionEngine, "evaluate");
    const { createProcess } = createMockAgent({
      prompts: [
        {
          permissionRequest: {
            toolCallId: "tc-1",
            title: "writeFile",
            options: [{ kind: "allow_once", name: "Allow", optionId: "allow" }],
          },
          stopReason: "end_turn",
        },
      ],
    });

    controller.subscribe((event) => {
      if (event.type === "permission_requested") {
        controller.resolvePermission({
          outcome: { outcome: "selected", optionId: "allow" },
        });
      }
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        permissionEngine,
        workspaceIdentityPath: "/workspace/root",
        sessionCwd: "/workspace/root/projects/alpha",
      }),
    );

    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "check permission roots" }]);

    expect(evaluateSpy).toHaveBeenCalled();
    expect(evaluateSpy.mock.calls[0]?.[2]).toBe("/workspace/root");
  });

  test("suggested permission scopes stay anchored to the workspace identity root", async () => {
    const events: ACPSessionEvent[] = [];
    const { createProcess } = createMockAgent({ prompts: [] });

    controller.subscribe((event) => events.push(event));

    await controller.start(
      makeStartConfig({
        createProcess,
        workspaceIdentityPath: "/workspace/root",
        sessionCwd: "/workspace/root/projects/alpha",
      }),
    );

    const permissionPromise = controller._handlePermissionRequest({
      sessionId: "test-session",
      toolCall: {
        toolCallId: "tc-1",
        title: "readTextFile",
        rawInput: {
          path: "/workspace/root/docs/spec.md",
        },
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    const permissionEvent = events.find((event) => event.type === "permission_requested");
    expect(permissionEvent).toBeDefined();
    if (permissionEvent?.type !== "permission_requested") {
      throw new Error("Expected permission_requested event");
    }

    const suggestedScopes = (
      permissionEvent.request as typeof permissionEvent.request & {
        suggestedScopes?: Array<{ scope: string }>;
      }
    ).suggestedScopes;

    expect(suggestedScopes?.map((scope) => scope.scope)).toContain("/workspace/root/");
    expect(suggestedScopes?.map((scope) => scope.scope)).toContain("/workspace/root/docs/");
    expect(suggestedScopes?.map((scope) => scope.scope)).not.toContain(
      "/workspace/root/projects/alpha/",
    );

    controller.resolvePermission({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    await permissionPromise;
  });

  test("write to directoryPolicy.autoApprovedWriteFolders is auto-approved without modal", async () => {
    const { createProcess } = createMockAgent({ prompts: [] });
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(
      makeStartConfig({
        createProcess,
        workspaceIdentityPath: "/workspace/root",
        sessionCwd: "/workspace/root/projects/alpha",
        directoryPolicy: {
          autoApprovedWriteFolders: ["projects/alpha/scratch"],
        },
      }),
    );

    const result = await controller._requestWriteGateApproval({
      path: "projects/alpha/scratch/note.md",
      diff: "some diff",
    });

    expect(result).toBe(true);
    expect(events.some((e) => e.type === "write_gate_requested")).toBe(false);
  });
});
