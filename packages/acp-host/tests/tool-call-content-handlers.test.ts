import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ToolCallContent } from "@agentclientprotocol/sdk";
import {
  ACPSessionController,
  configureLogging,
  type HostFileAdapters,
  resetLogging,
  type StartConfig,
  type ToolCallContentHandler,
} from "../src/index.ts";
import { createMockAgent } from "../src/testing.ts";

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

describe("ACPSessionController toolCallContentHandlers", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    configureLogging({ minLevel: "silent" });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  test("consumed tool_call content is omitted from richContent", async () => {
    const consumed: ToolCallContent[] = [];
    const handler: ToolCallContentHandler = {
      consume(item) {
        if (
          item.type !== "content" ||
          item.content.type !== "text" ||
          item.content.text !== "[consume]"
        ) {
          return false;
        }
        consumed.push(item);
        return true;
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
              content: [
                { type: "content", content: { type: "text", text: "[consume]" } },
                { type: "content", content: { type: "text", text: "keep me" } },
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
        toolCallContentHandlers: [handler],
      }),
    );
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "go" }]);

    await waitFor(() => consumed.length === 1, 2000);

    const turn = controller.getState().completedTurns[0];
    expect(turn).toBeDefined();
    const toolCall = turn?.toolCalls.find((entry) => entry.id === "tc-1");
    expect(toolCall?.richContent).toEqual([{ type: "content", text: "keep me" }]);
  });

  test("destroy() closes registered handlers", async () => {
    let closeCalls = 0;
    const handler: ToolCallContentHandler = {
      consume() {
        return false;
      },
      close() {
        closeCalls += 1;
      },
    };

    await controller.start(
      makeStartConfig({
        createProcess: createMockAgent({ prompts: [] }).createProcess,
        toolCallContentHandlers: [handler],
      }),
    );

    controller.destroy();
    expect(closeCalls).toBe(1);
  });
});
