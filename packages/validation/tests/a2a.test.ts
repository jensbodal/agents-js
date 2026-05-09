import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors.ts";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  validateA2ARequest,
  validateA2AResponse,
  validateAgentCard,
} from "../src/index.ts";

async function loadFixture(path: string): Promise<unknown> {
  const fixture = Bun.file(new URL(path, import.meta.url));
  return fixture.json();
}

describe("validateA2ARequest", () => {
  test("accepts valid message/send request", async () => {
    const input = await loadFixture("./fixtures/valid/a2a-request.json");
    const output = validateA2ARequest(input) as JsonRpcRequest;

    expect(output.method).toBe("message/send");
  });

  test("rejects invalid message/send params", async () => {
    const input = await loadFixture("./fixtures/invalid/a2a-request-missing-message.json");

    expect(() => validateA2ARequest(input)).toThrow(ValidationError);
  });

  test("accepts non-message/send methods without strict payload checks", () => {
    const output = validateA2ARequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { id: "task-1" },
    });

    expect(output.method).toBe("tasks/get");
  });
});

describe("validateA2AResponse", () => {
  test("accepts valid message response", async () => {
    const input = await loadFixture("./fixtures/valid/a2a-response.json");
    const output = validateA2AResponse(input) as JsonRpcResponse;

    expect(output.error).toBeUndefined();
  });

  test("rejects invalid message result", async () => {
    const input = await loadFixture("./fixtures/invalid/a2a-response-invalid-result.json");

    expect(() => validateA2AResponse(input)).toThrow(ValidationError);
  });

  test("accepts generic non-kind result for non-message/send flows", () => {
    const output = validateA2AResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { pushed: true },
    });

    expect(output.result).toEqual({ pushed: true });
  });
});

describe("validateAgentCard", () => {
  test("accepts full card", async () => {
    const input = await loadFixture("./fixtures/valid/agent-card.json");
    const output = validateAgentCard(input);

    expect(output.name).toBe("test-agent");
    expect(output.url).toBe("http://127.0.0.1:3000");
    expect(output.defaultInputModes).toEqual(["text"]);
  });

  test("rejects missing required fields", async () => {
    const input = await loadFixture("./fixtures/invalid/agent-card-missing-name.json");

    expect(() => validateAgentCard(input)).toThrow(ValidationError);
  });

  test("rejects the old minimal card shape", () => {
    expect(() =>
      validateAgentCard({
        name: "test-agent",
        description: "A test agent",
        capabilities: { "text-to-text": {} },
      }),
    ).toThrow(ValidationError);
  });
});
