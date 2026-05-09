#!/usr/bin/env bun
/**
 * Minimal Pi RPC stand-in for lifecycle/signal tests.
 *
 * Reads NDJSON commands on stdin and replies with a scripted event sequence.
 * Supports:
 *   - `prompt` → stream one text_delta, one thinking_delta, then agent_end
 *   - `abort`  → cancel any in-flight prompt by emitting agent_end immediately
 *   - `get_state` → stateless reply with a fake session id
 *
 * The fixture honors `PI_ACP_TEST_HANG=1` to drop replies entirely (so the
 * caller's cancellation / timeout path can be exercised) and
 * `PI_ACP_TEST_CONTAMINATE=1` to emit a non-JSON prefix line (so the
 * protocol-error path can be exercised).
 */

// biome-ignore lint/style/noProcessEnv: test fixture reads env gates intentionally.
const TEST_HANG = process.env.PI_ACP_TEST_HANG === "1";
// biome-ignore lint/style/noProcessEnv: test fixture reads env gates intentionally.
const TEST_CONTAMINATE = process.env.PI_ACP_TEST_CONTAMINATE === "1";

function emit(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function emitRaw(raw: string): void {
  process.stdout.write(`${raw}\n`);
}

let activeTimer: ReturnType<typeof setTimeout> | null = null;

async function handleCommand(cmd: { id?: string; type: string; message?: string }): Promise<void> {
  if (TEST_HANG && cmd.type === "prompt") {
    return;
  }
  switch (cmd.type) {
    case "prompt": {
      emit({ id: cmd.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_start" });
      emit({ type: "turn_start" });
      emit({ type: "message_start", message: { role: "user", content: [] } });
      emit({ type: "message_end", message: { role: "user", content: [] } });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex: 0 },
      });
      // Split the reply to exercise multi-chunk streaming.
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hi ", contentIndex: 0 },
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "there!", contentIndex: 0 },
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hi there!" },
      });
      emit({ type: "message_end", message: { role: "assistant", content: [] } });
      emit({ type: "turn_end", message: { role: "assistant" } });
      // Small delay so tests can interleave an abort if they want to.
      activeTimer = setTimeout(() => {
        emit({ type: "agent_end", messages: [] });
        activeTimer = null;
      }, 25);
      break;
    }
    case "abort": {
      if (activeTimer) {
        clearTimeout(activeTimer);
        activeTimer = null;
      }
      // No response envelope required; tests only rely on the subsequent
      // agent_end marker having been synthesized or cancellation being
      // observed on the ACP side.
      emit({ type: "agent_end", messages: [] });
      break;
    }
    case "get_state": {
      emit({
        id: cmd.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "mock-pi-session" },
      });
      break;
    }
    default: {
      emit({
        id: cmd.id,
        type: "response",
        command: cmd.type,
        success: false,
        error: `mock-pi: unhandled command "${cmd.type}"`,
      });
    }
  }
}

async function main(): Promise<void> {
  if (TEST_CONTAMINATE) {
    emitRaw("not-json-prefix");
  }
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let newline = buf.indexOf("\n");
    while (newline !== -1) {
      const line = buf.slice(0, newline);
      buf = buf.slice(newline + 1);
      if (line.length > 0) {
        try {
          const cmd = JSON.parse(line);
          void handleCommand(cmd);
        } catch {
          // Ignore malformed inputs in the fixture.
        }
      }
      newline = buf.indexOf("\n");
    }
  });
  process.stdin.on("end", () => {
    process.exit(0);
  });

  // Keep alive until stdin closes.
  await new Promise(() => {});
}

await main();
