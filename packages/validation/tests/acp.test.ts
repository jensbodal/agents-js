import { describe, expect, test } from "bun:test";
import {
  ACP_METHOD_WHITELIST,
  ValidationError,
  validateACPEnvelope,
  validateACPMethod,
  validateACPRequest,
  validateACPResponse,
} from "../src/index.ts";
import { validACPRequestCases, validACPResponseCases } from "./acp-samples.ts";

async function loadFixture(path: string): Promise<unknown> {
  return Bun.file(new URL(path, import.meta.url)).json();
}

describe("validateACPEnvelope", () => {
  test("accepts valid ACP request envelope", async () => {
    const input = await loadFixture("./fixtures/valid/acp-envelope.json");
    const output = validateACPEnvelope(input);

    expect("method" in output && output.method).toBe("session/prompt");
  });

  test("rejects mixed request and response fields", async () => {
    const input = await loadFixture("./fixtures/invalid/acp-envelope-invalid-shape.json");

    expect(() => validateACPEnvelope(input)).toThrow(ValidationError);
  });
});

describe("validateACPMethod", () => {
  test("accepts whitelisted method", () => {
    const output = validateACPMethod({ method: "session/new" });
    expect(output).toBe("session/new");
  });

  test("rejects unsupported method", () => {
    expect(() => validateACPMethod("custom/method")).toThrow(ValidationError);
  });

  test("whitelist contains latest published ACP methods", () => {
    expect(ACP_METHOD_WHITELIST).toContain("session/close");
    expect(ACP_METHOD_WHITELIST).toContain("session/set_model");
    expect(ACP_METHOD_WHITELIST).toContain("terminal/create");
  });
});

describe("validateACPRequest", () => {
  for (const { method, envelope } of validACPRequestCases) {
    test(`accepts valid ACP ${method} request payload`, () => {
      const output = validateACPRequest(envelope);
      expect(output.method).toBe(method);
    });
  }

  test("rejects request methods without an id", () => {
    expect(() =>
      validateACPRequest({
        jsonrpc: "2.0",
        method: "session/close",
        params: { sessionId: "session-1" },
      }),
    ).toThrow(ValidationError);
  });

  test("rejects notification methods with an id", () => {
    expect(() =>
      validateACPRequest({
        jsonrpc: "2.0",
        id: 99,
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "code",
          },
        },
      }),
    ).toThrow(ValidationError);
  });

  test("accepts omitted params for empty-object request schemas", () => {
    const output = validateACPRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "session/list",
    });

    expect(output.params).toEqual({});
  });

  test("accepts explicit empty object params for empty-object request schemas", () => {
    const output = validateACPRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "session/list",
      params: {},
    });

    expect(output.params).toEqual({});
  });

  test("rejects null params for empty-object request schemas", () => {
    expect(() =>
      validateACPRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "session/list",
        params: null,
      }),
    ).toThrow(ValidationError);
  });

  test("rejects explicit undefined params when params was provided", () => {
    expect(() =>
      validateACPRequest({
        jsonrpc: "2.0",
        id: 7,
        method: "session/list",
        params: undefined,
      }),
    ).toThrow(ValidationError);
  });

  test("accepts the boolean branch of session/set_config_option", () => {
    const output = validateACPRequest({
      jsonrpc: "2.0",
      id: 13,
      method: "session/set_config_option",
      params: {
        sessionId: "session-1",
        configId: "confirm",
        type: "boolean",
        value: true,
      },
    });

    expect(output.method).toBe("session/set_config_option");
  });

  test("normalizes additional-properties errors for nested session/update payloads", () => {
    try {
      validateACPRequest({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              {
                name: "create_plan",
                description: "Create a plan",
                unexpected: true,
              },
            ],
          },
        },
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.field).toBe("params");
      expect(validationError.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "update.availableCommands.0.unexpected",
            message: "Unknown property",
          }),
        ]),
      );
    }
  });

  test("filters nested unknown properties from discriminator branches while preserving _meta", () => {
    const output = validateACPRequest(
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "available_commands_update",
            _meta: {
              traceId: "trace-1",
            },
            availableCommands: [
              {
                name: "create_plan",
                description: "Create a plan",
                unexpected: true,
              },
            ],
            unexpectedRoot: true,
          },
        },
      },
      { mode: "filter" },
    ) as {
      params: {
        update: {
          _meta?: Record<string, unknown>;
          availableCommands: Array<Record<string, unknown>>;
          unexpectedRoot?: boolean;
        };
      };
    };

    expect(output.params.update._meta?.traceId).toBe("trace-1");
    expect(output.params.update.unexpectedRoot).toBeUndefined();
    expect(output.params.update.availableCommands[0]?.unexpected).toBeUndefined();
  });

  test("rejects uint32 overflow in fs/read_text_file params", () => {
    expect(() =>
      validateACPRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "fs/read_text_file",
        params: {
          sessionId: "session-1",
          path: "/tmp/file.txt",
          line: 4_294_967_296,
        },
      }),
    ).toThrow(ValidationError);

    expect(() =>
      validateACPRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "fs/read_text_file",
        params: {
          sessionId: "session-1",
          path: "/tmp/file.txt",
          limit: 4_294_967_296,
        },
      }),
    ).toThrow(ValidationError);
  });

  test("preserves _meta extension fields while rejecting sibling unknown params in strict mode", () => {
    try {
      validateACPRequest({
        jsonrpc: "2.0",
        id: 5,
        method: "session/close",
        params: {
          sessionId: "session-1",
          _meta: {
            traceId: "trace-1",
          },
          unexpected: true,
        },
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const validationError = error as ValidationError;
      expect(validationError.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "unexpected",
            message: "Unknown property",
          }),
        ]),
      );
    }
  });

  test("filters sibling unknown params while preserving _meta extension fields", () => {
    const output = validateACPRequest(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "session/close",
        params: {
          sessionId: "session-1",
          _meta: {
            traceId: "trace-1",
          },
          unexpected: true,
        },
      },
      { mode: "filter" },
    ) as {
      params: {
        _meta?: Record<string, unknown>;
        unexpected?: boolean;
      };
    };

    expect(output.params._meta?.traceId).toBe("trace-1");
    expect(output.params.unexpected).toBeUndefined();
  });
});

