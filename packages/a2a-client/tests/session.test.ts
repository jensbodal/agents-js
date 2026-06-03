import { describe, expect, test } from "bun:test";
import { Role, TaskState } from "@a2a-js/sdk";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import {
  ACP_A2A_AUTH_REQUIRED_METADATA_KEY,
  ACP_A2A_ELICITATION_METADATA_KEY,
  createInitialSessionState,
  extractLatestAgentText,
  extractMessageText,
  reduceA2ASessionState,
} from "../src/index.ts";
import {
  createMockTarget,
  makeAgentCard,
  makeMessage,
  makeStatusUpdate,
  makeTask,
  makeTextPart,
} from "./mock-a2a-transport.ts";

describe("a2a-client session helpers", () => {
  test("extracts message text from text parts", () => {
    expect(
      extractMessageText({
        parts: [makeTextPart("hello world")],
      }),
    ).toBe("hello world");
  });

  test("extracts latest agent text from task history", () => {
    const text = extractLatestAgentText(
      makeTask({
        id: "task-1",
        contextId: "ctx-1",
        state: TaskState.TASK_STATE_COMPLETED,
        history: [
          makeMessage({
            messageId: "msg-user-1",
            role: Role.ROLE_USER,
            parts: [makeTextPart("hi")],
          }),
          makeMessage({
            messageId: "msg-agent-1",
            role: Role.ROLE_AGENT,
            parts: [makeTextPart("hello")],
          }),
        ],
      }),
    );

    expect(text).toBe("hello");
  });

  test("reduces a completed message into transcript state", () => {
    const initial = createInitialSessionState();
    const next = reduceA2ASessionState(initial, {
      type: "message.completed",
      text: "hello",
      contextId: "ctx-1",
      taskId: "task-1",
      task: makeTask({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_COMPLETED }),
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
        card: makeAgentCard({
          url: "http://127.0.0.1:55363",
          protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
        }),
      },
    });
    const next = reduceA2ASessionState(initial, {
      type: "target.resolved",
      target: createMockTarget("http://127.0.0.1:55363"),
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
      message: makeMessage({
        messageId: "message-1",
        role: Role.ROLE_AGENT,
        parts: [makeTextPart("hello")],
        contextId: "ctx-1",
        taskId: "task-1",
      }),
    });

    expect(next.contextId).toBe("ctx-1");
    expect(next.taskId).toBeUndefined();
    expect(next.transcript[0]?.taskId).toBeUndefined();
  });

  test("tracks resumable task state and active elicitation from status updates", () => {
    const initial = createInitialSessionState();
    const next = reduceA2ASessionState(initial, {
      type: "task.status.updated",
      update: makeStatusUpdate({
        taskId: "task-1",
        contextId: "ctx-1",
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: makeMessage({
          role: Role.ROLE_AGENT,
          messageId: "agent-1",
          parts: [makeTextPart("Need project details")],
        }),
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
      }),
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
      task: makeTask({
        id: "task-1",
        contextId: "ctx-1",
        state: TaskState.TASK_STATE_AUTH_REQUIRED,
        metadata: {
          [ACP_A2A_AUTH_REQUIRED_METADATA_KEY]: {
            kind: "acp.auth-required",
            message: "Authenticate before continuing.",
          },
        },
      }),
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
