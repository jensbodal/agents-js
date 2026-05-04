import { afterAll, describe, expect, test } from "bun:test";
import {
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
} from "@a2a-js/sdk/server";
import type { InitializeResponse } from "@agents-js/acp";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../src/index.ts";
import { UniversalA2AServer } from "../src/server.ts";
import type { GatewayAgentCard } from "../src/types.ts";

interface SampledBody {
  jsonrpc?: string;
  id?: string | number | null;
  result?: SampledBody;
  error?: SampledBody & { code?: number; message?: string; data?: SampledBody };
  issues?: unknown;
  [key: string]: unknown;
}

/** Seed a task directly into the store so push notification CRUD can operate on it. */
function seedTask(taskStore: InMemoryTaskStore, taskId: string) {
  taskStore.save({
    kind: "task",
    id: taskId,
    contextId: `ctx-${taskId}`,
    status: { state: "working" },
  });
}

function createPushAgentCard(): GatewayAgentCard {
  return {
    name: "PushTestAgent",
    description: "Agent with push notification support",
    url: "http://127.0.0.1",
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

/** Build a handler with direct access to the task store (bypasses the executor). */
function createHandlerWithStore() {
  const taskStore = new InMemoryTaskStore();
  const pushStore = new InMemoryPushNotificationStore();
  const agentCard = createPushAgentCard();
  const noopExecutor = { execute: async () => {} } as never;

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    noopExecutor,
    undefined,
    pushStore,
  );
  const transportHandler = new JsonRpcTransportHandler(requestHandler);

  return { taskStore, pushStore, transportHandler };
}

async function handleRpc(
  handler: JsonRpcTransportHandler,
  method: string,
  params: unknown,
  id = 1,
) {
  return handler.handle({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });
}

describe("push notification CRUD via JsonRpcTransportHandler", () => {
  test("set — stores a push notification config for a task", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-1");

    const result = await handleRpc(transportHandler, "tasks/pushNotificationConfig/set", {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook", id: "config-1" },
    });

    expect(result).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        taskId: "task-1",
        pushNotificationConfig: {
          url: "https://example.com/hook",
          id: "config-1",
        },
      },
    });
  });

  test("get — retrieves a push notification config", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-1");

    await handleRpc(transportHandler, "tasks/pushNotificationConfig/set", {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook", id: "config-1" },
    });

    const result = await handleRpc(transportHandler, "tasks/pushNotificationConfig/get", {
      id: "task-1",
      pushNotificationConfigId: "config-1",
    });

    expect(result).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        taskId: "task-1",
        pushNotificationConfig: {
          url: "https://example.com/hook",
          id: "config-1",
        },
      },
    });
  });

  test("list — returns all push notification configs for a task", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-1");

    await handleRpc(transportHandler, "tasks/pushNotificationConfig/set", {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook1", id: "cfg-1" },
    });
    await handleRpc(transportHandler, "tasks/pushNotificationConfig/set", {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook2", id: "cfg-2" },
    });

    const result = (await handleRpc(transportHandler, "tasks/pushNotificationConfig/list", {
      id: "task-1",
    })) as { result: unknown[] };

    expect(Array.isArray((result as { result: unknown }).result)).toBe(true);
    expect((result as { result: unknown[] }).result.length).toBe(2);
  });

  test("delete — removes a push notification config", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-1");

    await handleRpc(transportHandler, "tasks/pushNotificationConfig/set", {
      taskId: "task-1",
      pushNotificationConfig: { url: "https://example.com/hook", id: "config-1" },
    });

    const deleteResult = await handleRpc(transportHandler, "tasks/pushNotificationConfig/delete", {
      id: "task-1",
      pushNotificationConfigId: "config-1",
    });

    expect(deleteResult).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: null,
    });

    const listResult = (await handleRpc(transportHandler, "tasks/pushNotificationConfig/list", {
      id: "task-1",
    })) as { result: unknown[] };

    expect((listResult as { result: unknown[] }).result).toEqual([]);
  });

  test("returns error for nonexistent task", async () => {
    const { transportHandler } = createHandlerWithStore();

    const result = (await handleRpc(transportHandler, "tasks/pushNotificationConfig/set", {
      taskId: "nonexistent",
      pushNotificationConfig: { url: "https://example.com/hook" },
    })) as { error?: { code: number; message: string } };

    expect(result.error).toBeDefined();
    expect(result.error?.code).toBeNumber();
  });

  test("full CRUD round-trip", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-crud");

    const setResult = (await handleRpc(transportHandler, "tasks/pushNotificationConfig/set", {
      taskId: "task-crud",
      pushNotificationConfig: { url: "https://example.com/hook", id: "crud-cfg" },
    })) as { result: { pushNotificationConfig: { id: string } } };
    expect(setResult.result.pushNotificationConfig.id).toBe("crud-cfg");

    const getResult = (await handleRpc(transportHandler, "tasks/pushNotificationConfig/get", {
      id: "task-crud",
      pushNotificationConfigId: "crud-cfg",
    })) as { result: { pushNotificationConfig: { url: string } } };
    expect(getResult.result.pushNotificationConfig.url).toBe("https://example.com/hook");

    const listResult = (await handleRpc(transportHandler, "tasks/pushNotificationConfig/list", {
      id: "task-crud",
    })) as { result: unknown[] };
    expect(listResult.result.length).toBe(1);

    const deleteResult = (await handleRpc(transportHandler, "tasks/pushNotificationConfig/delete", {
      id: "task-crud",
      pushNotificationConfigId: "crud-cfg",
    })) as { result: null };
    expect(deleteResult.result).toBeNull();

    const emptyList = (await handleRpc(transportHandler, "tasks/pushNotificationConfig/list", {
      id: "task-crud",
    })) as { result: unknown[] };
    expect(emptyList.result).toEqual([]);
  });
});

