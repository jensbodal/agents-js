/**
 * Tests for the opencode default-agent auto-recovery flow in
 * {@link ACPSessionController.newSession}. Covers:
 *
 *   1. Happy path — JSON-RPC `-32603` + `default agent "<name>" not found`
 *      triggers a destroy/restart with `--pure` appended, and the second
 *      `newSession` attempt succeeds.
 *   2. Scope guard — the same error does NOT trigger recovery when the
 *      StartConfig does not set `autoRecoverOpencodeDefaultAgent`.
 *   3. Idempotency — a second recovery-shaped failure on the SAME controller
 *      lifetime is NOT re-handled; the error propagates.
 *
 * Uses the shared in-process mock-agent harness with a thin `newSession`
 * interceptor so we can schedule per-call responses (throw → succeed).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Agent,
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type PromptResponse,
  RequestError,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { ACPProcess, ACPProcessOptions } from "@agents-js/acp";
import { configureLogging, resetLogging } from "../src/logger.ts";
import { ACPSessionController } from "../src/session-controller.ts";
import type { HostFileAdapters, StartConfig } from "../src/types/adapters.ts";

function createMockFileAdapters(): HostFileAdapters {
  return {
    readTextFile: async (params) => ({ content: `mock content of ${params.path}` }),
    writeTextFile: async () => ({}),
  };
}

type NewSessionOutcome =
  | { kind: "success"; sessionId: string }
  | { kind: "error"; code: number; message: string; data?: unknown };

interface RecoveryHarness {
  createProcess: (options: ACPProcessOptions) => ACPProcess;
  /** Arguments captured by each spawn. The first entry is the pre-recovery args. */
  spawnArgs: string[][];
  /** Count of `session/new` calls actually dispatched to the agent side. */
  newSessionCallCount(): number;
}

/**
 * Build a harness whose `createProcess` returns a fresh in-process ACP agent
 * on every spawn (one per `controller.start()`). Each spawn consumes the next
 * outcome from `outcomesPerSpawn[spawnIndex]` on its first `newSession` call,
 * then switches to the `afterFirst` outcome for that spawn on subsequent
 * `newSession` calls on the same spawn. This matches the recovery flow's
 * expected timeline: spawn #1 fails once, the controller destroys + respawns
 * as spawn #2, spawn #2 succeeds.
 */
function createRecoveryHarness(
  outcomesPerSpawn: Array<{ first: NewSessionOutcome; afterFirst: NewSessionOutcome }>,
): RecoveryHarness {
  const spawnArgs: string[][] = [];
  let totalNewSessionCalls = 0;
  let spawnIndex = 0;

  const createProcess = (options: ACPProcessOptions): ACPProcess => {
    const thisSpawnIndex = spawnIndex;
    spawnIndex++;
    spawnArgs.push([...(options.args ?? [])]);

    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
    const clientStream: Stream = ndJsonStream(clientToAgent.writable, agentToClient.readable);
    const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable);

    let newSessionCallCountThisSpawn = 0;

    const _agentConnection = new AgentSideConnection((_connection): Agent => {
      return {
        async authenticate() {
          return {};
        },
        async initialize() {
          return {
            agentInfo: { name: "mock-opencode", version: "1.0.0" },
            agentCapabilities: {},
            protocolVersion: PROTOCOL_VERSION,
          };
        },
        async newSession() {
          totalNewSessionCalls++;
          const plan = outcomesPerSpawn[thisSpawnIndex];
          if (!plan) {
            throw new Error(
              `Recovery harness: no scheduled outcome for spawn index ${thisSpawnIndex}`,
            );
          }
          const outcome = newSessionCallCountThisSpawn === 0 ? plan.first : plan.afterFirst;
          newSessionCallCountThisSpawn++;
          if (outcome.kind === "error") {
            throw new RequestError(outcome.code, outcome.message, outcome.data);
          }
          return { sessionId: outcome.sessionId };
        },
        async prompt(): Promise<PromptResponse> {
          return { stopReason: "end_turn" };
        },
        async cancel() {},
      };
    }, agentStream);

    return {
      stream: clientStream,
      process: null as unknown as import("node:child_process").ChildProcess,
      kill: () => {},
    };
  };

  return {
    createProcess,
    spawnArgs,
    newSessionCallCount: () => totalNewSessionCalls,
  };
}

function makeStartConfig(
  overrides: Partial<StartConfig> & Pick<StartConfig, "agentConfig">,
): StartConfig {
  return {
    workspacePath: "/tmp",
    fileAdapters: createMockFileAdapters(),
    ...overrides,
  };
}

