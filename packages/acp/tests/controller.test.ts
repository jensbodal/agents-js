import { describe, expect, test } from "bun:test";
import {
  type Agent,
  AgentSideConnection,
  type CancelNotification,
  CLIENT_METHODS,
  type ClientCapabilities,
  type CloseSessionRequest,
  type CreateElicitationRequest,
  type ForkSessionRequest,
  type InitializeRequest,
  type ListSessionsRequest,
  type LoadSessionRequest,
  type LogoutRequest,
  type NewSessionRequest,
  ndJsonStream,
  type PromptRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type Stream,
} from "@agentclientprotocol/sdk";
import { ACPClientController, PROTOCOL_VERSION } from "../src/index.ts";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return { promise, reject, resolve };
}

function createHarness(): {
  agentStream: Stream;
  clientStream: Stream;
} {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

  return {
    clientStream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
    agentStream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
  };
}

type PartialAgent = Partial<Agent> & Pick<Agent, "initialize" | "newSession" | "prompt">;

function startAgent(
  stream: Stream,
  createAgent: (connection: AgentSideConnection) => PartialAgent,
) {
  return new AgentSideConnection((connection) => {
    const agent = createAgent(connection);
    const completed: Agent = {
      authenticate: async () => {
        throw new Error("authenticate not implemented for this test");
      },
      cancel: async () => {},
      ...agent,
    };
    return completed;
  }, stream);
}

