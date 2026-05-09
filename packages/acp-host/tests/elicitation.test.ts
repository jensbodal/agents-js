import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configureLogging, resetLogging } from "../src/logger.ts";
import { ACPSessionController } from "../src/session-controller.ts";
import { createMockAgent } from "../src/testing/mock-acp-agent.ts";
import type {
  HostElicitationAdapter,
  HostFileAdapters,
  StartConfig,
} from "../src/types/adapters.ts";
import type { ACPSessionEvent, ACPSessionStatus } from "../src/types/session.ts";

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

const FORM_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const, description: "Your name" },
  },
};

describe("ACPSessionController elicitation", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    configureLogging({ minLevel: "silent" });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  test("initial state has pendingElicitation null", () => {
    expect(controller.getState().pendingElicitation).toBeNull();
  });

  test("resolveElicitation is a no-op when no pending elicitation", () => {
    // Should not throw
    controller.resolveElicitation({
      action: "cancel",
    });
  });

  test("_handleElicitationRequest emits event and transitions to waiting_elicitation", async () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const elicitationPromise = controller._handleElicitationRequest({
      sessionId: "test",
      mode: "form",
      message: "Enter your name",
      requestedSchema: FORM_SCHEMA,
    });

    expect(events.some((e) => e.type === "elicitation_requested")).toBe(true);
    expect(controller.getState().status).toBe("waiting_elicitation");
    expect(controller.getState().pendingElicitation).not.toBeNull();
    expect(controller.getState().pendingElicitation?.request.message).toBe("Enter your name");

    // Resolve to unblock
    controller.resolveElicitation({
      action: "accept",
      content: { name: "Alice" },
    });

    const result = await elicitationPromise;
    expect(result.action).toBe("accept");
    expect(controller.getState().pendingElicitation).toBeNull();
  });

  test("resolveElicitation with accept resolves promise and transitions back to prompting", async () => {
    const statuses: ACPSessionStatus[] = [];
    controller.subscribe((event) => {
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });

    const elicitationPromise = controller._handleElicitationRequest({
      sessionId: "test",
      mode: "form",
      message: "Confirm?",
      requestedSchema: FORM_SCHEMA,
    });

    expect(statuses).toContain("waiting_elicitation");

    controller.resolveElicitation({
      action: "accept",
      content: { name: "Bob" },
    });

    const result = await elicitationPromise;
    expect(result).toEqual({ action: "accept", content: { name: "Bob" } });
    expect(statuses).toContain("prompting");
    expect(controller.getState().pendingElicitation).toBeNull();
  });

  test("resolveElicitation with decline resolves promise correctly", async () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const elicitationPromise = controller._handleElicitationRequest({
      sessionId: "test",
      mode: "form",
      message: "Want to proceed?",
      requestedSchema: FORM_SCHEMA,
    });

    controller.resolveElicitation({
      action: "decline",
    });

    const result = await elicitationPromise;
    expect(result.action).toBe("decline");

    const resolvedEvent = events.find((e) => e.type === "elicitation_resolved");
    expect(resolvedEvent).toBeDefined();
    if (resolvedEvent?.type === "elicitation_resolved") {
      expect(resolvedEvent.action).toBe("decline");
    }
  });

  test("resolveElicitation with cancel resolves promise correctly", async () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const elicitationPromise = controller._handleElicitationRequest({
      sessionId: "test",
      mode: "form",
      message: "Input needed",
      requestedSchema: FORM_SCHEMA,
    });

    controller.resolveElicitation({
      action: "cancel",
    });

    const result = await elicitationPromise;
    expect(result.action).toBe("cancel");

    const resolvedEvent = events.find((e) => e.type === "elicitation_resolved");
    expect(resolvedEvent).toBeDefined();
    if (resolvedEvent?.type === "elicitation_resolved") {
      expect(resolvedEvent.action).toBe("cancel");
    }
  });

  test("cancel() resolves pending elicitation as cancel", async () => {
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const elicitationPromise = controller._handleElicitationRequest({
      sessionId: "test",
      mode: "form",
      message: "Enter value",
      requestedSchema: FORM_SCHEMA,
    });

    await controller.cancel();

    const result = await elicitationPromise;
    expect(result.action).toBe("cancel");
    expect(controller.getState().pendingElicitation).toBeNull();

    const resolvedEvent = events.find((e) => e.type === "elicitation_resolved");
    expect(resolvedEvent).toBeDefined();
    if (resolvedEvent?.type === "elicitation_resolved") {
      expect(resolvedEvent.action).toBe("cancel");
    }
  });

  test("destroy() resolves pending elicitation as cancel", async () => {
    const elicitationPromise = controller._handleElicitationRequest({
      sessionId: "test",
      mode: "form",
      message: "Enter value",
      requestedSchema: FORM_SCHEMA,
    });

    controller.destroy();

    const result = await elicitationPromise;
    expect(result.action).toBe("cancel");
  });

  test("host-provided elicitation adapter is called directly", async () => {
    const adapterCalls: string[] = [];
    const adapter: HostElicitationAdapter = {
      request: async (params) => {
        adapterCalls.push(params.message);
        return { action: "accept", content: { answer: "42" } };
      },
    };

    const events: ACPSessionEvent[] = [];
    controller.subscribe((event) => events.push(event));

    const { createProcess } = createMockAgent({
      prompts: [
        {
          messageChunks: ["thinking..."],
          elicitationRequest: {
            mode: "form",
            message: "What is the answer?",
            requestedSchema: FORM_SCHEMA,
          },
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess, elicitation: adapter }));
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "hello" }]);

    expect(adapterCalls).toContain("What is the answer?");
    expect(events.some((e) => e.type === "elicitation_requested")).toBe(true);
    // With a custom adapter, the session controller does NOT set pendingElicitation
    expect(controller.getState().pendingElicitation).toBeNull();
  });

  // -- Integration tests: full lifecycle with mock agent --

  test("elicitation request during prompt transitions state, resolveElicitation completes turn", async () => {
    const { createProcess } = createMockAgent({
      prompts: [
        {
          messageChunks: ["Before elicitation"],
          elicitationRequest: {
            mode: "form",
            message: "Please confirm",
            requestedSchema: FORM_SCHEMA,
          },
          stopReason: "end_turn",
        },
      ],
    });

    const statuses: ACPSessionStatus[] = [];
    const events: ACPSessionEvent[] = [];
    controller.subscribe((event, _state) => {
      events.push(event);
      if (event.type === "status_changed") {
        statuses.push(event.status);
      }
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    // Start prompt -- will block on elicitation
    const promptDone = controller.sendPrompt([{ type: "text", text: "do it" }]);

    // Wait for elicitation to appear
    await waitFor(() => controller.getState().pendingElicitation !== null, 2000);

    expect(controller.getState().status).toBe("waiting_elicitation");
    expect(controller.getState().pendingElicitation?.request.message).toBe("Please confirm");

    // Resolve the elicitation
    controller.resolveElicitation({
      action: "accept",
      content: { name: "yes" },
    });

    // Prompt should complete
    await promptDone;

    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().pendingElicitation).toBeNull();
    expect(statuses).toContain("waiting_elicitation");
    expect(statuses).toContain("prompting");
    expect(statuses).toContain("ready");
  });

  test("elicitation decline during prompt completes turn", async () => {
    const { createProcess } = createMockAgent({
      prompts: [
        {
          elicitationRequest: {
            mode: "form",
            message: "Want to continue?",
            requestedSchema: FORM_SCHEMA,
          },
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(makeStartConfig({ createProcess }));
    await controller.newSession();

    const promptDone = controller.sendPrompt([{ type: "text", text: "go" }]);

    await waitFor(() => controller.getState().pendingElicitation !== null, 2000);

    controller.resolveElicitation({
      action: "decline",
    });

    await promptDone;

    expect(controller.getState().status).toBe("ready");
    expect(controller.getState().pendingElicitation).toBeNull();
  });
});

/** Poll until a condition is met or timeout. */
function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}
