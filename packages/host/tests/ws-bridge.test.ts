import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A2UI_WS_FRAME_TYPE, type A2uiMessage } from "@agents-js/a2ui-types";
import {
  ACPSessionController,
  type ACPSessionState,
  configureLogging,
  createNodeFileAdapters,
  resetLogging,
  type StartConfig,
} from "@agents-js/acp-host";
import { SESSION_RESTORE_FAILURE_MESSAGE } from "@agents-js/acp-host/session-restore";
import { type AgentScenario, createMockAgent } from "@agents-js/acp-host/testing";
import { createGatewaySurfaceBroadcaster } from "../src/surface-broadcaster.ts";
import {
  createEnsureSessionCoordinator,
  createRuntimeSwitchCoordinator,
  createWSBridge,
  type WSServerMessage,
} from "../src/ws-bridge.ts";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
  stepMs = 10,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    await Bun.sleep(stepMs);
  }
}

async function waitForSocketOpen(socket: WebSocket, timeoutMs = 2_000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out opening websocket after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      },
      { once: true },
    );
  });
}

function createBridgeClient(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages: WSServerMessage[] = [];
  let notify: (() => void) | null = null;

  socket.addEventListener("message", (event) => {
    const payload = typeof event.data === "string" ? event.data : String(event.data);
    messages.push(JSON.parse(payload) as WSServerMessage);
    notify?.();
    notify = null;
  });

  return {
    socket,
    async open(): Promise<void> {
      await waitForSocketOpen(socket);
    },
    send(message: unknown): void {
      socket.send(JSON.stringify(message));
    },
    async waitForMessage(
      predicate: (message: WSServerMessage) => boolean,
      timeoutMs = 2_000,
    ): Promise<WSServerMessage> {
      const startedAt = Date.now();
      while (true) {
        const index = messages.findIndex(predicate);
        if (index >= 0) {
          const [message] = messages.splice(index, 1);
          if (message) {
            return message;
          }
        }

        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) {
          throw new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`);
        }

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (notify === resolve) notify = null;
            reject(new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`));
          }, remaining);
          notify = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
      }
    },
    close(): void {
      socket.close();
    },
  };
}

function makeStartConfig(
  workspacePath: string,
  createProcess: StartConfig["createProcess"],
): StartConfig {
  return {
    agentConfig: {
      name: "Test Agent",
      command: "unused",
      args: [],
      env: {},
      authHints: [],
      workspacePolicy: "workspace-root-only",
    },
    workspacePath,
    createProcess,
    fileAdapters: createNodeFileAdapters(workspacePath),
  };
}

async function createLiveBridgeHarness(scenario: AgentScenario) {
  const workspacePath = await mkdtemp(join(tmpdir(), "agents-js-ws-bridge-"));
  const controller = new ACPSessionController();
  const { createProcess, agentReady, promptRequests } = createMockAgent(scenario);

  await controller.start(makeStartConfig(workspacePath, createProcess));
  await agentReady;

  const bridge = createWSBridge({
    controller,
    port: 0,
    runtime: { id: "opencode", displayName: "OpenCode ACP" },
  });
  const client = createBridgeClient(bridge.server.port ?? 0);
  await client.open();

  return {
    workspacePath,
    controller,
    client,
    bridge,
    promptRequests,
    async cleanup(): Promise<void> {
      client.close();
      bridge.stop();
      controller.destroy();
      await rm(workspacePath, { recursive: true, force: true });
    },
  };
}

beforeEach(() => {
  configureLogging({ minLevel: "error" });
  spyOn(console, "log").mockImplementation(() => {});
  spyOn(console, "warn").mockImplementation(() => {});
  spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetLogging();
});