describe("ACPClientController", () => {
  test("initialize caches capabilities and emits state updates", async () => {
    const harness = createHarness();
    const initializeRequests: InitializeRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize(params) {
        initializeRequests.push(params);
        return {
          agentCapabilities: {
            loadSession: false,
            sessionCapabilities: {
              list: {},
            },
          },
          agentInfo: { name: "fake-agent", version: "1.0.0" },
          authMethods: [{ id: "local", name: "Local" }],
          protocolVersion: PROTOCOL_VERSION,
        };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const observedEventTypes: string[] = [];
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.subscribe((event) => {
      observedEventTypes.push(event.type);
    });

    const firstResponse = await controller.initialize({
      _meta: { traceId: "trace-1" },
      clientInfo: { name: "acp-host", version: "0.1.0" },
    });
    const secondResponse = await controller.initialize();

    expect(firstResponse).toBe(secondResponse);
    expect(initializeRequests).toHaveLength(1);
    expect(initializeRequests[0]?.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(initializeRequests[0]?.clientCapabilities).toEqual({
      auth: {
        terminal: false,
      },
      fs: {
        readTextFile: false,
        writeTextFile: false,
      },
      terminal: false,
    });
    expect(controller.getState()).toMatchObject({
      agentInfo: { name: "fake-agent", version: "1.0.0" },
      authMethods: [{ id: "local", name: "Local" }],
      status: "ready",
    });
    expect(observedEventTypes).toContain("initialized");
    expect(observedEventTypes).toContain("state.updated");

    controller.dispose();
  });

  test("newSession stores the active session and rejects cwd values outside the workspace root", async () => {
    const harness = createHarness();
    const newSessionRequests: NewSessionRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession(params) {
        newSessionRequests.push(params);
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    const session = await controller.newSession({
      cwd: "/vault/projects/demo",
    });

    expect(session.sessionId).toBe("session-1");
    expect(newSessionRequests).toHaveLength(1);
    expect(newSessionRequests[0]?.cwd).toBe("/vault/projects/demo");
    expect(newSessionRequests[0]?.mcpServers).toEqual([]);
    expect(controller.getState()).toMatchObject({
      sessionId: "session-1",
      status: "session_ready",
    });

    await expect(
      controller.newSession({
        cwd: "/other-root/project",
      }),
    ).rejects.toThrow("Session cwd must stay within the workspace root");
    expect(newSessionRequests).toHaveLength(1);

    controller.dispose();
  });

  test("prompt routes permission requests and session updates to host adapters", async () => {
    const harness = createHarness();
    const sessionUpdates: SessionNotification[] = [];
    const permissionResponses: RequestPermissionResponse[] = [];
    startAgent(harness.agentStream, (connection) => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt(params: PromptRequest) {
        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            content: { text: "Hello from the agent", type: "text" },
            sessionUpdate: "agent_message_chunk",
          },
        });

        const permissionResponse = await connection.requestPermission({
          options: [{ kind: "allow_once", name: "Allow once", optionId: "allow-1" }],
          sessionId: params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "Write file" },
        });
        permissionResponses.push(permissionResponse);

        return {
          stopReason: "end_turn",
        };
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({
          outcome: { optionId: "allow-1", outcome: "selected" },
        }),
        sessionUpdate: async (notification) => {
          sessionUpdates.push(notification);
        },
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();
    const promptResponse = await controller.prompt({
      prompt: [{ text: "Hello", type: "text" }],
    });

    expect(promptResponse.stopReason).toBe("end_turn");
    expect(permissionResponses).toEqual([
      {
        outcome: { optionId: "allow-1", outcome: "selected" },
      },
    ]);
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0]?.update).toMatchObject({
      content: { text: "Hello from the agent", type: "text" },
      sessionUpdate: "agent_message_chunk",
    });
    expect(controller.getState()).toMatchObject({
      lastStopReason: "end_turn",
      status: "session_ready",
    });

    controller.dispose();
  });

  test("cancel resolves pending permission requests and accepts late session updates", async () => {
    const harness = createHarness();
    const cancelNotifications: CancelNotification[] = [];
    const observedUpdates: SessionNotification[] = [];
    const permissionRequested = createDeferred<void>();
    const permissionOutcome = createDeferred<RequestPermissionResponse>();
    const promptFinished = createDeferred<void>();
    startAgent(harness.agentStream, (connection) => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt(params: PromptRequest) {
        const outcome = await connection.requestPermission({
          options: [{ kind: "allow_once", name: "Allow once", optionId: "allow-1" }],
          sessionId: params.sessionId,
          toolCall: { toolCallId: "tool-1", title: "Write file" },
        });
        permissionOutcome.resolve(outcome);

        await connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            content: { text: "Final chunk after cancel", type: "text" },
            sessionUpdate: "agent_message_chunk",
          },
        });
        promptFinished.resolve();

        return {
          stopReason: "cancelled",
        };
      },
      async cancel(params) {
        cancelNotifications.push(params);
      },
    }));

    const pendingPermissionResponse = createDeferred<RequestPermissionResponse>();
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => {
          permissionRequested.resolve();
          return pendingPermissionResponse.promise;
        },
        sessionUpdate: async (notification) => {
          observedUpdates.push(notification);
        },
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();

    const promptPromise = controller.prompt({
      prompt: [{ text: "Hello", type: "text" }],
    });
    await permissionRequested.promise;
    await controller.cancel();
    const promptResponse = await promptPromise;
    await promptFinished.promise;

    expect(cancelNotifications).toEqual([{ sessionId: "session-1" }]);
    expect(await permissionOutcome.promise).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(observedUpdates).toHaveLength(1);
    expect(observedUpdates[0]?.update).toMatchObject({
      content: { text: "Final chunk after cancel", type: "text" },
      sessionUpdate: "agent_message_chunk",
    });
    expect(promptResponse.stopReason).toBe("cancelled");
    expect(controller.getState()).toMatchObject({
      lastStopReason: "cancelled",
      status: "session_ready",
    });

    pendingPermissionResponse.resolve({ outcome: { optionId: "allow-1", outcome: "selected" } });
    controller.dispose();
  });

  test("initialize advertises fs and terminal capabilities only when matching adapters are present", async () => {
    const emptyHarness = createHarness();
    const emptyInitializeRequests: ClientCapabilities[] = [];
    startAgent(emptyHarness.agentStream, () => ({
      async initialize(params) {
        if (params.clientCapabilities) {
          emptyInitializeRequests.push(params.clientCapabilities);
        }
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const emptyController = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: emptyHarness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await emptyController.initialize();

    const fullHarness = createHarness();
    const fullInitializeRequests: ClientCapabilities[] = [];
    startAgent(fullHarness.agentStream, () => ({
      async initialize(params) {
        if (params.clientCapabilities) {
          fullInitializeRequests.push(params.clientCapabilities);
        }
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const fullController = new ACPClientController({
      adapters: {
        fs: {
          readTextFile: async () => ({ content: "hello" }),
          writeTextFile: async () => ({}),
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
        terminal: {
          create: async () => ({ terminalId: "term-1" }),
          kill: async () => ({}),
          output: async () => ({ output: "", truncated: false }),
          release: async () => ({}),
          waitForExit: async () => ({ exitCode: 0 }),
        },
      },
      dispose: () => {},
      stream: fullHarness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await fullController.initialize();

    expect(emptyInitializeRequests).toEqual([
      {
        auth: {
          terminal: false,
        },
        fs: {
          readTextFile: false,
          writeTextFile: false,
        },
        terminal: false,
      },
    ]);
    expect(fullInitializeRequests).toEqual([
      {
        auth: {
          terminal: false,
        },
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
        terminal: true,
      },
    ]);

    emptyController.dispose();
    fullController.dispose();
  });

  test("initialize advertises form elicitation capability when adapter is present", async () => {
    const harness = createHarness();
    const initializeRequests: ClientCapabilities[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize(params) {
        if (params.clientCapabilities) {
          initializeRequests.push(params.clientCapabilities);
        }
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        elicitation: {
          request: async () => ({ action: "cancel" }),
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();

    expect(initializeRequests[0]?.elicitation).toEqual({
      form: {},
    });

    controller.dispose();
  });

  test("prompt routes elicitation through the native protocol handler", async () => {
    const harness = createHarness();
    const observedRequests: CreateElicitationRequest[] = [];

    startAgent(harness.agentStream, (connection) => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt(params: PromptRequest) {
        const response = await connection.extMethod(CLIENT_METHODS.elicitation_create, {
          mode: "form",
          message: "Need project details",
          requestedSchema: {
            type: "object",
            properties: {
              project: { type: "string", description: "Project name" },
            },
            required: ["project"],
          },
          sessionId: params.sessionId,
        });

        expect(response).toEqual({
          action: "accept",
          content: { project: "demo" },
        });

        return {
          stopReason: "end_turn",
        };
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        elicitation: {
          request: async (request) => {
            observedRequests.push(request);
            return {
              action: "accept",
              content: { project: "demo" },
            };
          },
        },
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();
    const response = await controller.prompt({
      prompt: [{ text: "Hello", type: "text" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(observedRequests).toHaveLength(1);
    expect(observedRequests[0]?.mode).toBe("form");
    expect(observedRequests[0]?.message).toBe("Need project details");

    controller.dispose();
  });

  test("prompt rejects unknown extension methods but ignores unknown notifications", async () => {
    const harness = createHarness();
    let observedMethodError: unknown;

    startAgent(harness.agentStream, (connection) => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt(params: PromptRequest) {
        try {
          await connection.extMethod("session/unknown", {
            sessionId: params.sessionId,
          });
        } catch (error) {
          observedMethodError = error;
        }

        await connection.extNotification("session/unknown-notification", {
          sessionId: params.sessionId,
        });

        return {
          stopReason: "end_turn",
        };
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();
    const response = await controller.prompt({
      prompt: [{ text: "Hello", type: "text" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(observedMethodError).toEqual(
      expect.objectContaining({
        code: -32601,
        data: { method: "session/unknown" },
        message: expect.stringContaining("Method not found"),
      }),
    );
    controller.dispose();
  });

  test("initialize rejects with handshake_timeout when agent does not respond", async () => {
    const harness = createHarness();
    // Start an agent that never responds to initialize
    startAgent(harness.agentStream, () => ({
      async initialize() {
        // Never resolve — simulate a hung agent
        return new Promise<never>(() => {});
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    let disposed = false;
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {
        disposed = true;
      },
      handshakeTimeoutMs: 100,
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    const error = await controller.initialize().catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("ACP handshake did not complete within 100ms");
    expect(error.code).toBe("handshake_timeout");
    expect(disposed).toBe(true);
    expect(controller.getState().status).toBe("idle");
  }, 5000);

  test("dispose tears down the controller-owned transport", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    let disposed = false;
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {
        disposed = true;
      },
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.dispose();

    expect(disposed).toBe(true);
    expect(controller.getState().status).toBe("disposed");
    await expect(controller.initialize()).rejects.toThrow("already been disposed");
  });

  test("listSessions returns sessions from the connection", async () => {
    const harness = createHarness();
    const listRequests: ListSessionsRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async listSessions(params: ListSessionsRequest) {
        listRequests.push(params);
        return {
          sessions: [
            {
              sessionId: "session-1",
              cwd: "/vault",
              title: "First session",
              updatedAt: "2026-03-28T12:00:00Z",
            },
            {
              sessionId: "session-2",
              cwd: "/vault",
              title: "Second session",
              updatedAt: "2026-03-28T13:00:00Z",
            },
          ],
          nextCursor: "cursor-abc",
        };
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    const result = await controller.listSessions({ cwd: "/vault" });

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]?.sessionId).toBe("session-1");
    expect(result.sessions[1]?.sessionId).toBe("session-2");
    expect(result.nextCursor).toBe("cursor-abc");
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0]?.cwd).toBe("/vault");

    controller.dispose();
  });

  test("listSessions throws before initialization", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await expect(controller.listSessions()).rejects.toThrow(
      "Call initialize() before using session APIs.",
    );

    controller.dispose();
  });

  test("loadSession transitions through starting_session to session_ready", async () => {
    const harness = createHarness();
    const loadRequests: LoadSessionRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async loadSession(params: LoadSessionRequest) {
        loadRequests.push(params);
        return {
          modes: {
            availableModes: [{ id: "normal", name: "Normal" }],
            currentModeId: "normal",
          },
        };
      },
    }));

    const observedStatuses: string[] = [];
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.subscribe((event) => {
      if (event.type === "state.updated") {
        observedStatuses.push(event.state.status);
      }
    });

    await controller.initialize();
    const response = await controller.loadSession({
      sessionId: "existing-session-1",
      cwd: "/vault/project",
    });

    expect(observedStatuses).toContain("starting_session");
    expect(observedStatuses).toContain("session_ready");
    expect(response.modes?.currentModeId).toBe("normal");
    expect(loadRequests).toHaveLength(1);
    expect(loadRequests[0]?.sessionId).toBe("existing-session-1");
    expect(loadRequests[0]?.cwd).toBe("/vault/project");
    expect(loadRequests[0]?.mcpServers).toEqual([]);

    controller.dispose();
  });

  test("loadSession sets sessionId from request", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async loadSession() {
        return {};
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.loadSession({ sessionId: "restored-session-42" });

    expect(controller.getState().sessionId).toBe("restored-session-42");
    expect(controller.getState().status).toBe("session_ready");

    controller.dispose();
  });

  test("loadSession emits session.loaded event", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async loadSession() {
        return {
          modes: {
            availableModes: [{ id: "code", name: "Code" }],
            currentModeId: "code",
          },
        };
      },
    }));

    const observedEvents: string[] = [];
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.subscribe((event) => {
      observedEvents.push(event.type);
    });

    await controller.initialize();
    await controller.loadSession({ sessionId: "session-loaded-1" });

    expect(observedEvents).toContain("session.loaded");

    controller.dispose();
  });

  test("loadSession throws before initialization", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await expect(controller.loadSession({ sessionId: "session-1" })).rejects.toThrow(
      "Call initialize() before using session APIs.",
    );

    controller.dispose();
  });

  test("listSessions throws after dispose", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();

    controller.dispose();

    await expect(controller.listSessions()).rejects.toThrow("already been disposed");
  });

  test("loadSession throws after dispose", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();

    controller.dispose();

    await expect(controller.loadSession({ sessionId: "s-1" })).rejects.toThrow(
      "already been disposed",
    );
  });

  test("loadSession replaces existing session and updates state", async () => {
    const harness = createHarness();
    const loadRequests: Array<{ sessionId: string }> = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        return { sessionId: "first-session" };
      },
      async prompt() {
        return { stopReason: "end_turn" };
      },
      async loadSession(params: LoadSessionRequest) {
        loadRequests.push({ sessionId: params.sessionId });
        return {};
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession({});
    expect(controller.getState().sessionId).toBe("first-session");

    await controller.loadSession({ sessionId: "replacement-session" });
    expect(controller.getState().sessionId).toBe("replacement-session");
    expect(controller.getState().status).toBe("session_ready");
    expect(loadRequests).toHaveLength(1);
    expect(loadRequests[0]?.sessionId).toBe("replacement-session");

    controller.dispose();
  });

  test("loadSession recovers state when agent rejects", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        return { sessionId: "existing-session" };
      },
      async prompt() {
        return { stopReason: "end_turn" };
      },
      async loadSession() {
        throw new Error("Session not found");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession({});
    expect(controller.getState().sessionId).toBe("existing-session");

    // Agent errors are wrapped in JSON-RPC "Internal error" by the SDK
    await expect(controller.loadSession({ sessionId: "nonexistent-session" })).rejects.toThrow();

    // Should recover to session_ready with original sessionId preserved
    expect(controller.getState().sessionId).toBe("existing-session");
    expect(controller.getState().status).toBe("session_ready");

    controller.dispose();
  });

  test("listSessions passes cursor parameter to connection", async () => {
    const harness = createHarness();
    const listRequests: ListSessionsRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async listSessions(params: ListSessionsRequest) {
        listRequests.push(params);
        return { sessions: [], nextCursor: undefined };
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();

    const result = await controller.listSessions({ cursor: "page-2-cursor" });

    expect(result.sessions).toHaveLength(0);
    expect(listRequests).toHaveLength(1);
    expect(listRequests[0]?.cursor).toBe("page-2-cursor");

    controller.dispose();
  });

  test("_forceResetPromptInFlight clears stuck promptInFlight flag", async () => {
    const harness = createHarness();
    const promptStarted = createDeferred<void>();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        promptStarted.resolve();
        // Never resolve -- simulate a hung agent
        return new Promise<never>(() => {});
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();

    // Start a prompt that will hang forever
    const _promptPromise = controller.prompt({
      prompt: [{ text: "Hello", type: "text" }],
    });
    await promptStarted.promise;

    // Verify that promptInFlight blocks new operations
    expect(controller.getState().status).toBe("prompting");
    await expect(controller.newSession()).rejects.toThrow(
      "Cannot start another operation while a prompt turn is still active",
    );

    // Force reset the flag
    controller._forceResetPromptInFlight();

    // Now newSession should no longer throw about prompt in progress
    // (it may fail for other reasons since the agent is hung, but it
    // should NOT throw "prompt in progress")
    const newSessionPromise = controller.newSession().catch((e) => e);
    const error = await newSessionPromise;
    if (error instanceof Error) {
      expect(error.message).not.toContain("prompt turn is still active");
    }

    controller.dispose();
  }, 5000);

  test("closeSession sends session/close and transitions to ready", async () => {
    const harness = createHarness();
    const closeRequests: CloseSessionRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { close: {} },
          },
        };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async closeSession(params: CloseSessionRequest) {
        closeRequests.push(params);
        return {};
      },
    }));

    const observedEvents: string[] = [];
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.subscribe((event) => {
      observedEvents.push(event.type);
    });

    await controller.initialize();
    await controller.newSession();
    expect(controller.getState().sessionId).toBe("session-1");
    expect(controller.getState().status).toBe("session_ready");

    await controller.closeSession();

    expect(closeRequests).toHaveLength(1);
    expect(closeRequests[0]?.sessionId).toBe("session-1");
    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().sessionId).toBeUndefined();
    expect(observedEvents).toContain("session.closed");

    controller.dispose();
  });

  test("closeSession throws before initialization", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await expect(controller.closeSession()).rejects.toThrow(
      "Call initialize() before using session APIs.",
    );

    controller.dispose();
  });

  test("closeSession throws when no active session", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { close: {} },
          },
        };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await expect(controller.closeSession()).rejects.toThrow("No active session");

    controller.dispose();
  });

  test("forkSession sends session/fork and updates sessionId", async () => {
    const harness = createHarness();
    const forkRequests: ForkSessionRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { fork: {} },
          },
        };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async unstable_forkSession(params: ForkSessionRequest) {
        forkRequests.push(params);
        return {
          sessionId: "forked-session-1",
          modes: {
            availableModes: [{ id: "default", name: "Default" }],
            currentModeId: "default",
          },
        };
      },
    }));

    const observedEvents: string[] = [];
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.subscribe((event) => {
      observedEvents.push(event.type);
    });

    await controller.initialize();
    await controller.newSession();
    const response = await controller.forkSession({
      cwd: "/vault/project",
    });

    expect(response.sessionId).toBe("forked-session-1");
    expect(forkRequests).toHaveLength(1);
    expect(forkRequests[0]?.sessionId).toBe("session-1");
    expect(forkRequests[0]?.cwd).toBe("/vault/project");
    expect(forkRequests[0]?.mcpServers).toEqual([]);
    expect(controller.getState().sessionId).toBe("forked-session-1");
    expect(controller.getState().status).toBe("session_ready");
    expect(observedEvents).toContain("session.forked");

    controller.dispose();
  });

  test("forkSession throws before initialization", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await expect(controller.forkSession({ cwd: "/vault" })).rejects.toThrow(
      "Call initialize() before using session APIs.",
    );

    controller.dispose();
  });

  test("forkSession throws when no active session", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { fork: {} },
          },
        };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await expect(controller.forkSession({ cwd: "/vault" })).rejects.toThrow("No active session");

    controller.dispose();
  });

  test("resumeSession sends session/resume and sets sessionId", async () => {
    const harness = createHarness();
    const resumeRequests: ResumeSessionRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { resume: {} },
          },
        };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async resumeSession(params: ResumeSessionRequest) {
        resumeRequests.push(params);
        return {
          modes: {
            availableModes: [{ id: "default", name: "Default" }],
            currentModeId: "default",
          },
        };
      },
    }));

    const observedEvents: string[] = [];
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.subscribe((event) => {
      observedEvents.push(event.type);
    });

    await controller.initialize();
    const response = await controller.resumeSession({
      sessionId: "old-session-1",
      cwd: "/vault/project",
    });

    expect(response.modes?.currentModeId).toBe("default");
    expect(resumeRequests).toHaveLength(1);
    expect(resumeRequests[0]?.sessionId).toBe("old-session-1");
    expect(resumeRequests[0]?.cwd).toBe("/vault/project");
    expect(resumeRequests[0]?.mcpServers).toEqual([]);
    expect(controller.getState().sessionId).toBe("old-session-1");
    expect(controller.getState().status).toBe("session_ready");
    expect(observedEvents).toContain("session.resumed");

    controller.dispose();
  });

  test("resumeSession throws before initialization", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await expect(controller.resumeSession({ sessionId: "s-1", cwd: "/vault" })).rejects.toThrow(
      "Call initialize() before using session APIs.",
    );

    controller.dispose();
  });

  test("setConfigOption sends session/set_config_option with correct params", async () => {
    const harness = createHarness();
    const configRequests: SetSessionConfigOptionRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async setSessionConfigOption(params: SetSessionConfigOptionRequest) {
        configRequests.push(params);
        return { configOptions: [] };
      },
    }));

    const observedEvents: string[] = [];
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.subscribe((event) => {
      observedEvents.push(event.type);
    });

    await controller.initialize();
    await controller.newSession();
    const optionRequest: SetSessionConfigOptionRequest = {
      configId: "auto_approve",
      sessionId: "session-1",
      type: "boolean",
      value: true,
    };
    const { sessionId: _ignoredSessionId, ...optionRequestWithoutSession } = optionRequest;
    await controller.setConfigOption(optionRequestWithoutSession);

    expect(configRequests).toHaveLength(1);
    expect(configRequests[0]?.configId).toBe("auto_approve");
    expect(configRequests[0]?.sessionId).toBe("session-1");
    expect(observedEvents).toContain("session.config_option_set");

    controller.dispose();
  });

  test("setConfigOption throws before initialization", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    const setRequest1: SetSessionConfigOptionRequest = {
      configId: "test",
      sessionId: "ignored",
      type: "boolean",
      value: true,
    };
    const { sessionId: _id1, ...setRequest1WithoutSession } = setRequest1;
    await expect(controller.setConfigOption(setRequest1WithoutSession)).rejects.toThrow(
      "Call initialize() before using session APIs.",
    );

    controller.dispose();
  });

  test("setConfigOption throws when no active session", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    const setRequest2: SetSessionConfigOptionRequest = {
      configId: "test",
      sessionId: "ignored",
      type: "boolean",
      value: true,
    };
    const { sessionId: _id2, ...setRequest2WithoutSession } = setRequest2;
    await expect(controller.setConfigOption(setRequest2WithoutSession)).rejects.toThrow(
      "No active session",
    );

    controller.dispose();
  });

  test("logout sends logout request and clears auth state", async () => {
    const harness = createHarness();
    const logoutRequests: LogoutRequest[] = [];
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          authMethods: [{ id: "local", name: "Local" }],
        };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async unstable_logout(params: LogoutRequest) {
        logoutRequests.push(params);
        return {};
      },
    }));

    const observedEvents: string[] = [];
    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    controller.subscribe((event) => {
      observedEvents.push(event.type);
    });

    await controller.initialize();
    expect(controller.getState().authMethods).toEqual([{ id: "local", name: "Local" }]);

    await controller.logout();

    expect(logoutRequests).toHaveLength(1);
    expect(controller.getState().authMethods).toBeUndefined();
    expect(controller.getState().status).toBe("ready");
    expect(observedEvents).toContain("logged_out");

    controller.dispose();
  });

  test("logout throws before initialization", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return { protocolVersion: PROTOCOL_VERSION };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await expect(controller.logout()).rejects.toThrow(
      "Call initialize() before using session APIs.",
    );

    controller.dispose();
  });

  test("closeSession throws when agent does not advertise session/close capability", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { list: {} },
          },
        };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();

    await expect(controller.closeSession()).rejects.toThrow("Agent does not support session/close");

    controller.dispose();
  });

  test("closeSession succeeds when agent advertises session/close capability", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { close: {} },
          },
        };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async closeSession() {
        return {};
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();
    await controller.closeSession();

    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().sessionId).toBeUndefined();

    controller.dispose();
  });

  test("forkSession throws when agent does not advertise session/fork capability", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { list: {} },
          },
        };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();

    await expect(controller.forkSession()).rejects.toThrow("Agent does not support session/fork");

    controller.dispose();
  });

  test("resumeSession throws when agent does not advertise session/resume capability", async () => {
    const harness = createHarness();
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            sessionCapabilities: { list: {} },
          },
        };
      },
      async newSession() {
        throw new Error("unexpected newSession");
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();

    await expect(
      controller.resumeSession({ sessionId: "old-session", cwd: "/vault" }),
    ).rejects.toThrow("Agent does not support session/resume");

    controller.dispose();
  });

  test("capability gating throws without sending RPC to agent", async () => {
    const harness = createHarness();
    let closeSessionCalled = false;
    let forkSessionCalled = false;
    let resumeSessionCalled = false;
    startAgent(harness.agentStream, () => ({
      async initialize() {
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {},
        };
      },
      async newSession() {
        return { sessionId: "session-1" };
      },
      async prompt() {
        throw new Error("unexpected prompt");
      },
      async closeSession() {
        closeSessionCalled = true;
        return {};
      },
      async unstable_forkSession() {
        forkSessionCalled = true;
        return { sessionId: "forked" };
      },
      async resumeSession() {
        resumeSessionCalled = true;
        return {};
      },
    }));

    const controller = new ACPClientController({
      adapters: {
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
        sessionUpdate: async () => {},
      },
      dispose: () => {},
      stream: harness.clientStream,
      workspacePolicy: {
        resolveWorkspaceRoot: () => "/vault",
      },
    });

    await controller.initialize();
    await controller.newSession();

    await expect(controller.closeSession()).rejects.toThrow("Agent does not support session/close");
    await expect(controller.forkSession()).rejects.toThrow("Agent does not support session/fork");
    await expect(controller.resumeSession({ sessionId: "old", cwd: "/vault" })).rejects.toThrow(
      "Agent does not support session/resume",
    );

    // Verify no RPCs were sent
    expect(closeSessionCalled).toBe(false);
    expect(forkSessionCalled).toBe(false);
    expect(resumeSessionCalled).toBe(false);

    controller.dispose();
  });
});
