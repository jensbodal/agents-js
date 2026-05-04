#!/usr/bin/env bun

import { A2AClientController } from "@agents-js/a2a-client";
import { parseEnv } from "@agents-js/gateway-runtime";
import { defaultGatewayUrl } from "../../scripts/workspace-constants.ts";

function printUsage(): void {
  console.log(
    [
      "Usage:",
      "  bun examples/agent-zero/a2a-client-local-source-consumer.ts [url] [prompt]",
      "",
      "Environment fallback:",
      "  A2A_URL",
    ].join("\n"),
  );
}

if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  printUsage();
  process.exit(0);
}

const url = process.argv[2] ?? parseEnv("A2A_URL", defaultGatewayUrl).string();
const prompt = process.argv[3] ?? "Reply with the single word ready.";
const mode = url.endsWith(".json") ? "card" : "base";

const controller = new A2AClientController();
await controller.connect({ url, mode });
await controller.sendTurn(prompt);

const state = controller.getState();
const agentReply = [...state.transcript].reverse().find((entry) => entry.role === "agent");

console.log(
  JSON.stringify(
    {
      baseUrl: state.target?.baseUrl,
      cardUrl: state.target?.cardUrl,
      contextId: state.contextId,
      reply: agentReply?.text ?? null,
      transcriptLength: state.transcript.length,
    },
    null,
    2,
  ),
);
