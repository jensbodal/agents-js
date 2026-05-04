import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { TerminalManager } from "../src/terminal-manager.ts";

const WORKSPACE_PATH = "/tmp";

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

function makeRequest(
  overrides: Partial<CreateTerminalRequest> & { command: string },
): CreateTerminalRequest {
  return {
    sessionId: "test-session",
    command: overrides.command,
    args: overrides.args ?? [],
    cwd: overrides.cwd ?? undefined,
    env: overrides.env ?? undefined,
    outputByteLimit: overrides.outputByteLimit ?? undefined,
  } as CreateTerminalRequest;
}

describe("TerminalManager", () => {
  let manager: TerminalManager;

  afterEach(() => {
    manager?.destroyAll();
  });

  test("create returns a unique terminal ID", () => {
    manager = new TerminalManager();
    const id1 = manager.create(makeRequest({ command: "echo", args: ["hello"] }), WORKSPACE_PATH);
    const id2 = manager.create(makeRequest({ command: "echo", args: ["world"] }), WORKSPACE_PATH);
    expect(id1).toBeString();
    expect(id2).toBeString();
    expect(id1).not.toBe(id2);
  });

  test("echo hello produces output containing hello", async () => {
    manager = new TerminalManager();
    const id = manager.create(makeRequest({ command: "echo", args: ["hello"] }), WORKSPACE_PATH);

    await manager.waitForExit(id);

    const { output } = manager.getOutput(id);
    expect(output).toContain("hello");
  });

  test("waitForExit returns exit code 0 for successful command", async () => {
    manager = new TerminalManager();
    const id = manager.create(makeRequest({ command: "true" }), WORKSPACE_PATH);

    const result = await manager.waitForExit(id);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
  });

  test("waitForExit returns non-zero exit code for failed command", async () => {
    manager = new TerminalManager();
    const id = manager.create(makeRequest({ command: "false" }), WORKSPACE_PATH);

    const result = await manager.waitForExit(id);
    expect(result.exitCode).toBe(1);
  });

  test("kill terminates a running process", async () => {
    manager = new TerminalManager();
    const id = manager.create(makeRequest({ command: "sleep", args: ["60"] }), WORKSPACE_PATH);

    const outputBefore = manager.getOutput(id);
    expect(outputBefore.exitStatus).toBeNull();

    manager.kill(id);

    const result = await manager.waitForExit(id);
    expect(result.signal).toBe("SIGTERM");
  });

  test("release cleans up terminal from map", async () => {
    manager = new TerminalManager();
    const id = manager.create(makeRequest({ command: "echo", args: ["cleanup"] }), WORKSPACE_PATH);

    await manager.waitForExit(id);
    manager.release(id);

    expect(manager.getTerminal(id)).toBeUndefined();
  });

  test("release kills a still-running process", () => {
    manager = new TerminalManager();
    const id = manager.create(makeRequest({ command: "sleep", args: ["60"] }), WORKSPACE_PATH);

    manager.release(id);

    expect(manager.getTerminal(id)).toBeUndefined();
  });

  test("getOutput throws for invalid terminal ID", () => {
    manager = new TerminalManager();
    expect(() => manager.getOutput("nonexistent-id")).toThrow("Terminal not found");
  });

  test("waitForExit throws for invalid terminal ID", () => {
    manager = new TerminalManager();
    expect(() => manager.waitForExit("nonexistent-id")).toThrow("Terminal not found");
  });

  test("kill throws for invalid terminal ID", () => {
    manager = new TerminalManager();
    expect(() => manager.kill("nonexistent-id")).toThrow("Terminal not found");
  });

  test("output byte limit enforcement with truncation", async () => {
    manager = new TerminalManager();

    const longArg = "A".repeat(200);
    const id = manager.create(
      makeRequest({
        command: "echo",
        args: [longArg],
        outputByteLimit: 50,
      }),
      WORKSPACE_PATH,
    );

    await manager.waitForExit(id);

    const { output, truncated } = manager.getOutput(id);
    const outputBytes = new TextEncoder().encode(output).length;
    expect(outputBytes).toBeLessThanOrEqual(50);
    expect(truncated).toBe(true);
  });

  test("output within byte limit is not truncated", async () => {
    manager = new TerminalManager();
    const id = manager.create(
      makeRequest({
        command: "echo",
        args: ["short"],
        outputByteLimit: 1000,
      }),
      WORKSPACE_PATH,
    );

    await manager.waitForExit(id);

    const { output, truncated } = manager.getOutput(id);
    expect(output).toContain("short");
    expect(truncated).toBe(false);
  });

  test("captures stderr output", async () => {
    manager = new TerminalManager();
    const id = manager.create(
      makeRequest({
        command: "ls",
        args: ["/nonexistent-path-that-does-not-exist-12345"],
      }),
      WORKSPACE_PATH,
    );

    await manager.waitForExit(id);

    const { output } = manager.getOutput(id);
    expect(output.length).toBeGreaterThan(0);
  });

  test("destroyAll cleans up all terminals", () => {
    manager = new TerminalManager();
    const id1 = manager.create(makeRequest({ command: "sleep", args: ["60"] }), WORKSPACE_PATH);
    const id2 = manager.create(makeRequest({ command: "sleep", args: ["60"] }), WORKSPACE_PATH);

    manager.destroyAll();

    expect(manager.getTerminal(id1)).toBeUndefined();
    expect(manager.getTerminal(id2)).toBeUndefined();
  });

  // Unix-only: descendant cleanup relies on POSIX process groups
  // (spawn({ detached: true }) + `kill -- -pid` on the group). On Windows
  // the spawn path keeps `detached: false` and `child.kill()` only reaches
  // the direct child, so this guarantee does not apply.
  test.skipIf(process.platform === "win32")(
    "kill() terminates grandchildren spawned by the terminal (process-group kill)",
    async () => {
      // User-facing terminals routinely spawn shells that fan out into
      // pipelines and subshells. Simulate that here: /bin/sh backgrounds two
      // long sleeps and waits on them. Without process-group teardown the
      // sleeps would be reparented to init and keep running after kill().
      manager = new TerminalManager();
      const id = manager.create(
        makeRequest({
          command: "/bin/sh",
          args: ["-c", "sleep 30 & echo $! ; sleep 30 & echo $! ; wait"],
        }),
        WORKSPACE_PATH,
      );

      const terminal = manager.getTerminal(id);
      if (!terminal) throw new Error("expected terminal to exist");

      // Collect the two grandchild PIDs directly from the captured output
      // buffer (TerminalManager writes stdout into terminal.outputBuffer).
      const pids = await new Promise<number[]>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for grandchild PIDs")),
          5_000,
        );
        const check = () => {
          const lines = terminal.outputBuffer
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => /^\d+$/.test(l));
          if (lines.length >= 2) {
            clearTimeout(timeout);
            resolve(lines.slice(0, 2).map((l) => Number(l)));
            return;
          }
          setTimeout(check, 20);
        };
        check();
      });

      const trackedPids = [...pids];
      try {
        expect(pids).toHaveLength(2);
        for (const pid of pids) {
          expect(() => process.kill(pid, 0)).not.toThrow();
        }

        manager.kill(id);

        const deadline = Date.now() + 5_000;
        const survivors = new Set(pids);
        while (survivors.size > 0 && Date.now() < deadline) {
          for (const pid of [...survivors]) {
            if (!isProcessRunning(pid)) {
              survivors.delete(pid);
            }
          }
          if (survivors.size > 0) {
            await new Promise((r) => setTimeout(r, 50));
          }
        }

        expect(Array.from(survivors)).toEqual([]);
      } finally {
        for (const pid of trackedPids) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }
    },
  );

  test("env vars are passed to spawned process", async () => {
    manager = new TerminalManager();
    const id = manager.create(
      makeRequest({
        command: "env",
        env: [{ name: "MY_TEST_VAR", value: "hello_test_123" }],
      }),
      WORKSPACE_PATH,
    );

    await manager.waitForExit(id);

    const { output } = manager.getOutput(id);
    expect(output).toContain("MY_TEST_VAR=hello_test_123");
  });

  test("forbidden env keys are filtered from user-provided env", async () => {
    // Caller declares ANTHROPIC_API_KEY as an agent secret in the env
    // policy, which folds it into the forbidden-extra set. The system
    // loader guards (PATH/HOME/LD_PRELOAD/...) are unconditional.
    manager = new TerminalManager({
      envPolicy: { agentSecretEnvKeys: ["ANTHROPIC_API_KEY"] },
    });
    const id = manager.create(
      makeRequest({
        command: "env",
        env: [
          { name: "PATH", value: "/evil/path" },
          { name: "HOME", value: "/evil/home" },
          { name: "LD_PRELOAD", value: "/evil/lib.so" },
          { name: "ANTHROPIC_API_KEY", value: "sk-evil-key" },
          { name: "CUSTOM_VAR", value: "allowed_value" },
          { name: "NODE_ENV", value: "test" },
        ],
      }),
      WORKSPACE_PATH,
    );

    await manager.waitForExit(id);

    const { output } = manager.getOutput(id);

    // Forbidden keys must NOT appear with injected values
    expect(output).not.toContain("PATH=/evil/path");
    expect(output).not.toContain("HOME=/evil/home");
    expect(output).not.toContain("LD_PRELOAD=/evil/lib.so");
    expect(output).not.toContain("ANTHROPIC_API_KEY=sk-evil-key");

    // Non-forbidden keys MUST pass through
    expect(output).toContain("CUSTOM_VAR=allowed_value");
    expect(output).toContain("NODE_ENV=test");
  });
});
