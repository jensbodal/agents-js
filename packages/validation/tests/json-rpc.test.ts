import { describe, expect, test } from "bun:test";
import {
  jsonRpcRequestSchema,
  jsonRpcResponseSchema,
  ValidationError,
  validateJsonRpcEnvelope,
} from "../src/index.ts";

describe("jsonRpcRequestSchema", () => {
  test("accepts valid request with all fields", () => {
    const result = jsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { text: "hello" } },
    });
    expect(result.success).toBe(true);
  });

  test("accepts request without id (notification)", () => {
    const result = jsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      method: "message/send",
    });
    expect(result.success).toBe(true);
  });

  test("rejects missing method", () => {
    const result = jsonRpcRequestSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("jsonRpcResponseSchema", () => {
  test("accepts success response", () => {
    const result = jsonRpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      result: { status: "ok" },
    });
    expect(result.success).toBe(true);
  });

  test("accepts error response", () => {
    const result = jsonRpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32600,
        message: "Invalid Request",
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects response with both result and error", () => {
    const result = jsonRpcResponseSchema.safeParse({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: -32600, message: "Invalid Request" },
    });
    expect(result.success).toBe(false);
  });
});

describe("validateJsonRpcEnvelope", () => {
  test("returns parsed request", () => {
    const output = validateJsonRpcEnvelope(
      {
        jsonrpc: "2.0",
        id: "abc-123",
        method: "message/send",
      },
      "request",
    );

    expect(output.id).toBe("abc-123");
  });

  test("throws ValidationError for invalid request", () => {
    expect(() => validateJsonRpcEnvelope({ jsonrpc: "1.0" }, "request")).toThrow(ValidationError);
  });
});
