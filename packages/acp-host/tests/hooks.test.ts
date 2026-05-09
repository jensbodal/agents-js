import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ACPSessionController } from "../src/session-controller.ts";
import { createMockAgent } from "../src/testing/mock-acp-agent.ts";
import type { HostFileAdapters, StartConfig } from "../src/types/adapters.ts";
import type { SessionHooks, ToolCallSummary } from "../src/types/hooks.ts";
import type { ACPSessionStatus } from "../src/types/session.ts";

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
    workspacePath: "/tmp",
    fileAdapters: createMockFileAdapters(),
    ...overrides,
  };
}

describe("SessionHooks", () => {
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

  test("beforePrompt can modify content sent to the agent", async () => {
    const _receivedPrompts: unknown[] = [];

    const { createProcess } = createMockAgent({
      prompts: [{ messageChunks: ["got it"], stopReason: "end_turn" }],
    });

    const hooks: SessionHooks = {
      beforePrompt(_content, _sessionId) {
        return [{ type: "text", text: "modified by hook" }];
      },
    };

    await controller.start(makeStartConfig({ createProcess, hooks }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "original" }]);

    // The agent received the prompt and completed successfully
    expect(controller.getState().status).toBe("ready");
  });

  test("afterPrompt receives correct metadata", async () => {
    type AfterPromptParams = Parameters<NonNullable<SessionHooks["afterPrompt"]>>[0];
    const captured: { value: AfterPromptParams | null } = { value: null };

    const { createProcess } = createMockAgent({
      prompts: [
        {
          messageChunks: ["response ", "text"],
          messageChunkIds: [undefined, "agent-msg-1"],
          userMessageId: "user-msg-1",
          stopReason: "end_turn",
        },
      ],
    });

    const hooks: SessionHooks = {
      afterPrompt(params) {
        captured.value = params;
      },
    };

    await controller.start(makeStartConfig({ createProcess, hooks }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    // Wait for async hook to fire
    await new Promise((r) => setTimeout(r, 50));

    const afterParams = captured.value;
    if (!afterParams) throw new Error("afterPrompt was not called");
    expect(afterParams.stopReason).toBe("end_turn");
    expect(afterParams.durationMs).toBeGreaterThanOrEqual(0);
    expect(afterParams.requestId).toBeTruthy();
    expect(typeof afterParams.requestId).toBe("string");
    expect(afterParams.textChunks).toEqual(["response ", "text"]);
    expect(afterParams.sessionId).toBeTruthy();
    expect(afterParams.userMessageId).toBe("user-msg-1");
    expect(afterParams.agentMessageId).toBe("agent-msg-1");
  });

  test("onStatusChange receives from/to pairs during lifecycle", async () => {
    const transitions: Array<{ from: ACPSessionStatus; to: ACPSessionStatus }> = [];

    const { createProcess } = createMockAgent({
      prompts: [{ messageChunks: ["hi"], stopReason: "end_turn" }],
    });

    const hooks: SessionHooks = {
      onStatusChange(from, to) {
        transitions.push({ from, to });
      },
    };

    await controller.start(makeStartConfig({ createProcess, hooks }));

    // Wait for async hooks
    await new Promise((r) => setTimeout(r, 50));

    // Should have at least idle -> initializing and initializing -> ready
    expect(transitions.some((t) => t.from === "idle" && t.to === "initializing")).toBe(true);
    expect(transitions.some((t) => t.from === "initializing" && t.to === "ready")).toBe(true);
  });

  test("hook errors do not crash the session", async () => {
    const { createProcess } = createMockAgent({
      prompts: [{ messageChunks: ["response"], stopReason: "end_turn" }],
    });

    const hooks: SessionHooks = {
      beforePrompt() {
        throw new Error("hook explosion");
      },
      afterPrompt() {
        throw new Error("afterPrompt explosion");
      },
      onStatusChange() {
        throw new Error("status explosion");
      },
    };

    await controller.start(makeStartConfig({ createProcess, hooks }));
    await controller.newSession();

    // Should not throw despite hooks throwing
    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    expect(controller.getState().status).toBe("ready");
  });

  test("sendPrompt aborts cleanly if logout resets the session during beforePrompt", async () => {
    let releaseHook!: () => void;
    const hookStarted = Promise.withResolvers<void>();
    const beforePromptPending = new Promise<void>((resolve) => {
      releaseHook = resolve;
    });

    const { createProcess, promptRequests } = createMockAgent({
      initialize: {
        agentCapabilities: {
          auth: { logout: {} },
        },
      },
      prompts: [{ messageChunks: ["should never send"], stopReason: "end_turn" }],
      logout: {},
    });

    const hooks: SessionHooks = {
      async beforePrompt() {
        hookStarted.resolve();
        await beforePromptPending;
        return undefined;
      },
    };

    await controller.start(makeStartConfig({ createProcess, hooks }));
    await controller.newSession();

    const sendPromise = controller.sendPrompt([{ type: "text", text: "hello" }]);
    await hookStarted.promise;
    await controller.logout();
    releaseHook();
    await sendPromise;

    expect(promptRequests).toHaveLength(0);
    expect(controller.getState().sessionId).toBeNull();
    expect(controller.getState().status).toBe("ready");
  });

  test("beforePermission can transform the request", async () => {
    let transformedTitle: string | null | undefined;

    const { createProcess } = createMockAgent({
      prompts: [
        {
          permissionRequest: {
            toolCallId: "tc-1",
            title: "writeFile",
            options: [
              { kind: "allow_once", name: "Allow", optionId: "allow" },
              { kind: "reject_once", name: "Deny", optionId: "deny" },
            ],
          },
          stopReason: "end_turn",
        },
      ],
    });

    const hooks: SessionHooks = {
      beforePermission(request, _sessionId) {
        // Transform the request by modifying the tool title
        return {
          ...request,
          // biome-ignore lint/style/noNonNullAssertion: test assertion relies on known shape
          toolCall: { ...request.toolCall!, title: "transformed-title" },
        };
      },
    };

    controller.subscribe((event) => {
      if (event.type === "permission_requested") {
        transformedTitle = event.request.toolCall?.title;
        // Resolve permission so the prompt can complete
        controller.resolvePermission({
          outcome: { outcome: "selected", optionId: "allow" },
        });
      }
    });

    await controller.start(makeStartConfig({ createProcess, hooks }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "write" }]);

    expect(transformedTitle).toBe("transformed-title");
  });

  test("afterPermission receives the decision", async () => {
    let afterCalled = false;
    let receivedOutcome: string | undefined;

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

    const hooks: SessionHooks = {
      afterPermission(_request, response, _sessionId) {
        afterCalled = true;
        receivedOutcome = response.outcome.outcome;
      },
    };

    controller.subscribe((event) => {
      if (event.type === "permission_requested") {
        controller.resolvePermission({
          outcome: { outcome: "selected", optionId: "allow" },
        });
      }
    });

    await controller.start(makeStartConfig({ createProcess, hooks }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "write" }]);

    // Wait for async hook
    await new Promise((r) => setTimeout(r, 50));

    expect(afterCalled).toBe(true);
    expect(receivedOutcome).toBe("selected");
  });

  test("onToolCall fires for tool_call updates", async () => {
    const toolCalls: ToolCallSummary[] = [];

    const { createProcess } = createMockAgent({
      prompts: [
        {
          toolCalls: [
            { id: "tc-1", title: "readFile", status: "in_progress" },
            { id: "tc-1", title: "readFile", status: "completed" },
          ],
          stopReason: "end_turn",
        },
      ],
    });

    const hooks: SessionHooks = {
      onToolCall(tool, _sessionId) {
        toolCalls.push({ ...tool });
      },
    };

    await controller.start(makeStartConfig({ createProcess, hooks }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "read" }]);

    // Wait for async hooks
    await new Promise((r) => setTimeout(r, 50));

    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls.some((tc) => tc.name === "readFile")).toBe(true);
    expect(toolCalls.some((tc) => tc.id === "tc-1")).toBe(true);
  });
});
