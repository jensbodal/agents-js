/**
 * Minimal ACP-protocol mock used by `acp-real-process.test.ts`.
 *
 * Purpose is narrow: let the `agents-js acp` subcommand spawn a REAL child
 * process and exercise signal-forwarding, stdin-EPIPE, process-group kill,
 * and stdout-contamination paths end-to-end. The broader browser-smoke
 * mock at `tests/mock-acp-agent.cjs` covers auth + elicitation flows; this
 * fixture stays simple on purpose.
 *
 * Modes (env-gated; default is "clean session"):
 *
 * - AGENTS_JS_REAL_MODE=exit-zero        (default)
 *     Respond to initialize, session/new, and session/prompt; exit 0 after
 *     the prompt completes.
 *
 * - AGENTS_JS_REAL_MODE=exit-nonzero
 *     Respond to initialize + session/new; exit 7 on the first
 *     session/prompt before replying. Used to assert the cli surfaces the
 *     non-zero code and does not crash from the stdin EPIPE.
 *
 * - AGENTS_JS_REAL_MODE=spawn-grandchild
 *     Fork a sleeping grandchild that detaches into its own process group
 *     only if told to. By default the grandchild INHERITS the parent's
 *     process group so a `process.kill(-pid, SIGTERM)` on the cli kills
 *     all three layers (cli -> agent -> grandchild). The grandchild
 *     writes its pid to AGENTS_JS_REAL_GRANDCHILD_PID_FILE so the test
 *     can assert it terminated.
 *
 * - AGENTS_JS_REAL_MODE=contaminated-stdout
 *     Emit binary garbage as the FIRST stdout write. The cli inspects the
 *     first chunk via `inspectFirstChunk` and exits with
 *     `EXIT_PROTOCOL_CONTAMINATION` (70), writing the formatted diagnostic
 *     to stderr without passing the garbage through to its own stdout.
 */

const readline = require("node:readline");
const { spawn } = require("node:child_process");

// biome-ignore lint/style/noProcessEnv: test fixture reads env gates intentionally.
const MODE = process.env.AGENTS_JS_REAL_MODE || "exit-zero";
const SESSION_ID = "real-session-1";

// --- Grandchild fork (spawn-grandchild mode only) ---
// Runs before we touch stdin/stdout so the grandchild inherits our fds
// cleanly. The grandchild sleeps up to 30s; if SIGTERM propagates via the
// process group, Node exits ~immediately.
let grandchild = null;
if (MODE === "spawn-grandchild") {
  // node -e 'setTimeout(()=>process.exit(0), 30000)'
  grandchild = spawn(
    process.execPath,
    [
      "-e",
      // Write pid to file then idle. Parent's detached:true + pgid propagation
      // means SIGTERM to -pgid will hit us too.
      `require('node:fs').writeFileSync(process.env.AGENTS_JS_REAL_GRANDCHILD_PID_FILE, String(process.pid)); setTimeout(() => process.exit(0), 30000);`,
    ],
    {
      stdio: "ignore",
      // biome-ignore lint/style/noProcessEnv: grandchild inherits env for pid-file path.
      env: process.env,
      // IMPORTANT: do NOT set detached:true — we *want* the grandchild in our
      // process group so the cli's `process.kill(-pid, SIGTERM)` reaches it.
      detached: false,
    },
  );
  grandchild.unref();
}

function write(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function sendChunk(sessionId, text) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function handleInitialize(request) {
  reply(request.id, {
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { image: false } },
    agentInfo: { name: "RealProcessMock", version: "0.1.0" },
    authMethods: [],
  });
}

function handleNewSession(request) {
  reply(request.id, { sessionId: SESSION_ID });
}

function handlePrompt(request) {
  if (MODE === "exit-nonzero") {
    // Simulate a crashy agent: exit BEFORE replying. The cli's pipe of
    // process.stdin -> child.stdin may observe EPIPE afterward.
    process.stderr.write("[real-mock] exit-nonzero mode: exiting 7 before reply\n");
    process.exit(7);
  }

  sendChunk(SESSION_ID, "ok");
  reply(request.id, { stopReason: "end_turn" });

  // Shut down cleanly after the first prompt completes for modes that rely
  // on a natural exit. spawn-grandchild tests kill us via SIGTERM before
  // this runs.
  if (MODE === "exit-zero" || MODE === "contaminated-stdout") {
    // Give the event loop one tick so the reply flushes.
    setTimeout(() => process.exit(0), 10);
  }
}

function handleRequest(request) {
  switch (request.method) {
    case "initialize":
      handleInitialize(request);
      return;
    case "session/new":
      handleNewSession(request);
      return;
    case "session/prompt":
      handlePrompt(request);
      return;
    default:
      process.stderr.write(`[real-mock] ignoring method: ${request.method}\n`);
  }
}

// Contamination mode: write garbage BEFORE entering the ndJSON loop.
if (MODE === "contaminated-stdout") {
  // Four arbitrary non-JSON bytes followed by a newline. `inspectFirstChunk`
  // would classify this as `invalid-json` (empty-line → fallback).
  process.stdout.write(Buffer.from([0x00, 0xff, 0x7f, 0x01, 0x0a]));
  // Still run the normal protocol loop so the cli doesn't hang waiting for
  // a response to initialize — this lets the test observe whether the
  // garbage bytes make it through to the cli's stdout pipe.
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg && typeof msg === "object" && "method" in msg) {
      handleRequest(msg);
    }
  } catch (err) {
    process.stderr.write(`[real-mock] parse error: ${err.message}\n`);
  }
});

rl.on("close", () => {
  // Clean up grandchild if it's still around when stdin closes.
  if (grandchild && !grandchild.killed) {
    try {
      grandchild.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
});