const OPENCODE_MISSING_AGENT_ERROR = {
  kind: "error" as const,
  code: -32603,
  message: "Internal error",
  data: { details: 'default agent "\u200bSisyphus" not found' },
};

describe("ACPSessionController — opencode default-agent auto-recovery", () => {
  let controller: ACPSessionController;
  const warnEntries: Array<{ message: string }> = [];

  beforeEach(() => {
    warnEntries.length = 0;
    configureLogging({
      minLevel: "warn",
      transports: [
        {
          handle(entry) {
            if (entry.level === "warn") {
              warnEntries.push({ message: entry.message });
            }
          },
        },
      ],
    });
    controller = new ACPSessionController();
  });

  afterEach(() => {
    controller.destroy();
    resetLogging();
  });

  test("recovers from missing default agent by restarting with --pure and retrying once", async () => {
    const harness = createRecoveryHarness([
      // First spawn: fails with the opencode-missing-agent shape.
      {
        first: OPENCODE_MISSING_AGENT_ERROR,
        afterFirst: OPENCODE_MISSING_AGENT_ERROR,
      },
      // Second spawn (post-recovery): succeeds.
      {
        first: { kind: "success", sessionId: "recovered-session-1" },
        afterFirst: { kind: "success", sessionId: "recovered-session-1" },
      },
    ]);

    await controller.start(
      makeStartConfig({
        agentConfig: {
          name: "mock-opencode",
          command: "opencode",
          args: ["acp"],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          autoRecoverOpencodeDefaultAgent: true,
        },
        createProcess: harness.createProcess,
      }),
    );

    const sessionId = await controller.newSession();

    expect(sessionId).toBe("recovered-session-1");
    // Two spawns total: original + recovered.
    expect(harness.spawnArgs).toHaveLength(2);
    // First spawn uses the pre-recovery args.
    expect(harness.spawnArgs[0]).toEqual(["acp"]);
    // Second spawn appends `--pure` per the recovery contract.
    expect(harness.spawnArgs[1]).toEqual(["acp", "--pure"]);
    // A WARN explaining the recovery path must have been logged.
    expect(
      warnEntries.some((entry) =>
        entry.message.includes('default agent "\u200bSisyphus" not found'),
      ),
    ).toBe(true);
  });

  test("does NOT recover when autoRecoverOpencodeDefaultAgent is unset (scope guard)", async () => {
    const harness = createRecoveryHarness([
      {
        first: OPENCODE_MISSING_AGENT_ERROR,
        afterFirst: { kind: "success", sessionId: "should-not-reach" },
      },
    ]);

    await controller.start(
      makeStartConfig({
        agentConfig: {
          name: "mock-opencode",
          command: "opencode",
          args: ["acp"],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          // autoRecoverOpencodeDefaultAgent intentionally omitted.
        },
        createProcess: harness.createProcess,
      }),
    );

    await expect(controller.newSession()).rejects.toThrow("Internal error");
    // No respawn happened — exactly one spawn, one new-session dispatch.
    expect(harness.spawnArgs).toHaveLength(1);
    expect(harness.newSessionCallCount()).toBe(1);
  });

  test("refuses to re-enter the recovery path on a persistent failure (idempotency latch)", async () => {
    const harness = createRecoveryHarness([
      {
        // Spawn #1: fail with the recoverable shape.
        first: OPENCODE_MISSING_AGENT_ERROR,
        afterFirst: OPENCODE_MISSING_AGENT_ERROR,
      },
      {
        // Spawn #2 (post-recovery): still fails with the same shape.
        first: OPENCODE_MISSING_AGENT_ERROR,
        afterFirst: OPENCODE_MISSING_AGENT_ERROR,
      },
    ]);

    await controller.start(
      makeStartConfig({
        agentConfig: {
          name: "mock-opencode",
          command: "opencode",
          args: ["acp"],
          env: {},
          authHints: [],
          workspacePolicy: "workspace-root-only",
          autoRecoverOpencodeDefaultAgent: true,
        },
        createProcess: harness.createProcess,
      }),
    );

    // Single newSession call must propagate after one retry attempt; it must
    // NOT loop forever restarting the process. The latch prevents a second
    // recovery pass.
    await expect(controller.newSession()).rejects.toThrow("Internal error");

    // Exactly two spawns — original + single recovery attempt. If the latch
    // were broken, we'd see 3+ spawns here.
    expect(harness.spawnArgs).toHaveLength(2);
    expect(harness.spawnArgs[1]).toEqual(["acp", "--pure"]);
  });
});
