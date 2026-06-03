import { describe, expect, test } from "bun:test";
import { Role, TaskState } from "@a2a-js/sdk";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { createAuditEmitter } from "@agents-js/a2a/audit";
import { createA2AMentionMiddleware } from "../src/middleware.ts";
import type {
  A2ATransport,
  AgentTargetInput,
  ResolvedAgentTarget,
  TargetInspection,
} from "../src/types.ts";
import {
  createMockTarget,
  createMockTransport,
  createStreamingMockTransport,
  makeMessage,
  makeTextPart,
  type StreamItem,
  statusEvent,
  taskEvent,
} from "./mock-a2a-transport.ts";

interface AnnotatedTextBlock {
  type: "text";
  text: string;
  annotations: {
    audience: string[];
    _meta: {
      source: string;
      agentName: string;
      agentUrl: string;
    };
  };
}

function textBlock(text: string): ContentBlock {
  return { type: "text", text } as ContentBlock;
}

describe("createA2AMentionMiddleware", () => {
  test("passes through unchanged when no @mentions are present", async () => {
    const middleware = createA2AMentionMiddleware({
      agents: { "my-agent": { url: "http://localhost:3000" } },
      transport: createMockTransport({}),
    });

    const result = await middleware([textBlock("no mentions here")], "session-1");

    expect(result).toBeUndefined();
  });

  test("detects @mention, dispatches A2A, and injects response", async () => {
    const middleware = createA2AMentionMiddleware({
      agents: { "my-agent": { url: "http://localhost:3000" } },
      transport: createMockTransport({
        "http://localhost:3000": "I am the agent response",
      }),
    });

    const content = [textBlock("@my-agent hello there")];
    const result = await middleware(content, "session-1");

    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("I am the agent response");
    expect(responseBlock.text).toContain("@my-agent");
    expect(responseBlock.annotations._meta.source).toBe("a2a-delegation");
    expect(responseBlock.annotations._meta.agentName).toBe("my-agent");
    expect(responseBlock.annotations._meta.agentUrl).toBe("http://localhost:3000");
    expect(result?.[1]).toEqual(content[0]);
  });

  test("supports injected prompt extractors", async () => {
    const middleware = createA2AMentionMiddleware({
      agents: { reviewer: { url: "http://localhost:3001" } },
      transport: createMockTransport({
        "http://localhost:3001": "reviewed",
      }),
      getPromptText(content) {
        const textBlock = content.find(
          (block) =>
            block.type === "text" &&
            (block as { annotations?: { _meta?: { hostSource?: string } } }).annotations?._meta
              ?.hostSource === "user-prompt",
        ) as { text?: string } | undefined;
        return textBlock?.text ?? "";
      },
    });

    const result = await middleware(
      [
        {
          type: "text",
          text: "inline context with @reviewer should not dispatch",
          annotations: { _meta: { hostSource: "file-inline-context" } },
        } as ContentBlock,
        {
          type: "text",
          text: "@reviewer please help",
          annotations: { _meta: { hostSource: "user-prompt" } },
        } as ContentBlock,
      ],
      "session-1",
    );

    expect(result).toBeDefined();
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("reviewed");
  });

  test("dispatches multiple @mentions in parallel and injects all responses", async () => {
    const middleware = createA2AMentionMiddleware({
      agents: {
        alpha: { url: "http://localhost:3001" },
        beta: { url: "http://localhost:3002" },
      },
      transport: createMockTransport({
        "http://localhost:3001": "alpha says hi",
        "http://localhost:3002": "beta says hello",
      }),
    });

    const content = [textBlock("@alpha and @beta please respond")];
    const result = await middleware(content, "session-1");

    expect(result).toBeDefined();
    expect(result).toHaveLength(3);
    const blocks = result?.slice(0, 2) as AnnotatedTextBlock[];
    const texts = blocks.map((block) => block.text);
    expect(texts.some((t) => t.includes("alpha says hi"))).toBe(true);
    expect(texts.some((t) => t.includes("beta says hello"))).toBe(true);
  });

  test("skips unknown agent names with callback", async () => {
    const unknown: string[] = [];
    const middleware = createA2AMentionMiddleware({
      agents: {
        known: { url: "http://localhost:3000" },
      },
      transport: createMockTransport({}),
      onUnknownAgent: ({ agentName }) => {
        unknown.push(agentName);
      },
    });

    const result = await middleware([textBlock("@missing do something")], "session-1");

    expect(result).toBeUndefined();
    expect(unknown).toEqual(["missing"]);
  });

  test("audits unknown and blocked mentions without prompt text", async () => {
    const audit = createAuditEmitter({ logger: { log: () => {} } });
    const middleware = createA2AMentionMiddleware({
      agents: {
        blocked: { url: "http://localhost:3000" },
      },
      transport: createMockTransport({}),
      audit,
      allowDispatch({ agentName }) {
        return agentName !== "blocked";
      },
    });

    const result = await middleware([textBlock("@missing and @blocked hello")], "session-1");

    expect(result).toBeUndefined();
    const events = audit.recent();
    expect(events.some((event) => event.kind === "mention-dispatch-blocked")).toBe(true);
    expect(events.some((event) => event.kind === "mention-dispatch-unknown")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("hello");
    expect(JSON.stringify(events)).not.toContain("promptText");
  });

  test("allows injected resolver functions", async () => {
    const middleware = createA2AMentionMiddleware({
      async resolveAgent(name) {
        if (name !== "resolver-agent") {
          return null;
        }
        return { url: "http://localhost:3999" };
      },
      transport: createMockTransport({
        "http://localhost:3999": "resolved via callback",
      }),
    });

    const result = await middleware([textBlock("@resolver-agent ping")], "session-1");

    expect(result).toBeDefined();
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("resolved via callback");
  });

  test("allows injected registry resolvers", async () => {
    const middleware = createA2AMentionMiddleware({
      registry: {
        async resolve(name) {
          if (name !== "registry-agent") {
            return null;
          }
          return { url: "http://localhost:4888" };
        },
      },
      transport: createMockTransport({
        "http://localhost:4888": "resolved via registry",
      }),
    });

    const result = await middleware([textBlock("@registry-agent ping")], "session-1");

    expect(result).toBeDefined();
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("resolved via registry");
  });

  test("extracts baseUrl from registry-resolved targets for connect", async () => {
    const resolvedUrls: string[] = [];
    const transport = createMockTransport({
      "http://localhost:4888": "resolved via registry url",
    });
    const originalResolve = transport.resolveTarget.bind(transport);
    transport.resolveTarget = async (input: AgentTargetInput) => {
      resolvedUrls.push(input.url);
      return originalResolve(input);
    };

    const middleware = createA2AMentionMiddleware({
      registry: {
        async resolve(name) {
          if (name !== "registry-agent") {
            return null;
          }
          return { url: "http://localhost:4888" };
        },
      },
      transport,
    });

    const result = await middleware([textBlock("@registry-agent ping")], "session-1");

    expect(result).toBeDefined();
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("resolved via registry url");
    expect(resolvedUrls).toEqual(["http://localhost:4888"]);
  });

  test("preserves mode and headers from plain registry targets", async () => {
    const resolvedInputs: AgentTargetInput[] = [];
    const transport = createMockTransport({
      "http://localhost:4999": "resolved with preserved input",
    });
    const originalResolve = transport.resolveTarget.bind(transport);
    transport.resolveTarget = async (input: AgentTargetInput) => {
      resolvedInputs.push(input);
      return originalResolve(input);
    };

    const middleware = createA2AMentionMiddleware({
      registry: {
        async resolve(name) {
          if (name !== "registry-agent") {
            return null;
          }
          return {
            url: "http://localhost:4999",
            mode: "card",
            headers: { authorization: "Bearer test-token" },
          };
        },
      },
      transport,
    });

    const result = await middleware([textBlock("@registry-agent ping")], "session-1");

    expect(result).toBeDefined();
    expect(resolvedInputs).toEqual([
      {
        url: "http://localhost:4999",
        mode: "card",
        headers: { authorization: "Bearer test-token" },
      },
    ]);
  });

  test("reuses fully resolved registry targets without reconnecting", async () => {
    const transport = createMockTransport({
      "http://localhost:4777": "resolved target reused",
    });
    transport.resolveTarget = async () => {
      throw new Error("should not reconnect a resolved registry target");
    };

    const middleware = createA2AMentionMiddleware({
      registry: {
        async resolve(name) {
          if (name !== "registry-agent") {
            return null;
          }
          return createMockTarget("http://localhost:4777");
        },
      },
      transport,
    });

    const result = await middleware([textBlock("@registry-agent ping")], "session-1");

    expect(result).toBeDefined();
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("resolved target reused");
  });

  test("does not match email addresses in prompt", async () => {
    const middleware = createA2AMentionMiddleware({
      agents: { example: { url: "http://localhost:3000" } },
      transport: createMockTransport({
        "http://localhost:3000": "should not appear",
      }),
    });

    const result = await middleware(
      [textBlock("contact user@example.com for details")],
      "session-1",
    );

    expect(result).toBeUndefined();
  });

  test("handles null sessionId gracefully", async () => {
    const middleware = createA2AMentionMiddleware({
      agents: { "my-agent": { url: "http://localhost:3000" } },
      transport: createMockTransport({
        "http://localhost:3000": "response with null session",
      }),
    });

    const result = await middleware([textBlock("@my-agent test")], null);

    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
  });

  test("handles dispatch errors gracefully and continues", async () => {
    const transport = createMockTransport({
      "http://localhost:3000": "working response",
    });
    const originalResolveTarget = transport.resolveTarget.bind(transport);
    transport.resolveTarget = async (input: AgentTargetInput) => {
      if (input.url === "http://localhost:4000") {
        throw new Error("Connection refused");
      }
      return originalResolveTarget(input);
    };

    const errors: unknown[] = [];
    const middleware = createA2AMentionMiddleware({
      agents: {
        "failing-agent": { url: "http://localhost:4000" },
        "working-agent": { url: "http://localhost:3000" },
      },
      transport,
      onDispatchError: ({ error }) => {
        errors.push(error);
      },
    });

    const result = await middleware(
      [textBlock("@failing-agent and @working-agent help")],
      "session-1",
    );

    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    expect(errors).toHaveLength(1);
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("working response");
  });

  test("audits mention dispatch success and failure structurally", async () => {
    const audit = createAuditEmitter({ logger: { log: () => {} } });
    const transport = createMockTransport({
      "http://localhost:3000": "working response",
    });
    const originalResolveTarget = transport.resolveTarget.bind(transport);
    transport.resolveTarget = async (input: AgentTargetInput) => {
      if (input.url === "http://localhost:4000") {
        throw new Error("Connection refused");
      }
      return originalResolveTarget(input);
    };

    const middleware = createA2AMentionMiddleware({
      agents: {
        "failing-agent": { url: "http://localhost:4000" },
        "working-agent": { url: "http://localhost:3000" },
      },
      transport,
      audit,
    });

    await middleware([textBlock("@failing-agent and @working-agent help")], "session-1");

    const events = audit.recent();
    expect(events.filter((event) => event.kind === "mention-dispatch-started")).toHaveLength(2);
    expect(events.some((event) => event.kind === "mention-dispatch-succeeded")).toBe(true);
    expect(events.some((event) => event.kind === "mention-dispatch-failed")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("help");
    expect(JSON.stringify(events)).not.toContain("Connection refused");
  });

  test("fires onDispatchStart before sendTurn resolves, onDispatchSuccess after", async () => {
    const events: string[] = [];
    const transport = createMockTransport({
      "http://localhost:3000": "hello from agent",
    });
    // Wrap sendTurn to observe ordering between the hook and the wire call.
    const originalSendMessage = transport.sendMessage.bind(transport);
    transport.sendMessage = async (...args: Parameters<typeof transport.sendMessage>) => {
      events.push("wire:start");
      const result = await originalSendMessage(...args);
      events.push("wire:resolve");
      return result;
    };

    const middleware = createA2AMentionMiddleware({
      agents: { "my-agent": { url: "http://localhost:3000" } },
      transport,
      onDispatchStart: ({ agentName }) => {
        events.push(`start:${agentName}`);
      },
      onDispatchSuccess: ({ agentName, agentUrl }) => {
        events.push(`success:${agentName}:${agentUrl}`);
      },
    });

    const result = await middleware([textBlock("@my-agent hello")], "session-1");

    expect(result).toBeDefined();
    // start fires before the wire call; success fires after it resolves.
    expect(events).toEqual([
      "start:my-agent",
      "wire:start",
      "wire:resolve",
      "success:my-agent:http://localhost:3000",
    ]);
  });

  test("onDispatchSuccess and onDispatchError are mutually exclusive terminals", async () => {
    const starts: string[] = [];
    const successes: string[] = [];
    const errors: string[] = [];
    const transport = createMockTransport({
      "http://localhost:3000": "working response",
    });
    const originalResolveTarget = transport.resolveTarget.bind(transport);
    transport.resolveTarget = async (input: AgentTargetInput) => {
      if (input.url === "http://localhost:4000") {
        throw new Error("Connection refused");
      }
      return originalResolveTarget(input);
    };

    const middleware = createA2AMentionMiddleware({
      agents: {
        "failing-agent": { url: "http://localhost:4000" },
        "working-agent": { url: "http://localhost:3000" },
      },
      transport,
      onDispatchStart: ({ agentName }) => {
        starts.push(agentName);
      },
      onDispatchSuccess: ({ agentName }) => {
        successes.push(agentName);
      },
      onDispatchError: ({ agentName }) => {
        errors.push(agentName);
      },
    });

    const result = await middleware(
      [textBlock("@failing-agent and @working-agent help")],
      "session-1",
    );

    expect(result).toBeDefined();
    // Only the working agent got past resolveTarget, so only it produced a
    // start. The failing agent's target resolution threw before sendTurn, so
    // no onDispatchStart fired for it.
    expect(starts).toEqual(["working-agent"]);
    // Success only fires on the working agent.
    expect(successes).toEqual(["working-agent"]);
    // Error only fires on the failing agent.
    expect(errors).toEqual(["failing-agent"]);
  });

  test("awaits async onDispatchStart before issuing sendTurn", async () => {
    const events: string[] = [];
    const transport = createMockTransport({
      "http://localhost:3000": "response",
    });
    const originalSendMessage = transport.sendMessage.bind(transport);
    transport.sendMessage = async (...args: Parameters<typeof transport.sendMessage>) => {
      events.push("wire");
      return originalSendMessage(...args);
    };

    const middleware = createA2AMentionMiddleware({
      agents: { "my-agent": { url: "http://localhost:3000" } },
      transport,
      async onDispatchStart({ agentName }) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`start:${agentName}`);
      },
    });

    const result = await middleware([textBlock("@my-agent go")], "session-1");

    expect(result).toBeDefined();
    // If onDispatchStart were not awaited, the wire call would fire before
    // the delayed start push, and the order would be ["wire", "start:my-agent"].
    expect(events).toEqual(["start:my-agent", "wire"]);
  });

  test("onDispatchSuccess carries agentUrl and the A2ASendResult", async () => {
    const captured: Array<{ agentName: string; agentUrl: string; hasResult: boolean }> = [];
    const middleware = createA2AMentionMiddleware({
      agents: { "my-agent": { url: "http://localhost:3000" } },
      transport: createMockTransport({
        "http://localhost:3000": "reply body",
      }),
      onDispatchSuccess: ({ agentName, agentUrl, result }) => {
        captured.push({
          agentName,
          agentUrl,
          hasResult: result !== undefined && result !== null,
        });
      },
    });

    await middleware([textBlock("@my-agent ping")], "session-1");

    expect(captured).toEqual([
      { agentName: "my-agent", agentUrl: "http://localhost:3000", hasResult: true },
    ]);
  });

  test("does not intercept @@ dispatch directives", async () => {
    const middleware = createA2AMentionMiddleware({
      agents: { "my-agent": { url: "http://localhost:3000" } },
      transport: createMockTransport({
        "http://localhost:3000": "should not appear",
      }),
    });

    const result = await middleware([textBlock("@@my-agent do something")], "session-1");

    expect(result).toBeUndefined();
  });
});

