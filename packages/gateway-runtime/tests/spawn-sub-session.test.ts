/**
 * Unit + integration tests for spawnSubSession.
 *
 * Unit tests exercise the decision paths that happen BEFORE the ACP
 * spawn (unsupported mode, unsupported harness, harness resolution
 * failure) — these use injected resolver / spawner mocks so no real
 * subprocess is created.
 *
 * The integration test that spawns a real `trial-agent` binary and
 * drives a bounded prompt end-to-end lives in
 * `./spawn-sub-session.integration.test.ts` so unit-test runs stay
 * fast and deterministic.
 */

import { describe, expect, test } from "bun:test";
import type { Stream } from "@agentclientprotocol/sdk";
import type { ResolvedGatewayRuntime } from "../src/runtimes-registry.ts";
import {
  SPAWN_SUB_SESSION_DEFAULT_HARNESS,
  SPAWN_SUB_SESSION_SUPPORTED_HARNESSES,
  SpawnSubSessionTimeoutError,
  spawnSubSession,
} from "../src/spawn-sub-session.ts";

function makeRuntime(): ResolvedGatewayRuntime {
  return {
    definition: {
      id: "trial",
      displayName: "Trial Agent",
      description: "test double",
      command: "/bin/true",
      args: [],
      install: { owner: "agents-js", installHint: "n/a" },
      resolvesFromWorkspaceBin: true,
    },
    acp: { command: "/bin/true", args: [] },
    agentCard: {
      name: "universal-acp-gateway",
      description: "test",
      capabilities: { "text-to-text": {}, extensions: [] },
    },
  };
}

/**
 * Minimal Stream double — the ACP spawner is only exercised in tests
 * that reach the handshake, and those tests use the real spawner
 * against trial-agent in the integration suite. Unit tests that hit
 * the decision paths short-circuit before any Stream access.
 */
function makeDeadStream(): Stream {
  const readable = new ReadableStream<unknown>({
    start(controller) {
      controller.close();
    },
  });
  const writable = new WritableStream<unknown>({ write() {} });
  return {
    readable,
    writable,
  } as unknown as Stream;
}

describe("spawnSubSession — input validation", () => {
  test("supported harnesses registry is non-empty and includes the default", () => {
    expect(SPAWN_SUB_SESSION_SUPPORTED_HARNESSES.length).toBeGreaterThan(0);
    expect(SPAWN_SUB_SESSION_SUPPORTED_HARNESSES).toContain(SPAWN_SUB_SESSION_DEFAULT_HARNESS);
  });

  test("non-bounded mode returns errored without spawning", async () => {
    let spawnCalled = false;
    const result = await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        // Deliberately passing an unsupported mode to validate the runtime
        // check; cast through a wider type so the test expresses the
        // invariant even though the TS signature rejects it.
        mode: "detached" as unknown as "bounded",
      },
      {
        spawnAgent: () => {
          spawnCalled = true;
          throw new Error("should not reach spawn");
        },
        resolveRuntime: async () => makeRuntime(),
      },
    );
    expect(spawnCalled).toBe(false);
    expect(result.status).toBe("errored");
    expect(result.error?.code).toBe("gateway/unsupported-mode");
  });

  test("unsupported harness returns harness_unavailable without spawning", async () => {
    let spawnCalled = false;
    const result = await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        hints: { harness: "nonexistent" },
        mode: "bounded",
      },
      {
        spawnAgent: () => {
          spawnCalled = true;
          throw new Error("should not reach spawn");
        },
        resolveRuntime: async () => makeRuntime(),
      },
    );
    expect(spawnCalled).toBe(false);
    expect(result.status).toBe("harness_unavailable");
    expect(result.harness).toBe("nonexistent");
    expect(result.error?.code).toBe("gateway/harness-unavailable");
    expect(result.session_id).toBe("");
    expect(result.duration_ms).toBe(0);
  });

  test("runtime resolution failure returns harness_unavailable", async () => {
    let spawnCalled = false;
    const result = await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        mode: "bounded",
      },
      {
        spawnAgent: () => {
          spawnCalled = true;
          throw new Error("should not reach spawn");
        },
        resolveRuntime: async () => {
          throw new Error("binary not found");
        },
      },
    );
    expect(spawnCalled).toBe(false);
    expect(result.status).toBe("harness_unavailable");
    expect(result.harness).toBe(SPAWN_SUB_SESSION_DEFAULT_HARNESS);
    expect(result.error?.code).toBe("gateway/harness-resolution-failed");
    expect(result.error?.message).toContain("binary not found");
  });

  test("default harness is used when hints.harness is unspecified", async () => {
    let resolvedId: string | undefined;
    const result = await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        mode: "bounded",
      },
      {
        spawnAgent: () => {
          throw new Error("no-spawn");
        },
        resolveRuntime: async (id) => {
          resolvedId = id;
          throw new Error("stop here");
        },
      },
    );
    expect(resolvedId).toBe(SPAWN_SUB_SESSION_DEFAULT_HARNESS);
    expect(result.harness).toBe(SPAWN_SUB_SESSION_DEFAULT_HARNESS);
  });

  test("explicit hints.harness === default is accepted", async () => {
    let resolvedId: string | undefined;
    await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        hints: { harness: SPAWN_SUB_SESSION_DEFAULT_HARNESS },
        mode: "bounded",
      },
      {
        spawnAgent: () => {
          throw new Error("no-spawn");
        },
        resolveRuntime: async (id) => {
          resolvedId = id;
          throw new Error("stop here");
        },
      },
    );
    expect(resolvedId).toBe(SPAWN_SUB_SESSION_DEFAULT_HARNESS);
  });
});

