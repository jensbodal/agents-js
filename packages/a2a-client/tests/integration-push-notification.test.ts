import { afterAll, describe, expect, test } from "bun:test";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import { SdkA2ATransport } from "../src/transport.ts";
import type { ResolvedAgentTarget } from "../src/types.ts";

function createPushAgentCard(url: string): AgentCard {
  return {
    name: "PushTestAgent",
    description: "Agent with push notification support",
    url,
    version: "1.0.0",
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: {
      pushNotifications: true,
    },
  };
}

/** Starts a minimal A2A JSON-RPC server with push notification support. */
function startTestServer(taskStore: InMemoryTaskStore) {
  let cardUrl = "";
  const pushStore = new InMemoryPushNotificationStore();
  const agentCard = createPushAgentCard("http://127.0.0.1");
  const noopExecutor = { execute: async () => {} } as never;
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    noopExecutor,
    undefined,
    pushStore,
  );
  const transportHandler = new JsonRpcTransportHandler(requestHandler);

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/.well-known/agent-card.json") {
        return new Response(JSON.stringify({ ...agentCard, url: cardUrl }), {
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      if (req.method === "POST") {
        const body = await req.json();
        const result = await transportHandler.handle(body);
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
  return { server, pushStore };
}

describe("client-to-server push notification CRUD round-trip via SdkA2ATransport", () => {
  const servers: Array<{ stop: (force?: boolean) => void }> = [];

  afterAll(() => {
    for (const s of servers) {
      s.stop(true);
    }
  });

  test("full CRUD lifecycle", async () => {
    const taskStore = new InMemoryTaskStore();
    taskStore.save({
      kind: "task",
      id: "task-1",
      contextId: "ctx-1",
      status: { state: "working" },
    });

    const { server } = startTestServer(taskStore);
    servers.push(server);

    const transport = new SdkA2ATransport();
    const target: ResolvedAgentTarget = await transport.resolveTarget({
      url: `http://127.0.0.1:${server.port}`,
      mode: "base",
    });

    const setResult = await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook", id: "cfg-1" },
    });
    expect(setResult.taskId).toBe("task-1");
    expect(setResult.pushNotificationConfig.url).toBe("https://example.com/hook");
    expect(setResult.pushNotificationConfig.id).toBe("cfg-1");

    const getResult = await transport.getTaskPushNotificationConfig(target, {
      id: "task-1",
      pushNotificationConfigId: "cfg-1",
    });
    expect(getResult.taskId).toBe("task-1");
    expect(getResult.pushNotificationConfig.url).toBe("https://example.com/hook");

    const listResult = await transport.listTaskPushNotificationConfigs(target, { id: "task-1" });
    expect(listResult).toHaveLength(1);
    expect(listResult[0]?.taskId).toBe("task-1");

    await transport.deleteTaskPushNotificationConfig(target, {
      id: "task-1",
      pushNotificationConfigId: "cfg-1",
    });

    const emptyList = await transport.listTaskPushNotificationConfigs(target, { id: "task-1" });
    expect(emptyList).toEqual([]);
  });

  test("set multiple configs then list", async () => {
    const taskStore = new InMemoryTaskStore();
    taskStore.save({
      kind: "task",
      id: "task-multi",
      contextId: "ctx-multi",
      status: { state: "working" },
    });

    const { server } = startTestServer(taskStore);
    servers.push(server);

    const transport = new SdkA2ATransport();
    const target = await transport.resolveTarget({
      url: `http://127.0.0.1:${server.port}`,
      mode: "base",
    });

    await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-multi",
      pushNotificationConfig: { url: "https://example.com/hook1", id: "cfg-a" },
    });
    await transport.setTaskPushNotificationConfig(target, {
      taskId: "task-multi",
      pushNotificationConfig: { url: "https://example.com/hook2", id: "cfg-b" },
    });

    const configs = await transport.listTaskPushNotificationConfigs(target, { id: "task-multi" });
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.pushNotificationConfig.id).sort()).toEqual(["cfg-a", "cfg-b"]);
  });
});
