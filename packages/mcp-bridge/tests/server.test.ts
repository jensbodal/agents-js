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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
// @a2a-js/sdk is a transitive dep through @agents-js/a2a-client; reach it via a relative
// path so this test does not require declaring the SDK directly in mcp-bridge/package.json.
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
import type { BridgeConfig } from "../src/server.ts";
import { createBridgeServer } from "../src/server.ts";

/** Minimal mock A2A transport that returns fixed responses. */
class MockA2ATransport implements A2ATransport {
  readonly sentMessages: Array<{ target: ResolvedAgentTarget; params: MessageSendParams }> = [];

  constructor(
    private readonly cards: Map<string, AgentCard>,
    private readonly responses: Map<string, Message>,
  ) {}

  subscribeDebug(_listener: (record: DebugRecord) => void): () => void {
    return () => {};
  }

  async resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
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
    // Not used in these tests (stream: false)
  }

  async getTask(_target: ResolvedAgentTarget, _params: TaskQueryParams): Promise<Task> {
    throw new Error("not implemented");
  }

  async cancelTask(_target: ResolvedAgentTarget, _params: TaskIdParams): Promise<Task> {
    throw new Error("not implemented");
  }

  async *resubscribeTask(): AsyncGenerator<
    Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent | A2AStreamEvent
  > {
    // Not used
  }

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

async function setupBridge(config: BridgeConfig, transport: MockA2ATransport) {
  const server = await createBridgeServer(config, transport);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return { server, client, transport };
}

