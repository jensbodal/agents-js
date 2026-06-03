import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AgentCard,
  type Message,
  type Part,
  Role,
  type StreamResponse,
  type Task,
  TaskState,
} from "@a2a-js/sdk";
import { ClientFactory } from "@a2a-js/sdk/client";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import type { InitializeResponse } from "@agents-js/acp";
import { buildStatusUpdate, nowIso } from "../src/executor-events.ts";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../src/index.ts";
import { UniversalA2AServer } from "../src/server.ts";
import type { GatewayAgentCard } from "../src/types.ts";

/** Read text out of a proto text part. */
function partText(part: Part): string {
  return part.content?.$case === "text" ? part.content.value : "";
}

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
 * Minimal `AgentExecutor` driving a valid A2A 1.0 task-lifecycle stream:
 * an initial `task` (submitted) followed by `statusUpdate` events only
 * (`working` → terminal `completed`), then `eventBus.finished()`. A2A 1.0's
 * server `ResultManager` rejects a second full `task` event mid-lifecycle
 * ("stream ordering violation"), so termination rides a terminal
 * `TaskStatusUpdateEvent` carrying the agent reply in `status.message`.
 * (This intentionally diverges from `ACPtoA2AExecutor`, which still emits a
 * terminal `task` — see the streaming caveat noted with that executor.)
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
      const userText = userMessage.parts.map(partText).join("");

      const submittedTask: Task = {
        id: context.taskId,
        contextId: context.contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: nowIso(), message: undefined },
        artifacts: [],
        history: [userMessage],
        metadata: undefined,
      };
      eventBus.publish(AgentEvent.task(submittedTask));

      eventBus.publish(
        AgentEvent.statusUpdate(
          buildStatusUpdate(context.taskId, context.contextId, {
            state: TaskState.TASK_STATE_WORKING,
          }),
        ),
      );

      const replyText = `echo: ${userText}`;
      eventBus.publish(
        AgentEvent.statusUpdate(
          buildStatusUpdate(context.taskId, context.contextId, {
            state: TaskState.TASK_STATE_COMPLETED,
            text: replyText,
          }),
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
    supportedInterfaces: [
      {
        url: "http://127.0.0.1",
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    version: "1.0.0",
    securitySchemes: {},
    securityRequirements: [],
    skills: [],
    signatures: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: { extensions: [] },
  };
}

/** A `SendMessageResult` (`Message | Task`) is a Task when it carries a `status`. */
function isTaskResult(result: Message | Task): result is Task {
  return "status" in result && "id" in result;
}

describe("third-party @a2a-js/sdk client wire-level interop", () => {
  let server: { stop: (force?: boolean) => void; port: number | undefined } | null = null;
  let baseUrl: string;

  /** A2A 1.0 `SendMessageRequest` builder (tenant + required arrays). */
  function buildMessage(text: string): Message {
    return {
      messageId: crypto.randomUUID(),
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text", value: text },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        },
      ],
      taskId: "",
      contextId: "",
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
  }

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

  test("upstream ClientFactory resolves the gateway agent card", async () => {
    const client = await new ClientFactory().createFromUrl(baseUrl);
    const card: AgentCard = await client.getAgentCard();

    expect(card.name).toBe("EchoAgent");
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe(CURRENT_A2A_PROTOCOL_VERSION);
    // mapCapabilities sets streaming=true after the executor's initialize().
    expect(card.capabilities?.streaming).toBe(true);
  });

  test("upstream Client.sendMessage returns a spec-shaped terminal Task", async () => {
    const client = await new ClientFactory().createFromUrl(baseUrl);
    const result = await client.sendMessage({
      tenant: "",
      message: buildMessage("hello upstream"),
      configuration: undefined,
      metadata: undefined,
    });

    if (!isTaskResult(result)) {
      throw new Error(`Expected Task snapshot, got: ${JSON.stringify(result)}`);
    }
    expect(result.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    // The terminal agent reply rides the terminal status-update's message;
    // the ResultManager folds it into the Task's `status.message` (and may
    // also append it to history).
    const agentMsg =
      result.history?.find((m) => m.role === Role.ROLE_AGENT) ?? result.status?.message;
    expect(agentMsg).toBeDefined();
    const text = (agentMsg?.parts ?? []).map(partText).join("");
    expect(text).toBe("echo: hello upstream");
  });

  test("upstream Client.sendMessageStream yields submitted → working → final SSE events", async () => {
    const client = await new ClientFactory().createFromUrl(baseUrl);
    const events: StreamResponse["payload"][] = [];

    for await (const event of client.sendMessageStream({
      tenant: "",
      message: buildMessage("stream me"),
      configuration: undefined,
      metadata: undefined,
    })) {
      events.push(event.payload);
    }

    expect(events.length).toBeGreaterThanOrEqual(2);

    // First event must be a Task snapshot in 'submitted' state.
    const first = events[0];
    expect(first?.$case).toBe("task");
    if (first?.$case === "task") {
      expect(first.value.status?.state).toBe(TaskState.TASK_STATE_SUBMITTED);
    }

    // A 'working' status-update must appear between submitted and the final terminal.
    const working = events.find(
      (p) => p?.$case === "statusUpdate" && p.value.status?.state === TaskState.TASK_STATE_WORKING,
    );
    expect(working).toBeDefined();

    // The last event must be terminal. A2A 1.0 drops the `final`
    // discriminator and forbids a second `task` event mid-lifecycle, so
    // termination is a terminal-state status-update.
    const last = events[events.length - 1];
    const lastIsCompleted =
      last?.$case === "statusUpdate" && last.value.status?.state === TaskState.TASK_STATE_COMPLETED;
    expect(lastIsCompleted).toBe(true);
  });
});
