import { afterAll, describe, expect, test } from "bun:test";
import { TaskState } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  ServerCallContext,
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

/**
 * Shared call context. `new ServerCallContext({})` resolves to the
 * unauthenticated-user scope, so seeded tasks are visible to the
 * handler's CRUD operations (they share the same owner).
 */
const callContext = new ServerCallContext({});

/** Seed a task directly into the store so push notification CRUD can operate on it. */
function seedTask(taskStore: InMemoryTaskStore, taskId: string) {
  taskStore.save(
    {
      id: taskId,
      contextId: `ctx-${taskId}`,
      status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
      artifacts: [],
      history: [],
      metadata: undefined,
    },
    callContext,
  );
}

function createPushAgentCard(): GatewayAgentCard {
  return {
    name: "PushTestAgent",
    description: "Agent with push notification support",
    supportedInterfaces: [
      {
        url: "http://127.0.0.1",
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    version: "1.0.0",
    securitySchemes: {},
    securityRequirements: [],
    skills: [],
    signatures: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: {
      extensions: [],
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
  return handler.handle(
    {
      jsonrpc: "2.0",
      id,
      method,
      params,
    },
    callContext,
  );
}

// A2A 1.0 renamed the JSON-RPC verbs to PascalCase
// (`CreateTaskPushNotificationConfig`, ...) and flattened
// `TaskPushNotificationConfig` to `{ taskId, id, url, ... }` — there is no
// nested `pushNotificationConfig` envelope or `pushNotificationConfigId`.
describe("push notification CRUD via JsonRpcTransportHandler", () => {
  test("create — stores a push notification config for a task", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-1");

    const result = await handleRpc(transportHandler, "CreateTaskPushNotificationConfig", {
      taskId: "task-1",
      url: "https://example.com/hook",
      id: "config-1",
    });

    expect(result).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        taskId: "task-1",
        url: "https://example.com/hook",
        id: "config-1",
      },
    });
  });

  test("get — retrieves a push notification config", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-1");

    await handleRpc(transportHandler, "CreateTaskPushNotificationConfig", {
      taskId: "task-1",
      url: "https://example.com/hook",
      id: "config-1",
    });

    const result = await handleRpc(transportHandler, "GetTaskPushNotificationConfig", {
      taskId: "task-1",
      id: "config-1",
    });

    expect(result).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        taskId: "task-1",
        url: "https://example.com/hook",
        id: "config-1",
      },
    });
  });

  test("list — returns all push notification configs for a task", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-1");

    await handleRpc(transportHandler, "CreateTaskPushNotificationConfig", {
      taskId: "task-1",
      url: "https://example.com/hook1",
      id: "cfg-1",
    });
    await handleRpc(transportHandler, "CreateTaskPushNotificationConfig", {
      taskId: "task-1",
      url: "https://example.com/hook2",
      id: "cfg-2",
    });

    const result = (await handleRpc(transportHandler, "ListTaskPushNotificationConfigs", {
      taskId: "task-1",
    })) as { result: { configs: unknown[] } };

    expect(Array.isArray(result.result.configs)).toBe(true);
    expect(result.result.configs.length).toBe(2);
  });

  test("delete — removes a push notification config", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-1");

    await handleRpc(transportHandler, "CreateTaskPushNotificationConfig", {
      taskId: "task-1",
      url: "https://example.com/hook",
      id: "config-1",
    });

    const deleteResult = await handleRpc(transportHandler, "DeleteTaskPushNotificationConfig", {
      taskId: "task-1",
      id: "config-1",
    });

    expect(deleteResult).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: null,
    });

    const listResult = (await handleRpc(transportHandler, "ListTaskPushNotificationConfigs", {
      taskId: "task-1",
    })) as { result: { configs: unknown[] } };

    expect(listResult.result.configs ?? []).toEqual([]);
  });

  test("returns error for nonexistent task", async () => {
    const { transportHandler } = createHandlerWithStore();

    const result = (await handleRpc(transportHandler, "CreateTaskPushNotificationConfig", {
      taskId: "nonexistent",
      url: "https://example.com/hook",
    })) as { error?: { code: number; message: string } };

    expect(result.error).toBeDefined();
    expect(result.error?.code).toBeNumber();
  });

  test("full CRUD round-trip", async () => {
    const { taskStore, transportHandler } = createHandlerWithStore();
    seedTask(taskStore, "task-crud");

    const setResult = (await handleRpc(transportHandler, "CreateTaskPushNotificationConfig", {
      taskId: "task-crud",
      url: "https://example.com/hook",
      id: "crud-cfg",
    })) as { result: { id: string } };
    expect(setResult.result.id).toBe("crud-cfg");

    const getResult = (await handleRpc(transportHandler, "GetTaskPushNotificationConfig", {
      taskId: "task-crud",
      id: "crud-cfg",
    })) as { result: { url: string } };
    expect(getResult.result.url).toBe("https://example.com/hook");

    const listResult = (await handleRpc(transportHandler, "ListTaskPushNotificationConfigs", {
      taskId: "task-crud",
    })) as { result: { configs: unknown[] } };
    expect(listResult.result.configs.length).toBe(1);

    const deleteResult = (await handleRpc(transportHandler, "DeleteTaskPushNotificationConfig", {
      taskId: "task-crud",
      id: "crud-cfg",
    })) as { result: null };
    expect(deleteResult.result).toBeNull();

    const emptyList = (await handleRpc(transportHandler, "ListTaskPushNotificationConfigs", {
      taskId: "task-crud",
    })) as { result: { configs: unknown[] } };
    expect(emptyList.result.configs ?? []).toEqual([]);
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
        method: "CreateTaskPushNotificationConfig",
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

  // A2A 1.0 removed the gateway-side param pre-validation that emitted
  // `-32602` (invalid params) with a `data.issues` payload for a malformed
  // push-notification config. The proto `fromJSON` decode plus the SDK's
  // request handler now surface a numeric JSON-RPC error for a bad config
  // (e.g. `-32001` for an unknown task); the exact code is an SDK internal,
  // so these assert only that an error envelope is returned rather than
  // pinning the removed `-32602`/`issues` shape.
  test("returns a JSON-RPC error for malformed push notification params", async () => {
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
        method: "CreateTaskPushNotificationConfig",
        params: { url: 123 },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBeNumber();
  });

  test("returns a JSON-RPC error for non-http URL in push notification config", async () => {
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
        method: "CreateTaskPushNotificationConfig",
        params: {
          taskId: "task-1",
          url: "ftp://example.com/hook",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBeNumber();
  });

  test("returns a JSON-RPC error for plain string URL in push notification config", async () => {
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
        method: "CreateTaskPushNotificationConfig",
        params: {
          taskId: "task-1",
          url: "not-a-url",
        },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBeNumber();
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
        method: "CreateTaskPushNotificationConfig",
        params: { url: 123 },
      }),
    });

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
