import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ACPSessionState, PermissionEngine, type PermissionMode } from "@agents-js/acp-host";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";
import { createPermissionRule, type PermissionRule } from "@agents-js/policy";
import { __testing, switchHostSessionRuntime } from "../src/host-session.ts";
import {
  E2E_RUNTIME_PROFILE_DATA_HOME_ENV,
  E2E_RUNTIME_PROFILE_STATE_HOME_ENV,
} from "../src/runtime-profile-env.ts";
import { resolveHostWorkspaceFlag } from "../src/runtime-workspace-flag.ts";

const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgStateHome = process.env.XDG_STATE_HOME;
const originalRuntimeProfileDataHome = process.env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV];
const originalRuntimeProfileStateHome = process.env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV];

afterEach(() => {
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome;
  }
  if (originalXdgStateHome === undefined) {
    delete process.env.XDG_STATE_HOME;
  } else {
    process.env.XDG_STATE_HOME = originalXdgStateHome;
  }
  if (originalRuntimeProfileDataHome === undefined) {
    delete process.env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV];
  } else {
    process.env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV] = originalRuntimeProfileDataHome;
  }
  if (originalRuntimeProfileStateHome === undefined) {
    delete process.env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV];
  } else {
    process.env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV] = originalRuntimeProfileStateHome;
  }
});

function createRuntime(id: string, displayName: string): ResolvedGatewayRuntime {
  return {
    definition: {
      id,
      displayName,
      description: `${displayName} runtime`,
      command: `${id}-cli`,
      args: ["acp"],
      install: {
        owner: "external",
        installHint: `Install ${id}.`,
      },
      resolvesFromWorkspaceBin: false,
      workspaceFlag: "--cwd",
    },
    acp: {
      command: `/mock/bin/${id}`,
      args: ["serve"],
      env: { ACP_RUNTIME_ID: id },
      workspaceFlag: "--cwd",
    },
    agentCard: {
      name: displayName,
      description: `${displayName} agent`,
      capabilities: { streaming: true },
    } as ResolvedGatewayRuntime["agentCard"],
  };
}

