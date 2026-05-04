import { describe, expect, test } from "bun:test";
import type { Message } from "@a2a-js/sdk";
import { ndJsonStream } from "@agents-js/acp";
import {
  extractValidAgentMessageId,
  resolveAgentMessageId,
  selectPermissionOutcome,
} from "../src/executor-policies.ts";
import { ACPtoA2AExecutor, DEFAULT_MAX_TEXT_BUFFER_SIZE, getMessageText } from "../src/index.ts";

type AcpRequest = {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type AcpResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function asAcpRequest(value: unknown): AcpRequest {
  return value as AcpRequest;
}

function asAcpResponse(value: unknown): AcpResponse {
  return value as AcpResponse;
}

const dataPart: Extract<Message["parts"][number], { kind: "data" }> = {
  kind: "data",
  data: { foo: "bar" },
  metadata: {},
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type RecordedEvent = {
  kind: string;
  id?: string;
  messageId?: string;
  parts?: Array<{ kind: string; text?: string }>;
  taskId?: string;
  contextId?: string;
  status?: {
    state: string;
    message?: { messageId?: string; parts?: Array<{ kind: string; text?: string }> };
  };
  history?: Array<{
    kind: string;
    messageId?: string;
    role?: string;
    parts?: Array<{ kind: string; text?: string }>;
  }>;
  final?: boolean;
};
type ExecutorWithSessionIdStore = {
  sessionIdStore: {
    load: () => Promise<Map<string, string>>;
    save: (map: Map<string, string>) => Promise<void>;
  };
};

describe("getMessageText", () => {
  test("extracts text from a single text part", () => {
    const message: Message = {
      kind: "message",
      messageId: "test-1",
      role: "user",
      parts: [{ kind: "text", text: "Hello world" }],
    };
    expect(getMessageText(message)).toBe("Hello world");
  });

  test("concatenates multiple text parts", () => {
    const message: Message = {
      kind: "message",
      messageId: "test-2",
      role: "user",
      parts: [
        { kind: "text", text: "Hello " },
        { kind: "text", text: "world" },
      ],
    };
    expect(getMessageText(message)).toBe("Hello world");
  });

  test("ignores non-text parts", () => {
    const message: Message = {
      kind: "message",
      messageId: "test-3",
      role: "user",
      parts: [{ kind: "text", text: "Hello" }, dataPart, { kind: "text", text: " world" }],
    };
    expect(getMessageText(message)).toBe("Hello world");
  });

  test("returns empty string for no text parts", () => {
    const message: Message = {
      kind: "message",
      messageId: "test-4",
      role: "user",
      parts: [],
    };
    expect(getMessageText(message)).toBe("");
  });

  test("handles agent role messages", () => {
    const message: Message = {
      kind: "message",
      messageId: "test-5",
      role: "agent",
      parts: [{ kind: "text", text: "I am the agent" }],
    };
    expect(getMessageText(message)).toBe("I am the agent");
  });
});

describe("executor policy helpers", () => {
  test("selectPermissionOutcome selects the first option when present", () => {
    const result = selectPermissionOutcome([
      { kind: "allow_once", name: "Allow once", optionId: "opt-1" },
      { kind: "reject_once", name: "Reject once", optionId: "opt-2" },
    ]);

    expect(result).toEqual({
      outcome: {
        outcome: "selected",
        optionId: "opt-1",
      },
    });
  });

  test("selectPermissionOutcome cancels when no options are available", () => {
    const result = selectPermissionOutcome([]);

    expect(result).toEqual({
      outcome: {
        outcome: "cancelled",
      },
    });
  });

  test("resolveAgentMessageId preserves ACP chunk message IDs", () => {
    const messageId = "acp-message-id";
    expect(resolveAgentMessageId(messageId)).toBe(messageId);
  });

  test("resolveAgentMessageId falls back to a UUID when ACP provides none", () => {
    const messageId = resolveAgentMessageId(undefined);

    expect(messageId).toMatch(uuidPattern);
  });

  test("resolveAgentMessageId falls back to a UUID when ACP provides an empty string", () => {
    const messageId = resolveAgentMessageId("");

    expect(messageId).toMatch(uuidPattern);
  });

  test("extractValidAgentMessageId accepts non-empty strings only", () => {
    expect(extractValidAgentMessageId("acp-message-id")).toBe("acp-message-id");
    expect(extractValidAgentMessageId("")).toBeUndefined();
    expect(extractValidAgentMessageId({ messageId: "bad" })).toBeUndefined();
  });

  test("resolveAgentMessageId falls back to a UUID when ACP provides a malformed id", () => {
    const messageId = resolveAgentMessageId({ messageId: "bad" } as never);

    expect(messageId).toMatch(uuidPattern);
  });
});

function createAcpHarness() {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();

  return {
    executorStream: ndJsonStream(clientToAgent.writable, agentToClient.readable),
    agentStream: ndJsonStream(agentToClient.writable, clientToAgent.readable),
  };
}

async function runFakeAcpAgent(
  agentStream: ReturnType<typeof createAcpHarness>["agentStream"],
  updates: Array<{ messageId?: unknown; text: string }>,
) {
  const reader = agentStream.readable.getReader();
  const writer = agentStream.writable.getWriter();

  try {
    while (true) {
      const { value: rawValue, done } = await reader.read();
      if (done) {
        return;
      }

      if (!rawValue || typeof rawValue !== "object" || !("method" in rawValue)) {
        continue;
      }

      const value = asAcpRequest(rawValue);

      if (value.method === "initialize") {
        await writer.write({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "fake-agent", version: "1.0.0" },
            agentCapabilities: {
              loadSession: true,
              mcpCapabilities: { http: false, sse: false },
              promptCapabilities: { image: false },
              sessionCapabilities: {
                close: {},
                fork: {},
                list: {},
                resume: {},
              },
            },
            authMethods: [{ id: "agent", name: "Agent auth" }],
          },
        });
        continue;
      }

      if (value.method === "session/new") {
        await writer.write({
          jsonrpc: "2.0",
          id: value.id,
          result: { sessionId: "session-1" },
        });
        continue;
      }

      if (value.method === "session/prompt") {
        for (const update of updates) {
          const sessionUpdate: Record<string, unknown> = {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: update.text },
          };
          if ("messageId" in update) {
            sessionUpdate.messageId = update.messageId;
          }

          await writer.write({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: value.params?.sessionId,
              update: sessionUpdate,
            },
          });
        }

        await writer.write({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            stopReason: "end_turn",
            userMessageId: "user-message-1",
            usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 },
          },
        });

        await writer.close();
        return;
      }
    }
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

