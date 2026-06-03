import { afterAll, describe, expect, test } from "bun:test";
import { type AgentCard, type Task, type TaskPushNotificationConfig, TaskState } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
} from "@a2a-js/sdk/server";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../../a2a/src/index.ts";
import { SdkA2ATransport } from "../src/transport.ts";
import type { ResolvedAgentTarget } from "../src/types.ts";
import { makeAgentCard, makeTask } from "./mock-a2a-transport.ts";

function createPushAgentCard(url: string): AgentCard {
  return makeAgentCard({
    name: "PushTestAgent",
    description: "Agent with push notification support",
    url,
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    capabilities: { pushNotifications: true },
  });
}

function makeConfig(taskId: string, id: string, url: string): TaskPushNotificationConfig {
  return { tenant: "", id, taskId, url, token: "", authentication: undefined };
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
        return new Response(JSON.stringify(createPushAgentCard(cardUrl)), {
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
    const ctx = new ServerCallContext({});
    const task1: Task = makeTask({
      id: "task-1",
      contextId: "ctx-1",
      state: TaskState.TASK_STATE_WORKING,
    });
    await taskStore.save(task1, ctx);

    const { server } = startTestServer(taskStore);
    servers.push(server);

    const transport = new SdkA2ATransport();
    const target: ResolvedAgentTarget = await transport.resolveTarget({
      url: `http://127.0.0.1:${server.port}`,
      mode: "base",
    });

    const setResult = await transport.setTaskPushNotificationConfig(
      target,
      makeConfig("task-1", "cfg-1", "https://example.com/hook"),
    );
    expect(setResult.taskId).toBe("task-1");
    expect(setResult.url).toBe("https://example.com/hook");
    expect(setResult.id).toBe("cfg-1");

    const getResult = await transport.getTaskPushNotificationConfig(target, {
      tenant: "",
      taskId: "task-1",
      id: "cfg-1",
    });
    expect(getResult.taskId).toBe("task-1");
    expect(getResult.url).toBe("https://example.com/hook");

    const listResult = await transport.listTaskPushNotificationConfigs(target, {
      tenant: "",
      taskId: "task-1",
      pageSize: 0,
      pageToken: "",
    });
    expect(listResult).toHaveLength(1);
    expect(listResult[0]?.taskId).toBe("task-1");

    await transport.deleteTaskPushNotificationConfig(target, {
      tenant: "",
      taskId: "task-1",
      id: "cfg-1",
    });

    const emptyList = await transport.listTaskPushNotificationConfigs(target, {
      tenant: "",
      taskId: "task-1",
      pageSize: 0,
      pageToken: "",
    });
    expect(emptyList).toEqual([]);
  });

  test("set multiple configs then list", async () => {
    const taskStore = new InMemoryTaskStore();
    const ctx = new ServerCallContext({});
    const taskMulti: Task = makeTask({
      id: "task-multi",
      contextId: "ctx-multi",
      state: TaskState.TASK_STATE_WORKING,
    });
    await taskStore.save(taskMulti, ctx);

    const { server } = startTestServer(taskStore);
    servers.push(server);

    const transport = new SdkA2ATransport();
    const target = await transport.resolveTarget({
      url: `http://127.0.0.1:${server.port}`,
      mode: "base",
    });

    await transport.setTaskPushNotificationConfig(
      target,
      makeConfig("task-multi", "cfg-a", "https://example.com/hook1"),
    );
    await transport.setTaskPushNotificationConfig(
      target,
      makeConfig("task-multi", "cfg-b", "https://example.com/hook2"),
    );

    const configs = await transport.listTaskPushNotificationConfigs(target, {
      tenant: "",
      taskId: "task-multi",
      pageSize: 0,
      pageToken: "",
    });
    expect(configs).toHaveLength(2);
    expect(configs.map((c) => c.id).sort()).toEqual(["cfg-a", "cfg-b"]);
  });
});
