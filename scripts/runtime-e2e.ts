#!/usr/bin/env bun

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveACPOverA2A } from "@agents-js/a2a";
import { A2AClientController } from "@agents-js/a2a-client";
import { PROTOCOL_VERSION } from "@agents-js/acp";
import { formatContaminationError, inspectFirstChunk } from "@agents-js/cli";
import {
  applyGatewayRuntimeProfile,
  type GatewayRuntimeId,
  type GatewayRuntimeProfile,
  listGatewayRuntimeIds,
  loadAgentsJsConfig,
  type ResolvedGatewayRuntime,
  resolveGatewayRuntime,
  resolveGatewayRuntimeProfile,
  validateGatewayRuntimeProfileName,
} from "@agents-js/gateway-runtime";
import {
  formatRuntimeE2EResult,
  type RuntimeE2EFailureClassification,
  type RuntimeE2EFailureCode,
  type RuntimeE2EResultContract,
} from "./runtime-e2e-contract.ts";

const supportedRuntimes = new Set<GatewayRuntimeId>(listGatewayRuntimeIds());

/**
 * Harness binaries for externally-published ACP adapters
 * (`@agentclientprotocol/claude-agent-acp`, `@zed-industries/codex-acp`) are
 * declared as workspace deps of `apps/internal-gateway` — NOT of the
 * repo root. Under Bun's isolated workspace install they land in
 * `apps/internal-gateway/node_modules/.bin/`, not in the root
 * `node_modules/.bin/`. A PATH-only resolver walking up from
 * `scripts/runtime-e2e.ts` never visits that app-specific bin dir, so
 * `resolveGatewayRuntime("claude")` fails with "could not resolve
 * executable" even though the binary is installed.
 *
 * Pin the workspace-bin-root explicitly at this callsite. Matches the
 * detection phase in `scripts/e2e-deterministic.ts` which uses the
 * same root when calling `detectInstalledGatewayRuntimes`.
 */
const INTERNAL_GATEWAY_WORKSPACE_BIN_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps",
  "internal-gateway",
);

export function buildContaminationInitializeRequest() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "agents-js-e2e", version: "1.0.0" },
    },
  };
}

class RuntimeE2EFailure extends Error {
  constructor(
    public readonly classification: RuntimeE2EFailureClassification,
    public readonly failureCode: RuntimeE2EFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeE2EFailure";
  }
}

function runtimeFailure(
  classification: RuntimeE2EFailureClassification,
  failureCode: RuntimeE2EFailureCode,
  message: string,
  options?: ErrorOptions,
): RuntimeE2EFailure {
  return new RuntimeE2EFailure(classification, failureCode, message, options);
}

function toRuntimeE2EFailure(error: unknown): RuntimeE2EFailure {
  if (error instanceof RuntimeE2EFailure) {
    return error;
  }

  return runtimeFailure(
    "gateway-a2a-contract-problem",
    "unexpected_failure",
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? { cause: error } : undefined,
  );
}

function printUsage(): void {
  process.stdout.write(
    `${[
      "runtime-e2e",
      "",
      "Usage:",
      `  bun scripts/runtime-e2e.ts <${listGatewayRuntimeIds().join("|")}> [--profile <name>]`,
      "",
      "Starts the selected ACP runtime through the local gateway,",
      "then validates base-url and card-url A2A client flows end-to-end.",
      "When --profile is used, the named profile must already exist in",
      ".agents-js/config.json or ~/.config/agents-js/config.json.",
    ].join("\n")}\n`,
  );
}

function requireRuntimeId(argv: string[]): GatewayRuntimeId | undefined {
  const runtimeId = argv[0];
  if (runtimeId === "--help" || runtimeId === "-h") {
    printUsage();
    return undefined;
  }

  if (!runtimeId) {
    printUsage();
    throw runtimeFailure(
      "runtime-availability-config-problem",
      "missing_runtime_argument",
      "[runtime-e2e] Missing runtime argument.",
    );
  }

  if (!supportedRuntimes.has(runtimeId as GatewayRuntimeId)) {
    throw runtimeFailure(
      "runtime-availability-config-problem",
      "unsupported_runtime",
      `[runtime-e2e] Unsupported runtime "${runtimeId}". Expected one of: ${[...supportedRuntimes].join(", ")}`,
    );
  }

  return runtimeId as GatewayRuntimeId;
}

