import { describe, expect, test } from "bun:test";
import {
  ValidationError,
  validateA2ARequest,
  validateACPEnvelope,
  validateACPRequest,
  validateACPResponse,
  validateAgentCard,
  validateJsonRpcEnvelope,
  validateRuntimeManifest,
} from "../src/index.ts";

describe("validation modes", () => {
  test("json-rpc validators support strict, loose, and filter modes", () => {
    const input = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      traceId: "trace-1",
    };
    const original = structuredClone(input);

    expect(() => validateJsonRpcEnvelope(input, "request")).toThrow(ValidationError);

    const loose = validateJsonRpcEnvelope(input, "request", { mode: "loose" }) as Record<
      string,
      unknown
    >;
    expect(loose.traceId).toBe("trace-1");

    const filtered = validateJsonRpcEnvelope(input, "request", {
      mode: "filter",
    }) as Record<string, unknown>;
    expect(filtered.traceId).toBeUndefined();
    expect(input).toEqual(original);
  });

  test("a2a validators support strict, loose, and filter modes", () => {
    const input = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      traceId: "trace-1",
      params: {
        message: {
          messageId: "msg-1",
          role: "user",
          parts: [{ kind: "text", text: "hello" }],
          debug: true,
        },
      },
    };
    const original = structuredClone(input);

    expect(() => validateA2ARequest(input)).toThrow(ValidationError);

    const loose = validateA2ARequest(input, { mode: "loose" }) as {
      params: { message: { debug?: boolean } };
      traceId?: string;
    };
    expect(loose.traceId).toBe("trace-1");
    expect(loose.params.message.debug).toBe(true);

    const filtered = validateA2ARequest(input, { mode: "filter" }) as {
      params: { message: Record<string, unknown> };
      traceId?: string;
    };
    expect(filtered.traceId).toBeUndefined();
    expect(filtered.params.message.debug).toBeUndefined();
    expect(input).toEqual(original);
  });

  test("agent card validator supports strict, loose, and filter modes", () => {
    const input = {
      name: "test-agent",
      description: "agent",
      url: "http://127.0.0.1:3000",
      version: "1.0.0",
      protocolVersion: "0.2.1",
      skills: [],
      defaultInputModes: ["text"],
      defaultOutputModes: ["text"],
      capabilities: {},
      extra: true,
    };
    const original = structuredClone(input);

    expect(() => validateAgentCard(input)).toThrow(ValidationError);

    const loose = validateAgentCard(input, { mode: "loose" }) as unknown as Record<string, unknown>;
    expect(loose.extra).toBe(true);

    const filtered = validateAgentCard(input, { mode: "filter" }) as unknown as Record<
      string,
      unknown
    >;
    expect(filtered.extra).toBeUndefined();
    expect(input).toEqual(original);
  });

  test("runtime manifest validator supports strict, loose, and filter modes", () => {
    const input = {
      name: "codex",
      version: "1.0.0",
      extra: true,
    };
    const original = structuredClone(input);

    expect(() => validateRuntimeManifest(input, "codex")).toThrow(ValidationError);

    const loose = validateRuntimeManifest(input, "codex", { mode: "loose" }) as Record<
      string,
      unknown
    >;
    expect(loose.extra).toBe(true);

    const filtered = validateRuntimeManifest(input, "codex", { mode: "filter" }) as Record<
      string,
      unknown
    >;
    expect(filtered.extra).toBeUndefined();
    expect(input).toEqual(original);
  });

  test("acp envelope validator supports strict, loose, and filter modes", () => {
    const input = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp", mcpServers: [] },
      extra: true,
    };
    const original = structuredClone(input);

    expect(() => validateACPEnvelope(input)).toThrow(ValidationError);

    const loose = validateACPEnvelope(input, { mode: "loose" }) as unknown as Record<
      string,
      unknown
    >;
    expect(loose.extra).toBe(true);

    const filtered = validateACPEnvelope(input, { mode: "filter" }) as unknown as Record<
      string,
      unknown
    >;
    expect(filtered.extra).toBeUndefined();
    expect(input).toEqual(original);
  });

  test("acp request validator supports strict, loose, and filter modes", () => {
    const input = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/close",
      extra: true,
      params: {
        sessionId: "session-1",
        unknownParam: true,
      },
    };
    const original = structuredClone(input);

    expect(() => validateACPRequest(input)).toThrow(ValidationError);

    const loose = validateACPRequest(input, { mode: "loose" }) as {
      extra?: boolean;
      params: Record<string, unknown>;
    };
    expect(loose.extra).toBe(true);
    expect(loose.params.unknownParam).toBe(true);

    const filtered = validateACPRequest(input, { mode: "filter" }) as {
      extra?: boolean;
      params: Record<string, unknown>;
    };
    expect(filtered.extra).toBeUndefined();
    expect(filtered.params.unknownParam).toBeUndefined();
    expect(input).toEqual(original);
  });

  test("acp response validator supports strict, loose, and filter modes", () => {
    const input = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: 1,
        extra: true,
        agentCapabilities: {
          sessionCapabilities: {
            close: {},
            stop: {},
          },
        },
      },
    };
    const original = structuredClone(input);

    expect(() => validateACPResponse(input, { method: "initialize" })).toThrow(ValidationError);

    const loose = validateACPResponse(input, {
      method: "initialize",
      mode: "loose",
    }) as { result?: Record<string, unknown> };
    expect(loose.result?.extra).toBe(true);

    const filtered = validateACPResponse(input, {
      method: "initialize",
      mode: "filter",
    }) as {
      result?: {
        extra?: boolean;
        agentCapabilities?: { sessionCapabilities?: Record<string, unknown> };
      };
    };
    expect(filtered.result?.extra).toBeUndefined();
    expect(filtered.result?.agentCapabilities?.sessionCapabilities?.stop).toBeUndefined();
    expect(input).toEqual(original);
  });
});
