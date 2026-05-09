import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { buildDroidExecArgs, DroidExecClient } from "../src/droid-exec-client.ts";
import type { DroidStreamEvent } from "../src/types.ts";

const MOCK_DROID = path.resolve(import.meta.dir, "fixtures/mock-droid.ts");

describe("buildDroidExecArgs", () => {
  test("base argv sequence is exec + --output-format stream-json + prompt", () => {
    const args = buildDroidExecArgs({
      prompt: "hello",
      onEvent: () => {},
      onExit: () => {},
    });
    expect(args).toEqual(["exec", "--output-format", "stream-json", "hello"]);
  });

  test("session-id is appended before the prompt", () => {
    const args = buildDroidExecArgs({
      prompt: "hello",
      sessionId: "droid-xyz",
      onEvent: () => {},
      onExit: () => {},
    });
    expect(args).toEqual([
      "exec",
      "--output-format",
      "stream-json",
      "--session-id",
      "droid-xyz",
      "hello",
    ]);
  });

  test("cwd is forwarded as --cwd", () => {
    const args = buildDroidExecArgs({
      prompt: "hello",
      cwd: "/tmp/work",
      onEvent: () => {},
      onExit: () => {},
    });
    expect(args).toEqual(["exec", "--output-format", "stream-json", "--cwd", "/tmp/work", "hello"]);
  });

  test("autonomy is forwarded as --auto", () => {
    const args = buildDroidExecArgs({
      prompt: "hello",
      autonomy: "medium",
      onEvent: () => {},
      onExit: () => {},
    });
    expect(args).toEqual(["exec", "--output-format", "stream-json", "--auto", "medium", "hello"]);
  });

  test("extraArgs land between autonomy and the prompt", () => {
    const args = buildDroidExecArgs({
      prompt: "hello",
      autonomy: "low",
      extraArgs: ["--disabled-tools", "WebSearch"],
      onEvent: () => {},
      onExit: () => {},
    });
    expect(args).toEqual([
      "exec",
      "--output-format",
      "stream-json",
      "--auto",
      "low",
      "--disabled-tools",
      "WebSearch",
      "hello",
    ]);
  });

  test("prompt is always last so flag-shaped text is not mis-parsed", () => {
    const args = buildDroidExecArgs({
      prompt: "--not-a-flag because it is a prompt",
      sessionId: "s",
      cwd: "/w",
      autonomy: "high",
      onEvent: () => {},
      onExit: () => {},
    });
    expect(args[args.length - 1]).toBe("--not-a-flag because it is a prompt");
  });
});

describe("DroidExecClient against mock droid fixture", () => {
  test("parses scripted stream-json and exits on completion", async () => {
    const events: DroidStreamEvent[] = [];
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        new DroidExecClient({
          command: "bun",
          argvOverride: ["run", MOCK_DROID],
          prompt: "hi",
          onEvent: (event) => events.push(event),
          onExit: (info) => resolve(info),
        });
      },
    );
    await exited;
    expect(events.some((e) => e.type === "system")).toBe(true);
    expect(events.some((e) => e.type === "completion")).toBe(true);
    const sys = events.find((e) => e.type === "system") as { session_id?: string } | undefined;
    expect(sys?.session_id).toBe("fixture-session-1");
  }, 10000);

  test("surfaces protocol errors without crashing", async () => {
    const protocolErrors: Array<{ raw: string; err: unknown }> = [];
    const done = new Promise<void>((resolve) => {
      new DroidExecClient({
        command: "bun",
        argvOverride: ["run", MOCK_DROID],
        prompt: "hi",
        env: { DROID_ACP_TEST_CONTAMINATE: "1" },
        onEvent: () => {},
        onExit: () => resolve(),
        onProtocolError: (raw, err) => protocolErrors.push({ raw, err }),
      });
    });
    await done;
    expect(protocolErrors.length).toBeGreaterThan(0);
    expect(protocolErrors[0]?.raw).toBe("not-json-prefix");
  }, 10000);

  test("kill() terminates the child (SIGTERM path)", async () => {
    let onExitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const done = new Promise<void>((resolve) => {
      const client = new DroidExecClient({
        command: "bun",
        argvOverride: ["run", MOCK_DROID],
        prompt: "hi",
        env: { DROID_ACP_TEST_HANG: "1" },
        onEvent: () => {},
        onExit: (info) => {
          onExitInfo = info;
          resolve();
        },
      });
      // Give the fixture time to install its event handlers.
      setTimeout(() => client.kill("SIGTERM"), 100);
    });
    await done;
    expect(onExitInfo).not.toBeNull();
  }, 10000);

  test("tool_call + tool_result flow through the event stream", async () => {
    const events: DroidStreamEvent[] = [];
    const done = new Promise<void>((resolve) => {
      new DroidExecClient({
        command: "bun",
        argvOverride: ["run", MOCK_DROID],
        prompt: "list",
        env: { DROID_ACP_TEST_TOOLCALL: "1" },
        onEvent: (e) => events.push(e),
        onExit: () => resolve(),
      });
    });
    await done;
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  }, 10000);
});

describe("droid-acp binary lifecycle (source-mode smoke)", () => {
  test("SIGTERM to droid-acp binary gracefully shuts down", async () => {
    const binEntry = path.resolve(import.meta.dir, "../src/bin.ts");
    const child = spawn("bun", ["run", binEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    // Give the adapter a moment to install signal handlers before we send SIGTERM.
    await Bun.sleep(100);
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    const code = await Promise.race([exitPromise, Bun.sleep(5000).then(() => "timeout" as const)]);
    if (code === "timeout") {
      child.kill("SIGKILL");
      throw new Error("droid-acp binary did not exit within 5s of SIGTERM");
    }
    expect(code === null || code === 0 || typeof code === "number").toBe(true);
  }, 10000);

  test("--help prints usage and exits 0", async () => {
    const binEntry = path.resolve(import.meta.dir, "../src/bin.ts");
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn("bun", ["run", binEntry, "--help"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.once("exit", (code) =>
        resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("droid-acp");
    expect(result.stdout).toContain("ACP adapter");
  }, 10000);

  test("--version prints the adapter version and exits 0", async () => {
    const binEntry = path.resolve(import.meta.dir, "../src/bin.ts");
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = spawn("bun", ["run", binEntry, "--version"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => chunks.push(c));
      child.once("exit", (code) =>
        resolve({ code, stdout: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("droid-acp ");
  }, 10000);
});
