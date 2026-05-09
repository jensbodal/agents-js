#!/usr/bin/env bun

import { A2AClientController } from "@agents-js/a2a-client";
import { parseEnv } from "@agents-js/gateway-runtime";

function parseArgs(argv: string[]): { mode: "base" | "card"; prompt: string; url: string } {
  let url = parseEnv("A2A_URL").optional().string()?.trim();
  let card = parseEnv("A2A_CARD_URL").optional().string()?.trim();
  let prompt =
    parseEnv("A2A_SMOKE_PROMPT").optional().string()?.trim() || "Reply with the single word pong.";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === "--url" || arg === "--card" || arg === "--prompt") && !next) {
      throw new Error(`[client-smoke] Missing value for ${arg}.`);
    }

    switch (arg) {
      case "--url":
        url = next;
        index += 1;
        break;
      case "--card":
        card = next;
        index += 1;
        break;
      case "--prompt":
        prompt = next;
        index += 1;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "Usage:",
            "  bun scripts/client-smoke.ts (--url <base-url> | --card <card-url>) [--prompt <text>]",
            "",
            "Environment fallbacks:",
            "  A2A_URL",
            "  A2A_CARD_URL",
            "  A2A_SMOKE_PROMPT",
          ].join("\n"),
        );
        process.exit(0);
        return {
          mode: "base",
          prompt,
          url: "",
        };
      default:
        throw new Error(`[client-smoke] Unknown argument: ${arg}`);
    }
  }

  if ((url ? 1 : 0) + (card ? 1 : 0) !== 1) {
    throw new Error("[client-smoke] Provide exactly one of --url or --card.");
  }

  return {
    mode: card ? "card" : "base",
    prompt,
    url: card ?? url ?? "",
  };
}

const parsed = parseArgs(process.argv.slice(2));
const controller = new A2AClientController();

await controller.connect({
  mode: parsed.mode,
  url: parsed.url,
});

await controller.sendTurn(parsed.prompt);

const state = controller.getState();
const agentReply = [...state.transcript].reverse().find((entry) => entry.role === "agent");

if (!agentReply) {
  throw new Error("[client-smoke] Expected an agent reply in the transcript.");
}

console.log(
  JSON.stringify(
    {
      baseUrl: state.target?.baseUrl,
      cardUrl: state.target?.cardUrl,
      contextId: state.contextId,
      taskId: state.taskId,
      supportsStreaming: state.target?.capabilities.supportsStreaming ?? false,
      reply: agentReply.text,
    },
    null,
    2,
  ),
);
