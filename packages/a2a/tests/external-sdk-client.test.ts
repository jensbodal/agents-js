import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentCard, Message, Task, TaskStatusUpdateEvent } from "@a2a-js/sdk";
import { A2AClient } from "@a2a-js/sdk/client";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { InitializeResponse } from "@agents-js/acp";
import { buildStatusUpdate, buildTerminalTask, nowIso } from "../src/executor-events.ts";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../src/index.ts";
import { UniversalA2AServer } from "../src/server.ts";
import type { GatewayAgentCard } from "../src/types.ts";

/**
 * Verifies wire-level A2A interop with the canonical upstream consumer
 * (`@a2a-js/sdk` v0.3.x). The existing `tests/integration/a2a-client-external-smoke`
 * suite covers tarball-install resolution for first-party consumers; this
 * suite covers what that one cannot — that an external A2A client built
 * against the upstream SDK can talk to `UniversalA2AServer` over the wire
 * (agent-card discovery, JSON-RPC `message/send`, SSE `message/stream`).
 *
 * Closes the "third-party A2A interop" Known Limitation in
 * `docs/protocols.md` at the L8 Standards Map header.
 */

/**
 * Minimal `AgentExecutor` that publishes the lifecycle a real
 * `ACPtoA2AExecutor` produces (`submitted` → `working` → terminal +
 * `eventBus.finished()`) without spinning up an actual ACP child.
 */
function createEchoExecutor(): AgentExecutor & { initialize: () => Promise<InitializeResponse> } {
  return {
    async initialize(): Promise<InitializeResponse> {
      return {
        protocolVersion: 1,
        agentInfo: { name: "EchoAgent", version: "1.0.0" },
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: false, sse: false },
          promptCapabilities: { image: false },
        },
      };
    },

    async execute(context: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      const userMessage = context.userMessage as Message;
      const userText = userMessage.parts
        .filter((part): part is Extract<typeof part, { kind: "text" }> => part.kind === "text")
        .map((p) => p.text)
        .join("");

      const submittedTask: Task = {
        kind: "task",
        id: context.taskId,
        contextId: context.contextId,
        status: { state: "submitted", timestamp: nowIso() },
        history: [{ ...userMessage, kind: "message" }],
      };
      eventBus.publish(submittedTask);

      eventBus.publish(
        buildStatusUpdate(context.taskId, context.contextId, {
          state: "working",
          final: false,
        }),
      );

      const replyText = `echo: ${userText}`;
      eventBus.publish(
        buildTerminalTask(
          context.taskId,
          context.contextId,
          { ...userMessage, kind: "message" },
          {
            state: "completed",
            text: replyText,
          },
        ),
      );
      eventBus.finished();
    },

    async cancelTask(_taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      eventBus.finished();
    },
  };
}

function buildSeedAgentCard(): GatewayAgentCard {
  return {
    name: "EchoAgent",
    description: "Echo executor used to verify upstream @a2a-js/sdk interop",
    url: "http://127.0.0.1",
    version: "1.0.0",
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: {},
  };
}

function isTaskStatusUpdate(event: unknown): event is TaskStatusUpdateEvent {
  return (
    typeof event === "object" &&
    event !== null &&
    (event as { kind?: string }).kind === "status-update"
  );
}

function isTaskSnapshot(event: unknown): event is Task {
  return (
    typeof event === "object" && event !== null && (event as { kind?: string }).kind === "task"
  );
}

describe("third-party @a2a-js/sdk client wire-level interop", () => {
  let server: { stop: (force?: boolean) => void; port: number | undefined } | null = null;
  let baseUrl: string;

  beforeAll(async () => {
    const wrapper = new UniversalA2AServer(createEchoExecutor(), buildSeedAgentCard());
    server = await wrapper.start({ port: 0 });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    // Guard against `beforeAll` failing before `server` is assigned —
    // an unguarded `.stop()` would throw a secondary error and hide the
    // real beforeAll failure.
    server?.stop(true);
  });

  test("upstream A2AClient.fromCardUrl resolves the gateway agent card", async () => {
    const client = await A2AClient.fromCardUrl(`${baseUrl}/.well-known/agent-card.json`);
    const card: AgentCard = await client.getAgentCard();

    expect(card.name).toBe("EchoAgent");
    expect(card.protocolVersion).toBe(CURRENT_A2A_PROTOCOL_VERSION);
    // mapCapabilities sets streaming=true after the executor's initialize().
    expect(card.capabilities?.streaming).toBe(true);
  });

  test("upstream A2AClient.sendMessage returns a spec-shaped terminal Task", async () => {
    const client = await A2AClient.fromCardUrl(`${baseUrl}/.well-known/agent-card.json`);
    const response = await client.sendMessage({
      message: {
        kind: "message",
        role: "user",
        messageId: crypto.randomUUID(),
        parts: [{ kind: "text", text: "hello upstream" }],
      },
    });

    // The legacy `A2AClient.sendMessage` returns the JSON-RPC envelope
    // (`{ jsonrpc, id, result }` on success). The task or message lives
    // under `.result`. Newer `Client.sendMessage` unwraps automatically,
    // but the legacy surface is the canonical interop check.
    if ("error" in response) {
      throw new Error(`Expected success response, got error: ${JSON.stringify(response.error)}`);
    }
    const task = (response as { result: unknown }).result;
    if (!isTaskSnapshot(task)) {
      throw new Error(`Expected Task snapshot, got: ${JSON.stringify(task)}`);
    }
    expect(task.status.state).toBe("completed");
    const agentMsg = task.history?.find((m) => m.role === "agent");
    expect(agentMsg).toBeDefined();
    const text = agentMsg?.parts
      .filter((p): p is Extract<typeof p, { kind: "text" }> => p.kind === "text")
      .map((p) => p.text)
      .join("");
    expect(text).toBe("echo: hello upstream");
  });

  test("upstream A2AClient.sendMessageStream yields submitted → working → final SSE events", async () => {
    const client = await A2AClient.fromCardUrl(`${baseUrl}/.well-known/agent-card.json`);
    const events: unknown[] = [];

    for await (const event of client.sendMessageStream({
      message: {
        kind: "message",
        role: "user",
        messageId: crypto.randomUUID(),
        parts: [{ kind: "text", text: "stream me" }],
      },
    })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThanOrEqual(2);

    // First event must be a Task snapshot in 'submitted' state.
    const first = events[0];
    expect(isTaskSnapshot(first)).toBe(true);
    if (isTaskSnapshot(first)) {
      expect(first.status.state).toBe("submitted");
    }

    // A 'working' status-update must appear between submitted and the final terminal.
    const working = events.find((e) => isTaskStatusUpdate(e) && e.status.state === "working");
    expect(working).toBeDefined();

    // The last event must be terminal (final: true status-update OR completed Task snapshot).
    const last = events[events.length - 1];
    const lastIsTerminalStatus = isTaskStatusUpdate(last) && last.final === true;
    const lastIsCompletedTask = isTaskSnapshot(last) && last.status.state === "completed";
    expect(lastIsTerminalStatus || lastIsCompletedTask).toBe(true);
  });
});
