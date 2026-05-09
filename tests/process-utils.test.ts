import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureProcessStreamToFile, runCommand, runForeground } from "../scripts/process-utils.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
});

describe("captureProcessStreamToFile", () => {
  test("streams full logs to disk, keeps a bounded tail, and preserves line callbacks", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "agents-js-process-utils-test-"));
    tempDirs.push(dir);
    const logPath = path.join(dir, "stdout.log");
    const lines: string[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("Gateway URL: http://127.0.0.1:61001\nOpen"));
        controller.enqueue(encoder.encode(" URL: http://127.0.0.1:5173/?target=foo\nTAIL-END"));
        controller.close();
      },
    });

    const tail = await captureProcessStreamToFile(stream, {
      logPath,
      onLine: (line) => lines.push(line),
      tailChars: 8,
      target: "stdout",
    });

    expect(await readFile(logPath, "utf8")).toBe(
      "Gateway URL: http://127.0.0.1:61001\nOpen URL: http://127.0.0.1:5173/?target=foo\nTAIL-END",
    );
    expect(lines).toEqual([
      "Gateway URL: http://127.0.0.1:61001",
      "Open URL: http://127.0.0.1:5173/?target=foo",
      "TAIL-END",
    ]);
    expect(tail).toBe("TAIL-END");
  });
});

describe("runCommand", () => {
  test("resolves repo-local CLI bins without relying on the ambient PATH", async () => {
    const repoBinPath = path.join(path.resolve(import.meta.dir, ".."), "node_modules", ".bin");
    const sanitizedPath = (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((segment) => segment && segment !== repoBinPath)
      .join(path.delimiter);

    const result = await runCommand(["vp", "--version"], {
      env: { PATH: sanitizedPath },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("vp v");
  });

  test("runForeground resolves repo-local CLI bins without relying on the ambient PATH", async () => {
    const repoBinPath = path.join(path.resolve(import.meta.dir, ".."), "node_modules", ".bin");
    const sanitizedPath = (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter((segment) => segment && segment !== repoBinPath)
      .join(path.delimiter);

    await expect(
      runForeground(["vp", "--version"], {
        env: { PATH: sanitizedPath },
      }),
    ).resolves.toBe(0);
  });
});
