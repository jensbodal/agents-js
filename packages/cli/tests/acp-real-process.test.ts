/**
 * Real-process integration coverage for the `agents-js acp` subcommand.
 *
 * Every other cli test uses mock-spawn via the injectable `spawnProcess`
 * dependency. That leaves real-process behaviors uncovered:
 *
 *  - SIGTERM/SIGINT forwarding to the child (and process-group kill on Unix).
 *  - EPIPE-on-child-stdin handling when the child exits before consuming input.
 *  - Actual NDJSON flow through stdin/stdout.
 *  - Stdout contamination surface (documented here — see notes below).
 *
 * These tests spawn the cli (`bun src/cli.ts acp --acp-command …`) as a real
 * child against the minimal fixture in `fixtures/real-process-acp-agent.cjs`.
 * They are gated to Unix; Windows is not a supported test platform.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const IS_UNIX = process.platform !== "win32";

/**
 * Returns true if the process is actually running (not terminated).
 *
 * `kill(pid, 0)` alone is insufficient in container environments: when
 * PID 1 doesn't reap orphans (bare `bash` container entrypoint, not
 * `tini` / `docker-init`), terminated child processes linger as zombies
 * and respond to signal 0 the same way living processes do. On Linux we
 * therefore also consult `/proc/<pid>/status` — a `State: Z (zombie)`
 * line means terminated-but-unreaped, which the test contract treats as
 * terminated.
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw err;
  }
  if (process.platform === "linux") {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf-8");
      const stateLine = status.split("\n").find((l) => l.startsWith("State:"));
      if (stateLine?.includes("Z")) return false;
    } catch {
      return false;
    }
  }
  return true;
}
const PKG_ROOT = path.resolve(import.meta.dir, "..");
const CLI_ENTRY = path.join(PKG_ROOT, "src", "cli.ts");
const FIXTURE = path.join(PKG_ROOT, "tests", "fixtures", "real-process-acp-agent.cjs");

// Per-test timeout. Real-process tests are intrinsically slower than mock
// tests; 10s is generous on CI but still catches hangs.
const TEST_TIMEOUT_MS = 10_000;

interface CliProc {
  proc: ReturnType<typeof Bun.spawn>;
  pid: number;
  stdout: string[];
  stderr: string[];
  exited: Promise<number>;
  dispose: () => Promise<void>;
}

/**
 * Spawn the cli's acp subcommand against the fixture. Returns accumulated
 * stdout/stderr and a dispose() that kills the process-group if still live.
 */
