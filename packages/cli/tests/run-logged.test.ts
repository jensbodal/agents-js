/**
 * Tests for `agents-js run-logged`. The spawn + clock are injected so the
 * tee/append/exit-forwarding behavior is exercised without a real
 * interactive child. Real `fs` is used against a unique tmp dir to verify
 * parent-dir creation and append (vs truncate) semantics on disk.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type RunLoggedChild,
  type RunLoggedSpawn,
  runRunLoggedCommand,
} from "../src/run-logged.ts";

const tmpRoots: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `run-logged-${process.pid}-`));
  tmpRoots.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A capturing write sink standing in for a WriteStream. */
function captureSink(): { sink: Pick<NodeJS.WriteStream, "write">; bytes: () => Uint8Array[] } {
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      write: (chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    bytes: () => chunks,
  };
}

function decode(chunks: Uint8Array[]): string {
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c)).join("");
}

/**
 * Build a fake spawn that emits `stderrChunks` on the child's stderr and
 * resolves `exited` with `exitCode`.
 */
function fakeSpawn(stderrChunks: string[], exitCode: number): RunLoggedSpawn {
  return (): RunLoggedChild => {
    const encoder = new TextEncoder();
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of stderrChunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return { stderr, exited: Promise.resolve(exitCode) };
  };
}

const fixedNow = () => new Date("2026-01-01T00:00:00.000Z");

describe("run-logged", () => {
  test("tees stderr to both the logfile and the passthrough stderr", async () => {
    const dir = await makeTmpDir();
    const logPath = path.join(dir, "child.log");
    const passthrough = captureSink();

    const code = await runRunLoggedCommand(["--log", logPath, "--", "fake", "--tui"], {
      spawn: fakeSpawn(["hello ", "world\n"], 0),
      stderr: passthrough.sink,
      now: fixedNow,
    });

    expect(code).toBe(0);
    // Passthrough saw the live stderr.
    expect(decode(passthrough.bytes())).toBe("hello world\n");
    // Logfile got the same stderr (plus the header line).
    const logged = await readFile(logPath, "utf8");
    expect(logged).toContain("hello world\n");
    expect(logged).toContain("=== run-logged 2026-01-01T00:00:00.000Z :: fake --tui ===");
  });

  test("creates the parent directory if missing", async () => {
    const dir = await makeTmpDir();
    const logPath = path.join(dir, "nested", "deeper", "child.log");
    const passthrough = captureSink();

    const code = await runRunLoggedCommand(["--log", logPath, "--", "fake"], {
      spawn: fakeSpawn(["x"], 0),
      stderr: passthrough.sink,
      now: fixedNow,
    });

    expect(code).toBe(0);
    const logged = await readFile(logPath, "utf8");
    expect(logged).toContain("x");
  });

  test("appends rather than truncates an existing log", async () => {
    const dir = await makeTmpDir();
    const logPath = path.join(dir, "child.log");
    await writeFile(logPath, "PREEXISTING\n", "utf8");
    const passthrough = captureSink();

    const code = await runRunLoggedCommand(["--log", logPath, "--", "fake"], {
      spawn: fakeSpawn(["new-output"], 0),
      stderr: passthrough.sink,
      now: fixedNow,
    });

    expect(code).toBe(0);
    const logged = await readFile(logPath, "utf8");
    expect(logged.startsWith("PREEXISTING\n")).toBe(true);
    expect(logged).toContain("new-output");
  });

  test("forwards the child's non-zero exit code", async () => {
    const dir = await makeTmpDir();
    const logPath = path.join(dir, "child.log");
    const passthrough = captureSink();

    const code = await runRunLoggedCommand(["--log", logPath, "--", "fake"], {
      spawn: fakeSpawn([], 42),
      stderr: passthrough.sink,
      now: fixedNow,
    });

    expect(code).toBe(42);
  });

  test("missing --log is a usage error", async () => {
    const diagnostics = captureSink();
    const code = await runRunLoggedCommand(["--", "fake"], {
      diagnostics: diagnostics.sink,
      now: fixedNow,
    });

    expect(code).toBe(64);
    expect(decode(diagnostics.bytes())).toContain("missing --log");
  });

  test("missing command after -- is a usage error", async () => {
    const dir = await makeTmpDir();
    const logPath = path.join(dir, "child.log");
    const diagnostics = captureSink();

    const code = await runRunLoggedCommand(["--log", logPath, "--"], {
      diagnostics: diagnostics.sink,
      now: fixedNow,
    });

    expect(code).toBe(64);
    expect(decode(diagnostics.bytes())).toContain("missing command after");
  });
});
