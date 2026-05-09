#!/usr/bin/env bun
/**
 * Entry point for the `droid-acp` binary.
 *
 * Starts an ACP `AgentSideConnection` over stdio (NDJSON), dispatches ACP
 * requests to per-turn `droid exec` invocations, and forwards droid's
 * stream-json output as ACP `session/update` notifications.
 *
 * Authentication: droid reads `FACTORY_API_KEY` from the inherited
 * environment (and/or its own local credential cache under `~/.factory`).
 * This adapter does not interpose on auth — whichever credential source
 * droid finds at spawn time is what it uses.
 */
import { runAcpWrapperBinary } from "@agents-js/acp";
import { getCliVersion } from "@agents-js/gateway-runtime";
import pkg from "../package.json";
import { createDroidAcpAgent } from "./agent.ts";

const DROID_ACP_AGENT_NAME = "droid-acp";
const DROID_ACP_AGENT_VERSION = getCliVersion(pkg);

const DROID_ACP_HELP = [
  "ACP adapter for Factory.ai's Droid CLI",
  "",
  "Usage:",
  "  droid-acp                  Start the ACP adapter over stdin/stdout (NDJSON).",
  "  droid-acp --help           Print this message.",
  "  droid-acp --version        Print adapter version.",
  "  droid-acp --model glm-5.1 --auto low",
  "",
  "This binary speaks ACP on stdio. It spawns `droid exec --output-format",
  "stream-json` once per ACP prompt turn and forwards the resulting events",
  "as ACP `session/update` notifications. Multi-turn continuity is handled",
  "by threading droid's internal session_id through `--session-id` on each",
  "subsequent turn.",
  "",
  "Auth: droid reads FACTORY_API_KEY from the environment (or its local",
  "credential cache). This adapter forwards the inherited env unchanged.",
  "",
  "Any non-adapter flags are forwarded to each spawned `droid exec`",
  "invocation after the adapter-owned session/cwd flags and before the prompt.",
  "",
].join("\n");

if (import.meta.main) {
  await runAcpWrapperBinary({
    name: DROID_ACP_AGENT_NAME,
    version: DROID_ACP_AGENT_VERSION,
    helpText: DROID_ACP_HELP,
    createAgent: createDroidAcpAgent({
      name: DROID_ACP_AGENT_NAME,
      version: DROID_ACP_AGENT_VERSION,
    }),
  });
}
