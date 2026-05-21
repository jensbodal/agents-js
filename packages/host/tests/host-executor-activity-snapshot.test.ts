import { describe, expect, test } from "bun:test";
import { HostA2AExecutor } from "../src/host-executor.ts";

/**
 * Activity snapshot is the gateway's hook into "is the executor doing
 * anything I should not interrupt?". The runtime-switch gate in the
 * internal-gateway reads it; preflight asserts its presence.
 *
 * These tests exercise the snapshot via the public surface — no
 * private-field reach-in. They use an idle stub controller, manipulate
 * the visible state through cancelTask + the dispatchedTaskIds map
 * (which the previous sub-scope already exposed via `as unknown` in
 * its own tests), and assert the counters track reality.
 */

function createIdleControllerStub() {
  return {
    permissionMode: "default" as const,
    getState: () => ({
      status: "ready",
      sessionId: "session-1",
      agentName: "gateway",
      agentCapabilities: null,
    }),
    subscribe: () => () => {},
    async cancel() {},
  };
}

describe("HostA2AExecutor.getActivitySnapshot", () => {
  test("idle executor reports zero counts across the board", () => {
    const executor = new HostA2AExecutor(createIdleControllerStub() as never);
    const snapshot = executor.getActivitySnapshot();
    expect(snapshot).toEqual({
      activeTaskCount: 0,
      activeDispatchCount: 0,
      activeLaneCount: 0,
      inFlightLaneCount: 0,
      pendingLaneCount: 0,
    });
  });

  test("activeDispatchCount tracks the dispatchedTaskIds map", () => {
    const executor = new HostA2AExecutor(createIdleControllerStub() as never);
    const internals = executor as unknown as {
      dispatchedTaskIds: Map<string, string>;
    };
    internals.dispatchedTaskIds.set("d-1", "ctx-1");
    internals.dispatchedTaskIds.set("d-2", "ctx-2");

    const snapshot = executor.getActivitySnapshot();
    expect(snapshot.activeDispatchCount).toBe(2);
    expect(snapshot.activeTaskCount).toBe(0);
  });

  test("activeTaskCount tracks the activeTasks map", () => {
    const executor = new HostA2AExecutor(createIdleControllerStub() as never);
    const internals = executor as unknown as {
      activeTasks: Map<string, unknown>;
    };
    internals.activeTasks.set("t-1", { taskId: "t-1" });
    expect(executor.getActivitySnapshot().activeTaskCount).toBe(1);
  });

  test("inFlightLaneCount counts only lanes whose inFlightPrompt !== null", () => {
    const executor = new HostA2AExecutor(createIdleControllerStub() as never);
    const internals = executor as unknown as {
      lanes: Map<string, { inFlightPrompt: Promise<unknown> | null }>;
    };
    internals.lanes.set("ctx-1", { inFlightPrompt: Promise.resolve(undefined) });
    internals.lanes.set("ctx-2", { inFlightPrompt: null });
    internals.lanes.set("ctx-3", { inFlightPrompt: Promise.resolve(undefined) });

    const snapshot = executor.getActivitySnapshot();
    expect(snapshot.activeLaneCount).toBe(3);
    expect(snapshot.inFlightLaneCount).toBe(2);
  });
});

describe("HostA2AExecutor.getActivitySnapshot — TOCTOU on lane creation", () => {
  /**
   * A runtime switch attempted while `controllerFactory()` is
   * awaiting must not be invisible — without tracking, the lane is
   * not yet in `lanes` and `activeLaneCount` reads 0 even though a
   * fresh controller is about to be inserted. `pendingLaneCount`
   * surfaces the in-flight construction so the gate sees it.
   */
  test("a controllerFactory call in flight reports pendingLaneCount > 0", async () => {
    const idleController = createIdleControllerStub();
    let resolveFactory!: (c: unknown) => void;
    const factoryDeferred = new Promise<unknown>((resolve) => {
      resolveFactory = resolve;
    });
    const executor = new HostA2AExecutor(idleController as never, {
      controllerFactory: () => factoryDeferred as Promise<never>,
    });

    // Start a lane creation in the background; do NOT await — we
    // want to inspect the snapshot mid-flight.
    const lanePromise = (
      executor as unknown as {
        getOrCreateLane(contextId: string): Promise<unknown>;
      }
    ).getOrCreateLane("ctx-pending");

    // Yield so the executor enters the await on `controllerFactory`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mid = executor.getActivitySnapshot();
    expect(mid.pendingLaneCount).toBe(1);
    expect(mid.activeLaneCount).toBe(0);

    // Resolve the factory; the lane should now be registered and
    // pending count should drop back to 0.
    resolveFactory(idleController);
    await lanePromise;

    const after = executor.getActivitySnapshot();
    expect(after.pendingLaneCount).toBe(0);
    expect(after.activeLaneCount).toBe(1);
  });
});

describe("HostA2AExecutor.destroyIdleLanes", () => {
  test("evicts lanes with no in-flight prompt; skips lanes that are busy", () => {
    const executor = new HostA2AExecutor(createIdleControllerStub() as never);
    const internals = executor as unknown as {
      lanes: Map<
        string,
        {
          contextId: string;
          inFlightPrompt: Promise<unknown> | null;
          owningTaskId: string | null;
          controller: { destroy: () => void; subscribe: () => () => void };
          ownsController: boolean;
          acpSessionId: string | null;
          lastActivityMs: number;
        }
      >;
    };
    let destroyCalls = 0;
    const idleControllerForLane = {
      subscribe: () => () => {},
      destroy: () => {
        destroyCalls += 1;
      },
    };
    internals.lanes.set("ctx-idle", {
      contextId: "ctx-idle",
      inFlightPrompt: null,
      owningTaskId: null,
      controller: idleControllerForLane,
      ownsController: true,
      acpSessionId: null,
      lastActivityMs: Date.now(),
    });
    internals.lanes.set("ctx-busy", {
      contextId: "ctx-busy",
      inFlightPrompt: Promise.resolve(undefined),
      owningTaskId: "t-busy",
      controller: { subscribe: () => () => {}, destroy: () => {} },
      ownsController: true,
      acpSessionId: null,
      lastActivityMs: Date.now(),
    });

    const result = executor.destroyIdleLanes();
    expect(result).toEqual({ evicted: 1, skipped: 1 });
    expect(internals.lanes.has("ctx-idle")).toBe(false);
    expect(internals.lanes.has("ctx-busy")).toBe(true);
    expect(destroyCalls).toBe(1);
  });

  test("idempotent — calling twice on an already-evicted set is a no-op", () => {
    const executor = new HostA2AExecutor(createIdleControllerStub() as never);
    expect(executor.destroyIdleLanes()).toEqual({ evicted: 0, skipped: 0 });
    expect(executor.destroyIdleLanes()).toEqual({ evicted: 0, skipped: 0 });
  });
});
