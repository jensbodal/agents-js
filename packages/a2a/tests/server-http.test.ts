import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AgentCard } from "@a2a-js/sdk";
import type { InitializeResponse } from "@agents-js/acp";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../src/index.ts";
import { UniversalA2AServer } from "../src/server.ts";
import type { GatewayAgentCard } from "../src/types.ts";

/** Loose JSON shape used to sample HTTP response bodies in tests. */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | { [key: string]: JsonValue }
  | JsonValue[];

interface SampledBody {
  jsonrpc?: string;
  id?: string | number | null;
  name?: string;
  description?: string;
  result?: SampledBody;
  error?: SampledBody & { code?: number; message?: string; data?: SampledBody };
  capabilities?: SampledBody;
  pushNotifications?: boolean;
  streaming?: boolean;
  issues?: JsonValue;
  [key: string]: JsonValue | SampledBody | undefined;
}

function createMockExecutor() {
  return {
    async initialize(): Promise<InitializeResponse> {
      return {
        protocolVersion: 1,
        agentInfo: { name: "MockAgent", version: "1.0.0" },
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

function createMockAgentCard(): GatewayAgentCard {
  return {
    name: "MockAgent",
    description: "Mock agent for testing",
    url: "http://127.0.0.1",
    version: "1.0.0",
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: {},
  };
}

function createExtendedCard(): AgentCard {
  return {
    name: "MockAgent Extended",
    description: "Extended agent card with auth details",
    url: "http://127.0.0.1",
    version: "1.0.0",
    protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
    skills: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    capabilities: {
      pushNotifications: true,
      streaming: true,
    },
    supportsAuthenticatedExtendedCard: true,
  };
}

async function sendJsonRpc(
  port: number | undefined,
  method: string,
  params?: unknown,
  id: number | string = 1,
) {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id,
    method,
  };
  if (params !== undefined) {
    body.params = params;
  }
  return fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("A2A server HTTP handler integration", () => {
  const servers: Array<{ stop: (force?: boolean) => void; port: number | undefined }> = [];

  afterAll(() => {
    for (const server of servers) {
      server.stop(true);
    }
  });

  async function startServer(
    extendedCard?: AgentCard,
  ): Promise<{ stop: (force?: boolean) => void; port: number | undefined }> {
    const card = createMockAgentCard();
    if (extendedCard) {
      card.supportsAuthenticatedExtendedCard = true;
    }
    const serverWrapper = new UniversalA2AServer(
      createMockExecutor() as never,
      card,
      undefined,
      extendedCard ? { extendedAgentCardProvider: extendedCard } : undefined,
    );
    const bunServer = await serverWrapper.start({ port: 0 });
    servers.push(bunServer);
    return bunServer;
  }

  describe("agent card discovery", () => {
    let sharedServer: { stop: (force?: boolean) => void; port: number | undefined };

    beforeAll(async () => {
      sharedServer = await startServer();
    });

    test("GET /.well-known/agent-card.json returns agent card", async () => {
      const response = await fetch(
        `http://127.0.0.1:${sharedServer.port}/.well-known/agent-card.json`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      const body = (await response.json()) as SampledBody;
      expect(body.name).toBe("MockAgent");
      expect(body.description).toBe("Mock agent for testing");
    });

    test("CORS headers are applied to agent card response", async () => {
      const response = await fetch(
        `http://127.0.0.1:${sharedServer.port}/.well-known/agent-card.json`,
      );

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("CORS preflight", () => {
    let sharedServer: { stop: (force?: boolean) => void; port: number | undefined };

    beforeAll(async () => {
      sharedServer = await startServer();
    });

    test("OPTIONS returns 204 with CORS headers when enabled", async () => {
      const response = await fetch(`http://127.0.0.1:${sharedServer.port}`, {
        method: "OPTIONS",
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    });
  });

  describe("JSON-RPC error handling", () => {
    let sharedServer: { stop: (force?: boolean) => void; port: number | undefined };

    beforeAll(async () => {
      sharedServer = await startServer();
    });

    test("returns parse error for invalid JSON", async () => {
      const response = await fetch(`http://127.0.0.1:${sharedServer.port}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(-32700);
      expect(body.error?.message).toBe("Parse error");
    });

    test("returns validation error for malformed request envelope", async () => {
      const response = await fetch(`http://127.0.0.1:${sharedServer.port}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: 1 }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
    });

    test("returns 404 for non-POST, non-OPTIONS, non-card requests", async () => {
      const response = await fetch(`http://127.0.0.1:${sharedServer.port}/some/path`, {
        method: "GET",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("tasks/get", () => {
    let sharedServer: { stop: (force?: boolean) => void; port: number | undefined };

    beforeAll(async () => {
      sharedServer = await startServer();
    });

    test("returns error for nonexistent task", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/get", {
        id: "nonexistent-task",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.jsonrpc).toBe("2.0");
    });

    test("returns validation error for missing id param", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/get", {});

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(-32602);
    });

    test("applies CORS headers to tasks/get responses", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/get", {
        id: "nonexistent",
      });

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("tasks/cancel", () => {
    let sharedServer: { stop: (force?: boolean) => void; port: number | undefined };

    beforeAll(async () => {
      sharedServer = await startServer();
    });

    test("returns error for nonexistent task", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/cancel", {
        id: "nonexistent-task",
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.jsonrpc).toBe("2.0");
    });

    test("returns validation error for missing id param", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/cancel", {});

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(-32602);
    });

    test("applies CORS headers to tasks/cancel responses", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/cancel", {
        id: "nonexistent",
      });

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("agent/getAuthenticatedExtendedCard", () => {
    test("returns extended card when function provider is configured", async () => {
      const card = createMockAgentCard();
      card.supportsAuthenticatedExtendedCard = true;

      const asyncProvider = async () => createExtendedCard();
      const serverWrapper = new UniversalA2AServer(createMockExecutor() as never, card, undefined, {
        extendedAgentCardProvider: asyncProvider,
      });
      const bunServer = await serverWrapper.start({ port: 0 });
      servers.push(bunServer);

      const response = await sendJsonRpc(bunServer.port, "agent/getAuthenticatedExtendedCard");

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.result).toBeDefined();
      expect(body.result?.name).toBe("MockAgent Extended");
      expect(body.result?.capabilities?.pushNotifications).toBe(true);
      expect(body.result?.capabilities?.streaming).toBe(true);
    });

    test("returns basic card for static provider without authenticated context", async () => {
      const extendedCard = createExtendedCard();
      const bunServer = await startServer(extendedCard);

      const response = await sendJsonRpc(bunServer.port, "agent/getAuthenticatedExtendedCard");

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.jsonrpc).toBe("2.0");
      expect(body.result).toBeDefined();
      expect(body.result?.name).toBe("MockAgent");
    });

    test("returns error when extended card provider is not configured", async () => {
      const bunServer = await startServer();

      const response = await sendJsonRpc(bunServer.port, "agent/getAuthenticatedExtendedCard");

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
    });

    test("accepts request without params", async () => {
      const card = createMockAgentCard();
      card.supportsAuthenticatedExtendedCard = true;

      const asyncProvider = async () => createExtendedCard();
      const serverWrapper = new UniversalA2AServer(createMockExecutor() as never, card, undefined, {
        extendedAgentCardProvider: asyncProvider,
      });
      const bunServer = await serverWrapper.start({ port: 0 });
      servers.push(bunServer);

      const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "agent/getAuthenticatedExtendedCard",
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.result).toBeDefined();
      expect(body.result?.name).toBe("MockAgent Extended");
    });

    test("applies CORS headers to extended card responses", async () => {
      const extendedCard = createExtendedCard();
      const bunServer = await startServer(extendedCard);

      const response = await sendJsonRpc(bunServer.port, "agent/getAuthenticatedExtendedCard");

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    test("supports async function provider", async () => {
      const card = createMockAgentCard();
      card.supportsAuthenticatedExtendedCard = true;

      const asyncProvider = async () => createExtendedCard();
      const serverWrapper = new UniversalA2AServer(createMockExecutor() as never, card, undefined, {
        extendedAgentCardProvider: asyncProvider,
      });
      const bunServer = await serverWrapper.start({ port: 0 });
      servers.push(bunServer);

      const response = await sendJsonRpc(bunServer.port, "agent/getAuthenticatedExtendedCard");

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.result).toBeDefined();
      expect(body.result?.name).toBe("MockAgent Extended");
    });
  });

  describe("unknown methods", () => {
    let sharedServer: { stop: (force?: boolean) => void; port: number | undefined };

    beforeAll(async () => {
      sharedServer = await startServer();
    });

    test("returns method not found error for unknown method", async () => {
      const response = await sendJsonRpc(sharedServer.port, "nonexistent/method", {});

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(-32601);
    });

    test("CORS headers applied to error responses for unknown methods", async () => {
      const response = await sendJsonRpc(sharedServer.port, "nonexistent/method", {});

      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });
  });

  describe("push notification validation via HTTP", () => {
    let sharedServer: { stop: (force?: boolean) => void; port: number | undefined };

    beforeAll(async () => {
      sharedServer = await startServer();
    });

    test("returns -32602 error for malformed push notification params", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/pushNotificationConfig/set", {
        url: 123,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(-32602);
      expect(body.error?.data?.issues).toBeDefined();
    });

    test("returns -32602 error for non-http URL in push notification config", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/pushNotificationConfig/set", {
        taskId: "task-1",
        pushNotificationConfig: { url: "ftp://example.com/hook" },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(-32602);
    });

    test("returns -32602 error for plain string URL in push notification config", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/pushNotificationConfig/set", {
        taskId: "task-1",
        pushNotificationConfig: { url: "not-a-valid-url" },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(-32602);
    });

    test("accepts valid https URL in push notification config", async () => {
      const response = await sendJsonRpc(sharedServer.port, "tasks/pushNotificationConfig/set", {
        taskId: "task-1",
        pushNotificationConfig: { url: "https://example.com/webhook" },
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      // The task doesn't exist, but validation passes — error is about missing task, not validation
      if (body.error) {
        expect(body.error?.code).not.toBe(-32602);
      }
    });
  });

  describe("message/send validation", () => {
    let sharedServer: { stop: (force?: boolean) => void; port: number | undefined };

    beforeAll(async () => {
      sharedServer = await startServer();
    });

    test("returns validation error for missing message in send request", async () => {
      const response = await sendJsonRpc(sharedServer.port, "message/send", {});

      expect(response.status).toBe(200);
      const body = (await response.json()) as SampledBody;
      expect(body.error).toBeDefined();
      expect(body.error?.code).toBe(-32602);
    });
  });
});
