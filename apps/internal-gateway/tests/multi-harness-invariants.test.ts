/**
 * Multi-harness load-bearing invariant test — lane-manager-surface scope.
 *
 * The invariant: multi-harness coexistence preserves four process-wide
 * singletons (`permissionStore`, `auditEmitter`, WS bridge, agent card).
 *
 * What THIS test covers (the lane-manager-surface subset that's
 * directly observable without standing up the whole `main()` composition):
 *
 *   1. The lane manager NEVER caches controllers — every
 *      `getOrSpawnLane` call invokes `createController` fresh.
 *      Regression catch: if a future change re-adds a per-context
 *      cache, the "lane manager delegates every spawn to createController;
 *      never caches" test fails.
 *   2. `auditEmitter`'s ring buffer is structurally shared across
 *      both lanes (audit records from any lane appear in the same
 *      `recent()` view; bus-side, both lanes' `child-spawned` events
 *      reach the same subscriber).
 *   3. Agent card is a single mutable object reference whose
 *      `capabilities.harnesses` array is mutated in place (identity
 *      check before/after spawns) — every consumer holding the
 *      reference sees fleet state transitions without re-fetching.
 *   4. Crash isolation: one harness's `child-exited` doesn't take down
 *      the other; ready transitions publish `card-changed` correctly.
 *
 * What this test does NOT verify (out of scope at this level):
 *   - That `main.ts`'s composition root threads the SAME process-wide
 *     `permissionStore` reference into every `createController` call.
 *     The mock factory in this file is closure-captured by definition,
 *     so closure-only observation could pass even if the production
 *     composition forked stores per harness. Catching that regression
 *     requires either (a) exporting the composition seam from main.ts
 *     and exercising it here, or (b) a CI gate that lints the
 *     `createController` factory body in main.ts for per-call store
 *     construction. Neither is in scope here; deferred as later work.
 *
 * Composition mirrors `bus-audit-integration.test.ts`: same primitives
 * `main()` builds, without `Bun.serve` — the wire transport is covered
 * by `bus-endpoint.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { buildAgentCard, type HarnessCapabilityEntry } from "@agents-js/a2a";
import type { ACPSessionEvent, ACPSessionState, ProcessExitInfo } from "@agents-js/acp-host";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";
import {
  createAuditEmitter,
  createGatewayBus,
  type GatewayBusEvent,
  type GatewayHostController,
  type HarnessFleetEntry,
  HarnessLaneManager,
  wrapAuditEmitterAsBusPublisher,
} from "@agents-js/host";

type SessionListener = (event: ACPSessionEvent, state: ACPSessionState) => void;

interface MockController {
  controller: GatewayHostController;
  triggerExit(info: ProcessExitInfo): void;
  destroyed: () => boolean;
  pid: number | undefined;
}

/**
 * Minimal `GatewayHostController` stub. Captures the registered
 * `onProcessExit` handler so tests can synthetically fire ACP-child
 * exits without needing a real subprocess; session listeners are
 * accepted but no events are emitted in this test.
 */
