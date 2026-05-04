import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validACPRequestCases, validACPResponseCases } from "./acp-samples.ts";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

function runCli(args: string[]) {
  const bunBinary = Bun.which("bun") ?? "bun";
  return Bun.spawnSync({
    cmd: [bunBinary, cliPath, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
}

async function withTempJsonFile(payload: unknown, fn: (path: string) => void | Promise<void>) {
  const tempDir = await mkdtemp(join(tmpdir(), "agents-validate-cli-"));
  const sourcePath = join(tempDir, "payload.json");

  try {
    await writeFile(sourcePath, JSON.stringify(payload), "utf8");
    await fn(sourcePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("agents-validate CLI", () => {
  test("returns 0 for valid A2A request and emits validated payload", async () => {
    await withTempJsonFile(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: {
            kind: "message",
            messageId: "msg-1",
            role: "user",
            parts: [{ kind: "text", text: "hello" }],
          },
        },
      },
      (sourcePath) => {
        const result = runCli(["--source", sourcePath, "--target", "a2a-request"]);
        const payload = JSON.parse(result.stdout.toString()) as {
          mode: string;
          ok: boolean;
          payload: { method: string };
        };

        expect(result.exitCode).toBe(0);
        expect(payload.ok).toBe(true);
        expect(payload.mode).toBe("strict");
        expect(payload.payload.method).toBe("message/send");
      },
    );
  });

  test("returns non-zero for invalid payload", async () => {
    await withTempJsonFile({ jsonrpc: "2.0", id: 1, method: "message/send" }, (sourcePath) => {
      const result = runCli(["--source", sourcePath, "--target", "a2a-request"]);
      const payload = JSON.parse(result.stdout.toString()) as { ok: boolean };

      expect(result.exitCode).not.toBe(0);
      expect(payload.ok).toBe(false);
    });
  });

  test("requires runtime for runtime-manifest target", async () => {
    await withTempJsonFile({ name: "codex", version: "1.0.0" }, (sourcePath) => {
      const result = runCli(["--source", sourcePath, "--target", "runtime-manifest"]);
      const payload = JSON.parse(result.stdout.toString()) as { ok: boolean };

      expect(result.exitCode).toBe(1);
      expect(payload.ok).toBe(false);
    });
  });

  test("validates ACP request targets", async () => {
    const sample = validACPRequestCases.find((entry) => entry.method === "session/close");
    if (!sample) {
      throw new Error("missing ACP request sample");
    }

    await withTempJsonFile(sample.envelope, (sourcePath) => {
      const result = runCli(["--source", sourcePath, "--target", "acp-request"]);
      const payload = JSON.parse(result.stdout.toString()) as {
        ok: boolean;
        payload: { method: string };
      };

      expect(result.exitCode).toBe(0);
      expect(payload.ok).toBe(true);
      expect(payload.payload.method).toBe("session/close");
    });
  });

  test("validates ACP response targets when method is provided", async () => {
    const sample = validACPResponseCases.find((entry) => entry.method === "session/close");
    if (!sample) {
      throw new Error("missing ACP response sample");
    }

    await withTempJsonFile(sample.envelope, (sourcePath) => {
      const result = runCli([
        "--source",
        sourcePath,
        "--target",
        "acp-response",
        "--method",
        "session/close",
      ]);
      const payload = JSON.parse(result.stdout.toString()) as {
        ok: boolean;
        payload: { result: Record<string, unknown> };
      };

      expect(result.exitCode).toBe(0);
      expect(payload.ok).toBe(true);
      expect(payload.payload.result).toEqual({});
    });
  });

  test("requires method for acp-response target", async () => {
    const sample = validACPResponseCases.find((entry) => entry.method === "session/close");
    if (!sample) {
      throw new Error("missing ACP response sample");
    }

    await withTempJsonFile(sample.envelope, (sourcePath) => {
      const result = runCli(["--source", sourcePath, "--target", "acp-response"]);
      const payload = JSON.parse(result.stdout.toString()) as { ok: boolean };

      expect(result.exitCode).toBe(1);
      expect(payload.ok).toBe(false);
    });
  });

  test("filter mode strips unknown fields from emitted payloads", async () => {
    await withTempJsonFile(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "session/close",
        extra: true,
        params: {
          sessionId: "session-1",
          unknownParam: true,
        },
      },
      (sourcePath) => {
        const result = runCli([
          "--source",
          sourcePath,
          "--target",
          "acp-request",
          "--mode",
          "filter",
        ]);
        const payload = JSON.parse(result.stdout.toString()) as {
          mode: string;
          ok: boolean;
          payload: {
            extra?: boolean;
            params: Record<string, unknown>;
          };
        };

        expect(result.exitCode).toBe(0);
        expect(payload.ok).toBe(true);
        expect(payload.mode).toBe("filter");
        expect(payload.payload.extra).toBeUndefined();
        expect(payload.payload.params.unknownParam).toBeUndefined();
      },
    );
  });
});
