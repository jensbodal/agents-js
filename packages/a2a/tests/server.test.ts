import { afterAll, describe, expect, test } from "bun:test";
import type { InitializeResponse } from "@agents-js/acp";
import { CURRENT_A2A_PROTOCOL_VERSION } from "../src/index.ts";
import {
  buildAgentCardBaseUrl,
  DEFAULT_MAX_REQUEST_BODY_SIZE,
  formatBindAddress,
  normalizeAdvertisedHost,
  UniversalA2AServer,
} from "../src/server.ts";
import type { GatewayAgentCard } from "../src/types.ts";

interface SampledBody {
  jsonrpc?: string;
  id?: string | number | null;
  result?: SampledBody;
  error?: SampledBody & {
    code?: number;
    message?: string;
    data?: SampledBody & { maxBytes?: number };
  };
  [key: string]: unknown;
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

describe("A2A host formatting", () => {
  test("normalizes wildcard and missing hosts for advertised URLs", () => {
    expect(normalizeAdvertisedHost()).toBe("127.0.0.1");
    expect(normalizeAdvertisedHost("0.0.0.0")).toBe("127.0.0.1");
    expect(normalizeAdvertisedHost("::")).toBe("127.0.0.1");
  });

  test("builds advertised URLs for IPv4 and wildcard hosts", () => {
    expect(buildAgentCardBaseUrl(40100, "127.0.0.1")).toBe("http://127.0.0.1:40100");
    expect(buildAgentCardBaseUrl(40100, "0.0.0.0")).toBe("http://127.0.0.1:40100");
    expect(buildAgentCardBaseUrl(40100, "::")).toBe("http://127.0.0.1:40100");
  });

  test("builds advertised URLs for IPv6 hosts with brackets", () => {
    expect(buildAgentCardBaseUrl(40100, "::1")).toBe("http://[::1]:40100");
  });

  test("formats bind addresses for IPv4 and IPv6 hosts", () => {
    expect(formatBindAddress(40100, "127.0.0.1")).toBe("127.0.0.1:40100");
    expect(formatBindAddress(40100, "0.0.0.0")).toBe("0.0.0.0:40100");
    expect(formatBindAddress(40100, "::")).toBe("[::]:40100");
    expect(formatBindAddress(40100, "::1")).toBe("[::1]:40100");
  });
});

describe("DEFAULT_MAX_REQUEST_BODY_SIZE", () => {
  test("equals 4 MB", () => {
    expect(DEFAULT_MAX_REQUEST_BODY_SIZE).toBe(4 * 1024 * 1024);
  });
});

describe("A2A server request size limits", () => {
  const servers: Array<{ stop: (force?: boolean) => void }> = [];

  afterAll(() => {
    for (const server of servers) {
      server.stop(true);
    }
  });

  test("returns 413 for requests with Content-Length exceeding the limit", async () => {
    const server = new UniversalA2AServer(createMockExecutor() as never, createMockAgentCard());
    const bunServer = await server.start({ port: 0, maxRequestBodySize: 100 });
    servers.push(bunServer);

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "200",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "m1",
            role: "user",
            parts: [{ kind: "text", text: "x".repeat(150) }],
          },
        },
      }),
    });

    expect(response.status).toBe(413);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toBe("Request body too large");
    expect(body.error?.data?.maxBytes).toBe(100);
  });

  test("accepts POST JSON-RPC requests within the size limit", async () => {
    const server = new UniversalA2AServer(createMockExecutor() as never, createMockAgentCard());
    const bunServer = await server.start({ port: 0, maxRequestBodySize: 10_000 });
    servers.push(bunServer);

    const jsonRpcBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { id: "nonexistent-task" },
    });

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: jsonRpcBody,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as SampledBody;
    expect(body.jsonrpc).toBe("2.0");
  });

  test("rejects oversized body sent as a stream without Content-Length header", async () => {
    const server = new UniversalA2AServer(createMockExecutor() as never, createMockAgentCard());
    const maxSize = 100;
    const bunServer = await server.start({ port: 0, maxRequestBodySize: maxSize });
    servers.push(bunServer);

    const oversizedPayload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "x".repeat(200) }],
        },
      },
    });

    // Use a ReadableStream body so Bun does not auto-populate Content-Length.
    // This exercises the server's body-read size guard (arrayBuffer path)
    // rather than the Content-Length header check.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(oversizedPayload));
        controller.close();
      },
    });

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect(response.status).toBe(413);
    const body = (await response.json()) as SampledBody;
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message).toBe("Request body too large");
    expect(body.error?.data?.maxBytes).toBe(maxSize);
  });

  test("applies CORS headers to 413 responses", async () => {
    const server = new UniversalA2AServer(createMockExecutor() as never, createMockAgentCard());
    const bunServer = await server.start({ port: 0, cors: true, maxRequestBodySize: 50 });
    servers.push(bunServer);

    const response = await fetch(`http://127.0.0.1:${bunServer.port}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "200",
      },
      body: "x".repeat(200),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
