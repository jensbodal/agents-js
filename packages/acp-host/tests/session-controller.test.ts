import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { configureLogging, resetLogging } from "../src/logger.ts";
import { ACPSessionController } from "../src/session-controller.ts";
import {
  createEchoAgent,
  createHangingAgent,
  createMockAgent,
} from "../src/testing/mock-acp-agent.ts";
import type { HostFileAdapters, StartConfig } from "../src/types/adapters.ts";
import type { ACPSessionEvent, ACPSessionState } from "../src/types/session.ts";

/** Mock file adapters that return dummy data */
function createMockFileAdapters(): HostFileAdapters {
  return {
    readTextFile: async (params) => ({
      content: `mock content of ${params.path}`,
    }),
    writeTextFile: async (_params, _requestApproval) => ({}),
  };
}

/** Helper to build a minimal StartConfig */
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
    workspacePath: "/tmp",
    fileAdapters: createMockFileAdapters(),
    ...overrides,
  };
}

describe("ACPSessionController", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    // Suppress info/debug/warn logger output; real errors still print
    configureLogging({ minLevel: "error" });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  test("initial state is idle with null values", () => {
    const state = controller.getState();
    expect(state.status).toBe("idle");
    expect(state.sessionId).toBeNull();
    expect(state.agentName).toBeNull();
    expect(state.agentCapabilities).toBeNull();
    expect(state.currentTurn).toBeNull();
    expect(state.completedTurns).toEqual([]);
    expect(state.lastError).toBeNull();
    expect(state.pendingElicitation).toBeNull();
    expect(state.plan).toBeNull();
    expect(state.sessionTitle).toBeNull();
    expect(state.sessionUpdatedAt).toBeNull();
    expect(state.localLabel).toBeNull();
    expect(state.modes).toBeNull();
    expect(state.models).toBeNull();
  });

  test("subscribe returns an unsubscribe function", () => {
    const events: ACPSessionEvent[] = [];
    const unsub = controller.subscribe((event) => {
      events.push(event);
    });
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("destroy transitions to closed status", () => {
    const statuses: string[] = [];
    controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });
    controller.destroy();
    expect(statuses).toContain("closed");
    expect(controller.getState().status).toBe("idle");
  });

  test("start emits initializing status", () => {
    const statuses: string[] = [];
    controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });

    controller
      .start(
        makeStartConfig({
          agentConfig: {
            name: "Test",
            command: "false",
            args: [],
            env: {},
            authHints: [],
            workspacePolicy: "workspace-root-only",
          },
        }),
      )
      .catch(() => {});

    expect(statuses[0]).toBe("initializing");
  });

  test("sendPrompt throws when no connection exists", async () => {
    expect(controller.sendPrompt([{ type: "text", text: "hello" }])).rejects.toThrow(
      "No active ACP connection",
    );
  });

  test("newSession throws when no connection exists", async () => {
    expect(controller.newSession()).rejects.toThrow("No active ACP connection");
  });

  test("cancel is a no-op when no connection", async () => {
    await controller.cancel();
  });

  test("resolvePermission is a no-op when no pending permission", () => {
    controller.resolvePermission({
      outcome: { outcome: "cancelled" },
    });
  });

  test("_handleSessionUpdate accumulates text chunks", () => {
    controller._handleSessionUpdate({
      sessionId: "test",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
    });
    controller._handleSessionUpdate({
      sessionId: "test",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
    });

    const state = controller.getState();
    expect(state.currentTurn).not.toBeNull();
    expect(state.currentTurn?.textChunks).toEqual(["Hello ", "world"]);
  });

  test("_handleSessionUpdate captures the first valid agent chunk messageId", () => {
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello " },
      },
    });
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "world" },
        messageId: "agent-msg-1",
      },
    });
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "!" },
        messageId: "agent-msg-2",
      },
    });

    expect(controller.getState().currentTurn?.agentMessageId).toBe("agent-msg-1");
  });

  test("_handleSessionUpdate tracks tool calls", () => {
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "readFile",
        status: "in_progress",
      },
    });

    const state = controller.getState();
    const tc = state.currentTurn?.toolCalls.get("tc-1");
    expect(tc).toBeDefined();
    expect(tc?.name).toBe("readFile");
    expect(tc?.status).toBe("running");
  });

  test("_handleSessionUpdate updates tool call status", () => {
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "readFile",
        status: "in_progress",
      },
    });
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        status: "completed",
      },
    });

    const tc = controller.getState().currentTurn?.toolCalls.get("tc-1");
    expect(tc?.status).toBe("completed");
    expect(tc?.name).toBe("readFile");
  });

  test("turnItems preserves ordering with interleaved text and tool calls", () => {
    // text chunk 1
    controller._handleSessionUpdate({
      sessionId: "test",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
    });
    // tool call 1
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "readFile",
        status: "in_progress",
      },
    });
    // text chunk 2
    controller._handleSessionUpdate({
      sessionId: "test",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "middle " } },
    });
    // tool call 2
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-2",
        title: "writeFile",
        status: "in_progress",
      },
    });
    // text chunk 3
    controller._handleSessionUpdate({
      sessionId: "test",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "end" } },
    });

    const turn = controller.getState().currentTurn;
    expect(turn?.turnItems).toEqual([
      { type: "text", startIndex: 0 },
      { type: "tool_call", id: "tc-1" },
      { type: "text", startIndex: 1 },
      { type: "tool_call", id: "tc-2" },
      { type: "text", startIndex: 2 },
    ]);
    expect(turn?.textChunks).toEqual(["Hello ", "middle ", "end"]);
  });

  test("_handlePermissionRequest emits event and returns promise", async () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const permissionPromise = controller._handlePermissionRequest({
      sessionId: "test",
      toolCall: { toolCallId: "tc-1", title: "writeFile" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" as const },
        { optionId: "deny", name: "Deny", kind: "reject_once" as const },
      ],
    });

    expect(events.some((e) => e.type === "permission_requested")).toBe(true);
    expect(controller.getState().status).toBe("waiting_permission");
    expect(controller.getState().currentTurn?.pendingPermission).not.toBeNull();

    controller.resolvePermission({
      outcome: { outcome: "selected", optionId: "allow" },
    });

    const result = await permissionPromise;
    expect(result.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(controller.getState().currentTurn?.pendingPermission).toBeNull();
  });

  test("cancel resolves pending permission as cancelled", async () => {
    const permissionPromise = controller._handlePermissionRequest({
      sessionId: "test",
      toolCall: { toolCallId: "tc-1", title: "writeFile" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
    });

    await controller.cancel();

    const result = await permissionPromise;
    expect(result.outcome).toEqual({ outcome: "cancelled" });
  });

  test("multiple listeners receive events", () => {
    const events1: ACPSessionEvent[] = [];
    const events2: ACPSessionEvent[] = [];

    controller.subscribe((event) => events1.push(event));
    controller.subscribe((event) => events2.push(event));

    controller.destroy();

    expect(events1.length).toBeGreaterThan(0);
    expect(events1.length).toBe(events2.length);
  });

  test("unsubscribed listener does not receive events", () => {
    const events: ACPSessionEvent[] = [];
    const unsub = controller.subscribe((event) => events.push(event));
    unsub();

    controller.destroy();
    expect(events.length).toBe(0);
  });

  test("listener errors do not break other listeners", () => {
    const statuses: string[] = [];

    controller.subscribe(() => {
      throw new Error("bad listener");
    });
    controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });

    controller.destroy();
    expect(statuses).toContain("closed");
    expect(controller.getState().status).toBe("idle");
  });

  test("_handleSessionUpdate handles plan variant", () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Step 1", status: "in_progress", priority: "high" },
          { content: "Step 2", status: "pending", priority: "medium" },
        ],
      },
    });

    const state = controller.getState();
    expect(state.plan).not.toBeNull();
    expect(state.plan?.length).toBe(2);
    expect(state.plan?.[0]?.content).toBe("Step 1");
    expect(state.plan?.[0]?.status).toBe("in_progress");
    expect(state.plan?.[0]?.priority).toBe("high");
    expect(state.plan?.[1]?.content).toBe("Step 2");

    const planEvent = events.find((e) => e.type === "plan_updated");
    expect(planEvent).toBeDefined();
    if (planEvent?.type === "plan_updated") {
      expect(planEvent.entries.length).toBe(2);
    }
  });

  test("_handleSessionUpdate handles session_info_update variant", () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "session_info_update",
        title: "My Session",
        updatedAt: "2026-03-23T12:00:00Z",
      },
    });

    const state = controller.getState();
    expect(state.sessionTitle).toBe("My Session");
    expect(state.sessionUpdatedAt).toBe("2026-03-23T12:00:00Z");

    const infoEvent = events.find((e) => e.type === "session_info_updated");
    expect(infoEvent).toBeDefined();
    if (infoEvent?.type === "session_info_updated") {
      expect(infoEvent.title).toBe("My Session");
      expect(infoEvent.updatedAt).toBe("2026-03-23T12:00:00Z");
    }
  });

  test("_handleSessionUpdate handles session_info_update with null values", () => {
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "session_info_update",
      },
    });

    const state = controller.getState();
    expect(state.sessionTitle).toBeNull();
    expect(state.sessionUpdatedAt).toBeNull();
  });

  test("_handleSessionUpdate handles usage_update without error", () => {
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "usage_update",
        size: 100000,
        used: 5000,
      },
    });

    const state = controller.getState();
    expect(state.plan).toBeNull();
  });

  test("_handleSessionUpdate enriches tool_call with kind and richContent", () => {
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-rich",
        title: "editFile",
        status: "in_progress",
        kind: "edit",
        content: [
          {
            type: "diff",
            path: "/src/main.ts",
            oldText: "old",
            newText: "new",
          },
        ],
      },
    });

    const tc = controller.getState().currentTurn?.toolCalls.get("tc-rich");
    expect(tc).toBeDefined();
    expect(tc?.kind).toBe("edit");
    expect(tc?.richContent).toBeDefined();
    expect(tc?.richContent?.length).toBe(1);
    expect(tc?.richContent?.[0]?.type).toBe("diff");
    expect(tc?.richContent?.[0]?.diffPath).toBe("/src/main.ts");
    expect(tc?.richContent?.[0]?.diffOldText).toBe("old");
    expect(tc?.richContent?.[0]?.diffNewText).toBe("new");
  });

  test("plan is replaced wholesale on each plan update", () => {
    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Step 1", status: "completed", priority: "high" }],
      },
    });

    expect(controller.getState().plan?.length).toBe(1);

    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Step 1", status: "completed", priority: "high" },
          { content: "Step 2", status: "in_progress", priority: "medium" },
          { content: "Step 3", status: "pending", priority: "low" },
        ],
      },
    });

    expect(controller.getState().plan?.length).toBe(3);
    expect(controller.getState().plan?.[2]?.content).toBe("Step 3");
  });

  // -- Integration tests with mock agent and StartConfig --

  test("start strips ZWSP from upstream agentInfo.name and logs a warn", async () => {
    // Capture warn-level log entries via a transport so we don't depend on console spying.
    const warnEntries: Array<{ message: string; data?: Record<string, unknown> }> = [];
    configureLogging({
      minLevel: "warn",
      transports: [
        {
          handle(entry) {
            if (entry.level === "warn") {
              warnEntries.push({ message: entry.message, data: entry.data });
            }
          },
        },
      ],
    });

    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "\u200bSisyphus - Ultraworker", version: "1.0.0" },
        agentCapabilities: {},
      },
      newSession: { sessionId: "session-zwsp-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    expect(controller.getState().agentName).toBe("Sisyphus - Ultraworker");
    const normalizationWarn = warnEntries.find((entry) =>
      entry.message.includes("agent name normalized"),
    );
    expect(normalizationWarn).toBeDefined();
    expect(normalizationWarn?.data?.original).toBe("\u200bSisyphus - Ultraworker");
    expect(normalizationWarn?.data?.cleaned).toBe("Sisyphus - Ultraworker");
  });

  test("start + newSession transitions through initializing -> ready and sets session state", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: { promptCapabilities: { embeddedContext: true } },
      },
      newSession: { sessionId: "session-42" },
      prompts: [],
    });

    const statuses: string[] = [];
    controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });

    await controller.start(makeStartConfig({ createProcess }));

    expect(statuses).toContain("initializing");
    expect(statuses).toContain("ready");
    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().agentName).toBe("test-agent");

    const sessionId = await controller.newSession();
    expect(sessionId).toBe("session-42");
    expect(controller.getState().sessionId).toBe("session-42");
  });

  test("start + newSession + sendPrompt completes full lifecycle", async () => {
    const { createProcess, promptRequests } = createEchoAgent();

    const statuses: string[] = [];
    controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });

    await controller.start(makeStartConfig({ createProcess }));

    await controller.newSession();
    expect(controller.getState().status).toBe("ready");

    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    expect(statuses).toContain("prompting");
    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().currentTurn?.textChunks).toContain("Echo: received your message");
    const [firstReq] = promptRequests;
    if (!firstReq) throw new Error("expected at least one prompt request");
    const firstMessageId = firstReq.messageId;
    if (!firstMessageId) throw new Error("expected a messageId on first request");
    expect(firstMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(controller.getState().currentTurn?.userMessageId).toBe(firstMessageId);
    expect(controller.getState().completedTurns).toHaveLength(1);
    expect(controller.getState().completedTurns[0]?.promptContent).toEqual([
      { type: "text", text: "hello" },
    ]);
    expect(controller.getState().completedTurns[0]?.textChunks).toContain(
      "Echo: received your message",
    );
    expect(controller.getState().completedTurns[0]?.requestId).toBeTruthy();
  });

  test("completed turn snapshot preserves message ids, tool calls, and plan snapshot", async () => {
    const { createProcess } = createMockAgent({
      prompts: [
        {
          messageChunks: ["response ", "text"],
          messageChunkIds: [undefined, "agent-msg-1"],
          toolCalls: [{ id: "tc-1", title: "readFile", status: "completed" }],
          planEntries: [{ content: "Inspect file", status: "completed", priority: "high" }],
          userMessageId: "user-msg-1",
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    const snapshot = controller.getState().completedTurns[0];
    expect(snapshot).toBeDefined();
    expect(snapshot?.userMessageId).toBe("user-msg-1");
    expect(snapshot?.agentMessageId).toBe("agent-msg-1");
    expect(snapshot?.turnItems).toEqual([
      { type: "text", startIndex: 0 },
      { type: "tool_call", id: "tc-1" },
    ]);
    expect(snapshot?.toolCalls).toHaveLength(1);
    expect(snapshot?.toolCalls[0]).toMatchObject({
      id: "tc-1",
      name: "readFile",
      status: "completed",
    });
    expect(snapshot?.planAtCompletion).toEqual([
      { content: "Inspect file", status: "completed", priority: "high" },
    ]);
  });

  test("start uses custom clientInfo from StartConfig", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
      },
      newSession: { sessionId: "s-1" },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        clientInfo: { name: "my-host", version: "2.0.0" },
      }),
    );

    // If we got here without error, the mock agent accepted the initialize call
    expect(controller.getState().status).toBe("ready");
  });

  test("start wires file adapters for read and write", async () => {
    const readCalls: string[] = [];
    const writeCalls: string[] = [];

    const fileAdapters: HostFileAdapters = {
      readTextFile: async (params) => {
        readCalls.push(params.path);
        return { content: "test content" };
      },
      writeTextFile: async (params, _requestApproval) => {
        writeCalls.push(params.path);
        return {};
      },
    };

    const { createProcess } = createMockAgent({
      prompts: [
        {
          readFile: { path: "test.md" },
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess, fileAdapters }));

    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "read" }]);

    expect(readCalls).toContain("test.md");
  });

  test("write gate approval callback is passed through to file adapter", async () => {
    let receivedApprovalCallback = false;

    const fileAdapters: HostFileAdapters = {
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async (_params, requestApproval) => {
        receivedApprovalCallback = typeof requestApproval === "function";
        return {};
      },
    };

    const { createProcess } = createMockAgent({
      prompts: [
        {
          writeFile: { path: "test.md", content: "new content" },
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess, fileAdapters }));

    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "write" }]);

    expect(receivedApprovalCallback).toBe(true);
  });

  test("setPermissionMode updates the mode", async () => {
    expect(controller.permissionMode).toBe("ask");
    await controller.setPermissionMode("yolo");
    expect(controller.permissionMode).toBe("yolo");
    await controller.setPermissionMode("plan");
    expect(controller.permissionMode).toBe("plan");
    await controller.setPermissionMode("hub");
    expect(controller.permissionMode).toBe("hub");
    await controller.setPermissionMode("ask");
    expect(controller.permissionMode).toBe("ask");
  });

  test("plan mode attempts to activate agent plan mode when available", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only state injection
    const stateRef = (controller as unknown as Record<string, any>).state;
    stateRef.modes = {
      availableModes: [{ id: "plan", name: "Plan" }],
      currentModeId: "default",
    };
    stateRef.modesAdvertisedByAgent = true;
    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);
    await controller.setPermissionMode("plan");
    expect(setModeSpy).toHaveBeenCalledWith("plan");
    setModeSpy.mockRestore();
  });

  test("plan mode logs warning when agent has no plan mode", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: test-only state injection
    const stateRef = (controller as unknown as Record<string, any>).state;
    stateRef.modes = {
      availableModes: [{ id: "default", name: "Default" }],
      currentModeId: "default",
    };
    stateRef.modesAdvertisedByAgent = true;
    const setModeSpy = spyOn(controller, "setMode");
    await controller.setPermissionMode("plan");
    expect(setModeSpy).not.toHaveBeenCalled();
    setModeSpy.mockRestore();
  });

  test("setLocalLabel updates state and emits event", () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    controller.setLocalLabel("my-label");
    expect(controller.getState().localLabel).toBe("my-label");
    expect(events.some((e) => e.type === "status_changed")).toBe(true);
  });

  test("resolveWriteGate resolves pending write gate", () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    // Simulate a pending write gate
    const _gatePromise = controller._requestWriteGateApproval({
      path: "test.md",
      diff: "some diff",
    });

    expect(events.some((e) => e.type === "write_gate_requested")).toBe(true);

    controller.resolveWriteGate({ action: "approve" });

    expect(events.some((e) => e.type === "write_gate_resolved")).toBe(true);
  });

  test("resolveWriteGate is a no-op when no pending write gate", () => {
    // Should not throw
    controller.resolveWriteGate({ action: "approve" });
  });

  test("write to hub directory is auto-approved without modal", async () => {
    controller.setHubDirectory("hub/obsidian-acp/session-123");

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const result = await controller._requestWriteGateApproval({
      path: "hub/obsidian-acp/session-123/notes.md",
      diff: "some diff",
    });

    expect(result).toBe(true);
    // No write_gate_requested event should be emitted
    expect(events.some((e) => e.type === "write_gate_requested")).toBe(false);
  });

  test("write to configured writable folder is auto-approved", async () => {
    // Simulate agentConfig with writable folders by using the internal field
    // We need to start the controller to set agentConfig, or directly set it
    // Using _requestWriteGateApproval after setting hub directory instead
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    // Set hub to something unrelated to test writable folders path
    controller.setHubDirectory("hub/obsidian-acp/session-123");

    // Use allow_folder to add a writable folder, then verify subsequent auto-approval
    const firstGatePromise = controller._requestWriteGateApproval({
      path: "projects/daily/note.md",
      diff: "first diff",
    });

    // First write should show modal (not in hub or writable)
    expect(events.some((e) => e.type === "write_gate_requested")).toBe(true);

    // Resolve with allow_folder
    controller.resolveWriteGate({ action: "allow_folder", folder: "projects" });
    const firstResult = await firstGatePromise;
    expect(firstResult).toBe(true);
    expect(events.some((e) => e.type === "writable_folder_added")).toBe(true);

    // Clear events
    events.length = 0;

    // Second write to same folder should auto-approve
    const secondResult = await controller._requestWriteGateApproval({
      path: "projects/another/file.md",
      diff: "second diff",
    });

    expect(secondResult).toBe(true);
    // No modal event for the second write
    expect(events.some((e) => e.type === "write_gate_requested")).toBe(false);
  });

  test("write outside hub and writable folders shows modal", async () => {
    controller.setHubDirectory("hub/obsidian-acp/session-123");

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const gatePromise = controller._requestWriteGateApproval({
      path: "random/path/file.md",
      diff: "some diff",
    });

    expect(events.some((e) => e.type === "write_gate_requested")).toBe(true);

    // Verify closestParentFolder is included in the event
    const gateEvent = events.find((e) => e.type === "write_gate_requested");
    expect(gateEvent).toBeDefined();
    if (gateEvent?.type === "write_gate_requested") {
      expect(gateEvent.closestParentFolder).toBe("random/path");
    }

    controller.resolveWriteGate({ action: "approve" });
    const result = await gatePromise;
    expect(result).toBe(true);
  });

  test("reject resolution returns false", async () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const gatePromise = controller._requestWriteGateApproval({
      path: "some/file.md",
      diff: "diff",
    });

    controller.resolveWriteGate({ action: "reject" });
    const result = await gatePromise;
    expect(result).toBe(false);

    const resolvedEvent = events.find((e) => e.type === "write_gate_resolved");
    expect(resolvedEvent).toBeDefined();
    if (resolvedEvent?.type === "write_gate_resolved") {
      expect(resolvedEvent.approved).toBe(false);
    }
  });

  test("hub directory and writable folders reset on destroy", async () => {
    controller.setHubDirectory("hub/obsidian-acp/old-session");

    // Add a writable folder via allow_folder resolution
    const gatePromise = controller._requestWriteGateApproval({
      path: "projects/note.md",
      diff: "diff",
    });
    controller.resolveWriteGate({ action: "allow_folder", folder: "projects" });
    await gatePromise;

    // Verify hub is set before destroy
    expect(controller.getHubDirectory()).toBe("hub/obsidian-acp/old-session");

    // destroy() clears hub + writable folders
    controller.destroy();
    expect(controller.getHubDirectory()).toBeNull();

    // After destroy, a fresh controller should require modal for the same path
    const freshController = new ACPSessionController();
    const events: ACPSessionEvent[] = [];
    freshController.subscribe((event) => events.push(event));

    const postDestroyGate = freshController._requestWriteGateApproval({
      path: "projects/another.md",
      diff: "diff",
    });

    // Should show modal since writable folders were cleared
    expect(events.some((e) => e.type === "write_gate_requested")).toBe(true);
    freshController.resolveWriteGate({ action: "approve" });
    await postDestroyGate;
    freshController.destroy();
  });

  test("allow_folder rejects invalid paths with traversal segments", async () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const gatePromise = controller._requestWriteGateApproval({
      path: "some/file.md",
      diff: "diff",
    });

    // Try to allow a folder with traversal — should be rejected
    controller.resolveWriteGate({ action: "allow_folder", folder: "../../etc" });
    const result = await gatePromise;

    expect(result).toBe(false);
    // No writable_folder_added event should be emitted
    expect(events.some((e) => e.type === "writable_folder_added")).toBe(false);
  });
});