function spawnCli(args: string[], env: Record<string, string | undefined> = {}): CliProc {
  // Use `node <fixture>` via --acp-command + --acp-args-json so we don't have
  // to chmod +x the fixture. Mirrors how the existing mock-spawn tests pass
  // tests/mock-acp-agent.cjs to the serve subcommand.
  const proc = Bun.spawn(
    [
      "bun",
      CLI_ENTRY,
      "acp",
      "--acp-command",
      process.execPath,
      "--acp-args-json",
      JSON.stringify([FIXTURE]),
      ...args,
    ],
    {
      cwd: PKG_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    },
  );

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  // Stream stdout/stderr asynchronously so tests can observe them in real
  // time without blocking on a single large read.
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdoutChunks.push(decoder.decode(value, { stream: true }));
    }
  })().catch(() => {
    /* reader closed on exit */
  });

  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stderrChunks.push(decoder.decode(value, { stream: true }));
    }
  })().catch(() => {
    /* reader closed on exit */
  });

  return {
    proc,
    pid: proc.pid ?? -1,
    stdout: stdoutChunks,
    stderr: stderrChunks,
    exited: proc.exited,
    async dispose() {
      if (proc.killed) return;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      try {
        await Promise.race([proc.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      } catch {
        /* ignored */
      }
    },
  };
}

async function waitForStdoutMatch(
  cli: CliProc,
  matcher: (buffer: string) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (matcher(cli.stdout.join(""))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for stdout match. Stdout: ${cli.stdout.join("")}\nStderr: ${cli.stderr.join("")}`,
  );
}

async function writeCliStdin(cli: CliProc, payload: object): Promise<void> {
  const line = `${JSON.stringify(payload)}\n`;
  // With `stdin: "pipe"` the stdin slot is a Bun FileSink. Narrow via a
  // structural runtime check rather than `as` — fd numbers have no `write`.
  const writer = cli.proc.stdin;
  if (typeof writer === "number" || !writer || typeof writer.write !== "function") {
    throw new Error("cli stdin is not a writable FileSink");
  }
  writer.write(line);
  writer.flush();
}

describe.skipIf(!IS_UNIX)("acp real-process integration", () => {
  let activeCli: CliProc | undefined;
  let scratchDir: string | undefined;

  afterEach(async () => {
    if (activeCli) {
      await activeCli.dispose();
      activeCli = undefined;
    }
    if (scratchDir) {
      await rm(scratchDir, { recursive: true, force: true });
      scratchDir = undefined;
    }
  });

  test(
    "clean session: agent replies to initialize/prompt and exits 0",
    async () => {
      const cli = spawnCli([], { AGENTS_JS_REAL_MODE: "exit-zero" });
      activeCli = cli;

      await writeCliStdin(cli, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      });
      await waitForStdoutMatch(
        cli,
        (s) => s.includes('"id":1') && s.includes("RealProcessMock"),
        TEST_TIMEOUT_MS,
      );

      await writeCliStdin(cli, {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: PKG_ROOT, mcpServers: [] },
      });
      await waitForStdoutMatch(
        cli,
        (s) => s.includes('"sessionId":"real-session-1"'),
        TEST_TIMEOUT_MS,
      );

      await writeCliStdin(cli, {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "real-session-1",
          prompt: [{ type: "text", text: "hi" }],
        },
      });
      await waitForStdoutMatch(cli, (s) => s.includes("end_turn"), TEST_TIMEOUT_MS);

      const exitCode = await cli.exited;
      expect(exitCode).toBe(0);
      activeCli = undefined; // disposed via natural exit
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "SIGTERM forwarding: cli propagates signal to agent and grandchild (process-group kill)",
    async () => {
      scratchDir = await mkdtemp(path.join(tmpdir(), "agents-js-real-"));
      const grandchildPidFile = path.join(scratchDir, "grandchild.pid");

      const cli = spawnCli([], {
        AGENTS_JS_REAL_MODE: "spawn-grandchild",
        AGENTS_JS_REAL_GRANDCHILD_PID_FILE: grandchildPidFile,
      });
      activeCli = cli;

      // Drive the agent through initialize so it definitely spawned the
      // grandchild before we signal.
      await writeCliStdin(cli, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      });
      await waitForStdoutMatch(cli, (s) => s.includes("RealProcessMock"), TEST_TIMEOUT_MS);

      // Wait for grandchild to write its pid file.
      let grandchildPid: number | undefined;
      const grandchildDeadline = Date.now() + 3_000;
      while (Date.now() < grandchildDeadline) {
        try {
          const raw = await readFile(grandchildPidFile, "utf8");
          grandchildPid = Number.parseInt(raw.trim(), 10);
          if (Number.isFinite(grandchildPid) && grandchildPid > 0) break;
        } catch {
          /* not ready yet */
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(grandchildPid).toBeGreaterThan(0);

      // Send SIGTERM to the cli. Its own SIGTERM handler should forward to
      // the agent's process group, which includes the grandchild.
      cli.proc.kill("SIGTERM");

      const exitCode = await cli.exited;
      // cli exits with the child's exit code; SIGTERM on the agent is 143
      // (128+15) on Unix, though if the agent receives SIGKILL after a
      // timeout it could be 137. Either is acceptable for this assertion.
      expect(exitCode).not.toBe(0);

      // Give the grandchild a moment to exit, then verify it's not running.
      // Plain kill(pid, 0) is insufficient in container CI (zombies linger
      // when PID 1 doesn't reap orphans); `isProcessRunning` consults /proc
      // on Linux to treat zombie state as terminated.
      await new Promise((resolve) => setTimeout(resolve, 500));
      // biome-ignore lint/style/noNonNullAssertion: guarded above.
      expect(isProcessRunning(grandchildPid!)).toBe(false);

      activeCli = undefined;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "stdin EPIPE: cli does not crash when agent exits early",
    async () => {
      const cli = spawnCli([], { AGENTS_JS_REAL_MODE: "exit-nonzero" });
      activeCli = cli;

      await writeCliStdin(cli, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      });
      await waitForStdoutMatch(cli, (s) => s.includes("RealProcessMock"), TEST_TIMEOUT_MS);

      await writeCliStdin(cli, {
        jsonrpc: "2.0",
        id: 2,
        method: "session/new",
        params: { cwd: PKG_ROOT, mcpServers: [] },
      });
      await waitForStdoutMatch(
        cli,
        (s) => s.includes('"sessionId":"real-session-1"'),
        TEST_TIMEOUT_MS,
      );

      // Agent will exit(7) before replying to this prompt. Subsequent writes
      // to the child's stdin would EPIPE without the cli's swallow-handler.
      await writeCliStdin(cli, {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "real-session-1",
          prompt: [{ type: "text", text: "please die" }],
        },
      });

      // Fire-and-forget a second write to force an EPIPE if the agent is
      // already dead. Pre-existing error handler swallows EPIPE silently;
      // other errors would surface on stderr.
      try {
        await writeCliStdin(cli, {
          jsonrpc: "2.0",
          id: 4,
          method: "session/prompt",
          params: {
            sessionId: "real-session-1",
            prompt: [{ type: "text", text: "double" }],
          },
        });
      } catch {
        /* stdin already closed is fine */
      }

      const exitCode = await cli.exited;
      // cli inherits agent's exit code.
      expect(exitCode).toBe(7);

      const stderrText = cli.stderr.join("");
      // EPIPE messages should NOT surface as cli diagnostics (they are
      // swallowed by the stdin error handler in acp.ts).
      expect(stderrText).not.toContain("EPIPE");
      // Uncaught-exception traces would contain "Error:" from Node.
      expect(stderrText).not.toContain("Uncaught Error");
      activeCli = undefined;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "contaminated stdout: cli detects, logs diagnostic, kills child, and exits 2",
    async () => {
      // `runAcpCommand` now inspects the first stdout chunk with
      // `inspectFirstChunk`. The fixture's "contaminated-stdout" mode emits
      // 5 garbage bytes BEFORE any JSON-RPC reply. The cli must:
      //   1. Fail fast with a formatted contamination diagnostic on stderr.
      //   2. Terminate the child (SIGTERM via the existing process-group
      //      kill path).
      //   3. Exit with EXIT_PROTOCOL_CONTAMINATION (70) — distinct from the
      //      child's own exit code, which is irrelevant on contamination.
      //   4. NOT leak the garbage prefix to its own stdout.
      const cli = spawnCli([], { AGENTS_JS_REAL_MODE: "contaminated-stdout" });
      activeCli = cli;

      await writeCliStdin(cli, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1 },
      });

      const exitCode = await cli.exited;
      // 70 = EXIT_PROTOCOL_CONTAMINATION (sysexits-style) — the constant
      // is re-exported from src/acp.ts as ACP_CONTAMINATION_EXIT_CODE for
      // backwards compatibility with operator scripts.
      expect(exitCode).toBe(70);

      const stderrText = cli.stderr.join("");
      expect(stderrText).toContain("[agents-js] Stdout contamination detected");
      // `inspectFirstChunk` classifies the fixture's 0x00/0xff/0x7f/0x01 prefix
      // as `binary` (control chars outside TAB/LF/CR are detected before the
      // JSON-parse fallback).
      expect(stderrText).toContain("binary data");

      // Contaminated bytes must NOT have leaked to the cli's stdout. The
      // inspection runs on the first chunk BEFORE pipe() is attached.
      const stdoutText = cli.stdout.join("");
      expect(stdoutText).not.toContain("RealProcessMock");

      activeCli = undefined;
    },
    TEST_TIMEOUT_MS,
  );
});
