/**
 * End-to-end integration test for spawnSubSession against the real
 * trial-agent binary. Exercises the bounded-mode happy path: spawn,
 * prompt, capture summary, clean terminate.
 *
 * Requires `bun install` to have linked `trial-agent` into
 * `node_modules/.bin`. Runs against fixture workspace + hub under the
 * trial-agent package so the subagent finds deterministic content.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { ResolvedGatewayRuntime } from "../src/runtimes-registry.ts";
import { SPAWN_SUB_SESSION_DEFAULT_HARNESS, spawnSubSession } from "../src/spawn-sub-session.ts";

const FIXTURE_WS = path.resolve(
  import.meta.dir,
  "../../../tests/trial-agent/tests/fixtures/workspace",
);
const FIXTURE_HUB = path.resolve(import.meta.dir, "../../../tests/trial-agent/tests/fixtures/hub");
const TRIAL_AGENT_BIN = path.resolve(
  import.meta.dir,
  "../../../tests/trial-agent/bin/trial-agent.ts",
);
const BUN_BIN = Bun.which("bun") ?? "bun";

/**
 * Build a ResolvedGatewayRuntime pointing at the in-repo trial-agent
 * source file via `bun run`. Needed because `@agents-js/trial-agent` is
 * marked `"private": true` and not linked into `node_modules/.bin`, so
 * the default `resolveGatewayRuntime("trial")` path can't locate the
 * binary. Mirrors the direct-path-invocation pattern used by the
 * existing trial-agent integration suite.
 */
function makeTrialRuntimeResolved(): ResolvedGatewayRuntime {
  return {
    definition: {
      id: "trial",
      displayName: "Trial Agent (integration)",
      description: "test-local trial agent via bun run",
      command: BUN_BIN,
      args: ["run", TRIAL_AGENT_BIN],
      install: { owner: "agents-js", installHint: "n/a — in-repo" },
      resolvesFromWorkspaceBin: false,
    },
    acp: {
      command: BUN_BIN,
      args: ["run", TRIAL_AGENT_BIN],
      env: {
        TRIAL_AGENT_HUB_ROOT: FIXTURE_HUB,
        TRIAL_AGENT_WORKSPACE: FIXTURE_WS,
      },
    },
    agentCard: {
      name: "universal-acp-gateway",
      description: "integration test",
      capabilities: { "text-to-text": {}, extensions: [] },
    },
  };
}

describe("spawnSubSession — real trial-agent integration", () => {
  test("bounded mode: fetchContext subtask returns non-empty summary with completed status", async () => {
    // The trial-agent binary reads TRIAL_AGENT_HUB_ROOT /
    // TRIAL_AGENT_WORKSPACE from its env. gateway-runtime's
    // resolveGatewayRuntime("trial") produces the command+args but
    // does NOT merge fixture env by default. Inject a resolver that
    // layers the fixture env on top so the subagent hits fixture
    // data rather than the live hub.
    const result = await spawnSubSession(
      {
        parent_session_id: "parent-integration-test",
        subtask: "fetch context about time estimates",
        hints: {
          harness: SPAWN_SUB_SESSION_DEFAULT_HARNESS,
          workspace_root: FIXTURE_WS,
        },
        mode: "bounded",
        timeout_ms: 30_000,
      },
      {
        resolveRuntime: async () => makeTrialRuntimeResolved(),
      },
    );

    expect(result.status).toBe("completed");
    expect(result.harness).toBe(SPAWN_SUB_SESSION_DEFAULT_HARNESS);
    expect(result.session_id.length).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThan(0);
    expect(result.summary.length).toBeGreaterThan(0);
    // fetchContext rendering includes the function name; confirms the
    // subagent actually ran the fetch-context handler rather than a
    // fallback path.
    expect(result.summary).toContain("fetchContext");
    expect(result.summary).toContain("hub-file");
  }, 45_000);

  test("bounded mode: timeout fires and status reports timed_out", async () => {
    // Use a 1ms timeout with a real trial-agent spawn. The child
    // can't possibly respond that fast, so the race resolves on the
    // timeout side. Verifies the bounded-mode timeout invariant
    // surfaces correctly and cleanup still runs.
    const result = await spawnSubSession(
      {
        parent_session_id: "parent-timeout-test",
        subtask: "fetch context about anything",
        hints: {
          harness: SPAWN_SUB_SESSION_DEFAULT_HARNESS,
          workspace_root: FIXTURE_WS,
        },
        mode: "bounded",
        timeout_ms: 1,
      },
      {
        resolveRuntime: async () => makeTrialRuntimeResolved(),
      },
    );
    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("gateway/timeout");
  }, 15_000);
});