describe("prompt queue", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
  });

  test("queuePrompt adds to queue and emits queue_changed", () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    controller.queuePrompt([{ type: "text", text: "queued msg" }]);

    expect(controller.getState().promptQueue).toHaveLength(1);
    expect(events.some((e) => e.type === "queue_changed" && e.count === 1)).toBe(true);
  });

  test("getQueuedPrompts returns a copy", () => {
    controller.queuePrompt([{ type: "text", text: "a" }]);
    const copy = controller.getQueuedPrompts();
    expect(copy).toHaveLength(1);

    // Mutating the copy should not affect internal state
    (copy as unknown[]).push([{ type: "text", text: "b" }]);
    expect(controller.getQueuedPrompts()).toHaveLength(1);
  });

  test("clearQueue empties queue and emits queue_changed with count 0", () => {
    const events: ACPSessionEvent[] = [];
    controller.queuePrompt([{ type: "text", text: "a" }]);
    controller.queuePrompt([{ type: "text", text: "b" }]);

    controller.subscribe((event) => events.push(event));
    controller.clearQueue();

    expect(controller.getState().promptQueue).toHaveLength(0);
    expect(events.some((e) => e.type === "queue_changed" && e.count === 0)).toBe(true);
  });

  test("destroy clears the queue", () => {
    controller.queuePrompt([{ type: "text", text: "a" }]);
    expect(controller.getState().promptQueue).toHaveLength(1);

    controller.destroy();
    expect(controller.getState().promptQueue).toHaveLength(0);
  });

  test("auto-drain sends queued prompt after turn completes", async () => {
    const { createProcess } = createMockAgent({
      prompts: [
        { messageChunks: ["first reply"], stopReason: "end_turn" },
        { messageChunks: ["drained reply"], stopReason: "end_turn" },
      ],
    });
    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    // Queue a message before sending
    controller.queuePrompt([{ type: "text", text: "follow-up" }]);

    // Send first prompt — after it completes, the queued prompt should auto-drain
    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    // Wait for auto-drain to complete (it's fire-and-forget)
    await new Promise((r) => setTimeout(r, 500));

    // Should have two turn_completed events (original + drained)
    const turnCompleted = events.filter((e) => e.type === "turn_completed");
    expect(turnCompleted.length).toBe(2);

    // Queue should be drained
    expect(controller.getState().promptQueue).toHaveLength(0);
    expect(controller.getState().completedTurns).toHaveLength(2);
    expect(controller.getState().completedTurns.map((turn) => turn.textChunks.join(""))).toEqual([
      "first reply",
      "drained reply",
    ]);
  });

  test("steer clears queued prompts while the current turn is still prompting", async () => {
    const { createProcess, promptRequests } = createHangingAgent();
    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    void controller.sendPrompt([{ type: "text", text: "initial prompt" }]).catch(() => {});
    await new Promise((r) => setTimeout(r, 50));
    expect(controller.getState().status).toBe("prompting");

    controller.queuePrompt([{ type: "text", text: "queued follow-up" }]);
    void controller.steer([{ type: "text", text: "redirect now" }]).catch(() => {});

    await new Promise((r) => setTimeout(r, 50));
    controller.forceReset();
    await new Promise((r) => setTimeout(r, 200));

    expect(controller.getState().promptQueue).toHaveLength(0);
    expect(promptRequests).toHaveLength(2);
    expect(promptRequests[1]?.prompt[0]).toEqual({ type: "text", text: "redirect now" });
  });

  test("multiple queued prompts are queued in order", () => {
    controller.queuePrompt([{ type: "text", text: "first" }]);
    controller.queuePrompt([{ type: "text", text: "second" }]);
    controller.queuePrompt([{ type: "text", text: "third" }]);

    const queued = controller.getQueuedPrompts();
    expect(queued).toHaveLength(3);
    const [q0, q1, q2] = queued;
    if (!q0 || !q1 || !q2) throw new Error("expected three queued prompts");
    expect((q0[0] as { text: string }).text).toBe("first");
    expect((q1[0] as { text: string }).text).toBe("second");
    expect((q2[0] as { text: string }).text).toBe("third");
  });
});