function parseProfileName(argv: string[]): string | undefined {
  const remaining = [...argv];
  remaining.shift();

  if (remaining.length === 0) {
    return undefined;
  }

  if (remaining[0] === "--profile") {
    const profileName = remaining[1];
    if (!profileName) {
      throw runtimeFailure(
        "runtime-availability-config-problem",
        "missing_profile_argument",
        "[runtime-e2e] Missing value for --profile.",
      );
    }
    if (remaining.length !== 2) {
      throw runtimeFailure(
        "gateway-a2a-contract-problem",
        "gateway_a2a_contract_failure",
        `[runtime-e2e] Unknown extra arguments: ${remaining.slice(2).join(" ")}`,
      );
    }

    try {
      return validateGatewayRuntimeProfileName(profileName);
    } catch (error) {
      throw runtimeFailure(
        "runtime-availability-config-problem",
        "invalid_profile_name",
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? { cause: error } : undefined,
      );
    }
  }

  throw runtimeFailure(
    "gateway-a2a-contract-problem",
    "gateway_a2a_contract_failure",
    `[runtime-e2e] Unknown extra arguments: ${remaining.join(" ")}`,
  );
}

function getProfilesRoot(configPath: string): string {
  return path.join(path.dirname(configPath), "profiles");
}

function getConfiguredProfile(
  profileName: string,
  loadedConfig: Awaited<ReturnType<typeof loadAgentsJsConfig>>,
):
  | {
      profile: GatewayRuntimeProfile;
      profilesRoot: string;
      source: "project" | "user";
    }
  | undefined {
  const projectProfile = loadedConfig.projectConfig?.profiles?.[profileName];
  if (projectProfile) {
    return {
      profile: projectProfile,
      profilesRoot: getProfilesRoot(loadedConfig.paths.projectConfigPath),
      source: "project",
    };
  }

  const userProfile = loadedConfig.userConfig?.profiles?.[profileName];
  if (userProfile) {
    return {
      profile: userProfile,
      profilesRoot: getProfilesRoot(loadedConfig.paths.userConfigPath),
      source: "user",
    };
  }

  return undefined;
}

async function checkContamination(
  command: string,
  args: string[],
  env?: Record<string, string>,
): Promise<void> {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const silenceTimer = setTimeout(() => {
        child.stdout?.removeAllListeners("data");
        child.removeAllListeners("close");
        child.removeAllListeners("error");
        resolve();
      }, 500);

      child.stdout?.once("data", (chunk: Buffer) => {
        clearTimeout(silenceTimer);
        const result = inspectFirstChunk(chunk);
        reject(
          runtimeFailure(
            "acp-contamination-problem",
            "acp_stdout_contamination",
            formatContaminationError(result),
          ),
        );
      });

      child.once("close", (code) => {
        clearTimeout(silenceTimer);
        reject(
          runtimeFailure(
            "gateway-a2a-contract-problem",
            "gateway_a2a_contract_failure",
            `Process exited with code ${code} during silence check`,
          ),
        );
      });

      child.once("error", (error) => {
        clearTimeout(silenceTimer);
        reject(
          runtimeFailure(
            "gateway-a2a-contract-problem",
            "gateway_a2a_contract_failure",
            error.message,
            { cause: error },
          ),
        );
      });
    });

    const firstChunk = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            runtimeFailure(
              "gateway-a2a-contract-problem",
              "gateway_a2a_contract_failure",
              `Timeout waiting for initialize response from "${command}"`,
            ),
          ),
        10_000,
      );

      child.stdout?.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(chunk);
      });

      child.once("close", (code) => {
        clearTimeout(timer);
        reject(
          runtimeFailure(
            "gateway-a2a-contract-problem",
            "gateway_a2a_contract_failure",
            `Process exited with code ${code} before initialize response`,
          ),
        );
      });

      child.once("error", (error) => {
        clearTimeout(timer);
        reject(
          runtimeFailure(
            "gateway-a2a-contract-problem",
            "gateway_a2a_contract_failure",
            error.message,
            { cause: error },
          ),
        );
      });

      const initPayload = JSON.stringify(buildContaminationInitializeRequest());
      child.stdin?.write(`${initPayload}\n`);
    });

    const result = inspectFirstChunk(firstChunk);
    if (!result.ok) {
      throw runtimeFailure(
        "acp-contamination-problem",
        "acp_stdout_contamination",
        formatContaminationError(result),
      );
    }
    process.stdout.write("[runtime-e2e] contamination check: clean\n");
  } finally {
    child.kill("SIGKILL");
  }
}