function createRuntimeControllerHarness(state: {
  sessionId?: string | null;
  status?: string | null;
  promptQueue?: ACPSessionState["promptQueue"];
  newSessionError?: Error | null;
}) {
  const sessionState: ACPSessionState = {
    sessionId: state.sessionId ?? null,
    status: (state.status ?? "ready") as ACPSessionState["status"],
    agentName: null,
    agentCapabilities: null,
    currentTurn: null,
    completedTurns: [],
    lastError: null,
    pendingWriteGate: null,
    pendingElicitation: null,
    plan: null,
    sessionTitle: null,
    sessionUpdatedAt: null,
    localLabel: null,
    promptQueue: state.promptQueue ?? [],
    modes: null,
    models: null,
    modesAdvertisedByAgent: false,
    permissionGatingActive: true,
    hubPath: null,
    availableCommands: null,
    usage: null,
  };
  let newSessionCalls = 0;
  let destroyed = false;
  const controller = {
    permissionMode: "plan" as PermissionMode,
    getState() {
      return sessionState;
    },
    async start() {},
    async setPermissionMode(_mode: PermissionMode) {},
    async newSession() {
      newSessionCalls += 1;
      if (state.newSessionError) {
        throw state.newSessionError;
      }
      return "session-restarted";
    },
    destroy() {
      destroyed = true;
    },
  };

  return {
    controller,
    get newSessionCalls() {
      return newSessionCalls;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

describe("switchHostSessionRuntime", () => {
  test("preserves runtime-specific workspace flags for host processes", () => {
    const runtime = createRuntime("opencode", "OpenCode ACP");

    expect(resolveHostWorkspaceFlag(runtime)).toBe("--cwd");
  });

  test("opts out of the acp-host default workspace flag when the runtime has none", () => {
    const runtime = createRuntime("codex", "Codex ACP");
    delete (runtime.definition as { workspaceFlag?: string }).workspaceFlag;
    delete (runtime.acp as { workspaceFlag?: string }).workspaceFlag;

    expect(resolveHostWorkspaceFlag(runtime)).toBe("");
  });

  test("keeps the validated controller when the existing runtime had an active session", async () => {
    const runtime = createRuntime("claude", "Claude ACP");
    const active = createRuntimeControllerHarness({
      sessionId: "session-1",
      status: "ready",
      promptQueue: [],
    });
    const candidate = createRuntimeControllerHarness({
      sessionId: null,
      status: "ready",
      promptQueue: [],
    });
    const created: Array<{
      runtime: ResolvedGatewayRuntime;
      permissionMode: PermissionMode;
      defaultModel?: string;
    }> = [];
    let replacedController: unknown = null;

    const result = await switchHostSessionRuntime({
      activeController: active.controller,
      replaceActiveController(controller) {
        replacedController = controller;
      },
      async createController(config) {
        created.push(config);
        return candidate.controller;
      },
      runtime,
      defaultModel: "sonnet",
    });

    expect(result).toEqual({
      preservedSession: true,
      clearedPendingTurn: false,
    });
    expect(created).toEqual([
      {
        runtime,
        permissionMode: "plan",
        defaultModel: "sonnet",
      },
    ]);
    expect(active.destroyed).toBe(true);
    expect(candidate.destroyed).toBe(false);
    expect(candidate.newSessionCalls).toBe(1);
    expect(replacedController).toBe(candidate.controller);
  });

  test("keeps the started controller disconnected when no session was connected", async () => {
    const runtime = createRuntime("claude", "Claude ACP");
    const active = createRuntimeControllerHarness({
      sessionId: null,
      status: "ready",
      promptQueue: [],
    });
    const candidate = createRuntimeControllerHarness({
      sessionId: null,
      status: "ready",
      promptQueue: [],
    });
    const created: Array<{
      runtime: ResolvedGatewayRuntime;
      permissionMode: PermissionMode;
      defaultModel?: string;
    }> = [];
    let replacedController: unknown = null;

    const result = await switchHostSessionRuntime({
      activeController: active.controller,
      replaceActiveController(controller) {
        replacedController = controller;
      },
      async createController(config) {
        created.push(config);
        return candidate.controller;
      },
      runtime,
      defaultModel: "sonnet",
    });

    expect(result).toEqual({
      preservedSession: false,
      clearedPendingTurn: false,
    });
    expect(created).toEqual([
      {
        runtime,
        permissionMode: "plan",
        defaultModel: "sonnet",
      },
    ]);
    expect(candidate.newSessionCalls).toBe(0);
    expect(candidate.destroyed).toBe(false);
    expect(active.destroyed).toBe(true);
    expect(replacedController).toBe(candidate.controller);
  });

  test("keeps the active controller when the candidate runtime fails validation", async () => {
    const active = createRuntimeControllerHarness({
      sessionId: "session-1",
      status: "ready",
      promptQueue: [],
    });
    const candidate = createRuntimeControllerHarness({
      sessionId: null,
      status: "ready",
      promptQueue: [],
      newSessionError: new Error('default agent "Sisyphus - Ultraworker" not found'),
    });
    let replacedController: unknown = null;

    await expect(
      switchHostSessionRuntime({
        activeController: active.controller,
        replaceActiveController(controller) {
          replacedController = controller;
        },
        async createController() {
          return candidate.controller;
        },
        runtime: createRuntime("sisyphus", "Sisyphus ACP"),
      }),
    ).rejects.toThrow('default agent "Sisyphus - Ultraworker" not found');

    expect(active.destroyed).toBe(false);
    expect(candidate.destroyed).toBe(true);
    expect(candidate.newSessionCalls).toBe(1);
    expect(replacedController).toBeNull();
  });

  test("marks queued prompts as cleared during a runtime switch", async () => {
    const active = createRuntimeControllerHarness({
      sessionId: "session-queued",
      status: "ready",
      promptQueue: [[{ type: "text", text: "queued" }]],
    });
    const candidate = createRuntimeControllerHarness({
      sessionId: null,
      status: "ready",
      promptQueue: [],
    });

    const result = await switchHostSessionRuntime({
      activeController: active.controller,
      replaceActiveController() {},
      async createController() {
        return candidate.controller;
      },
      runtime: createRuntime("opencode", "OpenCode ACP"),
    });

    expect(result).toEqual({
      preservedSession: true,
      clearedPendingTurn: true,
    });
    expect(candidate.newSessionCalls).toBe(1);
  });

  for (const status of ["prompting", "cancelling"] as const) {
    test(`marks a "${status}" turn as cleared during a runtime switch`, async () => {
      const active = createRuntimeControllerHarness({
        sessionId: `session-${status}`,
        status,
        promptQueue: [],
      });
      const candidate = createRuntimeControllerHarness({
        sessionId: null,
        status: "ready",
        promptQueue: [],
      });

      const result = await switchHostSessionRuntime({
        activeController: active.controller,
        replaceActiveController() {},
        async createController() {
          return candidate.controller;
        },
        runtime: createRuntime("claude", "Claude ACP"),
      });

      expect(result).toEqual({
        preservedSession: true,
        clearedPendingTurn: true,
      });
      expect(candidate.newSessionCalls).toBe(1);
    });
  }
});

describe("loadPersistedRules", () => {
  test("loads workspace-local rules before global rules so specific matches win", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agents-js-host-session-rules-"));
    const workspace = join(tempRoot, "workspace");
    const xdgDataHome = join(tempRoot, "xdg-data");
    process.env.XDG_DATA_HOME = xdgDataHome;

    try {
      await mkdir(join(workspace, ".agents-js"), { recursive: true });
      await mkdir(join(xdgDataHome, "agents-js"), { recursive: true });

      const request = {
        sessionId: "session-1",
        toolCall: {
          toolCallId: "tool-1",
          title: "Read file",
          rawInput: { path: "notes/todo.md" },
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      };

      const globalRule: PermissionRule = createPermissionRule(
        request,
        "Claude ACP",
        "global",
        "reject",
        "persistent",
      );
      const localRule: PermissionRule = createPermissionRule(
        request,
        "Claude ACP",
        workspace,
        "allow",
        "persistent",
        "allow",
      );

      await writeFile(
        join(xdgDataHome, "agents-js", "permission-rules.json"),
        JSON.stringify([globalRule], null, 2),
        "utf8",
      );
      await writeFile(
        join(workspace, ".agents-js", "permission-rules.json"),
        JSON.stringify([localRule], null, 2),
        "utf8",
      );

      const loaded = __testing.loadPersistedRules(workspace);
      expect(loaded.map((rule) => rule.id)).toEqual([localRule.id, globalRule.id]);

      const engine = new PermissionEngine();
      engine.loadRules(loaded);
      const match = engine.evaluate(request, "Claude ACP", workspace);
      expect(match.matched).toBeTrue();
      expect(match.rule?.id).toBe(localRule.id);
      expect(match.rule?.outcome).toBe("allow");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("permission rule persistence helpers", () => {
  test("uses the repo-owned runtime-profile data home for global permission rules when set", () => {
    process.env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV] = "/tmp/runtime-profile-data";
    process.env.XDG_DATA_HOME = "/tmp/xdg-data";

    expect(__testing.getGlobalRulesFilePath()).toBe(
      "/tmp/runtime-profile-data/agents-js/permission-rules.json",
    );
  });

  test("uses the repo-owned runtime-profile state home for session snapshots when set", () => {
    process.env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV] = "/tmp/runtime-profile-state";
    process.env.XDG_STATE_HOME = "/tmp/xdg-state";

    expect(__testing.getSessionFilePath("/workspace/project", "session-1")).toBe(
      "/tmp/runtime-profile-state/agents-js/sessions/e3af8a725158/session-1.json",
    );
  });

  test("creates a persistent remembered rule for allow_always using the selected scope", () => {
    const engine = new PermissionEngine();
    const rule = __testing.deriveRememberedPermissionRule(
      {
        sessionId: "session-1",
        toolCall: {
          toolCallId: "tool-1",
          title: "Write file",
          rawInput: { path: "/workspace/docs/spec.md" },
        },
        options: [{ optionId: "allow", name: "Allow always", kind: "allow_always" }],
        suggestedScopes: [
          { level: "exact", scope: "/workspace/docs/spec.md", label: "Just this file" },
          { level: "parent_dir", scope: "/workspace/docs/", label: "Folder: docs/" },
        ],
      } as Parameters<typeof __testing.deriveRememberedPermissionRule>[0] & {
        suggestedScopes: Array<{ level: string; scope: string; label: string }>;
      },
      {
        outcome: { outcome: "selected", optionId: "allow" },
      },
      "Claude ACP",
      "/workspace",
      engine,
      "/workspace/docs/",
    );

    expect(rule).toMatchObject({
      outcome: "allow",
      lifetime: "persistent",
      resourceScope: "/workspace/docs/",
      selectedOptionId: "allow",
    });
  });

  test("does not create a remembered rule for once-only permission choices", () => {
    const engine = new PermissionEngine();
    const rule = __testing.deriveRememberedPermissionRule(
      {
        sessionId: "session-1",
        toolCall: {
          toolCallId: "tool-1",
          title: "Write file",
          rawInput: { path: "/workspace/docs/spec.md" },
        },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      },
      {
        outcome: { outcome: "selected", optionId: "allow" },
      },
      "Claude ACP",
      "/workspace",
      engine,
    );

    expect(rule).toBeNull();
  });

  test("saves and reloads persisted session state from disk", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "agents-js-session-storage-"));
    process.env.XDG_STATE_HOME = join(tempRoot, "xdg-state");
    const storage = __testing.createDiskBackedSessionStorage("/workspace/example");

    try {
      await storage.saveSession("session-7", {
        sessionId: "session-7",
        status: "ready",
        agentName: "Claude ACP",
        agentCapabilities: null,
        currentTurn: {
          textChunks: [],
          toolCalls: new Map(),
          turnItems: [],
          pendingPermission: null,
          approvedToolCallIds: new Set(["tool-1"]),
          emittedStartToolCallIds: new Set(),
          emittedEndToolCallIds: new Set(),
        },
        completedTurns: [],
        lastError: null,
        pendingWriteGate: null,
        pendingElicitation: null,
        plan: [{ content: "Review spec", status: "completed", priority: "medium" }],
        sessionTitle: "Review spec",
        sessionUpdatedAt: "2026-04-08T12:00:00.000Z",
        localLabel: "Saved session",
        promptQueue: [],
        modes: null,
        models: null,
        modesAdvertisedByAgent: false,
        permissionGatingActive: true,
        hubPath: null,
        availableCommands: null,
        usage: null,
      });

      const restored = await storage.loadSession("session-7");

      expect(restored?.sessionTitle).toBe("Review spec");
      expect(restored?.sessionUpdatedAt).toBe("2026-04-08T12:00:00.000Z");
      expect(restored?.currentTurn?.approvedToolCallIds).toBeInstanceOf(Set);
      expect(restored?.currentTurn?.approvedToolCallIds.has("tool-1")).toBe(true);
      expect(__testing.getSessionFilePath("/workspace/example", "session-7")).toContain(
        "agents-js/sessions",
      );
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
