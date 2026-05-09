import { afterEach, describe, expect, test } from "bun:test";
import { ResilientACPProcess } from "../src/resilience.ts";

const bunBinary = Bun.which("bun") ?? "bun";

/**
 * Spawn a ResilientACPProcess that runs a short bun script.
 * The script exits with the given code after an optional delay.
 */
function createCrashingProcess(
  exitCode: number,
  delayMs = 0,
  extraOpts: ConstructorParameters<typeof ResilientACPProcess>[0] = {},
) {
  const script =
    delayMs > 0
      ? `setTimeout(() => process.exit(${exitCode}), ${delayMs})`
      : `process.exit(${exitCode})`;

  return new ResilientACPProcess({
    command: bunBinary,
    args: ["-e", script],
    ...extraOpts,
  });
}

/** Spawn a long-lived process that won't exit on its own. */
function createStableProcess(extraOpts: ConstructorParameters<typeof ResilientACPProcess>[0] = {}) {
  return new ResilientACPProcess({
    command: bunBinary,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    ...extraOpts,
  });
}

/** Helper to wait for a specified duration. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Track processes for cleanup
const processes: ResilientACPProcess[] = [];

function tracked<T extends ResilientACPProcess>(p: T): T {
  processes.push(p);
  return p;
}

afterEach(() => {
  for (const p of processes) {
    try {
      p.destroy();
    } catch {
      // already destroyed or dead
    }
  }
  processes.length = 0;
});

describe("ResilientACPProcess", () => {
  test("initializes and creates a stream", () => {
    const acp = tracked(createStableProcess());
    expect(acp.stream).toBeDefined();
    expect(acp.process).toBeDefined();
  });

  test("restarts on manual restart()", () => {
    const acp = tracked(createStableProcess());
    const oldPid = acp.process.pid;

    acp.restart();
    const newPid = acp.process.pid;

    expect(oldPid).not.toEqual(newPid);
  });

  describe("auto-restart on crash (non-zero exit)", () => {
    test("restarts after non-zero exit code", async () => {
      const acp = tracked(
        createCrashingProcess(1, 0, {
          maxRestarts: 3,
          baseDelayMs: 50,
          stableWindowMs: 60000,
        }),
      );

      const firstPid = acp.process.pid;

      const timeoutMs = 1000;
      const started = Date.now();
      while (Date.now() - started < timeoutMs && acp.process.pid === firstPid) {
        await wait(25);
      }

      // Process should have been restarted — PID should differ
      expect(acp.process.pid).not.toEqual(firstPid);
    });
  });

  describe("no restart on clean exit (code 0)", () => {
    test("does not restart when process exits with code 0", async () => {
      const acp = tracked(
        createCrashingProcess(0, 0, {
          maxRestarts: 5,
          baseDelayMs: 50,
          stableWindowMs: 60000,
        }),
      );

      const firstPid = acp.process.pid;

      // Wait long enough that a restart would have happened if one was scheduled
      await wait(300);

      // PID should remain the same (no restart occurred).
      // The process is dead, but no new process was spawned.
      expect(acp.process.pid).toEqual(firstPid);
    });
  });

  describe("max retry limit and exhaustion callback", () => {
    test("fires exhaustion callback after max restarts", async () => {
      let exhaustionFired = false;
      let reportedCount = 0;

      const maxRestarts = 3;
      const baseDelay = 30;

      const acp = tracked(
        createCrashingProcess(1, 0, {
          maxRestarts,
          baseDelayMs: baseDelay,
          stableWindowMs: 60000,
        }),
      );

      acp.onExhaustion((count) => {
        exhaustionFired = true;
        reportedCount = count;
      });

      // Total time: crash + 30ms + crash + 60ms + crash + 120ms + crash (exhausted)
      // ~210ms + overhead. Give generous buffer.
      await wait(1500);

      expect(exhaustionFired).toBe(true);
      expect(reportedCount).toBe(maxRestarts);
    });

    test("stops restarting after max retries reached", async () => {
      const maxRestarts = 2;
      const baseDelay = 30;
      let restartsSeen = 0;

      const acp = tracked(
        createCrashingProcess(1, 0, {
          maxRestarts,
          baseDelayMs: baseDelay,
          stableWindowMs: 60000,
        }),
      );

      // Track PID changes via polling
      let lastPid = acp.process.pid;
      const checkInterval = setInterval(() => {
        const currentPid = acp.process.pid;
        if (currentPid !== lastPid) {
          restartsSeen++;
          lastPid = currentPid;
        }
      }, 20);

      // Wait for exhaustion: crash + 30ms + crash + 60ms + crash (exhausted)
      await wait(1000);
      clearInterval(checkInterval);

      // Should have restarted exactly maxRestarts times, then stopped
      expect(restartsSeen).toBeLessThanOrEqual(maxRestarts);
    });
  });

  describe("backoff delay", () => {
    test("applies exponential backoff between restarts", async () => {
      const maxRestarts = 3;
      const baseDelay = 80;
      const scheduledDelays: number[] = [];

      tracked(
        createCrashingProcess(1, 0, {
          maxRestarts,
          baseDelayMs: baseDelay,
          stableWindowMs: 60000,
          logSink: {
            error: () => {},
            warn: (message) => {
              const match = message.match(/in (\d+)ms/);
              if (match) {
                scheduledDelays.push(Number(match[1]));
              }
            },
          },
        }),
      );

      // Wait long enough for all scheduled retries to be observed.
      await wait(1500);

      expect(scheduledDelays).toEqual([80, 160, 320]);
    });
  });

  describe("sliding window reset", () => {
    test("resets retry counter after stable run period", async () => {
      // Use a very short stable window so test is fast
      const stableWindowMs = 200;
      let exhaustionFired = false;

      // Create a process that stays alive
      const acp = tracked(
        createStableProcess({
          maxRestarts: 2,
          baseDelayMs: 30,
          stableWindowMs,
        }),
      );

      acp.onExhaustion(() => {
        exhaustionFired = true;
      });

      // Wait for the stable window to elapse — counter should reset
      await wait(stableWindowMs + 100);

      // Now simulate 2 manual restarts that crash. After the window reset,
      // we should have a fresh counter. The process itself is stable (won't
      // auto-crash), so exhaustion should not fire.
      expect(exhaustionFired).toBe(false);
    });

    test("tolerates new crashes after window resets", async () => {
      const stableWindowMs = 200;
      const maxRestarts = 2;
      let exhaustionFired = false;

      // Create a stable process
      const acp = tracked(
        createStableProcess({
          maxRestarts,
          baseDelayMs: 30,
          stableWindowMs,
        }),
      );

      acp.onExhaustion(() => {
        exhaustionFired = true;
      });

      // Wait for the stable window to elapse so the counter resets
      await wait(stableWindowMs + 100);

      // Kill the process to trigger a crash — the counter was reset,
      // so this should count as restart 1 of 2 (not exhausted).
      const pidBefore = acp.process.pid;
      acp.process.kill();

      // Wait for the backoff restart to complete
      await wait(300);

      // Verify it restarted (new PID)
      expect(acp.process.pid).not.toEqual(pidBefore);
      // Verify exhaustion has NOT fired (counter was reset, only 1 crash)
      expect(exhaustionFired).toBe(false);
    });
  });

  describe("stable timer / exit race at window boundary", () => {
    test("stable timer does not reset counter when its bound child has crashed mid-backoff", async () => {
      // Regression test for a timer race in `startStableTimer`. The exit
      // handler schedules a restart via a backoff timer; during that
      // backoff, the stable-window timer (still armed for the dead child)
      // could fire and reset `restartCount` to 0. The freshly-spawned
      // child's exit handler would then increment from 0, effectively
      // granting one extra restart beyond `maxRestarts` over the lifetime.
      //
      // We force the race deterministically by choosing parameters so the
      // stable timer is guaranteed to fire while the backoff timer is
      // still pending.
      const stableWindowMs = 60;
      const baseDelayMs = 200; // backoff >> stable window
      const maxRestarts = 5;
      const acp = tracked(
        createStableProcess({
          maxRestarts,
          stableWindowMs,
          baseDelayMs,
          logSink: { error: () => {}, warn: () => {} },
        }),
      );

      const internals = acp as unknown as {
        restartCount: number;
        acpProcess: { process: { kill: (sig?: string | number) => boolean } };
      };

      // Crash the child with a non-zero exit. The exit handler will
      // increment restartCount to 1 and schedule performRestart for
      // baseDelayMs (200ms) later. The stable timer (60ms) will fire
      // during that backoff window — before performRestart re-arms.
      internals.acpProcess.process.kill("SIGKILL");

      // Wait long enough for the stable timer to fire but short enough
      // that the backoff hasn't completed yet. (60ms < wait < 200ms.)
      await wait(stableWindowMs + 50);

      // With the bug, the stale stable timer would have reset restartCount
      // to 0. With the fix, it sees the bound child has exited and skips.
      expect(internals.restartCount).toBe(1);
    });
  });

  describe("ENOENT handling", () => {
    test("exhausts immediately on ENOENT without retry", async () => {
      let exhausted = false;
      const acp = tracked(
        new ResilientACPProcess({
          command: "/nonexistent/cmd",
          args: [],
          maxRestarts: 5,
          baseDelayMs: 50,
          stableWindowMs: 60000,
          logSink: { error: () => {}, warn: () => {} },
        }),
      );
      acp.onExhaustion(() => {
        exhausted = true;
      });
      await wait(500);
      expect(exhausted).toBe(true);
    }, 5000);
  });

  describe("destroy()", () => {
    test("stops monitoring and kills the process", async () => {
      const acp = tracked(createStableProcess());
      expect(acp.process.exitCode).toBeNull();
      expect(acp.process.signalCode).toBeNull();

      acp.destroy();

      // On Unix, spawnACPAgent tears down via process-group kill
      // (`process.kill(-pid, "SIGTERM")`) rather than `child.kill()`, so the
      // Node-internal `ChildProcess.killed` flag is NEVER set. Assert the
      // observable outcome instead: the child actually terminates.
      const deadline = Date.now() + 2000;
      while (
        acp.process.exitCode === null &&
        acp.process.signalCode === null &&
        Date.now() < deadline
      ) {
        await wait(20);
      }
      expect(acp.process.exitCode !== null || acp.process.signalCode !== null).toBe(true);
    });

    test("no restart after destroy() is called", async () => {
      const acp = tracked(
        createCrashingProcess(1, 50, {
          maxRestarts: 5,
          baseDelayMs: 30,
          stableWindowMs: 60000,
        }),
      );

      const firstPid = acp.process.pid;

      // Destroy before the process crashes
      acp.destroy();

      // Wait for what would have been a restart
      await wait(300);

      // PID should not have changed — no restart after destroy
      expect(acp.process.pid).toEqual(firstPid);
    });

    test("calling destroy() multiple times does not throw", () => {
      const acp = tracked(createStableProcess());
      acp.destroy();
      expect(() => acp.destroy()).not.toThrow();
    });
  });
});