describe("MCP Bridge Server", () => {
  test("registers one tool per configured agent", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("alpha", "Alpha agent"));
    cards.set("http://localhost:3002", makeCard("beta", "Beta agent"));
    responses.set("http://localhost:3001", makeMessage("hello from alpha"));
    responses.set("http://localhost:3002", makeMessage("hello from beta"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [
        { name: "alpha", url: "http://localhost:3001" },
        { name: "beta", url: "http://localhost:3002" },
      ],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.listTools();

    const agentToolNames = result.tools
      .map((t) => t.name)
      .filter((n) => n !== "tool_search" && n !== "load_tool")
      .sort();
    expect(agentToolNames).toEqual(["alpha", "beta"]);

    // Verify descriptions come from agent cards
    const alphaTool = result.tools.find((t) => t.name === "alpha");
    expect(alphaTool?.description).toBe("Alpha agent");

    const betaTool = result.tools.find((t) => t.name === "beta");
    expect(betaTool?.description).toBe("Beta agent");
  });

  test("tool input schema accepts a message string", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("echo", "Echo agent"));
    responses.set("http://localhost:3001", makeMessage("echoed"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [{ name: "echo", url: "http://localhost:3001" }],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.listTools();

    const echoTool = result.tools.find((t) => t.name === "echo");
    expect(echoTool?.inputSchema).toBeDefined();
    expect(echoTool?.inputSchema?.properties?.message).toBeDefined();
  });

  test("routes tool calls to the correct agent and returns text", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("agent-a", "Agent A"));
    cards.set("http://localhost:3002", makeCard("agent-b", "Agent B"));
    responses.set("http://localhost:3001", makeMessage("response from A"));
    responses.set("http://localhost:3002", makeMessage("response from B"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [
        { name: "agent-a", url: "http://localhost:3001" },
        { name: "agent-b", url: "http://localhost:3002" },
      ],
    };

    const { client } = await setupBridge(config, mockTransport);

    const resultA = await client.callTool({ name: "agent-a", arguments: { message: "hello A" } });
    expect(resultA.content).toEqual([{ type: "text", text: "response from A" }]);

    const resultB = await client.callTool({ name: "agent-b", arguments: { message: "hello B" } });
    expect(resultB.content).toEqual([{ type: "text", text: "response from B" }]);
  });

  test("sends messages with a stable contextId per agent", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("ctx-agent", "Context agent"));
    responses.set("http://localhost:3001", makeMessage("ok"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [{ name: "ctx-agent", url: "http://localhost:3001" }],
    };

    const { client } = await setupBridge(config, mockTransport);

    await client.callTool({ name: "ctx-agent", arguments: { message: "first" } });
    await client.callTool({ name: "ctx-agent", arguments: { message: "second" } });

    expect(mockTransport.sentMessages).toHaveLength(2);

    const [firstSent, secondSent] = mockTransport.sentMessages;
    if (!firstSent || !secondSent) throw new Error("expected two recorded sends");
    const firstContextId = firstSent.params.message.contextId;
    const secondContextId = secondSent.params.message.contextId;

    expect(firstContextId).toBeDefined();
    expect(firstContextId).toBe(secondContextId);
  });

  test("sanitizes agent names with special characters into valid tool names", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("My Agent!", "Special agent"));
    responses.set("http://localhost:3001", makeMessage("ok"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [{ name: "My Agent!", url: "http://localhost:3001" }],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.listTools();

    expect(result.tools[0]?.name).toBe("My_Agent_");
  });

  test("returns '(no response)' when agent returns empty message", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("empty", "Empty agent"));
    responses.set("http://localhost:3001", {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [],
    });

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [{ name: "empty", url: "http://localhost:3001" }],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.callTool({ name: "empty", arguments: { message: "hello" } });

    expect(result.content).toEqual([{ type: "text", text: "(no response)" }]);
  });

  test("registers tool_search and load_tool discovery primitives", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("alpha", "Alpha agent"));
    responses.set("http://localhost:3001", makeMessage("ok"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [{ name: "alpha", url: "http://localhost:3001" }],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.listTools();

    const names = result.tools.map((t) => t.name).sort();
    expect(names).toContain("tool_search");
    expect(names).toContain("load_tool");
    expect(names).toContain("alpha");
  });

  test("tool_search filters by substring over name and description", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("reader", "reads files"));
    cards.set("http://localhost:3002", makeCard("writer", "writes files"));
    responses.set("http://localhost:3001", makeMessage("ok"));
    responses.set("http://localhost:3002", makeMessage("ok"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [
        { name: "reader", url: "http://localhost:3001" },
        { name: "writer", url: "http://localhost:3002" },
      ],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.callTool({
      name: "tool_search",
      arguments: { query: "read" },
    });

    const structured = (result as { structuredContent?: { results?: Array<{ name: string }> } })
      .structuredContent;
    const resultNames = (structured?.results ?? []).map((r) => r.name);
    expect(resultNames).toContain("reader");
    expect(resultNames).not.toContain("writer");
  });

  test("tool_search with empty query returns the full catalog", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("one", "first agent"));
    cards.set("http://localhost:3002", makeCard("two", "second agent"));
    responses.set("http://localhost:3001", makeMessage("ok"));
    responses.set("http://localhost:3002", makeMessage("ok"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [
        { name: "one", url: "http://localhost:3001" },
        { name: "two", url: "http://localhost:3002" },
      ],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.callTool({
      name: "tool_search",
      arguments: { query: "" },
    });

    const structured = (result as { structuredContent?: { results?: Array<{ name: string }> } })
      .structuredContent;
    const names = (structured?.results ?? []).map((r) => r.name);
    expect(names).toContain("one");
    expect(names).toContain("two");
  });

  test("skills passed in config are discoverable via tool_search", async () => {
    const mockTransport = new MockA2ATransport(new Map(), new Map());
    const config: BridgeConfig = {
      agents: [],
      skills: [
        {
          name: "code-review",
          description: "Review a pull request diff",
          dir: "/tmp/skills/code-review",
          skillFile: "/tmp/skills/code-review/SKILL.md",
        },
      ],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.callTool({
      name: "tool_search",
      arguments: { query: "review" },
    });

    const structured = (
      result as { structuredContent?: { results?: Array<{ name: string; source: string }> } }
    ).structuredContent;
    const hits = structured?.results ?? [];
    expect(hits).toHaveLength(1);
    expect(hits[0]?.name).toBe("code-review");
    expect(hits[0]?.source).toBe("skill");
  });

  test("load_tool(unknown) returns an error with a helpful message", async () => {
    const mockTransport = new MockA2ATransport(new Map(), new Map());
    const config: BridgeConfig = { agents: [] };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.callTool({
      name: "load_tool",
      arguments: { name: "does-not-exist" },
    });

    expect(result.isError).toBe(true);
    const textContent = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(textContent?.text).toContain("Unknown tool");
    expect(textContent?.text).toContain("does-not-exist");
  });

  test("load_tool rejects skills as invocation targets", async () => {
    const mockTransport = new MockA2ATransport(new Map(), new Map());
    const config: BridgeConfig = {
      agents: [],
      skills: [
        {
          name: "docs-skill",
          description: "Some docs",
          dir: "/tmp/skills/docs-skill",
          skillFile: "/tmp/skills/docs-skill/SKILL.md",
        },
      ],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.callTool({
      name: "load_tool",
      arguments: { name: "docs-skill" },
    });

    expect(result.isError).toBe(true);
    const textContent = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(textContent?.text).toContain("skill");
  });

  test("default mode: agent tools are listed up-front (backwards compat)", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("eager", "always visible"));
    responses.set("http://localhost:3001", makeMessage("ok"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [{ name: "eager", url: "http://localhost:3001" }],
      // progressiveDiscovery omitted → default false
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.listTools();

    const names = result.tools.map((t) => t.name);
    expect(names).toContain("eager");
  });

  test("progressive mode: agent tools hidden until load_tool is called", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("lazy", "hidden by default"));
    responses.set("http://localhost:3001", makeMessage("ok"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [{ name: "lazy", url: "http://localhost:3001" }],
      progressiveDiscovery: true,
    };

    const { client } = await setupBridge(config, mockTransport);
    const before = await client.listTools();
    const beforeNames = before.tools.map((t) => t.name);
    expect(beforeNames).not.toContain("lazy");
    // Discovery primitives are always visible so the agent can find them.
    expect(beforeNames).toContain("tool_search");
    expect(beforeNames).toContain("load_tool");

    const load = await client.callTool({
      name: "load_tool",
      arguments: { name: "lazy" },
    });
    expect(load.isError).toBeFalsy();

    const after = await client.listTools();
    expect(after.tools.map((t) => t.name)).toContain("lazy");

    // Now it can actually be called.
    const call = await client.callTool({
      name: "lazy",
      arguments: { message: "hello" },
    });
    expect(call.content).toEqual([{ type: "text", text: "ok" }]);
  });

  test("load_tool on an already-enabled tool is idempotent", async () => {
    const cards = new Map<string, AgentCard>();
    const responses = new Map<string, Message>();

    cards.set("http://localhost:3001", makeCard("solo", "standalone"));
    responses.set("http://localhost:3001", makeMessage("ok"));

    const mockTransport = new MockA2ATransport(cards, responses);
    const config: BridgeConfig = {
      agents: [{ name: "solo", url: "http://localhost:3001" }],
      // Default mode: solo is already enabled
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.callTool({
      name: "load_tool",
      arguments: { name: "solo" },
    });

    expect(result.isError).toBeFalsy();
    const textContent = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(textContent?.text).toContain("already loaded");
  });

  test("handles task-based responses by extracting agent text", async () => {
    const cards = new Map<string, AgentCard>();

    cards.set("http://localhost:3001", makeCard("task-agent", "Task agent"));
    const task: Task = {
      kind: "task",
      id: "task-1",
      contextId: "ctx-1",
      status: {
        state: "completed",
        message: {
          kind: "message",
          messageId: "msg-1",
          role: "agent",
          parts: [{ kind: "text", text: "task completed" }],
        },
      },
      history: [
        {
          kind: "message",
          messageId: "msg-1",
          role: "agent",
          parts: [{ kind: "text", text: "task completed" }],
        },
      ],
    };

    // Use a transport that returns a Task instead of a Message
    const mockTransport = new MockA2ATransport(cards, new Map());

    // Override sendMessage to return a task
    mockTransport.sendMessage = async (target, params) => {
      mockTransport.sentMessages.push({ target, params });
      return task;
    };

    const config: BridgeConfig = {
      agents: [{ name: "task-agent", url: "http://localhost:3001" }],
    };

    const { client } = await setupBridge(config, mockTransport);
    const result = await client.callTool({
      name: "task-agent",
      arguments: { message: "do something" },
    });

    expect(result.content).toEqual([{ type: "text", text: "task completed" }]);
  });
});