function summarizeTranscript(controller: A2AClientController): {
  contextId?: string;
  taskId?: string;
  transcriptSize: number;
  taskState?: string;
  lastAgentText: string;
} {
  const state = controller.getState();
  let lastAgentText = "";
  for (let index = state.transcript.length - 1; index >= 0; index -= 1) {
    const entry = state.transcript[index];
    if (entry?.role === "agent") {
      lastAgentText = entry.text ?? "";
      break;
    }
  }
  return {
    contextId: state.contextId,
    taskId: state.taskId,
    transcriptSize: state.transcript.length,
    taskState: state.taskState,
    lastAgentText,
  };
}

const TERMINAL_FAILURE_TASK_STATES = new Set(["failed", "canceled", "rejected", "unknown"]);

function assertTurnSucceeded(
  controller: A2AClientController,
  label: string,
): ReturnType<typeof summarizeTranscript> {
  const state = controller.getState();
  const summary = summarizeTranscript(controller);

  // Protocol-level error path (JSON-RPC transport / unreachable gateway).
  assert.equal(
    state.lastError,
    undefined,
    `[runtime-e2e] ${label}: controller reported a protocol-level error: ${state.lastError}`,
  );

  // Task-level failure path (A2A task that terminated with state:"failed"/"canceled"/etc.).
  if (summary.taskState && TERMINAL_FAILURE_TASK_STATES.has(summary.taskState)) {
    throw new Error(
      `[runtime-e2e] ${label}: task terminated in non-success state "${summary.taskState}". ` +
        `Last agent transcript text: ${JSON.stringify(summary.lastAgentText)}`,
    );
  }

  // The terminal task state must be the success state. A2A's success state is "completed"
  // (see packages/a2a-client/src/session.ts TERMINAL_TASK_STATES). We accept "completed"
  // explicitly; anything else here is ambiguous (e.g., "working" means the turn didn't fully
  // drain before we inspected it).
  assert.equal(
    summary.taskState,
    "completed",
    `[runtime-e2e] ${label}: expected terminal task state "completed", got ${JSON.stringify(
      summary.taskState,
    )}. Last agent transcript text: ${JSON.stringify(summary.lastAgentText)}`,
  );

  // The agent-role terminal message must carry non-empty text. An empty response is
  // indistinguishable from a runtime that silently swallowed its own error.
  assert.ok(
    summary.lastAgentText.trim().length > 0,
    `[runtime-e2e] ${label}: expected non-empty agent reply, got empty/whitespace-only text`,
  );

  return summary;
}

async function runFlow(targetUrl: string): Promise<void> {
  const controller = new A2AClientController();

  try {
    await controller.connect({
      mode: targetUrl.endsWith(".json") ? "card" : "base",
      url: targetUrl,
    });

    const connectedState = controller.getState();
    assert.ok(typeof connectedState.target?.capabilities.supportsStreaming === "boolean");
    assert.equal(connectedState.lastError, undefined);

    await controller.sendTurn("Hello");
    const first = assertTurnSucceeded(controller, "first turn");
    assert.ok(first.contextId, "[runtime-e2e] expected a contextId after the first turn");
    assert.ok(first.taskId, "[runtime-e2e] expected a taskId after the first turn");
    assert.ok(
      first.transcriptSize >= 2,
      "[runtime-e2e] expected transcript entries after the first turn",
    );

    await controller.sendTurn("What is the last message I sent?");
    const second = assertTurnSucceeded(controller, "second turn");
    assert.equal(second.contextId, first.contextId);
    assert.ok(second.taskId, "[runtime-e2e] expected a taskId after the second turn");
    assert.ok(
      second.transcriptSize >= first.transcriptSize + 2,
      "[runtime-e2e] expected the second turn to append user and agent transcript entries",
    );
  } catch (error) {
    throw runtimeFailure(
      "gateway-a2a-contract-problem",
      "gateway_a2a_contract_failure",
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? { cause: error } : undefined,
    );
  }
}

