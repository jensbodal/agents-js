import { describe, expect, test } from "bun:test";
import { runCommand } from "../src/subprocess.ts";

describe("runCommand — happy path", () => {
  test("captures stdout/stderr and zero exit", async () => {
    const result = await runCommand("sh", ["-c", "echo out; echo err 1>&2"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });
});

describe("runCommand — onError handling", () => {
  test("non-zero exit returns by default", async () => {
    const result = await runCommand("sh", ["-c", "echo boom 1>&2; exit 7"]);
    expect(result.exitCode).toBe(7);
    expect(result.stderr.trim()).toBe("boom");
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
  });

  test("non-zero exit throws with formatted message when onError=throw", async () => {
    await expect(
      runCommand("sh", ["-c", "echo boom 1>&2; exit 7"], { onError: "throw" }),
    ).rejects.toThrow("sh -c echo boom 1>&2; exit 7 failed with exit 7: boom");
  });

  test("falls back to stdout when stderr empty in throw message", async () => {
    await expect(
      runCommand("sh", ["-c", "echo only-stdout; exit 3"], { onError: "throw" }),
    ).rejects.toThrow(/failed with exit 3: only-stdout$/);
  });
});

describe("runCommand — timeout", () => {
  test("kills the process and reports timedOut=true", async () => {
    const start = Date.now();
    const result = await runCommand("sleep", ["10"], { timeoutMs: 100 });
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    // SIGTERM should kill `sleep` immediately; SIGKILL grace is 500ms upper bound.
    expect(elapsed).toBeLessThan(700);
    // Bun reports SIGTERM-killed processes as exit 143 (128 + 15).
    expect(result.exitCode).not.toBe(0);
  });

  test("throws with timeout-specific message when onError=throw", async () => {
    await expect(runCommand("sleep", ["10"], { timeoutMs: 100, onError: "throw" })).rejects.toThrow(
      "sleep timed out after 100ms",
    );
  });
});

describe("runCommand — external abort", () => {
  test("aborting mid-run reports aborted=true", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const result = await runCommand("sleep", ["10"], { signal: ac.signal });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test("pre-aborted signal kills immediately", async () => {
    const result = await runCommand("sleep", ["10"], { signal: AbortSignal.abort() });
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test("throws with abort-specific message when onError=throw", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(
      runCommand("sleep", ["10"], { signal: ac.signal, onError: "throw" }),
    ).rejects.toThrow("sleep aborted");
  });
});

describe("runCommand — composed signal + timeout", () => {
  test("signal wins when it fires first", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    const result = await runCommand("sleep", ["10"], {
      signal: ac.signal,
      timeoutMs: 5_000,
    });

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  test("timeout wins when it fires first", async () => {
    const ac = new AbortController(); // never aborted
    const result = await runCommand("sleep", ["10"], {
      signal: ac.signal,
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
  });
});

describe("runCommand — stdin", () => {
  test("delivers payload to the child process", async () => {
    const result = await runCommand("cat", [], { stdin: "hello from stdin" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello from stdin");
  });
});

describe("runCommand — env", () => {
  test("merges options.env over process.env", async () => {
    const result = await runCommand("sh", ["-c", 'printf %s "$RUN_COMMAND_TEST_VAR"'], {
      env: { RUN_COMMAND_TEST_VAR: "from-options" },
    });
    expect(result.stdout).toBe("from-options");
  });
});
