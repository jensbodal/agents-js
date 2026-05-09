/**
 * Smoke test for the createGatewayTestServer factory.
 *
 * Verifies that the factory assembles a full production gateway stack
 * (ACPSessionController + HostA2AExecutor + UniversalA2AServer) against
 * the deterministic mock ACP agent and that the resulting handle can
 * serve the agent card, then shut down cleanly.
 *
 * This test intentionally does NOT exercise the executor's concurrent
 * prompt path — that belongs to the HostA2AExecutor unit tests.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createGatewayTestServer } from "../src/testing.ts";

const mockAgentPath = path.resolve(import.meta.dir, "../../../tests/mock-acp-agent.cjs");

describe("createGatewayTestServer", () => {
  test("boots the full gateway stack against the mock ACP agent and serves the agent card", async () => {
    const handle = await createGatewayTestServer({
      acpCommand: "node",
      acpArgs: [mockAgentPath],
    });

    try {
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);

      const response = await fetch(`${handle.url}/.well-known/agent-card.json`);
      expect(response.status).toBe(200);

      const card = (await response.json()) as {
        name?: string;
        description?: string;
        url?: string;
        capabilities?: Record<string, unknown>;
      };
      expect(card.name).toBe("gateway-test");
      expect(card.description).toBe("Test gateway");
      // The server rewrites the default agent-card URL to the bound host:port.
      expect(card.url).toBe(handle.url);
      // text-to-text is the baseline capability we configured.
      expect(card.capabilities).toBeDefined();
      expect(card.capabilities?.["text-to-text"]).toBeDefined();
    } finally {
      await handle.stop();
    }

    // After stop(), the server should no longer accept connections.
    // A follow-up fetch should fail with a network error.
    let connectionClosed = false;
    try {
      await fetch(`${handle.url}/.well-known/agent-card.json`);
    } catch {
      connectionClosed = true;
    }
    expect(connectionClosed).toBe(true);
  }, 30_000);

  test("stop() is idempotent", async () => {
    const handle = await createGatewayTestServer({
      acpCommand: "node",
      acpArgs: [mockAgentPath],
    });

    await handle.stop();
    // Second call must not throw.
    await handle.stop();
  }, 30_000);
});
