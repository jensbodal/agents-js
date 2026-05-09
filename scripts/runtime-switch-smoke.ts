#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildRuntimeProfileConfigEnv,
  E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV,
  E2E_RUNTIME_PROFILE_DATA_HOME_ENV,
  E2E_RUNTIME_PROFILE_PREFIX_ENV,
  E2E_RUNTIME_PROFILE_RUNTIMES_ENV,
  E2E_RUNTIME_PROFILE_STATE_HOME_ENV,
  type WSServerMessage,
} from "@agents-js/host";
import { extractGatewayUrl, extractGatewayWsUrl } from "./browser-launch-contract.ts";
import { createEphemeralRuntimeProfileSandbox } from "./ephemeral-runtime-profiles.ts";
import {
  buildProcessEnv,
  captureProcessStreamToFile,
  stopProcess,
  waitForGatewayCard,
} from "./process-utils.ts";
import { repoRoot } from "./workspace-config.ts";

type RuntimeSwitchSmokeOptions = {
  outDir: string;
};

type RuntimeSwitchSmokeCheck = {
  data?: unknown;
  detail?: string;
  name: string;
  status: "failed" | "passed";
};

type CapturedGateway = {
  gatewayUrl: Promise<string>;
  gatewayWsUrl: Promise<string>;
  stderrTail: Promise<string>;
  stdoutTail: Promise<string>;
};

function createDeferred<T>() {
  let settled = false;
  let resolveInternal!: (value: T | PromiseLike<T>) => void;
  let rejectInternal!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveInternal = resolve;
    rejectInternal = reject;
  });

  return {
    promise,
    resolve(value: T | PromiseLike<T>) {
      if (settled) {
        return;
      }
      settled = true;
      resolveInternal(value);
    },
    reject(reason?: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      rejectInternal(reason);
    },
  };
}

function parseArgs(argv: string[]): RuntimeSwitchSmokeOptions {
  let outDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--out-dir") {
      if (!next) {
        throw new Error('[runtime-switch-smoke] Missing value for "--out-dir".');
      }
      outDir = path.resolve(repoRoot, next);
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "runtime-switch-smoke",
          "",
          "Usage:",
          "  bun scripts/runtime-switch-smoke.ts [--out-dir <path>]",
          "",
          "Starts the internal gateway on Claude ACP, connects to the WS bridge directly,",
          "and validates claude -> opencode -> claude runtime switches without Playwright.",
        ].join("\n"),
      );
      process.exit(0);
    }

    throw new Error(`[runtime-switch-smoke] Unknown argument: ${arg}`);
  }

  return {
    outDir: outDir ?? path.join(repoRoot, "output/e2e/runtime-switch-smoke"),
  };
}

function launchGateway(options: {
  env?: Record<string, string>;
  stderrLogPath: string;
  stdoutLogPath: string;
}): {
  captured: CapturedGateway;
  proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
} {
  const proc = Bun.spawn(
    ["bun", "apps/internal-gateway/cli.ts", "--runtime", "claude", "--workspace", repoRoot],
    {
      cwd: repoRoot,
      env: buildProcessEnv(options.env),
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const gatewayUrl = createDeferred<string>();
  const gatewayWsUrl = createDeferred<string>();

  const onLine = (line: string) => {
    const nextGatewayUrl = extractGatewayUrl(line);
    if (nextGatewayUrl) {
      gatewayUrl.resolve(nextGatewayUrl);
    }

    const nextGatewayWsUrl = extractGatewayWsUrl(line);
    if (nextGatewayWsUrl) {
      gatewayWsUrl.resolve(nextGatewayWsUrl);
    }
  };

  const stdoutTail = captureProcessStreamToFile(proc.stdout, {
    logPath: options.stdoutLogPath,
    onLine,
    target: "stdout",
    tailChars: 16_384,
  });
  const stderrTail = captureProcessStreamToFile(proc.stderr, {
    logPath: options.stderrLogPath,
    onLine,
    target: "stderr",
    tailChars: 16_384,
  });

  void proc.exited.then((code) => {
    const error = new Error(
      `[runtime-switch-smoke] Gateway exited before discovery completed (code ${code}).`,
    );
    gatewayUrl.reject(error);
    gatewayWsUrl.reject(error);
  });

  return {
    proc,
    captured: {
      gatewayUrl: gatewayUrl.promise,
      gatewayWsUrl: gatewayWsUrl.promise,
      stdoutTail,
      stderrTail,
    },
  };
}

async function waitForSocketOpen(socket: WebSocket, timeoutMs = 5_000): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out opening websocket after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket connection failed"));
      },
      { once: true },
    );
  });
}