async function runFakeAcpAgentUnknownExtMethod(
  agentStream: ReturnType<typeof createAcpHarness>["agentStream"],
) {
  const reader = agentStream.readable.getReader();
  const writer = agentStream.writable.getWriter();
  const extensionRequestId = "ext-unknown-1";
  let promptRequestId: string | number | null = null;

  try {
    while (true) {
      const { value: rawValue, done } = await reader.read();
      if (done) {
        return;
      }

      if (!rawValue || typeof rawValue !== "object") {
        continue;
      }

      if ("method" in rawValue) {
        const value = asAcpRequest(rawValue);
        if (value.method === "initialize") {
          await writer.write({
            jsonrpc: "2.0",
            id: value.id,
            result: {
              protocolVersion: 1,
              agentInfo: { name: "fake-agent", version: "1.0.0" },
              agentCapabilities: {
                loadSession: true,
                mcpCapabilities: { http: false, sse: false },
                promptCapabilities: { image: false },
                sessionCapabilities: {
                  close: {},
                  fork: {},
                  list: {},
                  resume: {},
                },
              },
            },
          });
          continue;
        }

        if (value.method === "session/new") {
          await writer.write({
            jsonrpc: "2.0",
            id: value.id,
            result: { sessionId: "session-unknown-ext" },
          });
          continue;
        }

        if (value.method === "session/prompt") {
          promptRequestId = value.id;
          await writer.write({
            jsonrpc: "2.0",
            id: extensionRequestId,
            method: "session/unknown",
            params: {
              sessionId: value.params?.sessionId,
            },
          });
          continue;
        }
      }

      if ("id" in rawValue && rawValue.id === extensionRequestId) {
        const response = asAcpResponse(rawValue);
        expect(response.error).toEqual(
          expect.objectContaining({
            code: -32601,
            data: { method: "session/unknown" },
            message: expect.stringContaining("Method not found"),
          }),
        );
        await writer.write({
          jsonrpc: "2.0",
          id: promptRequestId,
          result: {
            stopReason: "end_turn",
            userMessageId: "user-message-1",
          },
        });
        await writer.close();
        return;
      }
    }
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

async function runFakeAcpAgentAuthRequired(
  agentStream: ReturnType<typeof createAcpHarness>["agentStream"],
  options: {
    authMethods?: Array<{ id: string; name?: string }>;
    requestPermission?: boolean;
  } = {},
) {
  const reader = agentStream.readable.getReader();
  const writer = agentStream.writable.getWriter();

  try {
    while (true) {
      const { value: rawValue, done } = await reader.read();
      if (done) {
        return;
      }

      if (!rawValue || typeof rawValue !== "object" || !("method" in rawValue)) {
        continue;
      }

      const value = asAcpRequest(rawValue);

      if (value.method === "initialize") {
        await writer.write({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "fake-agent", version: "1.0.0" },
            agentCapabilities: {
              loadSession: true,
              mcpCapabilities: { http: false, sse: false },
              promptCapabilities: { image: false },
              sessionCapabilities: {
                close: {},
                fork: {},
                list: {},
                resume: {},
              },
            },
            authMethods: options.authMethods ?? [],
          },
        });
        continue;
      }

      if (value.method === "session/new") {
        if (options.requestPermission) {
          await writer.write({
            jsonrpc: "2.0",
            id: value.id,
            result: { sessionId: "session-1" },
          });
        } else {
          await writer.write({
            jsonrpc: "2.0",
            id: value.id,
            error: {
              code: -32001,
              message: "auth_required",
              data: { reason: "auth_required" },
            },
          });
          await writer.close();
          return;
        }
        continue;
      }

      if (options.requestPermission && value.method === "session/prompt") {
        await writer.write({
          jsonrpc: "2.0",
          method: "request_permission",
          params: {
            sessionId: value.params?.sessionId,
            toolCall: {
              toolCallId: "tool-1",
              title: "Write file",
            },
            options: [{ kind: "allow_once", name: "Allow once", optionId: "allow-1" }],
          },
        });
        await writer.write({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            stopReason: "end_turn",
            userMessageId: "user-message-1",
          },
        });
        await writer.close();
        return;
      }
    }
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

function createEventBus() {
  const events: RecordedEvent[] = [];

  return {
    events,
    eventBus: {
      publish(event: RecordedEvent) {
        events.push(event);
      },
      finished() {
        events.push({ kind: "finished" });
      },
    },
  };
}

function stubSessionIdStore(executor: ACPtoA2AExecutor): void {
  (executor as unknown as ExecutorWithSessionIdStore).sessionIdStore = {
    load: async () => new Map(),
    save: async () => {},
  };
}

function getPublishedTask(events: RecordedEvent[]): RecordedEvent {
  const tasks = events.filter((event) => event.kind === "task");
  const task = tasks[tasks.length - 1];
  expect(task).toBeDefined();
  // biome-ignore lint/style/noNonNullAssertion: guarded by expect(task).toBeDefined() above
  return task!;
}

describe("ACPtoA2AExecutor task persistence and message ID handling", () => {
  test("publishes a task event with the first valid ACP chunk message ID", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();
    const firstId = "acp-first";
    const secondId = "acp-second";

    const agentTask = runFakeAcpAgent(harness.agentStream, [
      { messageId: firstId, text: "Hello " },
      { messageId: secondId, text: "world" },
    ]);

    await executor.execute(
      {
        taskId: "task-1",
        contextId: "context-1",
        userMessage: {
          kind: "message",
          messageId: "user-1",
          role: "user",
          parts: [{ kind: "text", text: "Say hello" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    // Streaming execution publishes task snapshots and status updates, not bare A2A messages.
    expect(events.filter((e) => e.kind === "message")).toHaveLength(0);
    expect(events.filter((e) => e.kind === "task").length).toBeGreaterThanOrEqual(1);

    const task = getPublishedTask(events);
    expect(task.kind).toBe("task");
    expect(task.id).toBe("task-1");
    expect(task.contextId).toBe("context-1");
    expect(task.status?.state).toBe("completed");
    expect(task.status?.message?.messageId).toBe(firstId);
    expect(task.history).toHaveLength(2);
    expect(task.history?.[0]?.role).toBe("user");
    expect(task.history?.[1]?.role).toBe("agent");
    expect(task.history?.[1]?.messageId).toBe(firstId);
  });

  test("falls back to a UUID when the chunk message ID is empty", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();

    const agentTask = runFakeAcpAgent(harness.agentStream, [{ messageId: "", text: "Fallback " }]);

    await executor.execute(
      {
        taskId: "task-2",
        contextId: "context-2",
        userMessage: {
          kind: "message",
          messageId: "user-2",
          role: "user",
          parts: [{ kind: "text", text: "Say hello" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    const task = getPublishedTask(events);
    expect(task.kind).toBe("task");
    expect(task.id).toBe("task-2");
    expect(task.contextId).toBe("context-2");
    expect(task.status?.state).toBe("completed");
    expect(task.status?.message?.messageId).toMatch(uuidPattern);
  });

  test("falls back to a UUID when no valid ACP chunk message ID is provided", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();

    const agentTask = runFakeAcpAgent(harness.agentStream, [
      { text: "Missing " },
      { text: "message id" },
    ]);

    await executor.execute(
      {
        taskId: "task-4",
        contextId: "context-4",
        userMessage: {
          kind: "message",
          messageId: "user-4",
          role: "user",
          parts: [{ kind: "text", text: "Say hello" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    const task = getPublishedTask(events);
    expect(task.kind).toBe("task");
    expect(task.id).toBe("task-4");
    expect(task.status?.state).toBe("completed");
    expect(task.status?.message?.messageId).toMatch(uuidPattern);
  });

  test("does not overwrite the first accepted valid message ID in mixed chunks", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();
    const acceptedId = "acp-accepted";

    const agentTask = runFakeAcpAgent(harness.agentStream, [
      { messageId: null, text: "Hello " },
      { messageId: acceptedId, text: "world" },
      { messageId: "acp-later", text: "!" },
    ]);

    await executor.execute(
      {
        taskId: "task-3",
        contextId: "context-3",
        userMessage: {
          kind: "message",
          messageId: "user-3",
          role: "user",
          parts: [{ kind: "text", text: "Say hello" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    const task = getPublishedTask(events);
    expect(task.kind).toBe("task");
    expect(task.id).toBe("task-3");
    expect(task.contextId).toBe("context-3");
    expect(task.status?.state).toBe("completed");
    expect(task.status?.message?.messageId).toBe(acceptedId);
  });

  test("surfaces unknown ACP extension methods as method-not-found responses", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();

    const agentTask = runFakeAcpAgentUnknownExtMethod(harness.agentStream);

    await executor.execute(
      {
        taskId: "task-ext-1",
        contextId: "context-ext-1",
        userMessage: {
          kind: "message",
          messageId: "user-ext-1",
          role: "user",
          parts: [{ kind: "text", text: "Check extension behavior" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    const task = getPublishedTask(events);
    expect(task.id).toBe("task-ext-1");
    expect(task.status?.state).toBe("completed");
  });

  test("surfaces missing-auth-method failures as terminal failed tasks", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();

    const agentTask = runFakeAcpAgentAuthRequired(harness.agentStream, {
      authMethods: [],
    });

    await expect(
      executor.execute(
        {
          taskId: "task-auth-fail",
          contextId: "ctx-auth-fail",
          userMessage: {
            kind: "message",
            messageId: "user-auth-fail",
            role: "user",
            parts: [{ kind: "text", text: "Say hello" }],
          },
        } as never,
        eventBus as never,
      ),
    ).rejects.toBeDefined();

    await agentTask;

    const task = getPublishedTask(events);
    expect(task.status?.state).toBe("failed");
  });

  test("text buffer caps content at the configured maximum size", async () => {
    const maxSize = 20;
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream, undefined, {
      maxTextBufferSize: maxSize,
    });
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();

    const agentTask = runFakeAcpAgent(harness.agentStream, [
      { messageId: "msg-1", text: "A".repeat(15) },
      { messageId: "msg-1", text: "B".repeat(15) },
    ]);

    await executor.execute(
      {
        taskId: "task-buf",
        contextId: "ctx-buf",
        userMessage: {
          kind: "message",
          messageId: "user-buf",
          role: "user",
          parts: [{ kind: "text", text: "Say hello" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    const task = getPublishedTask(events);
    expect(task.status?.state).toBe("completed");

    // The terminal task text (from textBuffer) should be capped at maxSize
    const terminalText = task.status?.message?.parts?.[0]?.text;
    expect(terminalText).toBeDefined();
    expect(terminalText?.length).toBeLessThanOrEqual(maxSize);
    // First chunk is 15 chars, second is 15. With a 20 cap, only 5 of the second should be added.
    expect(terminalText).toBe("A".repeat(15) + "B".repeat(5));
  });

  test("text buffer uses the default maximum size constant", () => {
    expect(DEFAULT_MAX_TEXT_BUFFER_SIZE).toBe(256 * 1024);
  });

  test("does not publish input-required status for auto-resolved permission prompts", async () => {
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream);
    stubSessionIdStore(executor);
    const { eventBus, events } = createEventBus();

    const agentTask = runFakeAcpAgentAuthRequired(harness.agentStream, {
      authMethods: [{ id: "agent", name: "Agent auth" }],
      requestPermission: true,
    });

    await executor.execute(
      {
        taskId: "task-permission",
        contextId: "ctx-permission",
        userMessage: {
          kind: "message",
          messageId: "user-permission",
          role: "user",
          parts: [{ kind: "text", text: "Say hello" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    expect(
      events.some(
        (event) => event.kind === "status-update" && event.status?.state === "input-required",
      ),
    ).toBe(false);
  });
});

/**
 * Run a fake ACP agent that captures the prompt content it receives and
 * returns it in its text response, so tests can verify hook-transformed content.
 */
async function runFakeAcpAgentCapturingPrompt(
  agentStream: ReturnType<typeof createAcpHarness>["agentStream"],
  receivedPrompts: Array<unknown[]>,
) {
  const reader = agentStream.readable.getReader();
  const writer = agentStream.writable.getWriter();

  try {
    while (true) {
      const { value: rawValue, done } = await reader.read();
      if (done) {
        return;
      }

      if (!rawValue || typeof rawValue !== "object" || !("method" in rawValue)) {
        continue;
      }

      const value = asAcpRequest(rawValue);

      if (value.method === "initialize") {
        await writer.write({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "fake-agent", version: "1.0.0" },
            agentCapabilities: {
              loadSession: true,
              mcpCapabilities: { http: false, sse: false },
              promptCapabilities: { image: false },
              sessionCapabilities: {
                close: {},
                fork: {},
                list: {},
                resume: {},
              },
            },
          },
        });
        continue;
      }

      if (value.method === "session/new") {
        await writer.write({
          jsonrpc: "2.0",
          id: value.id,
          result: { sessionId: "session-hook" },
        });
        continue;
      }

      if (value.method === "session/prompt") {
        receivedPrompts.push((value.params?.prompt as unknown[]) ?? []);

        await writer.write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: value.params?.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "ack" },
            },
          },
        });

        await writer.write({
          jsonrpc: "2.0",
          id: value.id,
          result: {
            stopReason: "end_turn",
            userMessageId: "user-message-1",
          },
        });

        await writer.close();
        return;
      }
    }
  } finally {
    writer.releaseLock();
    reader.releaseLock();
  }
}

describe("ACPtoA2AExecutor beforePrompt hook", () => {
  test("transforms prompt content when beforePrompt returns modified blocks", async () => {
    const receivedPrompts: Array<unknown[]> = [];
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream, undefined, {
      hooks: {
        async beforePrompt(content) {
          return [{ type: "text", text: "injected context from A2A agent" }, ...content];
        },
      },
    });
    stubSessionIdStore(executor);
    const { eventBus } = createEventBus();

    const agentTask = runFakeAcpAgentCapturingPrompt(harness.agentStream, receivedPrompts);

    await executor.execute(
      {
        taskId: "task-hook",
        contextId: "ctx-hook",
        userMessage: {
          kind: "message",
          messageId: "user-hook",
          role: "user",
          parts: [{ kind: "text", text: "original prompt" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    expect(receivedPrompts).toHaveLength(1);
    expect(receivedPrompts[0]).toEqual([
      { type: "text", text: "injected context from A2A agent" },
      { type: "text", text: "original prompt" },
    ]);
  });

  test("leaves prompt unchanged when beforePrompt returns undefined", async () => {
    const receivedPrompts: Array<unknown[]> = [];
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream, undefined, {
      hooks: {
        async beforePrompt() {
          return undefined;
        },
      },
    });
    stubSessionIdStore(executor);
    const { eventBus } = createEventBus();

    const agentTask = runFakeAcpAgentCapturingPrompt(harness.agentStream, receivedPrompts);

    await executor.execute(
      {
        taskId: "task-noop",
        contextId: "ctx-noop",
        userMessage: {
          kind: "message",
          messageId: "user-noop",
          role: "user",
          parts: [{ kind: "text", text: "passthrough prompt" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    expect(receivedPrompts).toHaveLength(1);
    expect(receivedPrompts[0]).toEqual([{ type: "text", text: "passthrough prompt" }]);
  });

  test("continues with original prompt when beforePrompt throws", async () => {
    const receivedPrompts: Array<unknown[]> = [];
    const harness = createAcpHarness();
    const executor = new ACPtoA2AExecutor(harness.executorStream, undefined, {
      hooks: {
        async beforePrompt() {
          throw new Error("hook failure");
        },
      },
    });
    stubSessionIdStore(executor);
    const { eventBus } = createEventBus();

    const agentTask = runFakeAcpAgentCapturingPrompt(harness.agentStream, receivedPrompts);

    await executor.execute(
      {
        taskId: "task-error",
        contextId: "ctx-error",
        userMessage: {
          kind: "message",
          messageId: "user-error",
          role: "user",
          parts: [{ kind: "text", text: "should still work" }],
        },
      } as never,
      eventBus as never,
    );

    await agentTask;

    expect(receivedPrompts).toHaveLength(1);
    expect(receivedPrompts[0]).toEqual([{ type: "text", text: "should still work" }]);
  });
});
