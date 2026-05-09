/**
 * Unit tests for the tool-layer spawnAgent wrapper. Every test injects
 * a fake spawnSubSessionFn so no real subprocess is created. The real
 * end-to-end happy path lives in `./spawn-agent.integration.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { SpawnSubSessionResult } from "@agents-js/gateway-runtime";
import {
  SPAWN_AGENT_DEFAULT_MAX_DEPTH,
  SpawnAgentInvalidInputError,
  spawnAgent,
  translateGatewayResult,
} from "../src/primitives/spawn-agent.ts";
import { createMemorySink, TraceEmitter } from "../src/trace.ts";

function makeGatewayResult(overrides: Partial<SpawnSubSessionResult> = {}): SpawnSubSessionResult {
  return {
    session_id: "sess-42",
    summary: "hello from subagent",
    status: "completed",
    duration_ms: 123,
    harness: "trial",
    ...overrides,
  };
}

describe("spawnAgent — input validation", () => {
  test("empty string subtask throws SpawnAgentInvalidInputError", async () => {
    let spawned = false;
    await expect(
      spawnAgent("", {
        spawnSubSessionFn: async () => {
          spawned = true;
          return makeGatewayResult();
        },
      }),
    ).rejects.toBeInstanceOf(SpawnAgentInvalidInputError);
    expect(spawned).toBe(false);
  });

  test("whitespace-only subtask rejects", async () => {
    await expect(
      spawnAgent("   \n\t  ", {
        spawnSubSessionFn: async () => makeGatewayResult(),
      }),
    ).rejects.toBeInstanceOf(SpawnAgentInvalidInputError);
  });

  test("non-string subtask rejects (defends against deconstructed input bag)", async () => {
    await expect(
      // Simulate a tool-invocation bag that omits subtask; the registered
      // invoke handler deconstructs { subtask, ...options } and could pass
      // undefined through if this guard weren't present.
      spawnAgent(undefined as unknown as string, {
        spawnSubSessionFn: async () => makeGatewayResult(),
      }),
    ).rejects.toBeInstanceOf(SpawnAgentInvalidInputError);
  });

  test("error carries the structured code for operator diagnostics", async () => {
    try {
      await spawnAgent("", {});
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SpawnAgentInvalidInputError);
      if (error instanceof SpawnAgentInvalidInputError) {
        expect(error.code).toBe("tools/spawn-agent-invalid-input");
        expect(error.name).toBe("SpawnAgentInvalidInputError");
      }
    }
  });

  test("validation happens before depth check (invalid input never produces depth_limit_exceeded)", async () => {
    await expect(spawnAgent("", { depth: 99, maxDepth: 1 })).rejects.toBeInstanceOf(
      SpawnAgentInvalidInputError,
    );
  });
});

describe("spawnAgent — depth enforcement", () => {
  test("depth >= maxDepth short-circuits to depth_limit_exceeded", async () => {
    let spawned = false;
    const result = await spawnAgent("go", {
      depth: 1,
      maxDepth: 1,
      spawnSubSessionFn: async () => {
        spawned = true;
        return makeGatewayResult();
      },
    });
    expect(spawned).toBe(false);
    expect(result.status).toBe("depth_limit_exceeded");
    expect(result.error?.code).toBe("tools/spawn-depth-exceeded");
    expect(result.sources).toEqual([]);
  });

  test("default maxDepth matches the exported constant", () => {
    expect(SPAWN_AGENT_DEFAULT_MAX_DEPTH).toBeGreaterThanOrEqual(1);
  });

  test("depth < maxDepth proceeds to spawn", async () => {
    let spawned = false;
    const result = await spawnAgent("go", {
      depth: 0,
      maxDepth: 2,
      spawnSubSessionFn: async () => {
        spawned = true;
        return makeGatewayResult();
      },
    });
    expect(spawned).toBe(true);
    expect(result.status).toBe("completed");
  });
});

describe("spawnAgent — provenance", () => {
  test("completed spawn produces exactly one Source with tool:// URI", async () => {
    const fixedNow = () => new Date("2026-04-22T12:00:00.000Z");
    const result = await spawnAgent("go", {
      now: fixedNow,
      spawnSubSessionFn: async () =>
        makeGatewayResult({ session_id: "sess-abc", harness: "trial" }),
    });

    expect(result.sources).toHaveLength(1);
    const source = result.sources[0];
    if (!source) throw new Error("expected one source");
    expect(source.source_type).toBe("tool");
    expect(source.source_ref).toBe("tool://spawn-agent/trial/sess-abc");
    expect(source.observed_at).toBe("2026-04-22T12:00:00.000Z");
    expect(source.retrieved_at).toBe("2026-04-22T12:00:00.000Z");
    expect(source.confidence).toBe("responsible");
  });

  test("short-circuited spawn (no session_id) emits no sources", async () => {
    const result = await spawnAgent("go", {
      spawnSubSessionFn: async () =>
        makeGatewayResult({
          session_id: "",
          status: "harness_unavailable",
          error: { code: "gateway/harness-unavailable", message: "not in registry" },
        }),
    });
    expect(result.sources).toEqual([]);
    expect(result.status).toBe("harness_unavailable");
    expect(result.error?.code).toBe("gateway/harness-unavailable");
  });
});

describe("spawnAgent — trace emitter integration", () => {
  test("supplied emitter records a single SpawnAgent trace around the spawn", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({ sink, agentId: "@test:example" });
    await spawnAgent("do a thing", {
      traceEmitter: emitter,
      hints: { harness: "trial", workspace_root: "/tmp/x" },
      spawnSubSessionFn: async () => makeGatewayResult(),
    });
    expect(sink.records).toHaveLength(1);
    const record = sink.records[0];
    if (!record) throw new Error("expected one record");
    expect(record.tool_name).toBe("SpawnAgent");
    expect(record.status).toBe("ok");
    expect(record.tags).toEqual(["spawn-agent"]);
    const args = record.args as {
      subtask: string;
      depth: number;
      maxDepth: number;
      hints: unknown;
    };
    expect(args.subtask).toBe("do a thing");
    expect(args.depth).toBe(0);
    expect(args.maxDepth).toBe(SPAWN_AGENT_DEFAULT_MAX_DEPTH);
    expect(args.hints).toEqual({ harness: "trial", workspace_root: "/tmp/x" });
  });

  test("depth-limit-exceeded does NOT emit a trace (spawn never happened)", async () => {
    const sink = createMemorySink();
    const emitter = new TraceEmitter({ sink, agentId: "@test:example" });
    await spawnAgent("go", {
      depth: 5,
      maxDepth: 5,
      traceEmitter: emitter,
      spawnSubSessionFn: async () => makeGatewayResult(),
    });
    expect(sink.records).toHaveLength(0);
  });

  test("no emitter → spawn still proceeds and result is returned", async () => {
    const result = await spawnAgent("go", {
      spawnSubSessionFn: async () => makeGatewayResult(),
    });
    expect(result.status).toBe("completed");
  });
});

describe("spawnAgent — result translation", () => {
  test("passes through harness, session_id, summary, duration, error", async () => {
    const result = await spawnAgent("go", {
      spawnSubSessionFn: async () =>
        makeGatewayResult({
          session_id: "s1",
          summary: "hi",
          status: "errored",
          duration_ms: 500,
          harness: "trial",
          error: { code: "gateway/non-end-turn", message: "cancelled" },
        }),
    });
    expect(result.session_id).toBe("s1");
    expect(result.summary).toBe("hi");
    expect(result.status).toBe("errored");
    expect(result.duration_ms).toBe(500);
    expect(result.harness).toBe("trial");
    expect(result.error?.code).toBe("gateway/non-end-turn");
  });

  test("translateGatewayResult is exported for direct use", () => {
    const out = translateGatewayResult(
      makeGatewayResult({ session_id: "x", harness: "trial" }),
      () => new Date("2026-04-22T12:00:00.000Z"),
    );
    expect(out.sources).toHaveLength(1);
    expect(out.sources[0]?.source_ref).toBe("tool://spawn-agent/trial/x");
  });
});

describe("spawnAgent — parent session threading", () => {
  test("parent_session_id is forwarded into subSession params", async () => {
    let received: string | undefined;
    await spawnAgent("go", {
      parent_session_id: "parent-42",
      spawnSubSessionFn: async (params) => {
        received = params.parent_session_id;
        return makeGatewayResult();
      },
    });
    expect(received).toBe("parent-42");
  });

  test("missing parent_session_id defaults to empty string (not undefined)", async () => {
    let received: string | undefined;
    await spawnAgent("go", {
      spawnSubSessionFn: async (params) => {
        received = params.parent_session_id;
        return makeGatewayResult();
      },
    });
    expect(received).toBe("");
  });
});
