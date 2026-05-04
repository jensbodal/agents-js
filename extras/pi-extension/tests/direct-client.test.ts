import { describe, expect, test } from "bun:test";
import type {
  A2AStreamEvent,
  A2ATransport,
  AgentTargetInput,
  DebugRecord,
  ProbeResult,
  ResolvedAgentTarget,
  TargetInspection,
} from "@agents-js/a2a-client";
// @a2a-js/sdk is a transitive dep through @agents-js/a2a-client; reach it via a relative
// path so this test does not require declaring the SDK directly in pi-extension/package.json.
import type {
  AgentCard,
  DeleteTaskPushNotificationConfigParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  Message,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
  TaskStatusUpdateEvent,
} from "../../a2a-client/node_modules/@a2a-js/sdk/dist/index.d.ts";

// --- Mock transport (same pattern as mcp tests) ---

class MockA2ATransport implements A2ATransport {
  readonly sentMessages: Array<{ target: ResolvedAgentTarget; params: MessageSendParams }> = [];

  constructor(
    private readonly cards: Map<string, AgentCard>,
    private readonly responses: Map<string, Message>,
    private readonly failUrls = new Set<string>(),
  ) {}

  subscribeDebug(_listener: (record: DebugRecord) => void): () => void {
    return () => {};
  }

  async resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
    if (this.failUrls.has(input.url)) {
      throw new Error(`Connection refused: ${input.url}`);
    }
    const card = this.cards.get(input.url);
    if (!card) {
      throw new Error(`No mock card for URL: ${input.url}`);
    }
    return {
      baseUrl: input.url,
      cardUrl: `${input.url}/.well-known/agent-card.json`,
      card,
      protocolVersion: "0.2.3",
      capabilities: {
        inputModes: ["text"],
        outputModes: ["text"],
        supportsTextInput: true,
        supportsTextOutput: true,
        supportsStreaming: false,
        supportsPushNotifications: false,
        raw: card.capabilities ?? {},
      },
    };
  }

  async inspectTarget(_input: AgentTargetInput): Promise<TargetInspection> {
    return { status: "ready" };
  }

  async sendMessage(
    target: ResolvedAgentTarget,
    params: MessageSendParams,
  ): Promise<Message | Task> {
    this.sentMessages.push({ target, params });
    const response = this.responses.get(target.baseUrl);
    if (!response) {
      throw new Error(`No mock response for URL: ${target.baseUrl}`);
    }
    return response;
  }

  async *sendMessageStream(
    _target: ResolvedAgentTarget,
    _params: MessageSendParams,
  ): AsyncGenerator<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {
    // Not used — stream: false
  }

  async getTask(_target: ResolvedAgentTarget, _params: TaskQueryParams): Promise<Task> {
    throw new Error("not implemented");
  }

  async cancelTask(_target: ResolvedAgentTarget, _params: TaskIdParams): Promise<Task> {
    throw new Error("not implemented");
  }

  async *resubscribeTask(): AsyncGenerator<
    Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {}

  async setTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not implemented");
  }
  async getTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: GetTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig> {
    throw new Error("not implemented");
  }
  async listTaskPushNotificationConfigs(
    _target: ResolvedAgentTarget,
    _params: ListTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig[]> {
    throw new Error("not implemented");
  }
  async deleteTaskPushNotificationConfig(
    _target: ResolvedAgentTarget,
    _params: DeleteTaskPushNotificationConfigParams,
  ): Promise<void> {
    throw new Error("not implemented");
  }
  async getExtendedAgentCard(_target: ResolvedAgentTarget): Promise<AgentCard> {
    throw new Error("not implemented");
  }
  async probe(_input: AgentTargetInput): Promise<ProbeResult[]> {
    return [];
  }
}

function makeCard(name: string, description: string): AgentCard {
  return {
    name,
    description,
    url: `http://127.0.0.1:${3000 + name.length}`,
    version: "1.0.0",
    protocolVersion: "0.2.3",
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: {},
  };
}

function makeMessage(text: string): Message {
  return {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text }],
  };
}

import { A2AClientProvider } from "@agents-js/a2a-client";
import { A2UI_SURFACE_EVENT_NAME } from "@agents-js/a2ui-types";
import { DirectClient } from "../src/direct-client.ts";
import type { ProgressUpdate } from "../src/types.ts";

/**
 * Test-only structural view of DirectClient internals. Tests wire a mock
 * provider and populate the agents map directly to exercise behavior without
 * spawning real A2A connections.
 */
type DirectClientInternal = {
  provider: A2AClientProvider;
  agents: Map<string, { target: ResolvedAgentTarget; contextId: string }>;
};

