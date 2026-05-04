import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import { createA2AMentionMiddleware } from "../src/middleware.ts";
import type { AgentTargetInput } from "../src/types.ts";
import { createMockTarget, createMockTransport } from "./mock-a2a-transport.ts";

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