describe("createEnsureSessionCoordinator", () => {
  test("coalesces concurrent ensure_session requests into one session creation", async () => {
    let state = { sessionId: null } as unknown as ACPSessionState;
    let newSessionCalls = 0;

    const ensureSession = createEnsureSessionCoordinator({
      getState() {
        return state;
      },
      async newSession() {
        newSessionCalls += 1;
        await Promise.resolve();
        state = { ...state, sessionId: "session-1" } as ACPSessionState;
        return "session-1";
      },
    });

    await Promise.all([ensureSession(), ensureSession(), ensureSession()]);

    expect(newSessionCalls).toBe(1);
    expect(state.sessionId).toBe("session-1");
  });

  test("does nothing when a session already exists", async () => {
    let newSessionCalls = 0;

    const ensureSession = createEnsureSessionCoordinator({
      getState() {
        return { sessionId: "existing-session" } as ACPSessionState;
      },
      async newSession() {
        newSessionCalls += 1;
        return "unexpected";
      },
    });

    await ensureSession();

    expect(newSessionCalls).toBe(0);
  });
});

describe("createRuntimeSwitchCoordinator", () => {
  test("marks runtime swap unsupported when no handler is configured", async () => {
    const coordinator = createRuntimeSwitchCoordinator({
      initialRuntime: { id: "opencode", displayName: "OpenCode ACP" },
    });

    await coordinator.setRuntime("claude");

    expect(coordinator.getSnapshot()).toMatchObject({
      runtime: { id: "opencode", displayName: "OpenCode ACP" },
      runtimeSwitchState: {
        status: "runtimeUnsupported",
        requestedRuntimeId: "claude",
        origin: "manual",
      },
    });
  });

  test("updates runtime snapshot after a successful swap", async () => {
    const states: string[] = [];
    const coordinator = createRuntimeSwitchCoordinator({
      initialRuntime: { id: "opencode", displayName: "OpenCode ACP" },
      setRuntime: async () => ({
        runtime: { id: "claude", displayName: "Claude ACP" },
        preservedSession: true,
        clearedPendingTurn: true,
        message: "Switched.",
      }),
      onStateChange: (snapshot) => {
        states.push(snapshot.runtimeSwitchState?.status ?? "idle");
      },
    });

    await coordinator.setRuntime("claude");

    expect(states).toEqual(["switching", "runtimeApplied"]);
    expect(coordinator.getSnapshot()).toMatchObject({
      runtime: { id: "claude", displayName: "Claude ACP" },
      runtimeSwitchState: {
        status: "runtimeApplied",
        requestedRuntimeId: "claude",
        origin: "manual",
        preservedSession: true,
        clearedPendingTurn: true,
      },
    });
  });

  test("keeps the previous runtime snapshot when a saved restore swap fails", async () => {
    const coordinator = createRuntimeSwitchCoordinator({
      initialRuntime: { id: "claude", displayName: "Claude ACP" },
      setRuntime: async () => {
        throw new Error("switch failed");
      },
    });

    await coordinator.setRuntime("opencode", "saved_restore");

    expect(coordinator.getSnapshot()).toMatchObject({
      runtime: { id: "claude", displayName: "Claude ACP" },
      runtimeSwitchState: {
        status: "failed",
        requestedRuntimeId: "opencode",
        message: "switch failed",
        origin: "saved_restore",
      },
    });
  });

  test("serializes overlapping runtime switches", async () => {
    const calls: string[] = [];
    const claude = createDeferred<{
      runtime: { id: string; displayName: string };
      message: string;
    }>();
    const gemini = createDeferred<{
      runtime: { id: string; displayName: string };
      message: string;
    }>();

    const coordinator = createRuntimeSwitchCoordinator({
      initialRuntime: { id: "opencode", displayName: "OpenCode ACP" },
      setRuntime: async (runtimeId) => {
        calls.push(runtimeId);
        if (runtimeId === "claude") {
          return claude.promise;
        }
        if (runtimeId === "gemini") {
          return gemini.promise;
        }
        throw new Error(`Unexpected runtime ${runtimeId}`);
      },
    });

    const first = coordinator.setRuntime("claude");
    const second = coordinator.setRuntime("gemini");

    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["claude"]);

    claude.resolve({
      runtime: { id: "claude", displayName: "Claude ACP" },
      message: "Switched to Claude.",
    });
    await first;
    await Bun.sleep(0);

    expect(calls).toEqual(["claude", "gemini"]);

    gemini.resolve({
      runtime: { id: "gemini", displayName: "Gemini ACP" },
      message: "Switched to Gemini.",
    });
    await second;

    expect(coordinator.getSnapshot()).toMatchObject({
      runtime: { id: "gemini", displayName: "Gemini ACP" },
      runtimeSwitchState: {
        status: "runtimeApplied",
        requestedRuntimeId: "gemini",
        message: "Switched to Gemini.",
        origin: "manual",
      },
    });
  });
});

