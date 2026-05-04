#!/usr/bin/env bun
/**
 * Minimal droid-exec stand-in for lifecycle/signal tests.
 *
 * Parses a handful of argv flags (--output-format, --cwd, --session-id) and
 * the positional prompt, then emits a scripted stream-json event sequence
 * on stdout before exiting cleanly. The fixture does not drive any model —
 * it simply exercises the adapter's NDJSON reader, translator, and session
 * lifecycle code paths without depending on droid / FACTORY_API_KEY.
 *
 * Env gates:
 *   - DROID_ACP_TEST_HANG=1         drop the completion event entirely and
 *                                   sleep forever so the caller's cancel /
 *                                   SIGTERM path is exercised
 *   - DROID_ACP_TEST_CONTAMINATE=1  emit a non-JSON prefix line so the
 *                                   protocol-error path is exercised
 *   - DROID_ACP_TEST_TOOLCALL=1     include a tool_call + tool_result in
 *                                   the scripted sequence
 *   - DROID_ACP_TEST_SESSION_ID=<s> advertise a specific droid session_id
 *                                   in the system/init event so the caller
 *                                   can assert the latch behavior
 */

// biome-ignore lint/style/noProcessEnv: test fixture reads env gates intentionally.
const TEST_HANG = process.env.DROID_ACP_TEST_HANG === "1";
// biome-ignore lint/style/noProcessEnv: test fixture reads env gates intentionally.
const TEST_CONTAMINATE = process.env.DROID_ACP_TEST_CONTAMINATE === "1";
// biome-ignore lint/style/noProcessEnv: test fixture reads env gates intentionally.
const TEST_TOOLCALL = process.env.DROID_ACP_TEST_TOOLCALL === "1";
// biome-ignore lint/style/noProcessEnv: test fixture reads env gates intentionally.
const FIXTURE_SESSION_ID = process.env.DROID_ACP_TEST_SESSION_ID ?? "fixture-session-1";

function emit(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function emitRaw(raw: string): void {
  process.stdout.write(`${raw}\n`);
}

async function main(): Promise<void> {
  if (TEST_CONTAMINATE) {
    emitRaw("not-json-prefix");
  }
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: FIXTURE_SESSION_ID,
    tools: ["Execute", "Read"],
    model: "fixture-model",
    reasoning_effort: "high",
  });
  emit({
    type: "message",
    role: "user",
    id: "u-1",
    text: "hi",
    timestamp: 1,
    session_id: FIXTURE_SESSION_ID,
  });
  emit({
    type: "reasoning",
    id: "r-1",
    text: "**Planning**\nI will respond succinctly.",
    timestamp: 2,
    session_id: FIXTURE_SESSION_ID,
  });
  // Duplicate reasoning event — droid's current stream-json emits each
  // reasoning payload twice with identical id. The translator must dedupe.
  emit({
    type: "reasoning",
    id: "r-1",
    text: "**Planning**\nI will respond succinctly.",
    timestamp: 2,
    session_id: FIXTURE_SESSION_ID,
  });
  emit({
    type: "message",
    role: "assistant",
    id: "a-1",
    text: "<thinking>\n**Planning**\nI will respond succinctly.\n</thinking>\n\nHi there!",
    timestamp: 3,
    session_id: FIXTURE_SESSION_ID,
  });
  if (TEST_TOOLCALL) {
    emit({
      type: "tool_call",
      id: "tc-abc",
      messageId: "a-1",
      toolId: "Execute",
      toolName: "Execute",
      parameters: { command: "ls" },
      timestamp: 4,
      session_id: FIXTURE_SESSION_ID,
    });
    emit({
      type: "tool_result",
      id: "tc-abc",
      messageId: "a-2",
      toolId: "Execute",
      isError: false,
      value: "file-a\nfile-b\n",
      timestamp: 5,
      session_id: FIXTURE_SESSION_ID,
    });
  }
  if (TEST_HANG) {
    // Drop the completion event and sleep forever; caller must terminate us.
    await new Promise(() => {});
    return;
  }
  emit({
    type: "completion",
    finalText: "Hi there!",
    numTurns: 1,
    durationMs: 42,
    session_id: FIXTURE_SESSION_ID,
    timestamp: 6,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  });
  // Give the parent's stdout reader a moment to drain before we exit.
  await Bun.sleep(10);
  process.exit(0);
}

await main();