function createBridgeClient(wsUrl: string) {
  const socket = new WebSocket(wsUrl);
  const messages: WSServerMessage[] = [];
  let notify: (() => void) | null = null;

  socket.addEventListener("message", (event) => {
    const payload = typeof event.data === "string" ? event.data : String(event.data);
    messages.push(JSON.parse(payload) as WSServerMessage);
    notify?.();
    notify = null;
  });

  return {
    async open(): Promise<void> {
      await waitForSocketOpen(socket);
    },
    send(message: unknown): void {
      socket.send(JSON.stringify(message));
    },
    async waitForMessage(
      predicate: (message: WSServerMessage) => boolean,
      timeoutMs = 10_000,
    ): Promise<WSServerMessage> {
      const startedAt = Date.now();
      while (true) {
        const index = messages.findIndex(predicate);
        if (index >= 0) {
          const [message] = messages.splice(index, 1);
          if (message) {
            return message;
          }
        }

        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) {
          throw new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`);
        }

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (notify === resolve) {
              notify = null;
            }
            reject(new Error(`Timed out waiting for websocket message after ${timeoutMs}ms`));
          }, remaining);
          notify = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
      }
    },
    close(): void {
      socket.close();
    },
  };
}

function getRuntimeSwitchState(message: WSServerMessage): Record<string, unknown> | null {
  if (message.type !== "state_snapshot") {
    return null;
  }

  const runtimeSwitchState = (message.state as Record<string, unknown>).runtimeSwitchState;
  if (!runtimeSwitchState || typeof runtimeSwitchState !== "object") {
    return null;
  }

  return runtimeSwitchState as Record<string, unknown>;
}

function getRuntimeSnapshot(message: WSServerMessage): Record<string, unknown> | null {
  if (message.type !== "state_snapshot") {
    return null;
  }

  const runtime = (message.state as Record<string, unknown>).runtime;
  if (!runtime || typeof runtime !== "object") {
    return null;
  }

  return runtime as Record<string, unknown>;
}

async function recordCheck<T>(
  checks: RuntimeSwitchSmokeCheck[],
  name: string,
  action: () => Promise<T>,
): Promise<T> {
  try {
    const data = await action();
    checks.push({ name, status: "passed", data });
    return data;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    checks.push({ name, status: "failed", detail });
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const checks: RuntimeSwitchSmokeCheck[] = [];
  const startedAt = new Date().toISOString();

  await mkdir(options.outDir, { recursive: true });

  const stdoutLogPath = path.join(options.outDir, "gateway.stdout.log");
  const stderrLogPath = path.join(options.outDir, "gateway.stderr.log");
  const runtimeSandbox = await createEphemeralRuntimeProfileSandbox("runtime-switch-smoke", [
    "opencode",
  ]);
  const { proc, captured } = launchGateway({
    env: runtimeSandbox.env,
    stdoutLogPath,
    stderrLogPath,
  });

  let gatewayUrl: string | null = null;
  let gatewayWsUrl: string | null = null;
  let client: ReturnType<typeof createBridgeClient> | null = null;
  let failureMessage: string | null = null;

  try {
    [gatewayUrl, gatewayWsUrl] = await Promise.race([
      Promise.all([captured.gatewayUrl, captured.gatewayWsUrl]),
      new Promise<[string, string]>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              "[runtime-switch-smoke] Timed out waiting for the gateway discovery contract.",
            ),
          );
        }, 60_000);
      }),
    ]);

    await waitForGatewayCard(gatewayUrl, 20_000);

    client = createBridgeClient(gatewayWsUrl);
    await client.open();
    const activeClient = client;

    await recordCheck(checks, "initial runtime snapshot", async () => {
      const snapshot = await activeClient.waitForMessage(
        (message) =>
          message.type === "state_snapshot" &&
          getRuntimeSnapshot(message)?.id === "claude" &&
          getRuntimeSwitchState(message) === null,
      );
      return snapshot.state;
    });

    await recordCheck(checks, "runtime switch claude -> opencode", async () => {
      activeClient.send({ type: "set_runtime", runtimeId: "opencode", origin: "manual" });

      const switchingSnapshot = await activeClient.waitForMessage(
        (message) =>
          getRuntimeSwitchState(message)?.status === "switching" &&
          getRuntimeSwitchState(message)?.requestedRuntimeId === "opencode",
      );
      const appliedSnapshot = await activeClient.waitForMessage(
        (message) =>
          getRuntimeSwitchState(message)?.status === "runtimeApplied" &&
          getRuntimeSwitchState(message)?.requestedRuntimeId === "opencode" &&
          getRuntimeSnapshot(message)?.id === "opencode",
      );

      return {
        switching: switchingSnapshot.state,
        applied: appliedSnapshot.state,
      };
    });

    await recordCheck(checks, "runtime switch opencode -> claude", async () => {
      activeClient.send({ type: "set_runtime", runtimeId: "claude", origin: "manual" });

      const switchingSnapshot = await activeClient.waitForMessage(
        (message) =>
          getRuntimeSwitchState(message)?.status === "switching" &&
          getRuntimeSwitchState(message)?.requestedRuntimeId === "claude",
      );
      const appliedSnapshot = await activeClient.waitForMessage(
        (message) =>
          getRuntimeSwitchState(message)?.status === "runtimeApplied" &&
          getRuntimeSwitchState(message)?.requestedRuntimeId === "claude" &&
          getRuntimeSnapshot(message)?.id === "claude",
      );

      return {
        switching: switchingSnapshot.state,
        applied: appliedSnapshot.state,
      };
    });
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    client?.close();
    stopProcess(proc);

    const [stdoutTail, stderrTail] = await Promise.all([
      captured.stdoutTail.catch(() => ""),
      captured.stderrTail.catch(() => ""),
    ]);

    await writeFile(
      path.join(options.outDir, "summary.json"),
      `${JSON.stringify(
        {
          checks,
          command: "bun scripts/runtime-switch-smoke.ts",
          devLogs: {
            stdout: "gateway.stdout.log",
            stderr: "gateway.stderr.log",
          },
          devLogTail: {
            stdout: stdoutTail,
            stderr: stderrTail,
          },
          failureMessage,
          gatewayUrl,
          gatewayWsUrl,
          passed: failureMessage === null,
          runtimeIsolation: {
            configEnv: buildRuntimeProfileConfigEnv(runtimeSandbox.env),
            configPath: runtimeSandbox.configPath,
            dataHome: runtimeSandbox.env[E2E_RUNTIME_PROFILE_DATA_HOME_ENV] ?? "",
            isolatedRuntimes: runtimeSandbox.env[E2E_RUNTIME_PROFILE_RUNTIMES_ENV] ?? "",
            profilePrefix: runtimeSandbox.env[E2E_RUNTIME_PROFILE_PREFIX_ENV] ?? "",
            profileConfigHome: runtimeSandbox.env[E2E_RUNTIME_PROFILE_CONFIG_HOME_ENV] ?? "",
            stateHome: runtimeSandbox.env[E2E_RUNTIME_PROFILE_STATE_HOME_ENV] ?? "",
          },
          startedAt,
        },
        null,
        2,
      )}\n`,
    );

    await runtimeSandbox.cleanup().catch(() => {});
  }
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