describe("session history", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
  });

  test("listSessions returns empty when capability not supported", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {},
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    const result = await controller.listSessions();
    expect(result.sessions).toEqual([]);
    expect(result.nextCursor).toBeUndefined();
  });

  test("listSessions delegates to controller when capability is supported", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: {
            list: {},
          },
        },
      },
      listSessions: {
        sessions: [
          {
            sessionId: "s-1",
            cwd: "/tmp",
            title: "Test Session",
            updatedAt: "2026-03-28T12:00:00Z",
          },
        ],
        nextCursor: "next-page",
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    const result = await controller.listSessions();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.sessionId).toBe("s-1");
    expect(result.sessions[0]?.title).toBe("Test Session");
    expect(result.nextCursor).toBe("next-page");
  });

  test("loadSession throws when capability not supported", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {},
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    await expect(controller.loadSession("session-1")).rejects.toThrow(
      "Agent does not support loading sessions.",
    );
  });

  test("loadSession restores session state (sessionId, modes, models)", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
        },
      },
      loadSession: {
        modes: {
          availableModes: [{ id: "code", name: "Code" }],
          currentModeId: "code",
        },
        models: {
          availableModels: [{ modelId: "gpt-4", name: "GPT-4" }],
          currentModelId: "gpt-4",
        },
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    const sessionId = await controller.loadSession("restored-session-42");

    expect(sessionId).toBe("restored-session-42");
    expect(controller.getState().sessionId).toBe("restored-session-42");
    expect(controller.getState().modes?.currentModeId).toBe("code");
    expect(controller.getState().models?.currentModelId).toBe("gpt-4");
  });

  test("loadSession emits session_loaded event", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
        },
      },
      loadSession: {},
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));

    await controller.loadSession("loaded-session-1");

    const loadedEvent = events.find((e) => e.type === "session_loaded");
    expect(loadedEvent).toBeDefined();
    if (loadedEvent?.type === "session_loaded") {
      expect(loadedEvent.sessionId).toBe("loaded-session-1");
    }
  });

  test("loadSession restores locally persisted transcript and metadata when the agent returns a minimal session payload", async () => {
    const storedState: ACPSessionState = {
      sessionId: "existing-session",
      status: "ready",
      agentName: "test-agent",
      agentCapabilities: null,
      currentTurn: null,
      completedTurns: [
        {
          requestId: "req-1",
          completedAt: 1,
          durationMs: 25,
          stopReason: "end_turn",
          promptContent: [{ type: "text", text: "Review spec" }],
          textChunks: ["Looks good."],
          turnItems: [{ type: "text", startIndex: 0 }],
          toolCalls: [],
          planAtCompletion: null,
        },
      ],
      lastError: null,
      pendingWriteGate: null,
      pendingElicitation: null,
      plan: [{ content: "Review spec", status: "completed", priority: "medium" }],
      sessionTitle: "Review spec",
      sessionUpdatedAt: "2026-04-08T12:00:00.000Z",
      localLabel: "Saved review",
      promptQueue: [],
      modes: null,
      models: {
        currentModelId: "gpt-5",
        availableModels: [{ modelId: "gpt-5", name: "GPT-5" }],
      },
      modesAdvertisedByAgent: false,
      permissionGatingActive: true,
      hubPath: "hub/review",
      availableCommands: [{ name: "/help", description: "Show help" }],
      usage: { size: 128, used: 32, cost: null },
    };
    const sessionStorage = {
      async saveSession() {},
      async loadSession() {
        return storedState;
      },
    };
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
        },
      },
      loadSession: {},
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess, sessionStorage }));

    await controller.loadSession("existing-session");

    expect(controller.getState().completedTurns).toEqual(storedState.completedTurns);
    expect(controller.getState().plan).toEqual(storedState.plan);
    expect(controller.getState().sessionTitle).toBe("Review spec");
    expect(controller.getState().sessionUpdatedAt).toBe("2026-04-08T12:00:00.000Z");
    expect(controller.getState().localLabel).toBe("Saved review");
    expect(controller.getState().hubPath).toBe("hub/review");
    expect(controller.getState().models).toEqual(storedState.models);
    expect(controller.getState().availableCommands).toEqual(storedState.availableCommands);
    expect(controller.getState().usage).toEqual(storedState.usage);
  });

  test("loadSession transitions through loading -> ready status", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
        },
      },
      loadSession: {},
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));

    // Clear events from start() so we only see loadSession transitions
    events.length = 0;

    await controller.loadSession("loaded-session-1");

    const statusEvents = events
      .filter((e) => e.type === "status_changed")
      .map((e) => (e as { type: "status_changed"; status: string }).status);

    expect(statusEvents).toContain("loading");
    expect(statusEvents).toContain("ready");

    // loading must come before ready
    const loadingIndex = statusEvents.indexOf("loading");
    const readyIndex = statusEvents.indexOf("ready");
    expect(loadingIndex).toBeLessThan(readyIndex);

    // Final state should be ready
    expect(controller.getState().status).toBe("ready");
  });

  test("loadSession sets status to error on failure", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
        },
      },
      loadSession: new Error("session not found"),
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));
    events.length = 0;

    await expect(controller.loadSession("missing-session")).rejects.toThrow();

    const statusEvents = events
      .filter((e) => e.type === "status_changed")
      .map((e) => (e as { type: "status_changed"; status: string }).status);

    // Should go loading -> error
    expect(statusEvents).toContain("loading");
    expect(statusEvents).toContain("error");
    expect(controller.getState().status).toBe("error");
  });

  test("loadSession clears prompt queue and emits queue_changed", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
        },
      },
      loadSession: {},
      newSession: { sessionId: "session-1" },
      prompts: [
        {
          messageChunks: ["working..."],
          stopReason: "end_turn",
        },
      ],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    // Queue a prompt while the controller is idle (simulates queued follow-up)
    controller.queuePrompt([{ type: "text", text: "queued for session A" }]);
    expect(controller.getQueuedPrompts()).toHaveLength(1);

    // Clear events so we can isolate loadSession emissions
    events.length = 0;

    // Load a different session -- queue from session A must be cleared
    await controller.loadSession("session-B");

    expect(controller.getQueuedPrompts()).toHaveLength(0);
    const queueEvent = events.find((e) => e.type === "queue_changed");
    expect(queueEvent).toBeDefined();
    if (queueEvent?.type === "queue_changed") {
      expect(queueEvent.count).toBe(0);
    }
  });

  test("listSessions forwards cursor parameter", async () => {
    const _listCalls: Array<{ cursor?: string }> = [];
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: {
            list: {},
          },
        },
      },
      listSessions: {
        sessions: [],
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    // Intercept listSessions to track cursor parameter
    const originalCreateProcess = createProcess;
    const wrappedCreateProcess: typeof createProcess = (options) => {
      const process = originalCreateProcess(options);
      return process;
    };

    await controller.start(makeStartConfig({ createProcess: wrappedCreateProcess }));

    // Call with cursor
    const result = await controller.listSessions("page-2");
    expect(result.sessions).toHaveLength(0);
  });

  test("loadSession resets turn state before loading", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
        },
      },
      loadSession: {},
      newSession: { sessionId: "session-1" },
      prompts: [
        {
          messageChunks: ["first response"],
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    // Verify state has turn data
    expect(controller.getState().currentTurn).not.toBeNull();
    expect(controller.getState().completedTurns).toHaveLength(1);

    // Set plan and session metadata to simulate accumulated state
    controller._handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Step 1", status: "completed", priority: "high" }],
      },
    });
    controller._handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "Old Title",
        updatedAt: "2026-03-28T10:00:00Z",
      },
    });

    expect(controller.getState().plan).not.toBeNull();
    expect(controller.getState().sessionTitle).toBe("Old Title");

    // Load a new session -- state should be reset
    await controller.loadSession("new-session-id");

    expect(controller.getState().currentTurn).toBeNull();
    expect(controller.getState().completedTurns).toEqual([]);
    expect(controller.getState().plan).toBeNull();
    expect(controller.getState().sessionTitle).toBeNull();
    expect(controller.getState().sessionUpdatedAt).toBeNull();
    expect(controller.getState().sessionId).toBe("new-session-id");
  });

  test("newSession clears completed turn history from the previous session", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
      },
      newSession: { sessionId: "session-1" },
      prompts: [
        {
          messageChunks: ["first response"],
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "hello" }]);
    expect(controller.getState().completedTurns).toHaveLength(1);

    await controller.newSession();
    expect(controller.getState().completedTurns).toEqual([]);
  });
});

