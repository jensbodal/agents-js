import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostACPProcess } from "../src/process.ts";

const shellBinary = "/bin/sh";
const quietScript = "exit 0";
const workspacePath = process.cwd();

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

describe("createHostACPProcess", () => {
  test("appends the configured workspace flag when absent", () => {
    const acp = createHostACPProcess(workspacePath, {
      command: shellBinary,
      args: ["-c", quietScript, "--"],
      workspaceFlag: "--cwd",
    });

    try {
      expect(acp.process.spawnargs).toEqual([
        shellBinary,
        "-c",
        quietScript,
        "--",
        "--cwd",
        workspacePath,
      ]);
    } finally {
      acp.kill();
    }
  });

  test("does not append the workspace flag twice when it already exists", () => {
    const acp = createHostACPProcess(workspacePath, {
      command: shellBinary,
      args: ["-c", quietScript, "--", "--cwd", workspacePath],
      workspaceFlag: "--cwd",
    });

    try {
      expect(acp.process.spawnargs).toEqual([
        shellBinary,
        "-c",
        quietScript,
        "--",
        "--cwd",
        workspacePath,
      ]);
    } finally {
      acp.kill();
    }
  });

  test("treats --flag=value as already configured", () => {
    const acp = createHostACPProcess(workspacePath, {
      command: shellBinary,
      args: ["-c", quietScript, "--", `--cwd=${workspacePath}`],
      workspaceFlag: "--cwd",
    });

    try {
      expect(acp.process.spawnargs).toEqual([
        shellBinary,
        "-c",
        quietScript,
        "--",
        `--cwd=${workspacePath}`,
      ]);
    } finally {
      acp.kill();
    }
  });

  test("uses sessionCwd for the workspace flag and spawned cwd while keeping the workspace root stable", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "acp-process-root-"));
    const sessionCwd = join(workspaceRoot, "scoped");
    const markerFile = join(sessionCwd, "cwd.txt");
    await mkdir(sessionCwd, { recursive: true });

    const acp = createHostACPProcess(workspaceRoot, {
      command: shellBinary,
      args: ["-c", "pwd > cwd.txt"],
      sessionCwd,
      workspaceFlag: "--cwd",
    });

    try {
      expect(acp.process.spawnargs).toEqual([
        shellBinary,
        "-c",
        "pwd > cwd.txt",
        "--cwd",
        sessionCwd,
      ]);

      await new Promise<void>((resolve, reject) => {
        acp.process.on("exit", () => resolve());
        acp.process.on("error", reject);
      });

      const printedCwd = (await readFile(markerFile, "utf-8")).trim();
      expect(printedCwd).toBe(await realpath(sessionCwd));
    } finally {
      acp.kill();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  // Unix-only: the descendant-cleanup invariant relies on POSIX process groups
  // (spawn({ detached: true }) + `kill -- -pid` on the group). On Windows the
  // spawn path keeps `detached: false` and `child.kill()` only reaches the
  // direct child, so this guarantee does not apply.
  test.skipIf(process.platform === "win32")(
    "kill() terminates grandchild processes spawned by the agent (process-group kill)",
    async () => {
      // Spawn a shell that backgrounds two long-running sleeps and waits on them.
      // These sleeps become grandchildren of the test process; if kill() only
      // signals the direct child, the sleeps get reparented to init (pid 1 on
      // Linux, launchd on macOS) and survive.
      //
      // The sleeps print their own PIDs to stdout so we can assert on them
      // directly rather than relying on `pgrep -P` (which only sees direct
      // children and would give a false-positive pass if reparenting occurred).
      const acp = createHostACPProcess(workspacePath, {
        command: shellBinary,
        args: [
          "-c",
          // echo child PIDs, then wait (keeps the shell — and the sleeps — alive)
          "sleep 30 & echo $! ; sleep 30 & echo $! ; wait",
        ],
      });

      const trackedPids: number[] = [];
      try {
        // Collect the two grandchild PIDs from stdout.
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

        // Sanity: the grandchildren are alive right now (signal 0 probes
        // liveness without actually sending a signal).
        for (const pid of pids) {
          expect(() => process.kill(pid, 0)).not.toThrow();
        }

        // Kill via the ACPProcess abstraction — this is the code path under test.
        acp.kill();

        // Wait for the process group to wind down. SIGTERM propagates
        // asynchronously, so poll each grandchild PID until `kill(pid, 0)`
        // reports ESRCH (no such process).
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
        // Defensive cleanup: if the invariant is broken (grandchildren survive
        // `acp.kill()`), reap them directly by PID so a failing test doesn't
        // leak 30-second sleeps into the session. This is belt-and-suspenders
        // — a passing test has already verified they're gone.
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
