import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const compiledCliPath = new URL("../../packages/cli/dist/agents-js", import.meta.url).pathname;
const cliModulePath = new URL("../../packages/cli/dist/cli.mjs", import.meta.url).pathname;
const bunCommand = Bun.which("bun") ?? "bun";
const mockAgentPath = path.join(process.cwd(), "tests/mock-acp-agent.cjs");
let cliCommandPromise: Promise<string[]> | undefined;

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

async function resolveCliCommand(): Promise<string[]> {
  if (!cliCommandPromise) {
    cliCommandPromise = (async () => {
      const probe = Bun.spawn({
        cmd: [compiledCliPath, "--help"],
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: process.env,
      });
      const exitCode = await probe.exited;
      if (exitCode === 0) {
        return [compiledCliPath];
      }

      return [bunCommand, cliModulePath];
    })();
  }

  return await cliCommandPromise;
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
    } finally {
      child.kill();
      await child.exited;
    }
  }, 30_000);

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