/**
 * Build an instrumented streaming/non-streaming hybrid transport that
 * records which endpoint was called (`sendMessage` vs `sendMessageStream`)
 * and timestamps every stream yield. Used by AJS-92 streaming-default tests
 * to assert path selection AND intermediate-event ordering.
 */
interface InstrumentedTransport {
  transport: A2ATransport;
  calls: string[];
  yieldsSeq: number[];
  resolveSeq: { value: number };
}

function createInstrumentedTransport(opts: {
  supportsStreaming: boolean;
  streamItems?: StreamItem[];
  streamYieldDelayMs?: number;
  messageResponseText?: string;
}): InstrumentedTransport {
  const calls: string[] = [];
  const yieldsSeq: number[] = [];
  const resolveSeq = { value: -1 };
  let seq = 0;
  const nextSeq = () => ++seq;
  const streamItems = opts.streamItems ?? [];

  const transport: A2ATransport = {
    async resolveTarget(input: AgentTargetInput): Promise<ResolvedAgentTarget> {
      const target = createMockTarget(input.url);
      target.capabilities.supportsStreaming = opts.supportsStreaming;
      if (opts.supportsStreaming) {
        target.capabilities.raw = { streaming: true, extensions: [] };
        target.card.capabilities = { streaming: true, extensions: [] };
      }
      return target;
    },
    async inspectTarget(_input: AgentTargetInput): Promise<TargetInspection> {
      return { status: "ready" };
    },
    async sendMessage() {
      calls.push("sendMessage");
      return makeMessage({
        role: Role.ROLE_AGENT,
        parts: [makeTextPart(opts.messageResponseText ?? "non-streaming reply")],
      });
    },
    async *sendMessageStream(): AsyncGenerator<StreamItem> {
      calls.push("sendMessageStream");
      for (const item of streamItems) {
        if (opts.streamYieldDelayMs && opts.streamYieldDelayMs > 0) {
          await new Promise((r) => setTimeout(r, opts.streamYieldDelayMs));
        }
        yieldsSeq.push(nextSeq());
        yield item;
      }
    },
    async getTask() {
      throw new Error("Not implemented");
    },
    async cancelTask() {
      throw new Error("Not implemented");
    },
    resubscribeTask() {
      throw new Error("Not implemented");
    },
    async setTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async getTaskPushNotificationConfig() {
      throw new Error("Not implemented");
    },
    async listTaskPushNotificationConfigs() {
      throw new Error("Not implemented");
    },
    async deleteTaskPushNotificationConfig() {},
    async getExtendedAgentCard() {
      throw new Error("Not implemented");
    },
    async probe() {
      return [];
    },
    subscribeDebug() {
      return () => {};
    },
  };

  // Mark resolveSeq when sendTurn resolves: callers stamp via
  // `() => (resolveSeq.value = nextSeq())` after their awaited dispatch.
  // We expose nextSeq through a hidden property for the test scaffold.
  (transport as unknown as { __nextSeq: () => number }).__nextSeq = nextSeq;

  return { transport, calls, yieldsSeq, resolveSeq };
}

