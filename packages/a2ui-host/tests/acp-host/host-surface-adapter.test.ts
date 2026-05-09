import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { A2uiMessage } from "@agents-js/a2ui-types";
import { ACP_CATALOG_ID } from "@agents-js/a2ui-types";
import type { HostFileAdapters, StartConfig } from "@agents-js/acp-host";
import { ACPSessionController, configureLogging, resetLogging } from "@agents-js/acp-host";
import { createMockAgent } from "@agents-js/acp-host/testing";
import {
  createA2uiToolCallContentHandler,
  type HostSurfaceAdapter,
} from "../../src/acp-host/index.ts";

function createMockFileAdapters(): HostFileAdapters {
  return {
    readTextFile: async (params) => ({ content: `mock ${params.path}` }),
    writeTextFile: async () => ({}),
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

function createRecordingAdapter(): HostSurfaceAdapter & {
  received: A2uiMessage[];
  closed: string[];
} {
  const received: A2uiMessage[] = [];
  const closed: string[] = [];
  return {
    received,
    closed,
    async handleSurfaceMessage(message) {
      received.push(message);
    },
    async handleSurfaceClosed(surfaceId) {
      closed.push(surfaceId);
    },
  };
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
      setTimeout(check, 10);
    };
    check();
  });
}

describe("ACPSessionController + createA2uiToolCallContentHandler", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    configureLogging({ minLevel: "silent" });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  test("routes A2UI-tagged tool_call content into the adapter", async () => {
    const adapter = createRecordingAdapter();

    const create: A2uiMessage = {
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: ACP_CATALOG_ID },
    };
    const update: A2uiMessage = {
      version: "v0.9",
      updateComponents: {
        surfaceId: "s1",
        components: [{ component: "Text", id: "root", text: "hi" }],
      },
    };

    const { createProcess } = createMockAgent({
      prompts: [
        {
          toolCalls: [
            {
              id: "tc-1",
              title: "render",
              status: "completed",
              a2uiMessages: [create, update],
            },
          ],
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        toolCallContentHandlers: [createA2uiToolCallContentHandler({ surfaceAdapter: adapter })],
      }),
    );
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "go" }]);

    await waitFor(() => adapter.received.length === 2, 2000);
    expect(adapter.received).toEqual([create, update]);
  });

  test("skips A2UI content from the turn's richContent", async () => {
    const adapter = createRecordingAdapter();

    const { createProcess } = createMockAgent({
      prompts: [
        {
          toolCalls: [
            {
              id: "tc-2",
              title: "render",
              status: "completed",
              a2uiMessages: [
                {
                  version: "v0.9",
                  createSurface: { surfaceId: "s2", catalogId: ACP_CATALOG_ID },
                },
              ],
            },
          ],
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        toolCallContentHandlers: [createA2uiToolCallContentHandler({ surfaceAdapter: adapter })],
      }),
    );
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "go" }]);

    await waitFor(() => adapter.received.length === 1, 2000);

    const turns = controller.getState().completedTurns;
    expect(turns.length).toBe(1);
    const [firstTurn] = turns;
    if (!firstTurn) throw new Error("expected one completed turn");
    const toolCall = firstTurn.toolCalls.find((entry) => entry.id === "tc-2");
    expect(toolCall).toBeDefined();
    expect(toolCall?.richContent ?? []).toEqual([]);
  });

  test("invalid A2UI payloads are dropped without stopping the session", async () => {
    const adapter = createRecordingAdapter();

    const validMessage: A2uiMessage = {
      version: "v0.9",
      createSurface: { surfaceId: "s3", catalogId: ACP_CATALOG_ID },
    };

    const { createProcess } = createMockAgent({
      prompts: [
        {
          toolCalls: [
            {
              id: "tc-3",
              title: "render",
              status: "completed",
              a2uiMessages: [{ not: "a valid a2ui message" }, validMessage],
            },
          ],
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        toolCallContentHandlers: [createA2uiToolCallContentHandler({ surfaceAdapter: adapter })],
      }),
    );
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "go" }]);

    await waitFor(() => adapter.received.length === 1, 2000);
    expect(adapter.received).toEqual([validMessage]);
  });

  test("A2UI content is handled cleanly without a surface adapter", async () => {
    const { createProcess } = createMockAgent({
      prompts: [
        {
          toolCalls: [
            {
              id: "tc-4",
              title: "render",
              status: "completed",
              a2uiMessages: [
                {
                  version: "v0.9",
                  createSurface: { surfaceId: "s4", catalogId: ACP_CATALOG_ID },
                },
              ],
            },
          ],
          stopReason: "end_turn",
        },
      ],
    });

    await controller.start(
      makeStartConfig({
        createProcess,
        toolCallContentHandlers: [createA2uiToolCallContentHandler()],
      }),
    );
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "go" }]);

    expect(controller.getState().status).toBe("ready");
    const turns = controller.getState().completedTurns;
    expect(turns).toHaveLength(1);
    const toolCall = turns[0]?.toolCalls.find((entry) => entry.id === "tc-4");
    expect(toolCall?.richContent ?? []).toEqual([]);
  });
});