function buildResultContract(params: {
  classification: RuntimeE2EFailureClassification | "passed";
  failureCode?: RuntimeE2EFailureCode | null;
  failureMessage?: string | null;
  passed: boolean;
  profileName?: string;
  runtimeId: string;
}): RuntimeE2EResultContract {
  return {
    classification: params.classification,
    contractVersion: 1,
    failureCode: params.failureCode ?? null,
    failureMessage: params.failureMessage ?? null,
    passed: params.passed,
    profile: params.profileName ?? null,
    runtime: params.runtimeId,
  };
}

function printResultContract(result: RuntimeE2EResultContract): void {
  process.stdout.write(`${formatRuntimeE2EResult(result)}\n`);
}

async function main(argv: string[]): Promise<RuntimeE2EResultContract | null> {
  const runtimeId = requireRuntimeId(argv);
  if (!runtimeId) {
    return null;
  }

  const profileName = parseProfileName(argv);
  let runtime: ResolvedGatewayRuntime;
  try {
    runtime = await resolveGatewayRuntime(runtimeId, {
      workspaceBinRoot: INTERNAL_GATEWAY_WORKSPACE_BIN_ROOT,
    });
  } catch (error) {
    throw runtimeFailure(
      "runtime-availability-config-problem",
      "unsupported_runtime",
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? { cause: error } : undefined,
    );
  }

  if (profileName) {
    const loadedConfig = await loadAgentsJsConfig({
      cwd: process.cwd(),
      env: process.env,
    });
    const configuredProfile = getConfiguredProfile(profileName, loadedConfig);
    if (!configuredProfile) {
      throw runtimeFailure(
        "runtime-availability-config-problem",
        "runtime_profile_missing",
        `[runtime-e2e] Runtime profile "${profileName}" was not found in ${loadedConfig.paths.projectConfigPath} or ${loadedConfig.paths.userConfigPath}.`,
      );
    }
    if (configuredProfile.profile.runtime !== runtimeId) {
      throw runtimeFailure(
        "runtime-availability-config-problem",
        "runtime_profile_mismatch",
        `[runtime-e2e] Runtime profile "${profileName}" targets "${configuredProfile.profile.runtime}" but the requested runtime is "${runtimeId}".`,
      );
    }
    runtime = applyGatewayRuntimeProfile(
      runtime,
      resolveGatewayRuntimeProfile(
        profileName,
        configuredProfile.profile,
        configuredProfile.profilesRoot,
      ),
    );
    process.stdout.write(
      `[runtime-e2e] runtime profile: ${profileName} (${configuredProfile.source} config)\n`,
    );
  }

  process.stdout.write(`[runtime-e2e] runtime: ${runtimeId}\n`);
  if (runtime.acp.command) {
    await checkContamination(runtime.acp.command, runtime.acp.args ?? [], runtime.acp.env);
  }

  const handle = await serveACPOverA2A({
    acp: runtime.acp,
    agentCard: runtime.agentCard,
    host: "127.0.0.1",
    port: 0,
  });

  try {
    const baseUrl = `http://127.0.0.1:${handle.port}`;
    const cardUrl = `${baseUrl}/.well-known/agent-card.json`;

    process.stdout.write("[runtime-e2e] runtime boot: ok\n");
    await runFlow(baseUrl);
    process.stdout.write("[runtime-e2e] session bootstrap: ok\n");
    process.stdout.write("[runtime-e2e] prompt round-trip: ok\n");
    process.stdout.write("[runtime-e2e] base-url flow: ok\n");
    await runFlow(cardUrl);

    process.stdout.write(
      `${[
        `[runtime-e2e] profile: ${profileName ?? "none"}`,
        `[runtime-e2e] card-url flow: ok`,
        `[runtime-e2e] streaming: validated via capability flag`,
      ].join("\n")}\n`,
    );
  } finally {
    handle.stop();
  }

  return buildResultContract({
    classification: "passed",
    passed: true,
    profileName,
    runtimeId,
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const runtimeId = argv[0] && !argv[0].startsWith("-") ? argv[0] : "unknown";
  const profileIndex = argv.indexOf("--profile");
  const profileName = profileIndex >= 0 ? argv[profileIndex + 1] : undefined;

  try {
    const result = await main(argv);
    if (result) {
      printResultContract(result);
    }
    process.exit(0);
  } catch (error) {
    const failure = toRuntimeE2EFailure(error);
    printResultContract(
      buildResultContract({
        classification: failure.classification,
        failureCode: failure.failureCode,
        failureMessage: failure.message,
        passed: false,
        profileName,
        runtimeId,
      }),
    );
    console.error(error);
    process.exit(1);
  }
}
