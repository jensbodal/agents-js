import { describe, expect, test } from "bun:test";
import type { AgentCard } from "@a2a-js/sdk";
import type { AdaptTargetContext, RawAgentCard, TargetAdapter } from "../src/adapters/target.ts";
import { adaptTarget } from "../src/adapters/target.ts";
import { makeAgentCard } from "./mock-a2a-transport.ts";

const MOCK_CARD: AgentCard = makeAgentCard({
  name: "mock-agent",
  description: "A mock agent",
  url: "https://external.example.com",
  protocolVersion: "0.3.0",
});

function makeMockFetch(
  responseCard: RawAgentCard,
  status = 200,
): (input: string | Request | URL, init?: RequestInit) => Promise<Response> {
  return async (_input, _init) => {
    return new Response(JSON.stringify(responseCard), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("adaptTarget", () => {
  test("calls probePath and transforms the card", async () => {
    const calledPaths: string[] = [];
    const adapter: TargetAdapter = {
      probePath: "/.well-known/agent.json",
      transformCard: (_raw, ctx) => {
        calledPaths.push(ctx.probeUrl);
        return MOCK_CARD;
      },
    };

    const result = await adaptTarget(adapter, "https://external.example.com", {
      fetch: makeMockFetch({ name: "agent-zero" }),
    });

    expect(calledPaths).toHaveLength(1);
    expect(calledPaths[0]).toBe("https://external.example.com/.well-known/agent.json");
    expect(result.card).toEqual(MOCK_CARD);
  });

  test("applies authHeader when adapter provides one", async () => {
    const capturedHeaders: string[] = [];

    const adapter: TargetAdapter = {
      probePath: "/.well-known/agent.json",
      authHeader: () => "Bearer test-token",
      transformCard: () => MOCK_CARD,
    };

    const result = await adaptTarget(adapter, "https://external.example.com", {
      fetch: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        if (headers?.Authorization) {
          capturedHeaders.push(headers.Authorization);
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(capturedHeaders).toEqual(["Bearer test-token"]);
    expect(result.authHeader).toBe("Bearer test-token");
  });

  test("omits Authorization header when authHeader returns null", async () => {
    const capturedHeaderKeys: string[] = [];

    const adapter: TargetAdapter = {
      probePath: "/.well-known/agent.json",
      authHeader: () => null,
      transformCard: () => MOCK_CARD,
    };

    await adaptTarget(adapter, "https://external.example.com", {
      fetch: async (_input, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        capturedHeaderKeys.push(...Object.keys(headers ?? {}));
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(capturedHeaderKeys).not.toContain("Authorization");
  });

  test("throws when probe returns non-ok status", async () => {
    const adapter: TargetAdapter = {
      probePath: "/.well-known/agent.json",
      transformCard: () => MOCK_CARD,
    };

    await expect(
      adaptTarget(adapter, "https://external.example.com", {
        fetch: makeMockFetch({}, 404),
      }),
    ).rejects.toThrow("Probe failed");
  });

  test("passes correct context to transformCard", async () => {
    let capturedCtx: AdaptTargetContext | undefined;

    const adapter: TargetAdapter = {
      probePath: "/.well-known/agent.json",
      transformCard: (_raw, ctx) => {
        capturedCtx = ctx;
        return MOCK_CARD;
      },
    };

    await adaptTarget(adapter, "https://external.example.com/", {
      fetch: makeMockFetch({ name: "az" }),
    });

    expect(capturedCtx?.externalUrl).toBe("https://external.example.com/");
    expect(capturedCtx?.probeUrl).toBe("https://external.example.com/.well-known/agent.json");
  });

  test("full smoke: mock fetch → probe → auth → transform", async () => {
    const rawCard: RawAgentCard = {
      name: "agent-zero",
      description: "AZ instance",
      url: "http://localhost:8000",
      version: "2.0.0",
      protocolVersion: "0.3.0",
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      capabilities: { streaming: true },
    };

    const adapter: TargetAdapter = {
      probePath: "/.well-known/agent.json",
      authHeader: () => "Bearer smoke-token",
      transformCard: (raw, ctx) =>
        makeAgentCard({
          name: raw.name as string,
          description: raw.description as string,
          url: ctx.externalUrl,
          version: raw.version as string,
          protocolVersion: raw.protocolVersion as string,
          capabilities: raw.capabilities as Record<string, unknown>,
        }),
    };

    const result = await adaptTarget(adapter, "https://az.example.com", {
      fetch: makeMockFetch(rawCard),
    });

    expect(result.card.supportedInterfaces[0]?.url).toBe("https://az.example.com");
    expect(result.card.name).toBe("agent-zero");
    expect(result.authHeader).toBe("Bearer smoke-token");
    expect(result.probeUrl).toBe("https://az.example.com/.well-known/agent.json");
  });
});
