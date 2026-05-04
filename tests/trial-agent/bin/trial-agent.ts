#!/usr/bin/env bun
/**
 * Entry point for the `trial-agent` binary.
 *
 * Starts an ACP `AgentSideConnection` over stdio (NDJSON), wires each
 * `session/prompt` request through the {@link createPromptHandler} dispatch
 * surface, and emits the rendered response as an
 * `agent_message_chunk` session/update notification.
 *
 * Workspace + hub roots:
 *
 * - `workspaceRoot` is the ACP `NewSessionRequest.cwd` if provided, else the
 *   inherited `process.cwd()`. The trial agent is happy with either; the
 *   integration test always pins it via `cwd` so probes hit fixture data.
 * - `hubRoot` defaults to {@link DEFAULT_TRIAL_AGENT_HUB_ROOT} (the canonical
 *   `~/workspace/syncthing/lifestone_ios/hub` path also baked into the
 *   `searchDocs` primitive). Override precedence: `--hub-root <path>` CLI
 *   flag > `TRIAL_AGENT_HUB_ROOT` env var > default. Test harnesses that
 *   embed the agent programmatically should call {@link createTrialAgent}
 *   with an explicit `hubRoot` instead of going through the bin.
 */

import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { registerBuiltins } from "@agents-js/tools";
import {
  createTrialAgent,
  DEFAULT_TRIAL_AGENT_HUB_ROOT,
  TRIAL_AGENT_NAME,
  TRIAL_AGENT_VERSION,
} from "../src/acp-agent.ts";

interface ParsedArgs {
  help: boolean;
  version: boolean;
  hubRoot?: string;
  error?: string;
}

/**
 * Minimal hand-rolled CLI parser. Supported shapes for the value flag:
 *
 *   --hub-root /abs/path
 *   --hub-root=/abs/path
 *
 * Anything else with `--hub-root` (missing value, trailing flag) is a
 * usage error surfaced via the returned `error` field; `main()` prints
 * help and exits non-zero rather than starting the ACP loop with a
 * silently-wrong root.
 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, version: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      out.version = true;
      continue;
    }
    if (arg === "--hub-root") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        out.error = "--hub-root requires a path argument";
        return out;
      }
      out.hubRoot = next;
      i += 1;
      continue;
    }
    if (arg?.startsWith("--hub-root=")) {
      const value = arg.slice("--hub-root=".length);
      if (value.length === 0) {
        out.error = "--hub-root requires a non-empty path argument";
        return out;
      }
      out.hubRoot = value;
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    [
      "trial-agent - real-ACP isolation harness for @agents-js/tools",
      "",
      "Usage:",
      "  trial-agent                       Start the ACP adapter over stdin/stdout (NDJSON).",
      "  trial-agent --hub-root <path>     Override the hub-vault root used by fetchContext.",
      "  trial-agent --help                Print this message.",
      "  trial-agent --version             Print adapter version.",
      "",
      "Environment:",
      "  TRIAL_AGENT_HUB_ROOT     Override the hub-vault root used by fetchContext.",
      "                           The --hub-root CLI flag takes precedence when both are set.",
      "  TRIAL_AGENT_WORKSPACE    Override the workspace root (otherwise NewSessionRequest.cwd or process.cwd()).",
      "",
      "This binary speaks ACP on stdio. It dispatches each session/prompt to a",
      "@agents-js/tools primitive (fetchContext / findTools) or runs the seven",
      "D readiness gates programmatically. See the package README for prompt",
      "examples.",
      "",
    ].join("\n"),
  );
}

function printVersion(): void {
  process.stdout.write(`${TRIAL_AGENT_NAME} ${TRIAL_AGENT_VERSION}\n`);
}

/**
 * Resolve the effective hub root with explicit precedence:
 * CLI flag > env var > default. Exported only via the bin's `parseArgs`
 * caller — test code constructs the agent through {@link createTrialAgent}
 * directly and bypasses this helper.
 */
function resolveHubRoot(parsed: ParsedArgs): string {
  if (parsed.hubRoot) return parsed.hubRoot;
  const fromEnv = Bun.env.TRIAL_AGENT_HUB_ROOT;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return DEFAULT_TRIAL_AGENT_HUB_ROOT;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`trial-agent: ${parsed.error}\n\n`);
    printHelp();
    process.exit(2);
  }
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  if (parsed.version) {
    printVersion();
    process.exit(0);
  }

  // Bootstrap the @agents-js/tools default registry with the three
  // self-hosting primitives (searchMemories, searchDocs, SpawnAgent).
  // This is the explicit replacement for the prior implicit side-effect
  // registration on tools/index.ts module load.
  registerBuiltins();

  const stream: Stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );

  const hubRoot = resolveHubRoot(parsed);
  const workspaceRoot = Bun.env.TRIAL_AGENT_WORKSPACE;

  // The AgentSideConnection keeps itself alive via its internal reader on
  // stream.readable; the constructor return value is intentionally unused.
  void new AgentSideConnection(
    (conn) => createTrialAgent(conn, { hubRoot, workspaceRoot }),
    stream,
  );

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.once(signal, () => {
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

if (import.meta.main) {
  await main();
}
