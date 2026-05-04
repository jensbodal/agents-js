import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors.ts";
import { validateA2ARequest } from "../src/index.ts";

describe("validateA2ARequest — tasks/get", () => {
  test("accepts a valid tasks/get request with id", () => {
    const result = validateA2ARequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { id: "task-1" },
    });

    expect(result.method).toBe("tasks/get");
  });

  test("accepts tasks/get with optional historyLength", () => {
    const result = validateA2ARequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { id: "task-1", historyLength: 10 },
    });

    expect(result.method).toBe("tasks/get");
  });

  test("rejects tasks/get missing id", () => {
    expect(() =>
      validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: {},
      }),
    ).toThrow(ValidationError);
  });

  test("rejects tasks/get with empty id", () => {
    expect(() =>
      validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: { id: "" },
      }),
    ).toThrow(ValidationError);
  });

  test("rejects tasks/get missing params entirely", () => {
    expect(() =>
      validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
      }),
    ).toThrow(ValidationError);
  });

  test("sets jsonRpcCode to -32602 for invalid params", () => {
    try {
      validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: { id: "" },
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).jsonRpcCode).toBe(-32602);
    }
  });
});

describe("validateA2ARequest — tasks/cancel", () => {
  test("accepts a valid tasks/cancel request", () => {
    const result = validateA2ARequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/cancel",
      params: { id: "task-1" },
    });

    expect(result.method).toBe("tasks/cancel");
  });

  test("rejects tasks/cancel missing id", () => {
    expect(() =>
      validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/cancel",
        params: {},
      }),
    ).toThrow(ValidationError);
  });

  test("rejects tasks/cancel with empty id", () => {
    expect(() =>
      validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/cancel",
        params: { id: "" },
      }),
    ).toThrow(ValidationError);
  });

  test("rejects tasks/cancel missing params entirely", () => {
    expect(() =>
      validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/cancel",
      }),
    ).toThrow(ValidationError);
  });

  test("sets jsonRpcCode to -32602 for invalid params", () => {
    try {
      validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/cancel",
        params: {},
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).jsonRpcCode).toBe(-32602);
    }
  });
});

describe("validateA2ARequest — agent/getAuthenticatedExtendedCard", () => {
  test("accepts a valid request without params", () => {
    const result = validateA2ARequest({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/getAuthenticatedExtendedCard",
    });

    expect(result.method).toBe("agent/getAuthenticatedExtendedCard");
  });

  test("accepts a valid request with empty params", () => {
    const result = validateA2ARequest({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/getAuthenticatedExtendedCard",
      params: {},
    });

    expect(result.method).toBe("agent/getAuthenticatedExtendedCard");
  });

  test("accepts a valid request with arbitrary params", () => {
    const result = validateA2ARequest({
      jsonrpc: "2.0",
      id: 1,
      method: "agent/getAuthenticatedExtendedCard",
      params: { someField: "value" },
    });

    expect(result.method).toBe("agent/getAuthenticatedExtendedCard");
  });

  test("rejects malformed envelope (missing jsonrpc)", () => {
    expect(() =>
      validateA2ARequest({
        id: 1,
        method: "agent/getAuthenticatedExtendedCard",
      }),
    ).toThrow(ValidationError);
  });
});
