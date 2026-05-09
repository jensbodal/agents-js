import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnACPAgent } from "../src/index.ts";

const bunBinary = Bun.which("bun") ?? "bun";
const quietScript = "setTimeout(() => {}, 1000)";

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

function spawnQuietACPAgent(extraOptions: Parameters<typeof spawnACPAgent>[0] = {}) {
  return spawnACPAgent({
    command: bunBinary,
    args: ["-e", quietScript],
    ...extraOptions,
  });
}

describe("spawnACPAgent", () => {
  test("spawns a quiet subprocess with a stream", () => {
    const acp = spawnQuietACPAgent();

    try {
      expect(acp.stream).toBeDefined();
      expect(acp.process).toBeDefined();
      expect(typeof acp.kill).toBe("function");
    } finally {
      acp.kill();
    }
  });

  test("spawns with custom command and args", () => {
    const acp = spawnACPAgent({
      command: bunBinary,
      args: ["-e", quietScript, "--", "test", "args"],
    });

    try {
      expect(acp.process.spawnargs).toContain(bunBinary);
      expect(acp.process.spawnargs).toContain("--");
      expect(acp.process.spawnargs).toContain("test");
      expect(acp.process.spawnargs).toContain("args");
    } finally {
      acp.kill();
    }
  });

  test("passes extra env variables", async () => {
    const acp = spawnACPAgent({
      command: bunBinary,
      args: [
        "-e",
        [
          "process.stdout.write(",
          'JSON.stringify({ jsonrpc: "2.0", method: "test/env", params: { value: process.env.CUSTOM_VAR ?? null } })',
          ' + "\\n");',
          quietScript,
        ].join(""),
      ],
      env: { CUSTOM_VAR: "test_value" },
    });

    const reader = acp.stream.readable.getReader();
    try {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      expect(value).toMatchObject({
        method: "test/env",
        params: { value: "test_value" },
      });
    } finally {
      reader.releaseLock();
      acp.kill();
    }
  });

  test("creates a stream when stdio pipes are available", () => {
    const acp = spawnACPAgent({ command: "cat", args: [] });
    try {
      expect(acp.stream).toBeDefined();
    } finally {
      acp.kill();
    }
  });
});

describe("ACPProcess interface", () => {
  test("kill() terminates the process", async () => {
    const acp = spawnACPAgent({ command: "cat", args: [] });

    // Before kill, exit state is still pending.
    expect(acp.process.exitCode).toBeNull();
    acp.kill();

    // On Unix we signal the process group via `process.kill(-pid, "SIGTERM")`,
    // which does NOT flip `child.killed` (that flag is only set by
    // `child.kill()`). Assert termination by waiting for the actual exit.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("process did not exit after kill()")),
        5_000,
      );
      acp.process.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    expect(acp.process.signalCode ?? acp.process.exitCode).toBeTruthy();
  });

  // Unix-only: descendant cleanup relies on POSIX process groups
  // (spawn({ detached: true }) + `kill -- -pid` on the group).
  test.skipIf(process.platform === "win32")(
    "kill() terminates grandchild processes (process-group kill)",
    async () => {
      // Spawn a shell that backgrounds two long-running sleeps and waits on
      // them. If kill() only signaled the direct child, the sleeps would be
      // reparented to init and survive. Each sleep prints its own PID so we
      // can assert liveness directly via `process.kill(pid, 0)` rather than
      // relying on `pgrep -P` (which can't see reparented processes and would
      // false-positive pass the bug).
      const acp = spawnACPAgent({
        command: "/bin/sh",
        args: ["-c", "sleep 30 & echo $! ; sleep 30 & echo $! ; wait"],
      });

      const trackedPids: number[] = [];
      try {
        const pids = await new Promise<number[]>((resolve, reject) => {
          let buf = "";
          const timeout = setTimeout(
            () => reject(new Error("timed out waiting for grandchild PIDs")),
            5_000,
          );
          acp.process.stdout?.on("data", (chunk: Buffer) => {
            buf += chunk.toString("utf-8");
            const lines = buf.split("\n").filter((l) => /^\d+$/.test(l.trim()));
            if (lines.length >= 2) {
              clearTimeout(timeout);
              resolve(lines.slice(0, 2).map((l) => Number(l.trim())));
            }
          });
          acp.process.on("error", (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });

        expect(pids).toHaveLength(2);
        trackedPids.push(...pids);

        for (const pid of pids) {
          expect(() => process.kill(pid, 0)).not.toThrow();
        }

        acp.kill();

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
        try {
          acp.kill();
        } catch {
          /* noop */
        }
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
});

describe("error-aware stream", () => {
  test("rejects on ENOENT", async () => {
    const acp = spawnACPAgent({ command: "/nonexistent/cmd", args: [] });
    const reader = acp.stream.readable.getReader();
    await expect(reader.read()).rejects.toThrow(/Failed to start agent/);
  }, 5000);

  test("rejects on non-zero exit", async () => {
    const acp = spawnACPAgent({ command: bunBinary, args: ["-e", "process.exit(42)"] });
    const reader = acp.stream.readable.getReader();
    await expect(reader.read()).rejects.toThrow(/exited with code 42/);
  }, 5000);

  test("closes cleanly on exit 0", async () => {
    const acp = spawnACPAgent({ command: bunBinary, args: ["-e", "process.exit(0)"] });
    const reader = acp.stream.readable.getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
  }, 5000);
});