describe("createWSBridge", () => {
  test("resolves permission requests through the websocket bridge against a real controller", async () => {
    const harness = await createLiveBridgeHarness({
      prompts: [
        {
          permissionRequest: {
            toolCallId: "tool-read-1",
            title: "Write file: notes.md",
            options: [
              { kind: "allow_once", name: "Allow once", optionId: "allow-1" },
              { kind: "reject_once", name: "Reject once", optionId: "reject-1" },
            ],
          },
          stopReason: "end_turn",
        },
      ],
    });

    try {
      harness.client.send({ type: "ensure_session" });
      await waitForCondition(() => harness.controller.getState().sessionId === "mock-session-1");

      const promptPromise = harness.controller.sendPrompt([
        { type: "text", text: "Update notes.md" },
      ]);
      const permissionMessage = await harness.client.waitForMessage(
        (message) => message.type === "event" && message.event.type === "permission_requested",
      );

      expect(permissionMessage.type).toBe("event");
      if (
        permissionMessage.type !== "event" ||
        permissionMessage.event.type !== "permission_requested"
      ) {
        throw new Error("Expected permission_requested event");
      }

      expect(permissionMessage.event.request.toolCall.title).toBe("Write file: notes.md");

      harness.client.send({
        type: "resolve_permission",
        response: { outcome: { outcome: "selected", optionId: "allow-1" } },
      });

      await promptPromise;

      expect(harness.promptRequests).toHaveLength(1);
      expect(harness.controller.getState().status).toBe("ready");
      expect(harness.controller.getState().currentTurn?.pendingPermission).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  test("resolves write gates through the websocket bridge and commits the file write", async () => {
    const harness = await createLiveBridgeHarness({
      prompts: [
        {
          writeFile: {
            path: "drafts/summary.md",
            content: "# Summary\n\nReady for review.\n",
          },
          stopReason: "end_turn",
        },
      ],
    });

    try {
      const draftDir = join(harness.workspacePath, "drafts");
      const draftPath = join(draftDir, "summary.md");
      await mkdir(draftDir, { recursive: true });
      await Bun.write(draftPath, "# Summary\n\nDraft only.\n");

      harness.client.send({ type: "ensure_session" });
      await waitForCondition(() => harness.controller.getState().sessionId === "mock-session-1");

      const promptPromise = harness.controller.sendPrompt([
        { type: "text", text: "Update drafts/summary.md" },
      ]);
      const writeGateMessage = await harness.client.waitForMessage(
        (message) => message.type === "event" && message.event.type === "write_gate_requested",
      );

      expect(writeGateMessage.type).toBe("event");
      if (
        writeGateMessage.type !== "event" ||
        writeGateMessage.event.type !== "write_gate_requested"
      ) {
        throw new Error("Expected write_gate_requested event");
      }

      expect(writeGateMessage.event.path).toBe("drafts/summary.md");
      expect(writeGateMessage.event.closestParentFolder).toBe("drafts");

      harness.client.send({
        type: "resolve_write_gate",
        result: { action: "approve" },
      });

      await promptPromise;

      expect(await Bun.file(draftPath).text()).toBe("# Summary\n\nReady for review.\n");
      expect(harness.controller.getState().pendingWriteGate).toBeNull();
      expect(harness.controller.getState().status).toBe("ready");
    } finally {
      await harness.cleanup();
    }
  });

  test("forwards selectedScope when resolving permissions over the websocket bridge", async () => {
    const resolved: Array<{ response: unknown; selectedScope?: string }> = [];
    const state = {
      sessionId: null,
      status: "ready",
      currentTurn: null,
      completedTurns: [],
      lastError: null,
      pendingWriteGate: null,
      pendingElicitation: null,
      plan: null,
      sessionTitle: null,
      sessionUpdatedAt: null,
      localLabel: null,
      promptQueue: [],
      modes: null,
      modesAdvertisedByAgent: false,
      permissionGatingActive: true,
      hubPath: null,
      availableCommands: null,
      usage: null,
      agentName: null,
      agentCapabilities: null,
    } as ACPSessionState;

    const bridge = createWSBridge({
      controller: {
        permissionMode: "default",
        subscribe() {
          return () => {};
        },
        getState() {
          return state;
        },
        resolvePermission(response: unknown, selectedScope?: string) {
          resolved.push({ response, selectedScope });
        },
        resolveWriteGate() {},
        resolveElicitation() {},
        async newSession() {
          state.sessionId = "session-1";
          return "session-1";
        },
        async loadSession() {
          return "session-1";
        },
        async setRuntime() {},
        async setPermissionMode() {},
        async cancel() {},
        setLastError() {},
      } as unknown as ACPSessionController,
      port: 0,
      runtime: { id: "opencode", displayName: "OpenCode ACP" },
    });
    const client = createBridgeClient(bridge.server.port ?? 0);

    try {
      await client.open();
      client.send({
        type: "resolve_permission",
        response: {
          outcome: { outcome: "selected", optionId: "allow-1" },
        },
        selectedScope: "/workspace/docs/",
      });

      await waitForCondition(() => resolved.length === 1);

      expect(resolved[0]).toEqual({
        response: {
          outcome: { outcome: "selected", optionId: "allow-1" },
        },
        selectedScope: "/workspace/docs/",
      });
    } finally {
      client.close();
      bridge.stop();
    }
  });

  test("broadcasts a restore-failure snapshot before creating the replacement session", async () => {
    const state = {
      sessionId: null,
      status: "ready",
      currentTurn: null,
      completedTurns: [],
      lastError: null,
      pendingWriteGate: null,
      pendingElicitation: null,
      plan: null,
      sessionTitle: null,
      sessionUpdatedAt: null,
      localLabel: null,
      promptQueue: [],
      modes: null,
      modesAdvertisedByAgent: false,
      permissionGatingActive: true,
      hubPath: null,
      availableCommands: null,
      usage: null,
      agentName: null,
      agentCapabilities: null,
    } as ACPSessionState;

    const bridge = createWSBridge({
      controller: {
        permissionMode: "default",
        subscribe() {
          return () => {};
        },
        getState() {
          return state;
        },
        async newSession() {
          state.sessionId = "fresh-session-2";
          return "fresh-session-2";
        },
        async loadSession() {
          throw new Error("missing session");
        },
        resolvePermission() {},
        resolveWriteGate() {},
        resolveElicitation() {},
        async setRuntime() {},
        async setPermissionMode() {},
        async cancel() {},
        setLastError(error: string | null) {
          state.lastError = error;
        },
      } as unknown as ACPSessionController,
      port: 0,
      runtime: { id: "opencode", displayName: "OpenCode ACP" },
    });
    const client = createBridgeClient(bridge.server.port ?? 0);

    try {
      await client.open();
      client.send({ type: "load_session", sessionId: "stale-session-1" });

      const restoreFailureSnapshot = await client.waitForMessage(
        (message) =>
          message.type === "state_snapshot" &&
          (message.state as unknown as Record<string, unknown>).lastError ===
            SESSION_RESTORE_FAILURE_MESSAGE &&
          (message.state as unknown as Record<string, unknown>).sessionId == null,
      );
      const replacementSnapshot = await client.waitForMessage(
        (message) =>
          message.type === "state_snapshot" &&
          (message.state as unknown as Record<string, unknown>).sessionId === "fresh-session-2",
      );

      expect(restoreFailureSnapshot.type).toBe("state_snapshot");
      expect(replacementSnapshot.type).toBe("state_snapshot");
      if (replacementSnapshot.type !== "state_snapshot") {
        throw new Error("Expected state_snapshot replacement frame");
      }
      expect((replacementSnapshot.state as unknown as Record<string, unknown>).lastError).toBe(
        SESSION_RESTORE_FAILURE_MESSAGE,
      );
    } finally {
      client.close();
      bridge.stop();
    }
  });

  test("keeps the previous runtime snapshot when a saved restore runtime switch fails", async () => {
    const state = {
      sessionId: "session-1",
      status: "ready",
      currentTurn: null,
      completedTurns: [],
      lastError: null,
      pendingWriteGate: null,
      pendingElicitation: null,
      plan: null,
      sessionTitle: null,
      sessionUpdatedAt: null,
      localLabel: null,
      promptQueue: [],
      modes: null,
      modesAdvertisedByAgent: false,
      permissionGatingActive: true,
      hubPath: null,
      availableCommands: null,
      usage: null,
      agentName: null,
      agentCapabilities: null,
    } as ACPSessionState;

    const bridge = createWSBridge({
      controller: {
        permissionMode: "default",
        subscribe() {
          return () => {};
        },
        getState() {
          return state;
        },
        resolvePermission() {},
        resolveWriteGate() {},
        resolveElicitation() {},
        async newSession() {
          return "session-1";
        },
        async loadSession() {
          return "session-1";
        },
        async setPermissionMode() {},
        async cancel() {},
        setLastError() {},
      } as unknown as ACPSessionController,
      port: 0,
      runtime: { id: "claude", displayName: "Claude ACP" },
      setRuntime: async () => {
        throw new Error(
          "Failed to switch runtime to OpenCode ACP (opencode). Still using Claude ACP (claude).",
        );
      },
    });
    const client = createBridgeClient(bridge.server.port ?? 0);

    try {
      await client.open();
      client.send({
        type: "set_runtime",
        runtimeId: "opencode",
        origin: "saved_restore",
      });

      const failedSnapshot = await client.waitForMessage(
        (message) =>
          message.type === "state_snapshot" &&
          (message.state as unknown as Record<string, unknown>).runtimeSwitchState !== null &&
          (
            (message.state as unknown as Record<string, unknown>).runtimeSwitchState as Record<
              string,
              unknown
            >
          ).status === "failed",
      );

      expect(failedSnapshot.type).toBe("state_snapshot");
      if (failedSnapshot.type !== "state_snapshot") {
        throw new Error("Expected state_snapshot failed frame");
      }
      expect(failedSnapshot.state).toMatchObject({
        runtime: { id: "claude", displayName: "Claude ACP" },
        runtimeSwitchState: {
          status: "failed",
          requestedRuntimeId: "opencode",
          origin: "saved_restore",
          message:
            "Failed to switch runtime to OpenCode ACP (opencode). Still using Claude ACP (claude).",
        },
      });
    } finally {
      client.close();
      bridge.stop();
    }
  });

  test("fans a surface broadcaster's message out as an a2ui_message frame", async () => {
    const state = {
      sessionId: "session-1",
      status: "ready",
      currentTurn: null,
      completedTurns: [],
      lastError: null,
      pendingWriteGate: null,
      pendingElicitation: null,
      plan: null,
      sessionTitle: null,
      sessionUpdatedAt: null,
      localLabel: null,
      promptQueue: [],
      modes: null,
      modesAdvertisedByAgent: false,
      permissionGatingActive: true,
      hubPath: null,
      availableCommands: null,
      usage: null,
      agentName: null,
      agentCapabilities: null,
    } as ACPSessionState;

    const surfaceBroadcaster = createGatewaySurfaceBroadcaster();

    const bridge = createWSBridge({
      controller: {
        permissionMode: "default",
        subscribe() {
          return () => {};
        },
        getState() {
          return state;
        },
        resolvePermission() {},
        resolveWriteGate() {},
        resolveElicitation() {},
        async newSession() {
          return "session-1";
        },
        async loadSession() {
          return "session-1";
        },
        async setPermissionMode() {},
        async cancel() {},
        setLastError() {},
      } as unknown as ACPSessionController,
      port: 0,
      runtime: { id: "opencode", displayName: "OpenCode ACP" },
      surfaceBroadcaster,
    });
    const client = createBridgeClient(bridge.server.port ?? 0);

    try {
      await client.open();

      const surfaceMessage = {
        messageType: "CreateSurface",
        surfaceId: "s-live",
        components: [],
        root: null,
        dataModel: {},
      } as unknown as A2uiMessage;
      surfaceBroadcaster.handleSurfaceMessage(surfaceMessage);

      const frame = await client.waitForMessage((message) => message.type === A2UI_WS_FRAME_TYPE);
      expect(frame).toEqual({ type: A2UI_WS_FRAME_TYPE, message: surfaceMessage });
    } finally {
      client.close();
      bridge.stop();
    }
  });
});