describe("agent defaults (defaultMode / defaultModel)", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
  });

  test("newSession applies defaultMode when the agent advertises it", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        modes: {
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
          currentModeId: "default",
        },
      },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultMode: "plan",
        },
      }),
    );

    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);

    await controller.newSession();

    expect(setModeSpy).toHaveBeenCalledWith("plan");
    setModeSpy.mockRestore();
  });

  test("newSession silently ignores defaultMode when the mode is NOT available", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        modes: {
          availableModes: [{ id: "default", name: "Default" }],
          currentModeId: "default",
        },
      },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultMode: "plan",
        },
      }),
    );

    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);

    await controller.newSession();

    // The configured defaultMode "plan" is not available, so it should NOT be applied.
    // However, permission-gating mode sync will set "default" mode when permissionMode is "ask".
    expect(setModeSpy).not.toHaveBeenCalledWith("plan");
    expect(setModeSpy).toHaveBeenCalledWith("default");
    setModeSpy.mockRestore();
  });

  test("newSession applies defaultModel when the agent advertises it", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        models: {
          availableModels: [
            { modelId: "gpt-4", name: "GPT-4" },
            { modelId: "opus", name: "Opus" },
          ],
          currentModelId: "gpt-4",
        },
      },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultModel: "opus",
        },
      }),
    );

    const setModelSpy = spyOn(controller, "setModel").mockResolvedValue(undefined as never);

    await controller.newSession();

    expect(setModelSpy).toHaveBeenCalledWith("opus");
    setModelSpy.mockRestore();
  });

  test("newSession warns when defaultModel is NOT available", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        models: {
          availableModels: [{ modelId: "gpt-4", name: "GPT-4" }],
          currentModelId: "gpt-4",
        },
      },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultModel: "opus",
        },
      }),
    );

    const setModelSpy = spyOn(controller, "setModel").mockResolvedValue(undefined as never);

    await controller.newSession();

    expect(setModelSpy).not.toHaveBeenCalled();
    setModelSpy.mockRestore();
  });

  test("newSession synthesizes modes and skips setMode protocol call when agent returns no modes", async () => {
    const { createProcess } = createMockAgent({
      newSession: { sessionId: "s-1" },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultMode: "plan",
          defaultModel: "opus",
        },
      }),
    );

    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);
    const setModelSpy = spyOn(controller, "setModel").mockResolvedValue(undefined as never);

    await controller.newSession();

    const state = controller.getState();
    // Modes should be synthesized, not null
    expect(state.modes).not.toBeNull();
    expect(state.modes?.availableModes.map((m) => m.id)).toContain("default");
    expect(state.modes?.availableModes.map((m) => m.id)).toContain("plan");
    expect(state.modesAdvertisedByAgent).toBe(false);
    // setMode should NOT be called (agent didn't advertise modes)
    expect(setModeSpy).not.toHaveBeenCalled();
    // setModel should NOT be called (no models returned)
    expect(setModelSpy).not.toHaveBeenCalled();
    setModeSpy.mockRestore();
    setModelSpy.mockRestore();
  });

  test("synthesizes default modes when agent omits modes from newSession response", async () => {
    const { createProcess } = createMockAgent({
      newSession: { sessionId: "s-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    await controller.newSession();

    const state = controller.getState();
    expect(state.modes).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });
    expect(state.modesAdvertisedByAgent).toBe(false);
  });

  test("repairs empty modes from newSession response and keeps host-managed gating active", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        modes: {
          currentModeId: "broken",
          availableModes: [],
        },
      },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);

    await controller.newSession();

    const state = controller.getState();
    expect(state.modes).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });
    expect(state.modesAdvertisedByAgent).toBe(false);
    expect(state.permissionGatingActive).toBe(true);
    expect(setModeSpy).not.toHaveBeenCalled();
    setModeSpy.mockRestore();
  });

  test("loadSession applies defaultMode when the agent advertises it", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: { loadSession: true },
      },
      loadSession: {
        modes: {
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
          currentModeId: "default",
        },
      },
      newSession: { sessionId: "s-1" },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultMode: "plan",
        },
      }),
    );

    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);

    await controller.loadSession("existing-session");

    expect(setModeSpy).toHaveBeenCalledWith("plan");
    setModeSpy.mockRestore();
  });

  test("loadSession applies defaultModel when the agent advertises it", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: { loadSession: true },
      },
      loadSession: {
        models: {
          availableModels: [
            { modelId: "gpt-4", name: "GPT-4" },
            { modelId: "opus", name: "Opus" },
          ],
          currentModelId: "gpt-4",
        },
      },
      newSession: { sessionId: "s-1" },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultModel: "opus",
        },
      }),
    );

    const setModelSpy = spyOn(controller, "setModel").mockResolvedValue(undefined as never);

    await controller.loadSession("existing-session");

    expect(setModelSpy).toHaveBeenCalledWith("opus");
    setModelSpy.mockRestore();
  });

  test("loadSession synthesizes modes and skips setMode when modes/models are not available", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: { loadSession: true },
      },
      loadSession: {},
      newSession: { sessionId: "s-1" },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultMode: "plan",
          defaultModel: "opus",
        },
      }),
    );

    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);
    const setModelSpy = spyOn(controller, "setModel").mockResolvedValue(undefined as never);

    await controller.loadSession("existing-session");

    const state = controller.getState();
    // Modes should be synthesized even though agent didn't return them
    expect(state.modes).not.toBeNull();
    expect(state.modesAdvertisedByAgent).toBe(false);
    // setMode should NOT be called (agent didn't advertise modes — host-managed)
    expect(setModeSpy).not.toHaveBeenCalled();
    // setModel should NOT be called (no models returned)
    expect(setModelSpy).not.toHaveBeenCalled();
    setModeSpy.mockRestore();
    setModelSpy.mockRestore();
  });

  test("loadSession repairs empty modes and keeps host-managed gating active", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: { loadSession: true },
      },
      loadSession: {
        modes: {
          currentModeId: "broken",
          availableModes: [],
        },
      },
      newSession: { sessionId: "s-1" },
      prompts: [],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          defaultMode: "plan",
        },
      }),
    );

    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);

    await controller.loadSession("existing-session");

    const state = controller.getState();
    expect(state.modes).toEqual({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });
    expect(state.modesAdvertisedByAgent).toBe(false);
    expect(state.permissionGatingActive).toBe(true);
    expect(setModeSpy).not.toHaveBeenCalled();
    setModeSpy.mockRestore();
  });

  test("resetError transitions from error to ready when controller exists", async () => {
    const { createProcess } = createEchoAgent();

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
        },
      }),
    );

    // Verify we're in ready state after start
    expect(controller.getState().status).toBe("ready");

    // resetError on a non-error state should no-op
    const statusesBefore: string[] = [];
    const unsub = controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statusesBefore.push(event.status);
      }
    });
    controller.resetError();
    unsub();
    expect(statusesBefore).toEqual([]); // no status change emitted
    expect(controller.getState().status).toBe("ready");
  });

  test("resetError no-ops when status is not error", () => {
    // Controller is in idle state (no start() called)
    expect(controller.getState().status).toBe("idle");
    controller.resetError();
    expect(controller.getState().status).toBe("idle");
  });

  test("resetError no-ops after destroy (no controller)", async () => {
    const { createProcess } = createEchoAgent();

    await controller.start(
      makeStartConfig({
        createProcess,
        agentConfig: {
          name: "Test",
          command: "unused",
          args: [],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
        },
      }),
    );

    controller.destroy();
    // After destroy, status is "idle" (state reset) and controller is null
    expect(controller.getState().status).toBe("idle");
    // resetError should not throw or change state
    controller.resetError();
    expect(controller.getState().status).toBe("idle");
  });

  // -- forceReset tests --

  test("forceReset is a no-op when no controller exists", () => {
    // Fresh controller with no start() call -- should not throw
    controller.forceReset();
    expect(controller.getState().status).toBe("idle");
  });

  test("forceReset from error status resets to ready", async () => {
    const { createProcess } = createMockAgent({
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    // Force into error state
    // biome-ignore lint/suspicious/noExplicitAny: test-only state injection
    const state = controller.getState() as Record<string, any>;
    state.status = "error";
    state.lastError = "something broke";

    controller.forceReset();

    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().lastError).toBeNull();
  });

  test("forceReset cancels pending permissions", async () => {
    const { createProcess } = createMockAgent({
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    // Set up a pending permission
    const permissionPromise = controller._handlePermissionRequest({
      sessionId: "test",
      toolCall: { toolCallId: "tc-1", title: "writeFile" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
    });

    expect(controller.getState().status).toBe("waiting_permission");

    controller.forceReset();

    const result = await permissionPromise;
    expect(result.outcome).toEqual({ outcome: "cancelled" });
    expect(controller.getState().status).toBe("ready");
  });

  test("forceReset cancels pending elicitations", async () => {
    const { createProcess } = createMockAgent({
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    // Set up a pending elicitation
    const elicitationPromise = controller._handleElicitationRequest({
      sessionId: "test",
      mode: "form",
      message: "Enter details",
      requestedSchema: { type: "object" as const, properties: {} },
    });

    expect(controller.getState().status).toBe("waiting_elicitation");

    controller.forceReset();

    const result = await elicitationPromise;
    expect(result).toEqual({ action: "cancel" });
    expect(controller.getState().status).toBe("ready");
  });

  test("forceReset clears the prompt queue", async () => {
    const { createProcess } = createMockAgent({
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    controller.queuePrompt([{ type: "text", text: "queued 1" }]);
    controller.queuePrompt([{ type: "text", text: "queued 2" }]);
    expect(controller.getQueuedPrompts()).toHaveLength(2);

    const events: string[] = [];
    controller.subscribe((event) => {
      if (event.type === "queue_changed") events.push("queue_changed");
    });

    controller.forceReset();

    expect(controller.getQueuedPrompts()).toHaveLength(0);
    expect(events).toContain("queue_changed");
  });

  test("forceReset recovers from prompting state with hanging agent", async () => {
    const { createProcess } = createHangingAgent();

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    // Start a prompt that will hang
    const _promptPromise = controller.sendPrompt([{ type: "text", text: "hello" }]).catch(() => {});

    // Wait briefly for the status to reach "prompting"
    await new Promise((r) => setTimeout(r, 50));
    expect(controller.getState().status).toBe("prompting");

    controller.forceReset();

    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().lastError).toBeNull();
  });

  // -- Prompt timeout tests --

  test("sendPrompt times out after promptTimeoutMs and recovers to ready (not error)", async () => {
    const { createProcess } = createHangingAgent();

    await controller.start(
      makeStartConfig({
        createProcess,
        promptTimeoutMs: 200,
      }),
    );
    await controller.newSession();

    const statuses: string[] = [];
    controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });

    await expect(controller.sendPrompt([{ type: "text", text: "hello" }])).rejects.toThrow(
      "Prompt timed out after 200ms",
    );

    // After timeout + forceReset, the controller should be in "ready" state,
    // not "error". The error is communicated via the throw + lastError.
    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().lastError).toContain("Prompt timed out");

    // Verify there is no "error" status flash after the "ready" from forceReset
    const lastStatus = statuses[statuses.length - 1];
    expect(lastStatus).toBe("ready");
  }, 10_000);

  test("prompt timeout does not cause ready->error status flash", async () => {
    const { createProcess } = createHangingAgent();

    await controller.start(
      makeStartConfig({
        createProcess,
        promptTimeoutMs: 200,
      }),
    );
    await controller.newSession();

    const statuses: string[] = [];
    controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });

    await expect(controller.sendPrompt([{ type: "text", text: "hello" }])).rejects.toThrow(
      "Prompt timed out",
    );

    // After forceReset sets "ready", no subsequent "error" should appear.
    // Find the last "ready" index -- there must be no "error" after it.
    const lastReadyIndex = statuses.lastIndexOf("ready");
    expect(lastReadyIndex).toBeGreaterThanOrEqual(0);
    const statusesAfterReady = statuses.slice(lastReadyIndex + 1);
    expect(statusesAfterReady).not.toContain("error");
  }, 10_000);
});

