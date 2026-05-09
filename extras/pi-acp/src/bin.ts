#!/usr/bin/env bun
/**
 * Entry point for the `pi-acp` binary.
 *
 * Starts an ACP `AgentSideConnection` over stdio (NDJSON), dispatches ACP
 * requests to a fresh Pi process per ACP session, and forwards streaming
 * output back as ACP `session/update` notifications.
 */
import { runAcpWrapperBinary } from "@agents-js/acp";
import { getCliVersion } from "@agents-js/gateway-runtime";
import pkg from "../package.json";
import { createPiAcpAgent } from "./agent.ts";

const PI_ACP_AGENT_NAME = "pi-acp";
const PI_ACP_AGENT_VERSION = getCliVersion(pkg);

const PI_ACP_HELP = [
  "ACP adapter for @mariozechner/pi-coding-agent",
  "",
  "Usage:",
  "  pi-acp                  Start the ACP adapter over stdin/stdout (NDJSON).",
  "  pi-acp --help           Print this message.",
  "  pi-acp --version        Print adapter version.",
  "  pi-acp --provider zai --model glm-5.1",
  "",
  "This binary speaks ACP on stdio. It spawns the `pi` CLI in `--mode rpc`",
  "once per ACP session and forwards events as ACP `session/update`",
  "notifications. Pi manages provider auth internally via its `/login`",
  "TUI or provider env vars read by the Pi CLI itself.",
  "",
  "Any non-adapter flags are forwarded to the spawned Pi process after",
  "`--mode rpc`, so runtime profiles can select Pi providers, models,",
  "tools, and session behavior.",
  "",
].join("\n");

if (import.meta.main) {
  await runAcpWrapperBinary({
    name: PI_ACP_AGENT_NAME,
    version: PI_ACP_AGENT_VERSION,
    helpText: PI_ACP_HELP,
    createAgent: createPiAcpAgent({
      name: PI_ACP_AGENT_NAME,
      version: PI_ACP_AGENT_VERSION,
    }),
  });
}
