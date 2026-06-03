import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const cliModulePath = new URL("../../packages/cli/dist/bin.mjs", import.meta.url).pathname;
const bunCommand = Bun.which("bun") ?? "bun";
const mockAgentPath = path.join(process.cwd(), "tests/mock-acp-agent.cjs");

async function allocatePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("ok");
    },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

/**
 * Drive the native AG-UI `POST /agent` endpoint and collect SSE event
 * types until a terminal frame (RUN_FINISHED / RUN_ERROR) or timeout.
 *
 * This is the real proof that `agents-js serve` mounts the AG-UI surface:
 * before the host-session migration, serve used the raw ACP-over-A2A
 * facade, which had no `/agent` handler — the route fell through to A2A
 * JSON-RPC routing and returned 404/405. A live SSE stream that reaches
 * RUN_STARTED proves the endpoint is mounted AND executing a run, not
 * merely returning a 200 shell.
 */
async function probeAguiEndpoint(
  port: number,
  timeoutMs: number,
): Promise<{ status: number; contentType: string | null; eventTypes: string[] }> {
  const response = await fetch(`http://127.0.0.1:${port}/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      threadId: "it-thread-1",
      runId: "it-run-1",
      messages: [{ id: "m1", role: "user", content: "hello from integration test" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const contentType = response.headers.get("content-type");
  const eventTypes: string[] = [];

  if (!response.ok || !response.body) {
    return { status: response.status, contentType, eventTypes };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice("data:".length).trim();
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload) as { type?: string };
          if (typeof parsed.type === "string") {
            eventTypes.push(parsed.type);
          }
        } catch {
          // Partial frame split across chunks — wait for more bytes.
        }
      }
      // Keep only the trailing partial line in the buffer.
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline !== -1) buffer = buffer.slice(lastNewline + 1);
      if (eventTypes.some((t) => t === "RUN_FINISHED" || t === "RUN_ERROR")) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { status: response.status, contentType, eventTypes };
}

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      if (response.ok) {
        return;
      }
    } catch {
      // Wait for the child process to finish booting.
    }
    await delay(100);
  }

  throw new Error(`Timed out waiting for server on port ${port}`);
}

function resolveCliCommand(): string[] {
  return [bunCommand, cliModulePath];
}

async function withTempWorkspace(fn: (cwd: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "agents-js-cli-integration-"));
  const cwd = path.join(root, "workspace");
  await mkdir(cwd, { recursive: true });

  try {
    await fn(cwd);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("agents-js serve integration", () => {
  test("launches the A2A bridge with a custom ACP runtime", async () => {
    const port = await allocatePort();
    const cliCommand = await resolveCliCommand();
    const child = Bun.spawn({
      cmd: [
        ...cliCommand,
        "serve",
        "--harness",
        "custom",
        "--acp-command",
        "node",
        "--acp-args-json",
        JSON.stringify([mockAgentPath]),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      stdout: "pipe",
      stderr: "inherit",
      stdin: "ignore",
      env: process.env,
    });

    try {
      await waitForServer(port, 10_000);
      const cardResp = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      const card = await cardResp.json();

      expect(card.name).toBe("universal-acp-gateway");
      expect(card.capabilities.multimodal).toBe(true);

      // The AG-UI `/agent` endpoint must serve a live run — this is the
      // regression that the host-session migration fixes. The mock ACP
      // agent replies to a plain prompt and ends the turn, so the SSE
      // stream should reach RUN_STARTED and then RUN_FINISHED.
      const agui = await probeAguiEndpoint(port, 15_000);
      expect(agui.status).toBe(200);
      expect(agui.contentType ?? "").toContain("text/event-stream");
      expect(agui.eventTypes).toContain("RUN_STARTED");
      expect(agui.eventTypes).toContain("RUN_FINISHED");
    } finally {
      child.kill();
      await child.exited;
    }
  }, 45_000);

  test("launches from a saved project config without flags", async () => {
    await withTempWorkspace(async (cwd) => {
      const port = await allocatePort();
      const configDir = path.join(cwd, ".agents-js");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify(
          {
            serve: {
              selectionPolicy: "prefer-saved",
              host: "127.0.0.1",
              port,
              harness: {
                kind: "custom",
                command: "node",
                args: [mockAgentPath],
                displayName: "Saved Custom ACP Runtime",
                description: "Saved integration-test ACP runtime.",
              },
            },
          },
          null,
          2,
        ),
      );

      const cliCommand = await resolveCliCommand();
      const child = Bun.spawn({
        cmd: [...cliCommand, "serve"],
        cwd,
        stdout: "pipe",
        stderr: "inherit",
        stdin: "ignore",
        env: process.env,
      });

      try {
        await waitForServer(port, 10_000);
        const cardResp = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
        const card = await cardResp.json();

        expect(card.name).toBe("universal-acp-gateway");
        expect(card.capabilities.multimodal).toBe(true);
      } finally {
        child.kill();
        await child.exited;
      }
    });
  }, 30_000);
});