describe("A2A server HTTP push notification integration", () => {
  const servers: Array<{ stop: (force?: boolean) => void; port: number | undefined }> = [];

  afterAll(() => {
    for (const server of servers) {
      server.stop(true);
    }
  });

  function createMockExecutor() {
    return {
      async initialize(): Promise<InitializeResponse> {
        return {
          protocolVersion: 1,
          agentInfo: { name: "PushTestAgent", version: "1.0.0" },
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: { http: false, sse: false },
            promptCapabilities: { image: false },
          },
        };
      },
      async execute() {},
      async cancelTask() {},
    };
  }

  test("returns JSON-RPC error for push notification set on nonexistent task", async () => {
    const card = createPushAgentCard();
    const serverWrapper = new UniversalA2AServer(createMockExecutor() as never, card);
    const bunServer = await serverWrapper.start({ port: 0 });
    servers.push(bunServer);

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: {
          taskId: "nonexistent-task",
          pushNotificationConfig: { url: "https://example.com/hook" },
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBeNumber();
  });

  test("returns -32602 error for malformed push notification params", async () => {
    const card = createPushAgentCard();
    const serverWrapper = new UniversalA2AServer(createMockExecutor() as never, card);
    const bunServer = await serverWrapper.start({ port: 0 });
    servers.push(bunServer);

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: { url: 123 },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.data?.issues).toBeDefined();
  });

  test("returns -32602 error for non-http URL in push notification config", async () => {
    const card = createPushAgentCard();
    const serverWrapper = new UniversalA2AServer(createMockExecutor() as never, card);
    const bunServer = await serverWrapper.start({ port: 0 });
    servers.push(bunServer);

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: {
          taskId: "task-1",
          pushNotificationConfig: { url: "ftp://example.com/hook" },
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe(-32602);
  });

  test("returns -32602 error for plain string URL in push notification config", async () => {
    const card = createPushAgentCard();
    const serverWrapper = new UniversalA2AServer(createMockExecutor() as never, card);
    const bunServer = await serverWrapper.start({ port: 0 });
    servers.push(bunServer);

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: {
          taskId: "task-1",
          pushNotificationConfig: { url: "not-a-url" },
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe(-32602);
  });

  test("CORS headers applied to push notification error responses", async () => {
    const card = createPushAgentCard();
    const serverWrapper = new UniversalA2AServer(createMockExecutor() as never, card);
    const bunServer = await serverWrapper.start({ port: 0, cors: true });
    servers.push(bunServer);

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: { url: 123 },
      }),
    });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
