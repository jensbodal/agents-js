import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "../packages/acp/src/index.ts";
import { buildContaminationInitializeRequest } from "../scripts/runtime-e2e.ts";

describe("runtime-e2e contamination initialize request", () => {
  test("uses the shared ACP protocol version", () => {
    expect(buildContaminationInitializeRequest()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agents-js-e2e", version: "1.0.0" },
      },
    });
  });
});
