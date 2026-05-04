import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { McpBridgeClient } from "../src/mcp-client.ts";

/**
 * Test-only structural view of McpBridgeClient internals. Tests force-kill
 * the underlying subprocess to exercise reconnect-on-death behavior.
 */
type McpBridgeClientInternal = {
  process: { kill: () => void } | null;
};

const MOCK_BRIDGE = resolve(import.meta.dir, "mock-bridge.ts");

function createClient(): McpBridgeClient {
  return new McpBridgeClient({
    command: "bun",
    args: ["run", MOCK_BRIDGE],
  });
}

describe("McpBridgeClient", () => {
  let client: McpBridgeClient;

  afterEach(async () => {
    if (client) {
      await client.destroy();
    }
  });

  test("initialize sends correct JSON-RPC handshake sequence", async () => {
    client = createClient();

    // Should not throw — handshake completes successfully
    await client.initialize();

    // Verify the client is functional after init by listing tools
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  test("listTools parses tool array correctly", async () => {
    client = createClient();
    await client.initialize();

    const tools = await client.listTools();

    expect(tools).toEqual([
      { name: "echo-agent", description: "Echoes messages back" },
      { name: "math-agent", description: "Does math" },
    ]);
  });

  test("callTool sends correct params and extracts text", async () => {
    client = createClient();
    await client.initialize();

    const result = await client.callTool("echo-agent", "hello world");
    expect(result).toBe("[echo-agent] hello world");
  });

  test("callTool routes to correct tool by name", async () => {
    client = createClient();
    await client.initialize();

    const resultA = await client.callTool("echo-agent", "msg-a");
    expect(resultA).toBe("[echo-agent] msg-a");

    const resultB = await client.callTool("math-agent", "msg-b");
    expect(resultB).toBe("[math-agent] msg-b");
  });

  test("error handling when subprocess dies mid-session", async () => {
    client = createClient();
    await client.initialize();

    // Force-kill the underlying process (simulating unexpected death)
    const proc = (client as unknown as McpBridgeClientInternal).process;
    if (proc) {
      proc.kill();
    }

    // Wait a tick for the reader to detect the death
    await new Promise((r) => setTimeout(r, 100));

    // _ensureAlive should detect the dead process and reconnect
    const tools = await client.listTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  test("reconnection on subprocess death", async () => {
    client = createClient();
    await client.initialize();

    // Verify it works initially
    const toolsBefore = await client.listTools();
    expect(toolsBefore).toHaveLength(2);

    // Force-kill by accessing the private process handle
    const proc = (client as unknown as McpBridgeClientInternal).process;
    if (proc) {
      proc.kill();
    }

    // Wait a tick for the reader to detect the death
    await new Promise((r) => setTimeout(r, 100));

    // Next call should trigger reconnection transparently
    const toolsAfter = await client.listTools();
    expect(toolsAfter).toHaveLength(2);
    const [firstTool] = toolsAfter;
    if (!firstTool) throw new Error("expected at least one tool after reconnection");
    expect(firstTool.name).toBe("echo-agent");
  });
});