function buildStreamingTaskItems(text: string): StreamItem[] {
  // Two intermediate status events + one terminal status-update carrying the
  // final reply. A2A 1.0 has no terminal Task event — the provider resolves on
  // the terminal status-update.
  return [
    taskEvent({ id: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING }),
    statusEvent({ taskId: "task-1", contextId: "ctx-1", state: TaskState.TASK_STATE_WORKING }),
    statusEvent({
      taskId: "task-1",
      contextId: "ctx-1",
      state: TaskState.TASK_STATE_COMPLETED,
      message: makeMessage({
        messageId: "msg-1",
        role: Role.ROLE_AGENT,
        parts: [makeTextPart(text)],
      }),
    }),
  ];
}

describe("createA2AMentionMiddleware — streaming-by-default (AJS-92)", () => {
  test("uses streaming path when target advertises capabilities.streaming", async () => {
    const { transport, calls } = createInstrumentedTransport({
      supportsStreaming: true,
      streamItems: buildStreamingTaskItems("streamed reply"),
    });

    const middleware = createA2AMentionMiddleware({
      agents: { hello: { url: "http://localhost:3100" } },
      transport,
    });

    const result = await middleware([textBlock("@hello please respond")], "session-1");

    expect(result).toBeDefined();
    expect(calls).toEqual(["sendMessageStream"]);
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("streamed reply");
  });

  test("falls back to non-streaming when target lacks streaming capability", async () => {
    const { transport, calls } = createInstrumentedTransport({
      supportsStreaming: false,
      messageResponseText: "non-streaming reply",
    });

    const middleware = createA2AMentionMiddleware({
      agents: { hello: { url: "http://localhost:3100" } },
      transport,
    });

    const result = await middleware([textBlock("@hello please respond")], "session-1");

    expect(result).toBeDefined();
    expect(calls).toEqual(["sendMessage"]);
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("non-streaming reply");
  });

  test("explicit caller opt-out (stream: false) forces non-streaming even against streaming targets", async () => {
    const { transport, calls } = createInstrumentedTransport({
      supportsStreaming: true,
      messageResponseText: "forced non-streaming",
      // streamItems left empty: if streaming silently kicks in, the stream
      // is empty and the dispatch fails — additional protection.
      streamItems: [],
    });

    const middleware = createA2AMentionMiddleware({
      agents: { hello: { url: "http://localhost:3100" } },
      transport,
      stream: false,
    });

    const result = await middleware([textBlock("@hello please respond")], "session-1");

    expect(result).toBeDefined();
    expect(calls).toEqual(["sendMessage"]);
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.text).toContain("forced non-streaming");
  });

  test("intermediate stream events arrive at the transport BEFORE the middleware's dispatch resolves (canary against silent fallback)", async () => {
    // Order-property assertion: every stream yield must be sequenced
    // strictly before the dispatch resolution. Even if streaming silently
    // fell back to blocking (e.g. someone re-introduced `stream: false`),
    // sendMessageStream would never be called and yieldsSeq.length would
    // be 0 — failing the >1 assertion.
    const { transport, calls, yieldsSeq } = createInstrumentedTransport({
      supportsStreaming: true,
      streamItems: buildStreamingTaskItems("intermediate then terminal"),
      // Tiny per-yield delay so the test scheduler interleaves predictably.
      streamYieldDelayMs: 5,
    });
    const nextSeq = (transport as unknown as { __nextSeq: () => number }).__nextSeq;

    const middleware = createA2AMentionMiddleware({
      agents: { hello: { url: "http://localhost:3100" } },
      transport,
    });

    const result = await middleware([textBlock("@hello stream please")], "session-1");
    const resolveSeq = nextSeq();

    expect(result).toBeDefined();
    expect(calls).toEqual(["sendMessageStream"]);
    // Two intermediate events + one terminal must have yielded before the
    // dispatch resolved.
    expect(yieldsSeq.length).toBeGreaterThan(1);
    for (const seq of yieldsSeq) {
      expect(seq).toBeLessThan(resolveSeq);
    }
  });

  test("regression: streamed delegation produces the same <a2a-delegation-response> framing as non-streaming (terminal-shape stable)", async () => {
    const streaming = createInstrumentedTransport({
      supportsStreaming: true,
      streamItems: buildStreamingTaskItems("identical body"),
    });
    const blocking = createInstrumentedTransport({
      supportsStreaming: false,
      messageResponseText: "identical body",
    });

    const streamingMw = createA2AMentionMiddleware({
      agents: { hello: { url: "http://localhost:3100" } },
      transport: streaming.transport,
    });
    const blockingMw = createA2AMentionMiddleware({
      agents: { hello: { url: "http://localhost:3100" } },
      transport: blocking.transport,
    });

    const a = await streamingMw([textBlock("@hello hi")], "session-1");
    const b = await blockingMw([textBlock("@hello hi")], "session-1");

    const aBlock = a?.[0] as AnnotatedTextBlock;
    const bBlock = b?.[0] as AnnotatedTextBlock;
    expect(aBlock.text).toContain("<a2a-delegation-response>");
    expect(bBlock.text).toContain("<a2a-delegation-response>");
    // Identical body, identical framing — only the path differs.
    expect(aBlock.text).toBe(bBlock.text);
    expect(aBlock.annotations._meta.source).toBe("a2a-delegation");
    expect(bBlock.annotations._meta.source).toBe("a2a-delegation");
  });

  test("emits mention-dispatch-streaming-long-running audit warning when streaming dispatch exceeds threshold", async () => {
    const { transport } = createInstrumentedTransport({
      supportsStreaming: true,
      // Two delayed yields so the stream remains in-flight past the
      // configured warn threshold.
      streamYieldDelayMs: 60,
      streamItems: buildStreamingTaskItems("eventual reply"),
    });

    const audit = createAuditEmitter({ logger: { log: () => {} } });
    const middleware = createA2AMentionMiddleware({
      agents: { slowpoke: { url: "http://localhost:3100" } },
      transport,
      audit,
      // 30ms threshold; the 60ms-per-yield stream is guaranteed to cross it.
      streamingLongWarnMs: 30,
    });

    const result = await middleware([textBlock("@slowpoke please respond")], "session-1");

    expect(result).toBeDefined();
    const warned = audit
      .recent()
      .filter((e) => e.kind === "mention-dispatch-streaming-long-running");
    expect(warned.length).toBe(1);
    const event = warned[0] as Extract<
      ReturnType<typeof audit.recent>[number],
      { kind: "mention-dispatch-streaming-long-running" }
    >;
    expect(event.thresholdMs).toBe(30);
    expect(event.resumptionAvailable).toBe(false);
    expect(event.agentName).toBe("slowpoke");
  });

  test("does NOT emit streaming-long-running warning when the dispatch completes under threshold", async () => {
    const { transport } = createInstrumentedTransport({
      supportsStreaming: true,
      streamItems: buildStreamingTaskItems("fast reply"),
    });

    const audit = createAuditEmitter({ logger: { log: () => {} } });
    const middleware = createA2AMentionMiddleware({
      agents: { fast: { url: "http://localhost:3100" } },
      transport,
      audit,
      streamingLongWarnMs: 5_000,
    });

    await middleware([textBlock("@fast please respond")], "session-1");

    const warned = audit
      .recent()
      .filter((e) => e.kind === "mention-dispatch-streaming-long-running");
    expect(warned.length).toBe(0);
  });

  test("does NOT emit streaming-long-running warning when the target lacks streaming (warning is streaming-only)", async () => {
    const { transport } = createInstrumentedTransport({
      supportsStreaming: false,
      messageResponseText: "non-streaming",
    });

    const audit = createAuditEmitter({ logger: { log: () => {} } });
    const middleware = createA2AMentionMiddleware({
      agents: { plain: { url: "http://localhost:3100" } },
      transport,
      audit,
      streamingLongWarnMs: 1, // even with a 1ms threshold, non-streaming path doesn't arm
    });

    // Wait a tick so the timer would have a chance to fire if it were armed.
    await middleware([textBlock("@plain please respond")], "session-1");
    await new Promise((r) => setTimeout(r, 25));

    const warned = audit
      .recent()
      .filter((e) => e.kind === "mention-dispatch-streaming-long-running");
    expect(warned.length).toBe(0);
  });
});

// `createStreamingMockTransport` is used elsewhere in the suite; importing
// here keeps the linter from flagging the unused mock-a2a-transport export.
void createStreamingMockTransport;