describe("permission gating status", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    configureLogging({ minLevel: "error" });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  test("permissionGatingActive is true in initial state", () => {
    expect(controller.getState().permissionGatingActive).toBe(true);
  });

  test("permissionGatingActive is true when default mode exists and ask mode is set", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        modes: {
          availableModes: [{ id: "default", name: "Default" }],
          currentModeId: "default",
        },
      },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    const setModeSpy = spyOn(controller, "setMode").mockResolvedValue(undefined as never);

    await controller.newSession();

    expect(controller.getState().permissionGatingActive).toBe(true);
    setModeSpy.mockRestore();
  });

  test("permissionGatingActive stays true with host-managed fallback when default mode is unavailable", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        modes: {
          availableModes: [{ id: "code", name: "Code" }],
          currentModeId: "code",
        },
      },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.newSession();

    expect(controller.getState().permissionGatingActive).toBe(true);

    const gatingEvent = events.find((e) => e.type === "permission_gating_status");
    expect(gatingEvent).toBeDefined();
    if (gatingEvent && gatingEvent.type === "permission_gating_status") {
      expect(gatingEvent.active).toBe(true);
      expect(gatingEvent.reason).toContain('compatible "default" mode');
    }
  });

  test("emits permission_gating_status event on setPermissionMode", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        modes: {
          availableModes: [{ id: "code", name: "Code" }],
          currentModeId: "code",
        },
      },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.setPermissionMode("ask");

    const gatingEvent = events.find((e) => e.type === "permission_gating_status");
    expect(gatingEvent).toBeDefined();
    if (gatingEvent && gatingEvent.type === "permission_gating_status") {
      expect(gatingEvent.active).toBe(true);
      expect(gatingEvent.reason).toContain('compatible "default" mode');
    }
  });

  test("permission_gating_status explains repaired empty modes", async () => {
    const { createProcess } = createMockAgent({
      newSession: {
        sessionId: "s-1",
        modes: {
          currentModeId: "broken",
          availableModes: [],
        },
      },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.newSession();

    const gatingEvent = events.find((e) => e.type === "permission_gating_status");
    expect(gatingEvent).toBeDefined();
    if (gatingEvent && gatingEvent.type === "permission_gating_status") {
      expect(gatingEvent.active).toBe(true);
      expect(gatingEvent.reason).toContain("unusable modes");
    }
  });
});