function createMockController(pid: number): MockController {
  const exitHandlers = new Set<(info: ProcessExitInfo) => void>();
  const sessionListeners = new Set<SessionListener>();
  const state: Partial<ACPSessionState> = { status: "ready", sessionId: null };
  let isDestroyed = false;

  const controller = {
    getChildPid: () => pid,
    onProcessExit(handler: (info: ProcessExitInfo) => void) {
      exitHandlers.add(handler);
      return () => exitHandlers.delete(handler);
    },
    subscribe(listener: SessionListener) {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    destroy() {
      isDestroyed = true;
    },
    async cancel() {},
    async newSession() {
      return "session-mock";
    },
    async loadSession() {
      return "session-mock";
    },
    async sendPrompt() {},
    async setModel() {},
    async setPermissionMode() {},
    forceReset() {},
    getState: () => state as ACPSessionState,
    resolveElicitation() {},
    resolvePermission() {},
    resolveWriteGate() {},
    sendSurfaceEvent() {},
    setLastError() {},
    permissionMode: "ask",
  } as unknown as GatewayHostController;

  return {
    controller,
    triggerExit(info) {
      for (const h of exitHandlers) h(info);
    },
    destroyed: () => isDestroyed,
    pid,
  };
}

function buildFleetEntries(): HarnessFleetEntry[] {
  const fakeRuntime = {} as ResolvedGatewayRuntime;
  return [
    { id: "harness-a", displayName: "Harness A", primary: true, runtime: fakeRuntime },
    { id: "harness-b", displayName: "Harness B", primary: false, runtime: fakeRuntime },
  ];
}

describe("multi-harness invariants (load-bearing)", () => {
  test("lane manager delegates every spawn to createController; never caches", async () => {
    // The lane manager MUST NOT cache controllers — `HostA2AExecutor`
    // owns each factory-returned controller and destroys it on idle
    // eviction. If the lane manager kept a `lanes: Map<ctx, controller>`
    // it could hand back a controller the executor had already torn down.
    //
    // This test catches that regression structurally: every successful
    // `getOrSpawnLane` call must invoke `createController` exactly once,
    // and back-to-back calls for the same `(harnessId, contextId)` pair
    // must return DISTINCT controllers.
    const bus = createGatewayBus();
    const gatewayCard = buildAgentCard({ name: "test-gateway", description: "test" });

    let createCallCount = 0;
    const seenControllers: GatewayHostController[] = [];
    const laneManager = new HarnessLaneManager({
      entries: buildFleetEntries(),
      gatewayCard,
      bus,
      createController: async (_entry) => {
        createCallCount += 1;
        const mock = createMockController(7000 + createCallCount);
        seenControllers.push(mock.controller);
        return mock.controller;
      },
    });

    const a1 = await laneManager.getOrSpawnLane("harness-a", "ctx-a");
    const a2 = await laneManager.getOrSpawnLane("harness-a", "ctx-a");
    const a3 = await laneManager.getOrSpawnLane("harness-a", "ctx-other");
    const b1 = await laneManager.getOrSpawnLane("harness-b", "ctx-b");

    // Every getOrSpawnLane resolves with a fresh controller invocation.
    expect(createCallCount).toBe(4);
    expect(new Set([a1, a2, a3, b1]).size).toBe(4);
    expect(seenControllers).toHaveLength(4);

    laneManager.destroy();
  });

  test("two-lane spawn preserves agent-card identity + shared bus + shared audit", async () => {
    // Compose the same primitives main() builds.
    const bus = createGatewayBus();
    const audit = wrapAuditEmitterAsBusPublisher({
      bus,
      emitter: createAuditEmitter({ logger: { log() {} } }),
    });
    const gatewayCard = buildAgentCard({ name: "test-gateway", description: "test" });
    // Hold a reference to the same card array slot the lane manager will
    // mutate; if any code path replaces the array, this snapshot
    // diverges from the live card and the test fails.
    const events: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((e) => events.push(e));

    const laneManager = new HarnessLaneManager({
      entries: buildFleetEntries(),
      gatewayCard,
      bus,
      createController: async (entry) =>
        createMockController(entry.id === "harness-a" ? 1001 : 1002).controller,
    });

    // Capture the harnesses array reference BEFORE spawning so a later
    // identity check proves the lane manager mutates in place rather
    // than swapping the array.
    const initialHarnessesArrayRef = gatewayCard.capabilities.harnesses;
    expect(initialHarnessesArrayRef).toBeDefined();

    const ctrlA = await laneManager.getOrSpawnLane("harness-a", "ctx-a");
    const ctrlB = await laneManager.getOrSpawnLane("harness-b", "ctx-b");

    // Distinct lane controllers — fan-out happened.
    expect(ctrlA).not.toBe(ctrlB);

    // INVARIANT: bus is shared — both spawn events reach the same
    // subscriber. The bus is the cross-process surface that wraps the
    // audit ring buffer; cross-lane delivery confirms the topology.
    const spawnEvents = events.filter((e) => e.type === "gateway.harness.child-spawned");
    expect(spawnEvents).toHaveLength(2);
    expect(spawnEvents.map((e) => (e.payload as { harnessId: string }).harnessId).sort()).toEqual([
      "harness-a",
      "harness-b",
    ]);

    // INVARIANT: card-changed publishes on the first-spawn ready
    // transition for each harness (cache-invalidation contract). Two
    // harnesses, two transitions — two events.
    const readyTransitions = events.filter(
      (e) =>
        e.type === "gateway.harness.card-changed" &&
        (e.payload as { previousEntry: HarnessCapabilityEntry }).previousEntry.ready === false &&
        (e.payload as { newEntry: HarnessCapabilityEntry }).newEntry.ready === true,
    );
    expect(readyTransitions).toHaveLength(2);

    // INVARIANT: agent-card harnesses array is mutated in place, not
    // replaced. Same reference before and after spawn.
    expect(gatewayCard.capabilities.harnesses).toBe(initialHarnessesArrayRef);
    expect(gatewayCard.capabilities.harnesses).toHaveLength(2);
    const cardA = gatewayCard.capabilities.harnesses?.find((h) => h.id === "harness-a");
    const cardB = gatewayCard.capabilities.harnesses?.find((h) => h.id === "harness-b");
    expect(cardA?.primary).toBe(true);
    expect(cardA?.ready).toBe(true);
    expect(cardB?.primary).toBe(false);
    expect(cardB?.ready).toBe(true);

    // INVARIANT: audit ring buffer is shared — records from contexts
    // bound to different harnesses both appear in the same ring.
    audit.record({
      kind: "a2a-task-started",
      correlationId: "c-a",
      taskId: "t-a",
      contextId: "ctx-a",
    });
    audit.record({
      kind: "a2a-task-finished",
      correlationId: "c-b",
      taskId: "t-b",
      contextId: "ctx-b",
      state: "completed",
    });
    const recent = audit.recent(10);
    expect(recent).toHaveLength(2);
    expect(recent.map((r) => r.kind).sort()).toEqual(["a2a-task-finished", "a2a-task-started"]);

    laneManager.destroy();
  });

  test("crash isolation: one harness crashing flips its ready false but leaves the other alone", async () => {
    const bus = createGatewayBus();
    const gatewayCard = buildAgentCard({ name: "test-gateway", description: "test" });

    // Hold references to the spawned mocks so the test can synthetically
    // fire the exit observer on one of them.
    const spawnedMocks: Array<{ harnessId: string; mock: MockController }> = [];
    const events: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((e) => events.push(e));

    const laneManager = new HarnessLaneManager({
      entries: buildFleetEntries(),
      gatewayCard,
      bus,
      createController: async (entry) => {
        const mock = createMockController(entry.id === "harness-a" ? 2001 : 2002);
        spawnedMocks.push({ harnessId: entry.id, mock });
        return mock.controller;
      },
    });

    await laneManager.getOrSpawnLane("harness-a", "ctx-a");
    await laneManager.getOrSpawnLane("harness-b", "ctx-b");
    expect(spawnedMocks).toHaveLength(2);

    // Reset event log so the crash-path assertions only see the crash.
    events.length = 0;

    const mockA = spawnedMocks.find((m) => m.harnessId === "harness-a")?.mock;
    if (!mockA) throw new Error("expected harness-a mock");
    mockA.triggerExit({
      pid: 2001,
      exitCode: 137,
      signal: "SIGKILL",
      crash: true,
      durationMs: 50,
    });

    // Crash publishes child-exited with `crash: true`.
    const exitedEvent = events.find((e) => e.type === "gateway.harness.child-exited");
    expect(exitedEvent).toBeDefined();
    const exitPayload = exitedEvent?.payload as {
      harnessId: string;
      crash: boolean;
      exitCode: number | null;
    };
    expect(exitPayload.harnessId).toBe("harness-a");
    expect(exitPayload.crash).toBe(true);
    expect(exitPayload.exitCode).toBe(137);

    // INVARIANT: ready transitions to false for the crashed harness,
    // card-changed publishes the diff. Other harness is untouched.
    expect(gatewayCard.capabilities.harnesses?.find((h) => h.id === "harness-a")?.ready).toBe(
      false,
    );
    expect(gatewayCard.capabilities.harnesses?.find((h) => h.id === "harness-b")?.ready).toBe(true);

    const cardChanged = events.find(
      (e) =>
        e.type === "gateway.harness.card-changed" &&
        (e.payload as { harnessId: string }).harnessId === "harness-a",
    );
    expect(cardChanged).toBeDefined();
    expect(
      (cardChanged?.payload as { previousEntry: HarnessCapabilityEntry }).previousEntry.ready,
    ).toBe(true);
    expect((cardChanged?.payload as { newEntry: HarnessCapabilityEntry }).newEntry.ready).toBe(
      false,
    );

    // INVARIANT: re-spawning harness-a flips ready back to true and
    // publishes another card-changed transition. The lane manager does
    // NOT auto-respawn — the next getOrSpawnLane call is what spawns.
    events.length = 0;
    await laneManager.getOrSpawnLane("harness-a", "ctx-a-respawn");
    expect(gatewayCard.capabilities.harnesses?.find((h) => h.id === "harness-a")?.ready).toBe(true);
    const respawnTransition = events.find(
      (e) =>
        e.type === "gateway.harness.card-changed" &&
        (e.payload as { harnessId: string }).harnessId === "harness-a" &&
        (e.payload as { previousEntry: HarnessCapabilityEntry }).previousEntry.ready === false &&
        (e.payload as { newEntry: HarnessCapabilityEntry }).newEntry.ready === true,
    );
    expect(respawnTransition).toBeDefined();

    laneManager.destroy();
  });

  test("destroy() rejects new spawns and tears down live controllers", async () => {
    const bus = createGatewayBus();
    const gatewayCard = buildAgentCard({ name: "test-gateway", description: "test" });

    const spawnedMocks: MockController[] = [];
    const laneManager = new HarnessLaneManager({
      entries: buildFleetEntries(),
      gatewayCard,
      bus,
      createController: async () => {
        const mock = createMockController(4000 + spawnedMocks.length);
        spawnedMocks.push(mock);
        return mock.controller;
      },
    });

    await laneManager.getOrSpawnLane("harness-a", "ctx-a");
    await laneManager.getOrSpawnLane("harness-b", "ctx-b");
    expect(spawnedMocks).toHaveLength(2);
    expect(spawnedMocks.every((m) => !m.destroyed())).toBe(true);

    laneManager.destroy();

    // All previously-spawned controllers had destroy() called on them.
    expect(spawnedMocks.every((m) => m.destroyed())).toBe(true);

    // Post-destroy spawn attempts reject loudly.
    await expect(laneManager.getOrSpawnLane("harness-a", "ctx-c")).rejects.toThrow(/destroyed/i);
  });

  test("agent card capabilities.harnesses shape is JSON-serializable (federation peer view)", async () => {
    const bus = createGatewayBus();
    const gatewayCard = buildAgentCard({ name: "test-gateway", description: "test" });
    const laneManager = new HarnessLaneManager({
      entries: buildFleetEntries(),
      gatewayCard,
      bus,
      createController: async (entry) =>
        createMockController(entry.id === "harness-a" ? 3001 : 3002).controller,
    });

    await laneManager.getOrSpawnLane("harness-a", "ctx-a");
    await laneManager.getOrSpawnLane("harness-b", "ctx-b");

    // Round-trip the capabilities block through JSON — this is what a
    // federating A2A peer sees on `/.well-known/agent-card.json`.
    const roundTripped = JSON.parse(JSON.stringify(gatewayCard.capabilities)) as {
      harnesses: HarnessCapabilityEntry[];
    };
    expect(Array.isArray(roundTripped.harnesses)).toBe(true);
    expect(roundTripped.harnesses).toHaveLength(2);
    expect(roundTripped.harnesses).toEqual([
      { id: "harness-a", displayName: "Harness A", primary: true, ready: true },
      { id: "harness-b", displayName: "Harness B", primary: false, ready: true },
    ]);

    laneManager.destroy();
  });
});
