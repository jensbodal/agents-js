#!/usr/bin/env bun
/**
 * Entry point for the `mock-acp` binary.
 *
 * A deterministic ACP runtime that speaks stdio NDJSON and responds to every
 * session/prompt with a canned reply. Used in CI to exercise the real-runtime
 * gate (scripts/e2e-deterministic.ts → scripts/runtime-e2e.ts) without a
 * live opencode/claude-agent-acp/gemini binary.
 *
 * Protocol:
 * - Handles initialize, session/new, session/prompt, authenticate.
 * - Each session/prompt emits one agent_message_chunk notification then
 *   replies stopReason: "end_turn".
 * - Opt-in streaming-text mode: when env `MOCK_ACP_STREAMING_TEXT=1`,
 *   each session/prompt emits N single-character agent_message_chunk
 *   notifications (one per char of MOCK_ACP_REPLY) — exercises the
 *   per-chunk streaming-render path that 0.3.0 fixes for the CLI TUI.
 *   Used by the Layer 3 end-to-end render test.
 * - Opt-in non-text-event modes (each independent of the others):
 *     - `MOCK_ACP_THOUGHT_CHUNKS=1` — emits 5 agent_thought_chunk
 *       notifications before the visible response. Exercises the
 *       executor → translator → provider thought.delta fan-out path.
 *     - `MOCK_ACP_TOOL_CALLS=1` — emits a tool_call (status:
 *       in_progress) followed after the visible response by a
 *       tool_call_update with status: completed. Exercises the
 *       tool-call-start / tool-call-progress / tool-call-end gating.
 *     - `MOCK_ACP_PLAN_UPDATES=1` — emits a plan notification with a
 *       3-entry SDK-typed PlanEntry list (high/medium/low priority).
 *     - `MOCK_ACP_AVAILABLE_COMMANDS=1` — emits an
 *       available_commands_update with two commands.
 *     - `MOCK_ACP_MODE_CHANGES=1` — emits a current_mode_update.
 *     - `MOCK_ACP_USAGE_UPDATES=1` — emits a usage_update with
 *       structured Cost (`{ amount: 0.18, currency: "USD" }`).
 *   These flags are independent and composable, e.g. set both
 *   THOUGHT_CHUNKS and TOOL_CALLS to exercise both paths in one turn.
 * - Does NOT write to stdout before the initialize response — zero
 *   contamination guarantee required by checkContamination in runtime-e2e.ts.
 *
 * Not for production use. Only registered in the runtime registry when
 * AGENTS_JS_ENABLE_MOCK_ACP_RUNTIME=1.
 */

import { Readable, Writable } from "node:stream";
import {
  type Agent,
  AgentSideConnection,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  type Stream,
} from "@agentclientprotocol/sdk";
import pkg from "../package.json";
import { getCliVersion } from "../src/cli-version.ts";
import { MOCK_ACP_REPLY } from "../src/mock-acp/constants.ts";

const MOCK_ACP_NAME = "mock-acp";
const MOCK_ACP_VERSION = getCliVersion(pkg);

let sessionCounter = 0;

function nextSessionId(): string {
  sessionCounter += 1;
  return `mock-acp-session-${sessionCounter}`;
}

function createMockAgent(connection: AgentSideConnection): Agent {
  const sessions = new Set<string>();

  return {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: MOCK_ACP_NAME, version: MOCK_ACP_VERSION },
        agentCapabilities: {
          promptCapabilities: { image: true },
        },
        authMethods: [],
      };
    },

    async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
      const sessionId = nextSessionId();
      sessions.add(sessionId);
      return { sessionId };
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const { sessionId } = params;

      // Opt-in non-text events (PRE-text). Each flag is independent
      // and composable so a single test can exercise more than one
      // wire-shape branch in one prompt. Env-var toggles are
      // intentional — the mock is a deterministic test fixture
      // invoked by `MOCK_ACP_*=1 bun ...`, and adding a config-file
      // layer here would be ceremony for single-purpose probes.

      // biome-ignore lint/style/noProcessEnv: see comment above
      if (process.env.MOCK_ACP_AVAILABLE_COMMANDS === "1") {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "/think", description: "Toggle thinking" },
              { name: "/plan", description: "Switch to plan mode" },
            ],
          },
        });
      }

      // biome-ignore lint/style/noProcessEnv: see comment above
      if (process.env.MOCK_ACP_PLAN_UPDATES === "1") {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "step 1", priority: "high", status: "completed" },
              { content: "step 2", priority: "medium", status: "in_progress" },
              { content: "step 3", priority: "low", status: "pending" },
            ],
          },
        });
      }

      // biome-ignore lint/style/noProcessEnv: see comment above
      if (process.env.MOCK_ACP_MODE_CHANGES === "1") {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "execute",
          },
        });
      }

      // biome-ignore lint/style/noProcessEnv: see comment above
      if (process.env.MOCK_ACP_THOUGHT_CHUNKS === "1") {
        const thoughtId = `mock-acp-thought-${sessionId}`;
        for (const piece of ["First, ", "I'm ", "thinking ", "about ", "this. "]) {
          await connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              messageId: thoughtId,
              content: { type: "text", text: piece },
            },
          });
        }
      }

      // biome-ignore lint/style/noProcessEnv: see comment above
      const toolCallsEnabled = process.env.MOCK_ACP_TOOL_CALLS === "1";
      const toolCallId = toolCallsEnabled ? `mock-tc-${sessionId}` : "";
      if (toolCallsEnabled) {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: "Read",
            kind: "read",
            status: "in_progress",
          },
        });
      }

      // Opt-in streaming text (env MOCK_ACP_STREAMING_TEXT=1): emit one
      // agent_message_chunk per character of MOCK_ACP_REPLY, sharing a
      // stable messageId so the per-message accumulator on the consumer
      // side stitches them. Default mode keeps the v0.2.x behavior of
      // one big chunk for backwards compatibility with existing tests.
      // biome-ignore lint/style/noProcessEnv: see comment above
      if (process.env.MOCK_ACP_STREAMING_TEXT === "1") {
        const messageId = `mock-acp-msg-${sessionId}`;
        for (const char of MOCK_ACP_REPLY) {
          await connection.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId,
              content: { type: "text", text: char },
            },
          });
        }
      } else {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: MOCK_ACP_REPLY },
          },
        });
      }

      // Opt-in non-text events (POST-text). Tool-call terminal status
      // and final usage update arrive after the visible response, mirroring
      // how real harnesses report cost + completion at turn end.
      if (toolCallsEnabled) {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
          },
        });
      }

      // biome-ignore lint/style/noProcessEnv: see comment above
      if (process.env.MOCK_ACP_USAGE_UPDATES === "1") {
        await connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "usage_update",
            size: 200_000,
            used: 12_345,
            cost: { amount: 0.18, currency: "USD" },
          },
        });
      }

      return { stopReason: "end_turn" };
    },

    async cancel(_params: CancelNotification): Promise<void> {
      // No-op: deterministic mock has no in-flight work to cancel.
    },

    async authenticate() {
      return {};
    },
  };
}

async function main(): Promise<void> {
  const stream: Stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  );

  // AgentSideConnection keeps itself alive via its internal reader; unused return is intentional.
  void new AgentSideConnection((conn) => createMockAgent(conn), stream);

  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) {
    process.once(signal, () => {
      setTimeout(() => process.exit(0), 500).unref();
    });
  }
}

if (import.meta.main) {
  await main();
}