describe("spawnSubSession — timeout plumbing", () => {
  test("SpawnSubSessionTimeoutError carries the timeout value", () => {
    const err = new SpawnSubSessionTimeoutError(12_345);
    expect(err.code).toBe("gateway/timeout");
    expect(err.timeout_ms).toBe(12_345);
    expect(err.message).toContain("12345");
  });

  test("spawner that throws synchronously surfaces as errored", async () => {
    const result = await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        mode: "bounded",
        timeout_ms: 100,
      },
      {
        resolveRuntime: async () => makeRuntime(),
        spawnAgent: () => {
          throw new Error("spawn EACCES");
        },
      },
    );
    // Spawner synchronous throw propagates through the try/catch.
    expect(result.status).toBe("errored");
    expect(result.error?.message).toContain("spawn EACCES");
  });

  test("connection-layer throw surfaces as errored with empty summary", async () => {
    const result = await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        mode: "bounded",
        timeout_ms: 100,
      },
      {
        resolveRuntime: async () => makeRuntime(),
        spawnAgent: () => ({
          stream: makeDeadStream(),
          // biome-ignore lint/suspicious/noExplicitAny: minimal ChildProcess shape suffices here
          process: {} as any,
          kill: () => {},
        }),
      },
    );
    // ClientSideConnection.initialize() will reject against the
    // immediately-closed stream. Status should be errored; summary stays empty
    // because no notifications fired before the failure.
    expect(result.status).toBe("errored");
    expect(result.summary).toBe("");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("hung handshake honors timeout (initialize covered by raceWithTimeout)", async () => {
    // Stream that accepts writes but never emits anything: initialize()
    // posts a request and awaits a response that never arrives. Prior
    // to the handshake-timeout fix this hung forever. With the fix,
    // timeout covers the entire handshake + prompt window.
    const hungStream = (): Stream => {
      const readable = new ReadableStream<unknown>({
        start() {
          // No close, no enqueue — reader blocks.
        },
      });
      const writable = new WritableStream<unknown>({ write() {} });
      return { readable, writable } as unknown as Stream;
    };
    const result = await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        mode: "bounded",
        timeout_ms: 50,
      },
      {
        resolveRuntime: async () => makeRuntime(),
        spawnAgent: () => ({
          stream: hungStream(),
          // biome-ignore lint/suspicious/noExplicitAny: minimal ChildProcess shape suffices here
          process: {} as any,
          kill: () => {},
        }),
      },
    );
    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("gateway/timeout");
  });

  test("kill() errors in finally do not shadow prior errors", async () => {
    let killCalled = false;
    const result = await spawnSubSession(
      {
        parent_session_id: "p1",
        subtask: "go",
        mode: "bounded",
        timeout_ms: 50,
      },
      {
        resolveRuntime: async () => makeRuntime(),
        spawnAgent: () => ({
          stream: makeDeadStream(),
          // biome-ignore lint/suspicious/noExplicitAny: minimal ChildProcess shape suffices here
          process: {} as any,
          kill: () => {
            killCalled = true;
            throw new Error("kill: already terminated");
          },
        }),
      },
    );
    // Kill was attempted AND threw; original error should still surface.
    expect(killCalled).toBe(true);
    expect(result.status).toBe("errored");
    expect(result.error?.code).toBe("gateway/acp-error");
    // The kill error message must NOT leak into the result.
    expect(result.error?.message).not.toContain("already terminated");
  });
});