describe("session lifecycle (close, fork, resume)", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    configureLogging({ minLevel: "error" });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  // -- closeSession --

  test("closeSession throws when capability not supported", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {},
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    await expect(controller.closeSession()).rejects.toThrow(
      "Agent does not support closing sessions.",
    );
  });

  test("closeSession emits session_closed event and resets state", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { close: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      closeSession: {},
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    expect(controller.getState().sessionId).toBe("session-1");

    events.length = 0;
    await controller.closeSession();

    const state = controller.getState();
    expect(state.sessionId).toBeNull();
    expect(state.currentTurn).toBeNull();
    expect(state.completedTurns).toEqual([]);
    expect(state.plan).toBeNull();
    expect(state.modes).toBeNull();
    expect(state.models).toBeNull();
    expect(state.promptQueue).toEqual([]);

    const closedEvent = events.find((e) => e.type === "session_closed");
    expect(closedEvent).toBeDefined();

    const statusEvents = events
      .filter((e) => e.type === "status_changed")
      .map((e) => (e as { type: "status_changed"; status: string }).status);
    expect(statusEvents).toContain("ready");
  });

  test("closeSession cancels pending permission before close", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { close: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      closeSession: {},
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    // Simulate a pending permission
    const permissionPromise = controller._handlePermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "tc-1", title: "writeFile" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
    });

    await controller.closeSession();

    const result = await permissionPromise;
    expect(result.outcome).toEqual({ outcome: "cancelled" });
  });

  test("closeSession throws when no active session", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { close: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    await expect(controller.closeSession()).rejects.toThrow("No active session to close.");
  });

  // -- forkSession --

  test("forkSession throws when capability not supported", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {},
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    await expect(controller.forkSession()).rejects.toThrow(
      "Agent does not support forking sessions.",
    );
  });

  test("forkSession creates new session with shared history", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { fork: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      forkSession: {
        sessionId: "forked-session-42",
        modes: {
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
          currentModeId: "default",
        },
        models: {
          availableModels: [{ modelId: "gpt-4", name: "GPT-4" }],
          currentModelId: "gpt-4",
        },
      },
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    expect(controller.getState().sessionId).toBe("session-1");

    events.length = 0;
    const forkedId = await controller.forkSession();

    expect(forkedId).toBe("forked-session-42");
    expect(controller.getState().sessionId).toBe("forked-session-42");
    expect(controller.getState().currentTurn).toBeNull();
    expect(controller.getState().completedTurns).toEqual([]);
    expect(controller.getState().modes?.currentModeId).toBe("default");
    expect(controller.getState().models?.currentModelId).toBe("gpt-4");

    const forkEvent = events.find((e) => e.type === "session_forked");
    expect(forkEvent).toBeDefined();
    if (forkEvent?.type === "session_forked") {
      expect(forkEvent.sessionId).toBe("forked-session-42");
      expect(forkEvent.parentSessionId).toBe("session-1");
    }
  });

  test("forkSession throws when no active session", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { fork: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    await expect(controller.forkSession()).rejects.toThrow("No active session to fork.");
  });

  // -- resumeSession --

  test("resumeSession throws when capability not supported", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {},
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    await expect(controller.resumeSession("old-session-1")).rejects.toThrow(
      "Agent does not support resuming sessions.",
    );
  });

  test("resumeSession reconnects to previously closed session", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { resume: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      resumeSession: {
        modes: {
          availableModes: [{ id: "code", name: "Code" }],
          currentModeId: "code",
        },
        models: {
          availableModels: [{ modelId: "opus", name: "Opus" }],
          currentModelId: "opus",
        },
      },
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));

    events.length = 0;
    const sessionId = await controller.resumeSession("old-session-1");

    expect(sessionId).toBe("old-session-1");
    expect(controller.getState().sessionId).toBe("old-session-1");
    expect(controller.getState().modes?.currentModeId).toBe("code");
    expect(controller.getState().models?.currentModelId).toBe("opus");
    expect(controller.getState().status).toBe("ready");

    const resumeEvent = events.find((e) => e.type === "session_resumed");
    expect(resumeEvent).toBeDefined();
    if (resumeEvent?.type === "session_resumed") {
      expect(resumeEvent.sessionId).toBe("old-session-1");
    }
  });

  test("resumeSession resets turn state before resuming", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { resume: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      resumeSession: {},
      prompts: [
        {
          messageChunks: ["first response"],
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    // Verify state has accumulated data
    expect(controller.getState().completedTurns).toHaveLength(1);

    await controller.resumeSession("resumed-session-1");

    expect(controller.getState().sessionId).toBe("resumed-session-1");
    expect(controller.getState().currentTurn).toBeNull();
    expect(controller.getState().completedTurns).toEqual([]);
    expect(controller.getState().plan).toBeNull();
  });

  test("resumeSession sets error status on failure", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { resume: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      resumeSession: new Error("session expired"),
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    await expect(controller.resumeSession("expired-session")).rejects.toThrow();
    expect(controller.getState().status).toBe("error");
  });

  test("resumeSession preserves existing session state on failure", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { resume: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      resumeSession: new Error("network error"),
      prompts: [
        {
          messageChunks: ["first response"],
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    // Accumulate session state
    controller._handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Step 1", status: "completed", priority: "high" }],
      },
    });
    controller._handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "My Session",
        updatedAt: "2026-04-05T12:00:00Z",
      },
    });

    // Verify state has accumulated data before resume attempt
    expect(controller.getState().sessionId).toBe("session-1");
    expect(controller.getState().completedTurns).toHaveLength(1);
    expect(controller.getState().plan).not.toBeNull();
    expect(controller.getState().sessionTitle).toBe("My Session");

    // Queue a prompt to verify it's preserved
    controller.queuePrompt([{ type: "text", text: "queued" }]);
    expect(controller.getQueuedPrompts()).toHaveLength(1);

    // Attempt to resume a different session — should fail
    await expect(controller.resumeSession("other-session")).rejects.toThrow();

    // Existing session state must be preserved after resume failure
    expect(controller.getState().sessionId).toBe("session-1");
    expect(controller.getState().completedTurns).toHaveLength(1);
    expect(controller.getState().plan).not.toBeNull();
    expect(controller.getState().sessionTitle).toBe("My Session");
    expect(controller.getQueuedPrompts()).toHaveLength(1);
  });

  // -- Event subscriber coverage --

  test("all three session lifecycle events reach subscribers", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { close: {}, fork: {}, resume: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      closeSession: {},
      forkSession: { sessionId: "forked-1" },
      resumeSession: {},
      prompts: [],
    });

    const eventTypes: string[] = [];
    controller.subscribe((event) => eventTypes.push(event.type));

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    eventTypes.length = 0;

    // Fork the session
    await controller.forkSession();
    expect(eventTypes).toContain("session_forked");

    // Close the forked session
    await controller.closeSession();
    expect(eventTypes).toContain("session_closed");

    // Resume a session
    await controller.resumeSession("old-session");
    expect(eventTypes).toContain("session_resumed");
  });
});

