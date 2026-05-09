#!/usr/bin/env bun

import path from "node:path";
import { buildAgentCard, serveACPOverA2A } from "@agents-js/a2a";

const repoRoot = path.resolve(import.meta.dir, "..");
const mockAgentPath = path.join(repoRoot, "tests/mock-acp-agent.cjs");
const gatewayHost = "127.0.0.1";
const gatewayPort = 0; // let the OS pick a free port

async function main(): Promise<void> {
  console.log("[gateway-smoke] Starting mock ACP gateway...");

  const gateway = await serveACPOverA2A({
    acp: {
      command: "node",
      args: [mockAgentPath],
    },
    agentCard: buildAgentCard({
      name: "gateway-smoke-agent",
      description: "Headless gateway smoke test agent",
      capabilities: { "text-to-text": {} },
    }),
    host: gatewayHost,
    port: gatewayPort,
  });

  const baseUrl = `http://${gatewayHost}:${gateway.port}`;
  console.log(`[gateway-smoke] Gateway listening on ${baseUrl}`);

  try {
    // 1. Verify the agent card is discoverable
    const cardResponse = await fetch(`${baseUrl}/.well-known/agent-card.json`);
    if (!cardResponse.ok) {
      throw new Error(
        `[gateway-smoke] Agent card fetch failed: ${cardResponse.status} ${cardResponse.statusText}`,
      );
    }
    const card = await cardResponse.json();
    if (card.name !== "gateway-smoke-agent") {
      throw new Error(`[gateway-smoke] Unexpected agent card name: ${JSON.stringify(card.name)}`);
    }
    console.log("[gateway-smoke] Agent card: ok");

    // 2. Send an A2A message/send JSON-RPC request
    const rpcBody = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          role: "user",
          messageId: "smoke-001",
          parts: [{ kind: "text", text: "Hello from gateway smoke" }],
        },
      },
    };

    const rpcResponse = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcBody),
    });

    if (!rpcResponse.ok) {
      throw new Error(
        `[gateway-smoke] JSON-RPC request failed: ${rpcResponse.status} ${rpcResponse.statusText}`,
      );
    }

    const rpcResult = await rpcResponse.json();
    console.log(`[gateway-smoke] JSON-RPC response: ${JSON.stringify(rpcResult, null, 2)}`);

    // Verify the response contains agent reply text
    const resultStr = JSON.stringify(rpcResult);
    if (!resultStr.includes("Mock ACP Agent")) {
      throw new Error(
        `[gateway-smoke] Expected response to contain "Mock ACP Agent", got: ${resultStr}`,
      );
    }
    console.log("[gateway-smoke] message/send: ok");

    console.log("[gateway-smoke] All checks passed.");
  } finally {
    gateway.stop();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