describe("DirectClient", () => {
  test("initialize() with Promise.allSettled handles partial failures", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();
    const failUrls = new Set<string>();

    // Agent "good" is reachable
    cards.set("http://localhost:3001", makeCard("good", "Good agent"));
    responses.set("http://localhost:3001", makeMessage("hello"));

    // Agent "bad" is unreachable
    failUrls.add("http://localhost:3002");

    const transport = new MockA2ATransport(cards, responses, failUrls);

    // Build a DirectClient with the mock registry returning both agents
    const client = new DirectClient();
    const provider = new A2AClientProvider(transport);

    // Manually wire the client to simulate what initialize() does,
    // but with our mock transport. We call the internal connect logic.
    (client as unknown as DirectClientInternal).provider = provider;

    const agentConfigs = [
      { name: "good", url: "http://localhost:3001" },
      { name: "bad", url: "http://localhost:3002" },
    ];

    const results = await Promise.allSettled(
      agentConfigs.map(async (agent) => {
        const target = await provider.connect({ url: agent.url });
        return { name: agent.name, target };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        (client as unknown as DirectClientInternal).agents.set(result.value.name, {
          target: result.value.target,
          contextId: crypto.randomUUID(),
        });
      }
    }

    // Only the "good" agent should be connected
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    const [firstTool] = tools;
    if (!firstTool) throw new Error("expected one tool");
    expect(firstTool.name).toBe("good");
    expect(firstTool.description).toBe("Good agent");
  });

  test("listTools() returns only successfully connected agents", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("alpha", "Alpha agent"));
    cards.set("http://localhost:3002", makeCard("beta", "Beta agent"));
    responses.set("http://localhost:3001", makeMessage("hi"));
    responses.set("http://localhost:3002", makeMessage("hi"));

    const transport = new MockA2ATransport(cards, responses);
    const client = new DirectClient();
    const provider = new A2AClientProvider(transport);
    (client as unknown as DirectClientInternal).provider = provider;

    // Connect both agents
    for (const [name, url] of [
      ["alpha", "http://localhost:3001"],
      ["beta", "http://localhost:3002"],
    ] as const) {
      const target = await provider.connect({ url });
      (client as unknown as DirectClientInternal).agents.set(name, {
        target,
        contextId: crypto.randomUUID(),
      });
    }

    const tools = await client.listTools();
    expect(tools).toHaveLength(2);

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  test("callTool() dispatches to the correct agent and returns text", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("echo", "Echo agent"));
    responses.set("http://localhost:3001", makeMessage("echoed back"));

    const transport = new MockA2ATransport(cards, responses);
    const client = new DirectClient();
    const provider = new A2AClientProvider(transport);
    (client as unknown as DirectClientInternal).provider = provider;

    const target = await provider.connect({ url: "http://localhost:3001" });
    (client as unknown as DirectClientInternal).agents.set("echo", {
      target,
      contextId: crypto.randomUUID(),
    });

    const result = await client.callTool("echo", "hello");
    expect(result).toBe("echoed back");

    // Verify the transport received the call
    expect(transport.sentMessages).toHaveLength(1);
    const [firstMsg] = transport.sentMessages;
    if (!firstMsg) throw new Error("expected one sent message");
    expect(firstMsg.params.message.parts).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("callTool() throws for unknown agent name", async () => {
    const client = new DirectClient();

    await expect(client.callTool("nonexistent", "hello")).rejects.toThrow(
      "[pi-extension] Unknown agent: nonexistent",
    );
  });

  test("callTool() forwards A2UI surface_event CUSTOM events via onProgress", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("ui", "UI agent"));
    responses.set("http://localhost:3001", makeMessage("done"));

    const transport = new MockA2ATransport(cards, responses);
    const client = new DirectClient();
    const provider = new A2AClientProvider(transport);

    // Capture the listener that DirectClient registers on callTool, so the
    // test can script a synthetic CUSTOM event as if the provider's transport
    // had emitted one. This keeps the test focused on the forwarding logic.
    let captured: ((event: unknown) => void) | null = null;
    const originalSubscribe = provider.subscribe.bind(provider);
    provider.subscribe = (listener) => {
      captured = listener as (event: unknown) => void;
      return originalSubscribe(listener);
    };

    (client as unknown as DirectClientInternal).provider = provider;

    const target = await provider.connect({ url: "http://localhost:3001" });
    (client as unknown as DirectClientInternal).agents.set("ui", {
      target,
      contextId: crypto.randomUUID(),
    });

    const updates: ProgressUpdate[] = [];
    const surfacePayload = { surfaceId: "surf-1", event: { kind: "render", root: "r" } };

    // Start the call. `subscribe` is invoked synchronously inside `callTool`
    // before the first `await`, so `captured` is populated by the time we
    // yield here.
    const pending = client.callTool("ui", "hello", (update) => {
      updates.push(update);
    });

    // Drive a scripted CUSTOM event through the captured listener, as if the
    // gateway had emitted an `agents-js.a2ui.surface_event` on the A2A bus.
    if (!captured) throw new Error("expected provider.subscribe to have been called");
    (captured as (event: unknown) => void)({
      type: "custom",
      name: A2UI_SURFACE_EVENT_NAME,
      data: surfacePayload,
    });

    await pending;

    const a2uiUpdates = updates.filter((u) => u.type === "a2ui");
    expect(a2uiUpdates).toHaveLength(1);
    const forwarded = a2uiUpdates[0];
    if (forwarded?.type !== "a2ui") throw new Error("expected a2ui update");
    expect(forwarded.surfaceId).toBe("surf-1");
    expect(forwarded.event).toEqual(surfacePayload.event);
  });

  test("destroy() clears all state", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("temp", "Temporary"));
    responses.set("http://localhost:3001", makeMessage("hi"));

    const transport = new MockA2ATransport(cards, responses);
    const client = new DirectClient();
    const provider = new A2AClientProvider(transport);
    (client as unknown as DirectClientInternal).provider = provider;

    const target = await provider.connect({ url: "http://localhost:3001" });
    (client as unknown as DirectClientInternal).agents.set("temp", {
      target,
      contextId: crypto.randomUUID(),
    });

    expect(await client.listTools()).toHaveLength(1);

    await client.destroy();

    expect(await client.listTools()).toHaveLength(0);
  });
});
