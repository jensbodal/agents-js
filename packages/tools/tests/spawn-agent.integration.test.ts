/**
 * End-to-end integration test for spawnAgent against the real
 * trial-agent binary. Mirrors the gateway-runtime integration test
 * but exercises the tool-layer surface (provenance sources + trace
 * emission) in addition to the underlying spawn.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";
import { spawnAgent } from "../src/primitives/spawn-agent.ts";
import { createMemorySink, TraceEmitter } from "../src/trace.ts";

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

describe("spawnAgent — real trial-agent integration", () => {
  test("bounded completion returns summary + single tool:// provenance source", async () => {
    const result = await spawnAgent("fetch context about time estimates", {
      parent_session_id: "parent-int-1",
      hints: { harness: "trial", workspace_root: FIXTURE_WS },
      timeout_ms: 30_000,
      subSessionOptions: {
        resolveRuntime: async () => makeTrialRuntimeResolved(),
      },
    });

    expect(result.status).toBe("completed");
    expect(result.session_id.length).toBeGreaterThan(0);
    expect(result.summary).toContain("fetchContext");
    expect(result.summary).toContain("hub-file");

    expect(result.sources).toHaveLength(1);
    const source = result.sources[0];
    if (!source) throw new Error("expected one source");
    expect(source.source_type).toBe("tool");
    expect(source.source_ref).toBe(`tool://spawn-agent/trial/${result.session_id}`);
    expect(source.confidence).toBe("responsible");
  }, 45_000);

  test("TraceEmitter records a single SpawnAgent tool-call-trace spanning the subagent", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({
      sink,
      agentId: "@test-parent:example",
      sessionId: "parent-session-42",
    });

    const result = await spawnAgent("fetch context about time estimates", {
      parent_session_id: "parent-session-42",
      hints: { harness: "trial", workspace_root: FIXTURE_WS },
      timeout_ms: 30_000,
      traceEmitter: emitter,
      subSessionOptions: {
        resolveRuntime: async () => makeTrialRuntimeResolved(),
      },
    });

    expect(result.status).toBe("completed");

    // Exactly one trace record at the parent's emitter — the SpawnAgent
    // call itself. Trial-agent does not currently emit its own
    // tool-call-traces, so there are no child records in v1.
    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    if (!record) throw new Error("expected one record");
    expect(record.tool_name).toBe("SpawnAgent");
    expect(record.status).toBe("ok");
    expect(record.agent_id).toBe("@test-parent:example");
    expect(record.session_id).toBe("parent-session-42");
    expect(record.tags).toEqual(["spawn-agent"]);

    // The emitted trace's event_id is the composition root that
    // subagents *would* thread as parentEventId / rootEventId into
    // their own emitters (not exercised here — trial-agent doesn't
    // carry an emitter yet).
    expect(typeof record.event_id).toBe("string");
    expect(record.event_id.length).toBeGreaterThan(0);
    expect(record.root_event_id).toBe(record.event_id);
    expect(record.parent_event_id).toBeNull();
  }, 45_000);
});
