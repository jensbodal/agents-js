import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors.ts";
import { validateAgentCard } from "../src/index.ts";

describe("validateAgentCard", () => {
  test("round-trips a valid A2A 1.0 proto card", () => {
    const card = {
      name: "test-agent",
      description: "A test agent",
      supportedInterfaces: [
        {
          url: "http://127.0.0.1:3000",
          protocolBinding: "JSONRPC",
          tenant: "",
          protocolVersion: "1.0",
        },
      ],
      provider: { url: "https://example.com", organization: "Acme" },
      version: "1.0.0",
      capabilities: { extensions: [] },
      securitySchemes: {},
      securityRequirements: [],
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      signatures: [],
    };

    const output = validateAgentCard(card);

    expect(output.name).toBe("test-agent");
    expect(output.supportedInterfaces[0]?.url).toBe("http://127.0.0.1:3000");
    expect(output.supportedInterfaces[0]?.protocolBinding).toBe("JSONRPC");
    expect(output.defaultInputModes).toEqual(["text/plain"]);
    expect(output.version).toBe("1.0.0");
  });

  test("rejects non-object garbage", () => {
    expect(() => validateAgentCard(42)).toThrow(ValidationError);
    expect(() => validateAgentCard("nope")).toThrow(ValidationError);
    expect(() => validateAgentCard(null)).toThrow(ValidationError);
  });
});