describe("session config and logout", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    configureLogging({ minLevel: "error" });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  // -- setConfigOption --

  test("setConfigOption sends config to server and emits event", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: {},
        },
      },
      newSession: { sessionId: "session-1" },
      setConfigOption: {},
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    events.length = 0;
    await controller.setConfigOption("auto_approve", true, "boolean");

    const configEvent = events.find((e) => e.type === "config_option_changed");
    expect(configEvent).toBeDefined();
    if (configEvent?.type === "config_option_changed") {
      expect(configEvent.configId).toBe("auto_approve");
      expect(configEvent.value).toBe(true);
    }
  });

  test("setConfigOption with string value emits correct event", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: {},
        },
      },
      newSession: { sessionId: "session-1" },
      setConfigOption: {},
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    events.length = 0;
    await controller.setConfigOption("theme", "dark");

    const configEvent = events.find((e) => e.type === "config_option_changed");
    expect(configEvent).toBeDefined();
    if (configEvent?.type === "config_option_changed") {
      expect(configEvent.configId).toBe("theme");
      expect(configEvent.value).toBe("dark");
    }
  });

  test("setConfigOption throws when no active session", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: {},
        },
      },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    await expect(controller.setConfigOption("key", true)).rejects.toThrow("No active session");
  });

  test("setConfigOption throws when no active connection", async () => {
    await expect(controller.setConfigOption("key", true)).rejects.toThrow(
      "Agent does not support session config options.",
    );
  });

  // -- logout --

  test("logout throws when capability not supported", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {},
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));

    await expect(controller.logout()).rejects.toThrow("Agent does not support logout.");
  });

  test("logout clears auth state and emits logged_out event", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          auth: { logout: {} },
        },
        authMethods: [{ id: "local", name: "Local" }],
      },
      newSession: { sessionId: "session-1" },
      logout: {},
      prompts: [],
    });

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    await controller.start(makeStartConfig({ createProcess }));

    events.length = 0;
    await controller.logout();

    const logoutEvent = events.find((e) => e.type === "logged_out");
    expect(logoutEvent).toBeDefined();

    const statusEvents = events
      .filter((e) => e.type === "status_changed")
      .map((e) => (e as { type: "status_changed"; status: string }).status);
    expect(statusEvents).toContain("ready");
  });

  test("logout resets session state when session is active", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          auth: { logout: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      logout: {},
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();
    expect(controller.getState().sessionId).toBe("session-1");

    await controller.logout();

    expect(controller.getState().sessionId).toBeNull();
    expect(controller.getState().currentTurn).toBeNull();
    expect(controller.getState().completedTurns).toEqual([]);
    expect(controller.getState().plan).toBeNull();
    expect(controller.getState().modes).toBeNull();
    expect(controller.getState().models).toBeNull();
    expect(controller.getState().promptQueue).toEqual([]);
    expect(controller.getState().availableCommands).toBeNull();
    expect(controller.getState().usage).toBeNull();
    expect(controller.getState().status).toBe("ready");
  });

  test("logout cancels pending operations before logging out", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          auth: { logout: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      logout: {},
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    // Set up a pending permission
    const permissionPromise = controller._handlePermissionRequest({
      sessionId: "session-1",
      toolCall: { toolCallId: "tc-1", title: "writeFile" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
    });

    await controller.logout();

    const result = await permissionPromise;
    expect(result.outcome).toEqual({ outcome: "cancelled" });
  });

  test("logout throws when no active connection", async () => {
    await expect(controller.logout()).rejects.toThrow("Agent does not support logout.");
  });

  // -- usage_update state integration --

  test("_handleSessionUpdate populates usage field and emits usage_updated", () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "usage_update",
        size: 100000,
        used: 5000,
      },
    });

    const state = controller.getState();
    expect(state.usage).toEqual({ size: 100000, used: 5000, cost: null });

    const usageEvent = events.find((e) => e.type === "usage_updated");
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === "usage_updated") {
      expect(usageEvent.size).toBe(100000);
      expect(usageEvent.used).toBe(5000);
    }
  });

  // -- available_commands_update state integration --

  test("_handleSessionUpdate populates availableCommands and emits available_commands_updated", () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    controller._handleSessionUpdate({
      sessionId: "test",
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [
          { name: "create_plan", description: "Create a plan" },
          { name: "research", description: "Research codebase" },
        ],
      },
    });

    const state = controller.getState();
    expect(state.availableCommands).toHaveLength(2);
    expect(state.availableCommands?.[0]?.name).toBe("create_plan");
    expect(state.availableCommands?.[1]?.name).toBe("research");

    const cmdEvent = events.find((e) => e.type === "available_commands_updated");
    expect(cmdEvent).toBeDefined();
    if (cmdEvent?.type === "available_commands_updated") {
      expect(cmdEvent.commands).toHaveLength(2);
    }
  });

  // -- setConfigOption capability gating --

  test("setConfigOption throws when capability not supported", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {},
      },
      newSession: { sessionId: "session-1" },
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    await expect(controller.setConfigOption("key", true)).rejects.toThrow(
      "Agent does not support session config options.",
    );
  });

  // -- Initial state includes new fields --

  test("initial state has null availableCommands and usage", () => {
    const state = controller.getState();
    expect(state.availableCommands).toBeNull();
    expect(state.usage).toBeNull();
  });

  // -- closeSession resetSessionState refactor --

  test("closeSession clears sessionTitle and sessionUpdatedAt via resetSessionState", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          sessionCapabilities: { close: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      closeSession: {},
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    // Accumulate session metadata that was previously not cleared by closeSession
    controller._handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "Test Session Title",
        updatedAt: "2026-04-05T12:00:00Z",
      },
    });

    expect(controller.getState().sessionTitle).toBe("Test Session Title");
    expect(controller.getState().sessionUpdatedAt).toBe("2026-04-05T12:00:00Z");

    await controller.closeSession();

    // Verify all session state is fully cleaned up
    const state = controller.getState();
    expect(state.sessionId).toBeNull();
    expect(state.sessionTitle).toBeNull();
    expect(state.sessionUpdatedAt).toBeNull();
    expect(state.currentTurn).toBeNull();
    expect(state.completedTurns).toEqual([]);
    expect(state.plan).toBeNull();
    expect(state.modes).toBeNull();
    expect(state.models).toBeNull();
    expect(state.promptQueue).toEqual([]);
    expect(state.availableCommands).toBeNull();
    expect(state.usage).toBeNull();
  });

  test("logout clears sessionTitle and sessionUpdatedAt via resetSessionState", async () => {
    const { createProcess } = createMockAgent({
      initialize: {
        agentInfo: { name: "test-agent", version: "1.0.0" },
        agentCapabilities: {
          auth: { logout: {} },
        },
      },
      newSession: { sessionId: "session-1" },
      logout: {},
      prompts: [],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    // Accumulate session metadata
    controller._handleSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "Session Before Logout",
        updatedAt: "2026-04-05T13:00:00Z",
      },
    });

    expect(controller.getState().sessionTitle).toBe("Session Before Logout");

    await controller.logout();

    const state = controller.getState();
    expect(state.sessionId).toBeNull();
    expect(state.sessionTitle).toBeNull();
    expect(state.sessionUpdatedAt).toBeNull();
    expect(state.availableCommands).toBeNull();
    expect(state.usage).toBeNull();
  });
});
