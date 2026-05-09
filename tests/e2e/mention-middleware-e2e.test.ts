import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { ServeACPOverA2AHandle } from "@agents-js/a2a";
import { buildAgentCard, serveACPOverA2A } from "@agents-js/a2a";
import { createA2AMentionMiddleware } from "@agents-js/a2a-client";

const mockAgentPath = path.resolve(import.meta.dir, "../../tests/mock-acp-agent.cjs");

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

describe("Mention Middleware E2E (real A2A server)", () => {
  let gateway: ServeACPOverA2AHandle;

  beforeAll(async () => {
    gateway = await serveACPOverA2A({
      acp: { command: "node", args: [mockAgentPath] },
      agentCard: buildAgentCard({
        name: "test-agent",
        description: "Test agent for mention middleware e2e",
        capabilities: { "text-to-text": {} },
      }),
      host: "127.0.0.1",
      port: 0,
    });
  });

  afterAll(() => {
    gateway?.stop();
  });

  test("dispatches @mention to real A2A server and returns annotated response", async () => {
    const middleware = createA2AMentionMiddleware({
      agents: { "test-agent": { url: `http://127.0.0.1:${gateway.port}` } },
    });

    const content: ContentBlock[] = [{ type: "text", text: "@test-agent hello" } as ContentBlock];
    const result = await middleware(content, "e2e-session-1");

    // Middleware should return response blocks prepended to original content
    expect(result).toBeDefined();
    expect(result?.length).toBeGreaterThanOrEqual(2);

    // Last block should be the original content
    const originalBlock = result?.[result.length - 1] as { type: string; text: string };
    expect(originalBlock.text).toBe("@test-agent hello");

    // First block should be the agent response with delegation annotation
    const responseBlock = result?.[0] as AnnotatedTextBlock;
    expect(responseBlock.type).toBe("text");
    expect(responseBlock.text).toContain("Hello from Mock ACP Agent!");
    expect(responseBlock.annotations._meta.source).toBe("a2a-delegation");
    expect(responseBlock.annotations._meta.agentName).toBe("test-agent");
    expect(responseBlock.annotations._meta.agentUrl).toContain(`127.0.0.1:${gateway.port}`);
    expect(responseBlock.annotations.audience).toContain("assistant");
  }, 30000);
});
