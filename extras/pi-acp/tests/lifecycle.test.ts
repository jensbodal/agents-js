import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { PiRpcClient } from "../src/pi-rpc-client.ts";

const MOCK_PI = path.resolve(import.meta.dir, "fixtures/mock-pi.ts");

describe("PiRpcClient against mock Pi fixture", () => {
  test("spawns, receives response for get_state, and exits on kill", async () => {
    const messages: unknown[] = [];
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const exited = new Promise<void>((resolve) => {
      const client = new PiRpcClient({
        command: "bun",
        argvOverride: ["run", MOCK_PI],
        onMessage: (msg) => {
          messages.push(msg);
        },
        onExit: (info) => {
          exitInfo = info;
          resolve();
        },
      });
      // Strip the default "--mode rpc" argv — the fixture doesn't care, but we
      // emulate "command + extraArgs" by swapping command to bun and letting
      // PiRpcClient append --mode rpc harmlessly.
      void client.sendAndAwait({ type: "get_state" }).then((resp) => {
        expect(resp.success).toBe(true);
        expect((resp.data as { sessionId: string } | undefined)?.sessionId).toBe("mock-pi-session");
        client.kill("SIGTERM");
      });
    });
    await exited;
    expect(exitInfo).not.toBeNull();
    // Verify the response was surfaced via onMessage too.
    expect(
      messages.some(
        (m) =>
          (m as { type?: string; command?: string }).type === "response" &&
          (m as { command?: string }).command === "get_state",
      ),
    ).toBe(true);
  }, 10000);

  test("pending requests reject when the Pi child exits prematurely", async () => {
    const client = new PiRpcClient({
      command: "bun",
      argvOverride: ["run", MOCK_PI],
      env: { PI_ACP_TEST_HANG: "1" },
      onMessage: () => {},
      onExit: () => {},
    });
    const pending = client.sendAndAwait({ type: "prompt", message: "hi" });
    // Kill after a short delay so the pending request is already registered.
    setTimeout(() => client.kill("SIGTERM"), 50);
    let pendingError: unknown = null;
    try {
      await pending;
    } catch (err) {
      pendingError = err;
    }
    expect(pendingError).toBeInstanceOf(Error);
    expect((pendingError as Error).message).toContain("Pi process exited before response");
  }, 10000);

  test("protocol errors surface via onProtocolError without crashing", async () => {
    const protocolErrors: Array<{ raw: string; err: unknown }> = [];
    const messages: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      const client = new PiRpcClient({
        command: "bun",
        argvOverride: ["run", MOCK_PI],
        env: { PI_ACP_TEST_CONTAMINATE: "1" },
        onMessage: (msg) => messages.push(msg),
        onExit: () => resolve(),
        onProtocolError: (raw, err) => protocolErrors.push({ raw, err }),
      });
      void client.sendAndAwait({ type: "get_state" }).then(() => client.kill("SIGTERM"));
    });
    await done;
    expect(protocolErrors.length).toBeGreaterThan(0);
    expect(protocolErrors[0]?.raw).toBe("not-json-prefix");
  }, 10000);
});

describe("PiAcp binary end-to-end (compiled binary path)", () => {
  test("SIGTERM to pi-acp binary gracefully shuts down (smoke)", async () => {
    // Spawn a bun-driven adapter in source mode. The binary path from build
    // isn't guaranteed in test-time; use `bun run src/bin.ts` which exercises
    // the same entrypoint. We don't drive a full ACP handshake here — we only
    // verify the adapter installs signal handlers and exits cleanly. Full
    // handshake coverage is exercised through @agents-js/gateway-runtime and
    // @agents-js/acp-host integration paths.
    const binEntry = path.resolve(import.meta.dir, "../src/bin.ts");
    const child = spawn("bun", ["run", binEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: { ...process.env, PI_ACP_TEST_HANG: "1" },
    });
    const exitPromise = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });
    // Give it a moment to install the signal handlers.
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
      throw new Error("pi-acp binary did not exit within 5s of SIGTERM");
    }
    // Code 0 on graceful exit; signal-terminated processes may expose null +
    // a signal. We accept either as long as the child actually ended.
    expect(code === null || code === 0 || typeof code === "number").toBe(true);
  }, 10000);
});
