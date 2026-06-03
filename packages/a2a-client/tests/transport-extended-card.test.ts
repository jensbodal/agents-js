import { afterAll, describe, expect, test } from "bun:test";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import { SdkA2ATransport } from "../src/transport.ts";
import type { ResolvedAgentTarget } from "../src/types.ts";
import { makeAgentCard } from "./mock-a2a-transport.ts";

function createBaseCard(url: string): AgentCard {
  return makeAgentCard({
    name: "BaseAgent",
    description: "Basic agent card",
    url,
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    capabilities: { extendedAgentCard: true },
  });
}

function createExtendedCard(url: string): AgentCard {
  return makeAgentCard({
    name: "ExtendedAgent",
    description: "Extended agent card with extra capabilities",
    url,
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    capabilities: { pushNotifications: true, streaming: true },
  });
}

function startTestServer() {
  let cardUrl = "";
  const baseCard = createBaseCard("http://127.0.0.1");
  const taskStore = new InMemoryTaskStore();
  const noopExecutor = { execute: async () => {} } as never;
  const extendedCardProvider = async () => createExtendedCard(cardUrl);
  const requestHandler = new DefaultRequestHandler(
    baseCard,
    taskStore,
    noopExecutor,
    undefined,
    undefined,
    undefined,
    extendedCardProvider,
  );
  const transportHandler = new JsonRpcTransportHandler(requestHandler);

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/.well-known/agent-card.json") {
        return new Response(JSON.stringify(createBaseCard(cardUrl)), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const result = await transportHandler.handle(body, new ServerCallContext({}));
        return new Response(JSON.stringify(result), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  cardUrl = `http://127.0.0.1:${server.port}`;
  return server;
}

describe("SdkA2ATransport.getExtendedAgentCard", () => {
  const servers: Array<{ stop: (force?: boolean) => void }> = [];

  afterAll(() => {
    for (const s of servers) {
      s.stop(true);
    }
  });

  test("delegates to client.getExtendedAgentCard, not client.getAgentCard", async () => {
    const server = startTestServer();
    servers.push(server);

    const transport = new SdkA2ATransport();
    const target: ResolvedAgentTarget = await transport.resolveTarget({
      url: `http://127.0.0.1:${server.port}`,
      mode: "base",
    });

    // The base card has name "BaseAgent", the extended card has name "ExtendedAgent".
    // If delegation is correct (client.getExtendedAgentCard), we get "ExtendedAgent".
    // If delegation is wrong (client.getAgentCard), we get "BaseAgent".
    const extendedCard = await transport.getExtendedAgentCard(target);

    expect(extendedCard.name).toBe("ExtendedAgent");
    expect(extendedCard.capabilities?.pushNotifications).toBe(true);
    expect(extendedCard.capabilities?.streaming).toBe(true);
  });
});
