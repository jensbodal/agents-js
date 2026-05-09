import { describe, expect, test } from "bun:test";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import {
  ACP_A2A_AUTH_REQUIRED_METADATA_KEY,
  ACP_A2A_ELICITATION_METADATA_KEY,
  createInitialSessionState,
  extractLatestAgentText,
  extractMessageText,
  reduceA2ASessionState,
} from "../src/index.ts";

describe("a2a-client session helpers", () => {
  test("extracts message text from text parts", () => {
    expect(
      extractMessageText({
        parts: [{ kind: "text", text: "hello world" }],
      }),
    ).toBe("hello world");
  });

  test("extracts latest agent text from task history", () => {
    const text = extractLatestAgentText({
      kind: "task",
      id: "task-1",
      contextId: "ctx-1",
      status: {
        state: "completed",
      },
      history: [
        {
          kind: "message",
          messageId: "msg-user-1",
          role: "user",
          parts: [{ kind: "text", text: "hi" }],
        },
        {
          kind: "message",
          messageId: "msg-agent-1",
          role: "agent",
          parts: [{ kind: "text", text: "hello" }],
        },
      ],
    });

    expect(text).toBe("hello");
  });

  test("reduces a completed message into transcript state", () => {
    const initial = createInitialSessionState();
    const next = reduceA2ASessionState(initial, {
      type: "message.completed",
      text: "hello",
      contextId: "ctx-1",
      taskId: "task-1",
      task: {
        kind: "task",
        id: "task-1",
        contextId: "ctx-1",
        status: { state: "completed" },
      },
    });

    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBe("task-1");
    expect(next.transcript).toHaveLength(1);
    expect(next.transcript[0]?.text).toBe("hello");
  });

  test("preserves pre-connect inspection state across connect-adjacent reducer events", () => {
    const initial = createInitialSessionState({
      targetInput: { url: "http://127.0.0.1:55363" },
      targetInspection: {
        status: "ready",
        card: {
          name: "mock",
          description: "mock",
          url: "http://127.0.0.1:55363",
          version: "1.0.0",
          protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
          defaultInputModes: ["text"],
          defaultOutputModes: ["text"],
          skills: [],
          capabilities: {},
        },
      },
    });
    const next = reduceA2ASessionState(initial, {
      type: "target.resolved",
      target: {
        baseUrl: "http://127.0.0.1:55363",
        cardUrl: "http://127.0.0.1:55363/.well-known/agent-card.json",
        protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
        card: {
          name: "mock",
          description: "mock",
          url: "http://127.0.0.1:55363",
          version: "1.0.0",
          protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
          defaultInputModes: ["text"],
          defaultOutputModes: ["text"],
          skills: [],
          capabilities: {},
        },
        capabilities: {
          inputModes: ["text"],
          outputModes: ["text"],
          supportsTextInput: true,
          supportsTextOutput: true,
          supportsStreaming: false,
          supportsPushNotifications: false,
          raw: {},
        },
      },
    });

    expect(next.targetInput?.url).toBe("http://127.0.0.1:55363");
    expect(next.targetInspection?.status).toBe("ready");
  });

  test("clears task state for direct message completions", () => {
    const initial = createInitialSessionState({
      contextId: "ctx-0",
      taskId: "task-0",
    });
    const next = reduceA2ASessionState(initial, {
      type: "message.completed",
      text: "hello",
      contextId: "ctx-1",
      message: {
        kind: "message",
        messageId: "message-1",
        role: "agent",
        parts: [{ kind: "text", text: "hello" }],
        contextId: "ctx-1",
        taskId: "task-1",
      },
    });

    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBeUndefined();
    expect(next.transcript[0]?.taskId).toBeUndefined();
  });

  test("tracks resumable task state and active elicitation from status updates", () => {
    const initial = createInitialSessionState();
    const next = reduceA2ASessionState(initial, {
      type: "task.status.updated",
      update: {
        kind: "status-update",
        taskId: "task-1",
        contextId: "ctx-1",
        final: false,
        metadata: {
          [ACP_A2A_ELICITATION_METADATA_KEY]: {
            kind: "acp.elicitation",
            mode: "form",
            message: "Need project details",
            requestedSchema: {
              type: "object",
              properties: {
                project: { type: "string", description: "Project name" },
              },
              required: ["project"],
            },
            sessionId: "session-1",
          },
        },
        status: {
          state: "input-required",
          message: {
            kind: "message",
            role: "agent",
            messageId: "agent-1",
            parts: [{ kind: "text", text: "Need project details" }],
          },
        },
      },
    });

    expect(next.status).toBe("input_required");
    expect(next.taskId).toBe("task-1");
    expect(next.resumableTaskId).toBe("task-1");
    expect(next.activeElicitation?.message).toBe("Need project details");
    expect(next.activeElicitation?.requestedSchema.required).toEqual(["project"]);
  });

  test("tracks auth-required status from task metadata", () => {
    const initial = createInitialSessionState();
    const next = reduceA2ASessionState(initial, {
      type: "task.updated",
      task: {
        kind: "task",
        id: "task-1",
        contextId: "ctx-1",
        metadata: {
          [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: {
            kind: "acp.auth-required",
            message: "Authenticate before continuing.",
          },
        },
        status: {
          state: "auth-required",
        },
      },
    });

    expect(next.status).toBe("auth_required");
    expect(next.resumableTaskId).toBe("task-1");
    expect(next.activeAuth?.message).toBe("Authenticate before continuing.");
  });

  test("clears interruption and resumable task state on error", () => {
    const initial = createInitialSessionState({
      activeAuth: { message: "Authenticate before continuing." },
      contextId: "ctx-1",
      resumableTaskId: "task-1",
      status: "auth_required",
      taskId: "task-1",
      taskState: "auth-required",
      targetInput: { url: "http://127.0.0.1:55363" },
      targetInspection: { status: "unreachable", error: "connect ECONNREFUSED" },
    });

    const next = reduceA2ASessionState(initial, {
      type: "error",
      error: "boom",
    });

    expect(next.status).toBe("error");
    expect(next.activeAuth).toBeUndefined();
    expect(next.resumableTaskId).toBeUndefined();
    expect(next.taskId).toBeUndefined();
    expect(next.taskState).toBeUndefined();
    expect(next.targetInput?.url).toBe("http://127.0.0.1:55363");
    expect(next.targetInspection?.status).toBe("unreachable");
  });
});
