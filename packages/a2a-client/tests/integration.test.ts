import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACPtoA2AExecutor,
  buildAgentCard,
  CURRENT_A2A_PROTOCOL_VERSION,
  UniversalA2AServer,
} from "../../a2a/src/index.ts";
import { spawnACPAgent } from "../../acp/src/index.ts";
import { A2AClientController } from "../src/index.ts";

describe("a2a-client integration", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const mockAgentPath = path.resolve(testDir, "../../../tests/mock-acp-agent.cjs");

  async function withGateway(
    fn: (baseUrl: string, cardUrl: string) => Promise<void>,
  ): Promise<void> {
    const previousCwd = process.cwd();
    const tempCwd = mkdtempSync(path.join(tmpdir(), "agents-js-a2a-client-"));
    process.chdir(tempCwd);

    const acp = spawnACPAgent({
      command: "node",
      args: [mockAgentPath],
    });
    const gatewayCard = buildAgentCard({
      name: "client-integration-gateway",
      description: "Integration test gateway",
      capabilities: { "text-to-text": {} },
    });
    const serverWrapper = new UniversalA2AServer(new ACPtoA2AExecutor(acp.stream), gatewayCard);
    const server = await serverWrapper.start(0);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const cardUrl = `${baseUrl}/.well-known/agent-card.json`;

    try {
      await fn(baseUrl, cardUrl);
    } finally {
      server.stop();
      acp.kill();
      process.chdir(previousCwd);
    }
  }

  test("connects and sends a turn from a base URL", async () => {
    await withGateway(async (baseUrl) => {
      const controller = new A2AClientController();
      await controller.connect({ url: baseUrl, mode: "base" });
      await controller.sendTurn("hello");

      const state = controller.getState();
      expect(state.target?.baseUrl).toBe(baseUrl);
      expect(state.transcript.some((entry) => entry.role === "agent")).toBe(true);
    });
  }, 30_000);

  test("continues chat with contextId and taskId after a task result", async () => {
    await withGateway(async (baseUrl) => {
      const controller = new A2AClientController();
      await controller.connect({ url: baseUrl, mode: "base" });
      await controller.sendTurn("hello");

      const afterFirstTurn = controller.getState();
      expect(afterFirstTurn.contextId).toBeDefined();
      // The gateway now returns Task results, so taskId is tracked
      expect(afterFirstTurn.taskId).toBeDefined();

      await controller.sendTurn("what did I just say?");

      const afterSecondTurn = controller.getState();
      expect(afterSecondTurn.contextId).toBe(afterFirstTurn.contextId);
      expect(afterSecondTurn.taskId).toBeDefined();
      expect(afterSecondTurn.transcript.filter((entry) => entry.role === "user")).toHaveLength(2);
      expect(afterSecondTurn.transcript.filter((entry) => entry.role === "agent")).toHaveLength(2);
    });
  }, 30_000);

  test("connects and sends a turn from a full agent card URL", async () => {
    await withGateway(async (_baseUrl, cardUrl) => {
      const controller = new A2AClientController();
      await controller.connect({ url: cardUrl, mode: "card" });
      await controller.sendTurn("hello");

      const state = controller.getState();
      expect(state.target?.cardUrl).toBe(cardUrl);
      expect(state.transcript.some((entry) => entry.role === "agent")).toBe(true);
    });
  }, 30_000);

  test("connects using a custom full agent card URL", async () => {
    type SimpleServer = { port: number | undefined; stop(force?: boolean): void };
    const server: SimpleServer = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.pathname === "/custom-card.json") {
          return Response.json({
            name: "custom-card-agent",
            description: "Custom card path",
            url: `http://127.0.0.1:${server.port}`,
            version: "1.0.0",
            protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
            skills: [],
            defaultInputModes: ["text"],
            defaultOutputModes: ["text"],
            capabilities: {},
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const controller = new A2AClientController();
      const cardUrl = `http://127.0.0.1:${server.port}/custom-card.json`;

      await controller.connect({ url: cardUrl, mode: "card" });

      const state = controller.getState();
      expect(state.target?.cardUrl).toBe(cardUrl);
      expect(state.target?.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
      expect(state.target?.card.name).toBe("custom-card-agent");
    } finally {
      server.stop(true);
    }
  });

  test("falls back to origin-level card when sub-path card fetch 404s", async () => {
    type SimpleServer = { port: number | undefined; stop(force?: boolean): void };
    // Multi-segment subpath exercises the fallback: the SDK's internal
    // `new URL('.well-known/agent-card.json', baseUrl)` resolution only
    // strips the final path segment, so /api/agents/foo/a2a resolves
    // the card to /api/agents/foo/.well-known/agent-card.json (still 404).
    const server: SimpleServer = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.pathname === "/.well-known/agent-card.json") {
          return Response.json({
            name: "origin-card-agent",
            description: "Served at origin only",
            url: `http://127.0.0.1:${server.port}`,
            version: "1.0.0",
            protocolVersion: CURRENT_A2A_PROTOCOL_VERSION,
            skills: [],
            defaultInputModes: ["text"],
            defaultOutputModes: ["text"],
            capabilities: {},
          });
        }
        return new Response("Not Found", { status: 404 });
      },
    });

    try {
      const controller = new A2AClientController();
      const endpointUrl = `http://127.0.0.1:${server.port}/api/agents/foo/a2a`;

      await controller.connect({ url: endpointUrl, mode: "base" });

      const state = controller.getState();
      expect(state.target?.cardUrl).toBe(
        `http://127.0.0.1:${server.port}/.well-known/agent-card.json`,
      );
      expect(state.target?.card.name).toBe("origin-card-agent");
    } finally {
      server.stop(true);
    }
  });
});