describe("validateACPResponse", () => {
  for (const { method, envelope } of validACPResponseCases) {
    test(`accepts valid ACP ${method} response payload`, () => {
      const output = validateACPResponse(envelope, { method });
      expect("result" in output).toBe(true);
    });
  }

  test("accepts ACP error responses when method context is provided", () => {
    const output = validateACPResponse(
      {
        jsonrpc: "2.0",
        id: 10,
        error: {
          code: -32603,
          message: "Internal error",
        },
      },
      { method: "session/prompt" },
    );

    expect(output.error?.message).toBe("Internal error");
  });

  test("rejects responses for ACP notification methods", () => {
    expect(() =>
      validateACPResponse(
        {
          jsonrpc: "2.0",
          id: 10,
          result: {},
        },
        { method: "session/cancel" },
      ),
    ).toThrow(ValidationError);
  });

  test("rejects outdated ACP response fields in strict mode", () => {
    expect(() =>
      validateACPResponse(
        {
          jsonrpc: "2.0",
          id: 4,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              sessionCapabilities: {
                stop: {},
              },
            },
          },
        },
        { method: "initialize" },
      ),
    ).toThrow(ValidationError);
  });

  test("accepts terminal/output responses with null exitCode", () => {
    const output = validateACPResponse(
      {
        jsonrpc: "2.0",
        id: 18,
        result: {
          output: "terminated",
          truncated: false,
          exitStatus: {
            exitCode: null,
            signal: "SIGTERM",
          },
        },
      },
      { method: "terminal/output" },
    );

    expect(output.result).toBeDefined();
  });

  test("rejects oversized exitCode values in terminal/output responses", () => {
    expect(() =>
      validateACPResponse(
        {
          jsonrpc: "2.0",
          id: 18,
          result: {
            output: "terminated",
            truncated: false,
            exitStatus: {
              exitCode: 4_294_967_296,
              signal: null,
            },
          },
        },
        { method: "terminal/output" },
      ),
    ).toThrow(ValidationError);
  });

  test("accepts terminal/wait_for_exit responses with 0 and null exitCode", () => {
    const exitedNormally = validateACPResponse(
      {
        jsonrpc: "2.0",
        id: 20,
        result: {
          exitCode: 0,
          signal: null,
        },
      },
      { method: "terminal/wait_for_exit" },
    );
    const terminatedBySignal = validateACPResponse(
      {
        jsonrpc: "2.0",
        id: 20,
        result: {
          exitCode: null,
          signal: "SIGTERM",
        },
      },
      { method: "terminal/wait_for_exit" },
    );

    expect(exitedNormally.result).toBeDefined();
    expect(terminatedBySignal.result).toBeDefined();
  });

  test("rejects oversized exitCode values in terminal/wait_for_exit responses", () => {
    expect(() =>
      validateACPResponse(
        {
          jsonrpc: "2.0",
          id: 20,
          result: {
            exitCode: 4_294_967_296,
            signal: null,
          },
        },
        { method: "terminal/wait_for_exit" },
      ),
    ).toThrow(ValidationError);
  });
});
