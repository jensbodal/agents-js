import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors.ts";
import { validateA2ARequest } from "../src/index.ts";

describe("validateA2ARequest — push notification config methods", () => {
  describe("tasks/pushNotificationConfig/set", () => {
    test("accepts a valid set request", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: {
          taskId: "task-1",
          pushNotificationConfig: {
            url: "https://example.com/hook",
          },
        },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/set");
    });

    test("accepts set request with optional config fields", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tasks/pushNotificationConfig/set",
        params: {
          taskId: "task-2",
          pushNotificationConfig: {
            url: "https://example.com/hook",
            id: "config-1",
            token: "secret-token",
            authentication: {
              schemes: ["bearer"],
              credentials: "my-token",
            },
          },
        },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/set");
    });

    test("rejects set request missing taskId", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            pushNotificationConfig: {
              url: "https://example.com/hook",
            },
          },
        }),
      ).toThrow(ValidationError);
    });

    test("rejects set request missing pushNotificationConfig", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            taskId: "task-1",
          },
        }),
      ).toThrow(ValidationError);
    });

    test("rejects set request with empty taskId", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            taskId: "",
            pushNotificationConfig: {
              url: "https://example.com/hook",
            },
          },
        }),
      ).toThrow(ValidationError);
    });

    test("rejects set request with empty url in pushNotificationConfig", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            taskId: "task-1",
            pushNotificationConfig: {
              url: "",
            },
          },
        }),
      ).toThrow(ValidationError);
    });

    test("sets jsonRpcCode to -32602 for invalid params", () => {
      try {
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: { url: 123 },
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).jsonRpcCode).toBe(-32602);
      }
    });

    test("accepts http:// URL", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: {
          taskId: "task-1",
          pushNotificationConfig: {
            url: "http://example.com/hook",
          },
        },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/set");
    });

    test("accepts https:// URL", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: {
          taskId: "task-1",
          pushNotificationConfig: {
            url: "https://example.com/hook",
          },
        },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/set");
    });

    test("accepts https URL with port and path", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/set",
        params: {
          taskId: "task-1",
          pushNotificationConfig: {
            url: "https://example.com:8443/webhooks/push?token=abc",
          },
        },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/set");
    });

    test("rejects non-URL string with -32602 error", () => {
      try {
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            taskId: "task-1",
            pushNotificationConfig: {
              url: "not-a-url",
            },
          },
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).jsonRpcCode).toBe(-32602);
      }
    });

    test("rejects ftp:// URL with -32602 error", () => {
      try {
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            taskId: "task-1",
            pushNotificationConfig: {
              url: "ftp://example.com/hook",
            },
          },
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).jsonRpcCode).toBe(-32602);
      }
    });

    test("rejects javascript: URL with -32602 error", () => {
      try {
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            taskId: "task-1",
            pushNotificationConfig: {
              url: "javascript:alert(1)",
            },
          },
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).jsonRpcCode).toBe(-32602);
      }
    });

    test("rejects plain domain string with -32602 error", () => {
      try {
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            taskId: "task-1",
            pushNotificationConfig: {
              url: "example.com/hook",
            },
          },
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).jsonRpcCode).toBe(-32602);
      }
    });

    test("rejects file:// URL with -32602 error", () => {
      try {
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/set",
          params: {
            taskId: "task-1",
            pushNotificationConfig: {
              url: "file:///etc/passwd",
            },
          },
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).jsonRpcCode).toBe(-32602);
      }
    });
  });

  describe("tasks/pushNotificationConfig/get", () => {
    test("accepts a valid get request with task id", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/get",
        params: { id: "task-1" },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/get");
    });

    test("accepts a get request with optional pushNotificationConfigId", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/get",
        params: { id: "task-1", pushNotificationConfigId: "config-1" },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/get");
    });

    test("rejects get request missing id", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/get",
          params: {},
        }),
      ).toThrow(ValidationError);
    });

    test("rejects get request with empty id", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/get",
          params: { id: "" },
        }),
      ).toThrow(ValidationError);
    });
  });

  describe("tasks/pushNotificationConfig/list", () => {
    test("accepts a valid list request", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/list",
        params: { id: "task-1" },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/list");
    });

    test("rejects list request missing id", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/list",
          params: {},
        }),
      ).toThrow(ValidationError);
    });

    test("rejects list request with empty id", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/list",
          params: { id: "" },
        }),
      ).toThrow(ValidationError);
    });
  });

  describe("tasks/pushNotificationConfig/delete", () => {
    test("accepts a valid delete request", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/pushNotificationConfig/delete",
        params: { id: "task-1", pushNotificationConfigId: "config-1" },
      });

      expect(result.method).toBe("tasks/pushNotificationConfig/delete");
    });

    test("rejects delete request missing id", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/delete",
          params: { pushNotificationConfigId: "config-1" },
        }),
      ).toThrow(ValidationError);
    });

    test("rejects delete request missing pushNotificationConfigId", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/delete",
          params: { id: "task-1" },
        }),
      ).toThrow(ValidationError);
    });

    test("rejects delete request with empty id", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/delete",
          params: { id: "", pushNotificationConfigId: "config-1" },
        }),
      ).toThrow(ValidationError);
    });

    test("rejects delete request with empty pushNotificationConfigId", () => {
      expect(() =>
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/pushNotificationConfig/delete",
          params: { id: "task-1", pushNotificationConfigId: "" },
        }),
      ).toThrow(ValidationError);
    });
  });

  describe("pushNotificationConfig URL validation in message/send", () => {
    const validMessage = {
      messageId: "msg-1",
      role: "user",
      parts: [{ kind: "text", text: "hello" }],
    };

    test("accepts valid https URL in message/send configuration", () => {
      const result = validateA2ARequest({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: validMessage,
          configuration: {
            pushNotificationConfig: {
              url: "https://example.com/webhook",
            },
          },
        },
      });

      expect(result.method).toBe("message/send");
    });

    test("rejects non-URL string in message/send pushNotificationConfig with -32602", () => {
      try {
        validateA2ARequest({
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: {
            message: validMessage,
            configuration: {
              pushNotificationConfig: {
                url: "not-a-url",
              },
            },
          },
        });
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).jsonRpcCode).toBe(-32602);
      }
    });
  });
});
