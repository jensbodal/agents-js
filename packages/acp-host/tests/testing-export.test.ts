import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ACPSessionController,
  configureLogging,
  createNodeFileAdapters,
  resetLogging,
  type StartConfig,
} from "../src/index.ts";
import { createEchoAgent, createMockAgent } from "../src/testing.ts";

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

function makeStartConfig(
  workspacePath: string,
  createProcess: StartConfig["createProcess"],
): StartConfig {
  return {
    agentConfig: {
      name: "Testing Export Harness",
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

describe("testing export harness", () => {
  let controller: ACPSessionController;

  beforeEach(() => {
    configureLogging({ minLevel: "error" });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  test("createMockAgent replays deterministic permission scenarios and captures prompts", async () => {
    const { createProcess, agentReady, promptRequests } = createMockAgent({
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

    await controller.start(makeStartConfig("/tmp/acp-host-testing-export", createProcess));
    await agentReady;
    await controller.newSession();

    const promptPromise = controller.sendPrompt([{ type: "text", text: "Write the notes" }]);

    await waitForCondition(() => controller.getState().status === "waiting_permission");
    controller.resolvePermission({
      outcome: { outcome: "selected", optionId: "allow-1" },
    });

    await promptPromise;

    expect(promptRequests).toHaveLength(1);
    expect(promptRequests[0]?.prompt[0]).toEqual({ type: "text", text: "Write the notes" });
    expect(controller.getState().status).toBe("ready");
  });

  test("createEchoAgent streams the submitted prompt content back through the controller", async () => {
    const { createProcess, agentReady } = createEchoAgent();

    await controller.start(makeStartConfig("/tmp/acp-host-testing-export-echo", createProcess));
    await agentReady;
    await controller.newSession();
    await controller.sendPrompt([{ type: "text", text: "Echo this back" }]);

    expect(controller.getState().currentTurn?.textChunks).toEqual(["Echo: received your message"]);
  });
});
