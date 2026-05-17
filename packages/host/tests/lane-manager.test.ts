import { describe, expect, test } from "bun:test";
import { buildAgentCard, type GatewayAgentCard, type HarnessCapabilityEntry } from "@agents-js/a2a";
import type { ACPSessionEvent, ACPSessionState, ProcessExitInfo } from "@agents-js/acp-host";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";
import { createGatewayBus, type GatewayBusEvent } from "../src/gateway-bus.ts";
import type { GatewayHostController } from "../src/host-session.ts";
import { type HarnessFleetEntry, HarnessLaneManager } from "../src/lane-manager.ts";

type SessionListener = (event: ACPSessionEvent, state: ACPSessionState) => void;

interface MockController {
  controller: GatewayHostController;
  /** Trigger the registered `onProcessExit` handler with the given info. */
  triggerExit(info: ProcessExitInfo): void;
  /** Emit a session event to subscribed listeners. */
  emit(event: ACPSessionEvent): void;
  destroyed: () => boolean;
  pid: number | undefined;
}

function createMockController(opts?: { pid?: number }): MockController {
  const pid = opts?.pid;
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
    // Unused-but-required surface for `GatewayHostController` structural shape.
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
    emit(event) {
      for (const l of sessionListeners) l(event, state as ACPSessionState);
    },
    destroyed: () => isDestroyed,
    pid,
  };
}

function buildFleet(): {
  entries: HarnessFleetEntry[];
  card: GatewayAgentCard;
} {
  const fakeRuntime = {} as ResolvedGatewayRuntime;
  const entries: HarnessFleetEntry[] = [
    { id: "opencode", displayName: "OpenCode ACP", primary: true, runtime: fakeRuntime },
    { id: "gemini", displayName: "Gemini ACP", primary: false, runtime: fakeRuntime },
  ];
  const card = buildAgentCard({ name: "test-gateway", description: "test" });
  return { entries, card };
}

describe("HarnessLaneManager", () => {
  test("pre-populates gatewayCard.capabilities.harnesses with ready:false for every entry", () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const _mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController().controller,
    });

    expect(card.capabilities.harnesses).toHaveLength(2);
    expect(card.capabilities.harnesses?.[0]).toEqual({
      id: "opencode",
      displayName: "OpenCode ACP",
      primary: true,
      ready: false,
    });
    expect(card.capabilities.harnesses?.[1]).toEqual({
      id: "gemini",
      displayName: "Gemini ACP",
      primary: false,
      ready: false,
    });
  });

  test("constructor rejects when no primary is marked", () => {
    const bus = createGatewayBus();
    const card = buildAgentCard({ name: "test", description: "t" });
    const fakeRuntime = {} as ResolvedGatewayRuntime;
    expect(
      () =>
        new HarnessLaneManager({
          entries: [{ id: "a", displayName: "A", primary: false, runtime: fakeRuntime }],
          gatewayCard: card,
          bus,
          createController: async () => createMockController().controller,
        }),
    ).toThrow(/exactly one primary/);
  });

  test("constructor rejects when two entries share a harness id", () => {
    // Load-bearing for `apps/internal-gateway/main.ts`: createHostSession
    // spawns the primary ACP child BEFORE this constructor runs, so an
    // unhandled throw here orphans the child in embedded-gateway use.
    // main.ts now wraps the constructor in `try/catch` + `session.destroy()`;
    // this test guards the trigger so the wrap's `catch` arm stays exercised.
    const bus = createGatewayBus();
    const card = buildAgentCard({ name: "test", description: "t" });
    const fakeRuntime = {} as ResolvedGatewayRuntime;
    expect(
      () =>
        new HarnessLaneManager({
          entries: [
            { id: "shared", displayName: "First", primary: true, runtime: fakeRuntime },
            { id: "shared", displayName: "Second", primary: false, runtime: fakeRuntime },
          ],
          gatewayCard: card,
          bus,
          createController: async () => createMockController().controller,
        }),
    ).toThrow(/duplicate harness id "shared"/);
  });

  test("getOrSpawnLane creates a fresh controller for every call (no caching)", async () => {
    // The lane manager does NOT cache controllers. HostA2AExecutor owns
    // each factory-returned controller and is free to destroy it on idle
    // eviction; caching at the manager would hand back a torn-down ref.
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    let spawnCount = 0;
    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => {
        spawnCount += 1;
        return createMockController({ pid: 1000 + spawnCount }).controller;
      },
    });

    const c1 = await mgr.getOrSpawnLane("opencode", "ctx-1");
    const c2 = await mgr.getOrSpawnLane("opencode", "ctx-1");
    const c3 = await mgr.getOrSpawnLane("opencode", "ctx-2");
    expect(c1).not.toBe(c2);
    expect(c1).not.toBe(c3);
    expect(c2).not.toBe(c3);
    expect(spawnCount).toBe(3);
  });

  test("spawn fires gateway.harness.child-spawned with the right payload + ready flipped to true", async () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const events: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((e) => events.push(e));

    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController({ pid: 4242 }).controller,
    });

    await mgr.getOrSpawnLane("opencode", "ctx-1");

    const spawned = events.find((e) => e.type === "gateway.harness.child-spawned");
    expect(spawned).toBeDefined();
    const payload = spawned?.payload as {
      harnessId: string;
      pid: number | undefined;
      harnessDisplayName: string;
      capabilities: HarnessCapabilityEntry[];
    };
    expect(payload.harnessId).toBe("opencode");
    expect(payload.pid).toBe(4242);
    expect(payload.harnessDisplayName).toBe("OpenCode ACP");
    const openSnapshot = payload.capabilities.find((c) => c.id === "opencode");
    expect(openSnapshot?.ready).toBe(true);
    expect(card.capabilities.harnesses?.find((c) => c.id === "opencode")?.ready).toBe(true);
  });

  test("process exit fires child-exited AND card-changed (ready true → false)", async () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const mock = createMockController({ pid: 7777 });
    const events: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((e) => events.push(e));

    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => mock.controller,
    });

    await mgr.getOrSpawnLane("opencode", "ctx-1");
    events.length = 0; // discard spawn events

    mock.triggerExit({
      pid: 7777,
      exitCode: 1,
      signal: null,
      crash: true,
      durationMs: 1234,
    });

    const exited = events.find((e) => e.type === "gateway.harness.child-exited");
    expect(exited).toBeDefined();
    const exitedPayload = exited?.payload as {
      harnessId: string;
      pid: number | undefined;
      exitCode: number | null;
      crash: boolean;
      durationMs: number;
    };
    expect(exitedPayload.harnessId).toBe("opencode");
    expect(exitedPayload.pid).toBe(7777);
    expect(exitedPayload.exitCode).toBe(1);
    expect(exitedPayload.crash).toBe(true);
    expect(exitedPayload.durationMs).toBe(1234);

    const cardChanged = events.find((e) => e.type === "gateway.harness.card-changed");
    expect(cardChanged).toBeDefined();
    const cardChangedPayload = cardChanged?.payload as {
      harnessId: string;
      previousEntry: HarnessCapabilityEntry;
      newEntry: HarnessCapabilityEntry;
    };
    expect(cardChangedPayload.harnessId).toBe("opencode");
    expect(cardChangedPayload.previousEntry.ready).toBe(true);
    expect(cardChangedPayload.newEntry.ready).toBe(false);

    // The mirrored agent-card entry must have been flipped too.
    expect(card.capabilities.harnesses?.find((c) => c.id === "opencode")?.ready).toBe(false);
  });

  test("getOrSpawnLane AFTER exit triggers a respawn (createController called twice)", async () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    let spawnCount = 0;
    const mocks: MockController[] = [];

    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => {
        spawnCount += 1;
        const m = createMockController({ pid: 1000 + spawnCount });
        mocks.push(m);
        return m.controller;
      },
    });

    const c1 = await mgr.getOrSpawnLane("opencode", "ctx-1");
    expect(spawnCount).toBe(1);

    // Crash the first child.
    // biome-ignore lint/style/noNonNullAssertion: just pushed
    mocks[0]!.triggerExit({
      pid: 1001,
      exitCode: 137,
      signal: "SIGKILL",
      crash: true,
      durationMs: 50,
    });

    const c2 = await mgr.getOrSpawnLane("opencode", "ctx-2");
    expect(spawnCount).toBe(2);
    expect(c2).not.toBe(c1);
  });

  test("destroy() tears down every spawned lane controller", async () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const mocks: MockController[] = [];

    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async (entry) => {
        const m = createMockController({ pid: entry.id === "opencode" ? 1 : 2 });
        mocks.push(m);
        return m.controller;
      },
    });

    await mgr.getOrSpawnLane("opencode", "ctx-1");
    await mgr.getOrSpawnLane("gemini", "ctx-2");

    mgr.destroy();
    expect(mocks).toHaveLength(2);
    // biome-ignore lint/style/noNonNullAssertion: validated length above
    expect(mocks[0]!.destroyed()).toBe(true);
    // biome-ignore lint/style/noNonNullAssertion: validated length above
    expect(mocks[1]!.destroyed()).toBe(true);

    // Post-destroy spawn rejects loudly rather than silently leaking.
    await expect(mgr.getOrSpawnLane("opencode", "ctx-3")).rejects.toThrow(/destroyed/i);
  });

  test("first spawn fires card-changed for the ready:false → true transition", async () => {
    // Fix #5 from Copilot's review: card-changed is the
    // cache-invalidation signal for federated peers. Suppressing it on
    // the first-spawn ready flip would leave subscribers who only
    // listen to card-changed (not child-spawned) seeing a stale
    // ready:false card after the harness was already up.
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const events: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((e) => events.push(e));

    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController({ pid: 9999 }).controller,
    });

    await mgr.getOrSpawnLane("opencode", "ctx-1");

    const readyTransition = events.find(
      (e) =>
        e.type === "gateway.harness.card-changed" &&
        (e.payload as { previousEntry: HarnessCapabilityEntry }).previousEntry.ready === false &&
        (e.payload as { newEntry: HarnessCapabilityEntry }).newEntry.ready === true,
    );
    expect(readyTransition).toBeDefined();

    // A second spawn for the SAME harness must NOT republish the
    // ready-transition card-changed (ready is already true; the diff
    // is empty so no spurious event).
    events.length = 0;
    await mgr.getOrSpawnLane("opencode", "ctx-2");
    const spuriousTransition = events.find(
      (e) =>
        e.type === "gateway.harness.card-changed" &&
        (e.payload as { newEntry: HarnessCapabilityEntry }).newEntry.ready === true,
    );
    expect(spuriousTransition).toBeUndefined();
  });

  test("two harnesses are isolated — each spawns its own controller and fires its own child-spawned", async () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const events: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((e) => events.push(e));

    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async (entry) =>
        createMockController({ pid: entry.id === "opencode" ? 11 : 22 }).controller,
    });

    const opencode = await mgr.getOrSpawnLane("opencode", "ctx-1");
    const gemini = await mgr.getOrSpawnLane("gemini", "ctx-2");
    expect(opencode).not.toBe(gemini);

    const spawnedEvents = events.filter((e) => e.type === "gateway.harness.child-spawned");
    expect(spawnedEvents).toHaveLength(2);
    const ids = spawnedEvents.map((e) => (e.payload as { harnessId: string }).harnessId).sort();
    expect(ids).toEqual(["gemini", "opencode"]);
  });

  test("getPrimaryHarnessId returns the configured primary entry's id", () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController().controller,
    });
    expect(mgr.getPrimaryHarnessId()).toBe("opencode");
  });

  test("getOrSpawnLane throws on unknown harnessId", async () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController().controller,
    });
    await expect(mgr.getOrSpawnLane("nonexistent", "ctx")).rejects.toThrow(/unknown harnessId/);
  });

  // ---- primary-routing-target switch ----

  test("setPrimaryHarnessId flips primary flag + publishes card-changed for both entries", () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const events: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((e) => events.push(e));

    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController().controller,
    });

    expect(mgr.getPrimaryHarnessId()).toBe("opencode");
    const newEntry = mgr.setPrimaryHarnessId("gemini");
    expect(newEntry.id).toBe("gemini");
    expect(mgr.getPrimaryHarnessId()).toBe("gemini");

    // Card mutated in place: opencode primary false, gemini primary true.
    expect(card.capabilities.harnesses?.find((c) => c.id === "opencode")?.primary).toBe(false);
    expect(card.capabilities.harnesses?.find((c) => c.id === "gemini")?.primary).toBe(true);

    // Two card-changed events, one per affected entry.
    const cardChanged = events.filter((e) => e.type === "gateway.harness.card-changed");
    expect(cardChanged).toHaveLength(2);

    // Verify the diff payloads are faithful (old went true→false, new went false→true).
    const opencodeDiff = cardChanged.find(
      (e) => (e.payload as { harnessId: string }).harnessId === "opencode",
    );
    expect(
      (opencodeDiff?.payload as { previousEntry: HarnessCapabilityEntry }).previousEntry.primary,
    ).toBe(true);
    expect((opencodeDiff?.payload as { newEntry: HarnessCapabilityEntry }).newEntry.primary).toBe(
      false,
    );

    const geminiDiff = cardChanged.find(
      (e) => (e.payload as { harnessId: string }).harnessId === "gemini",
    );
    expect(
      (geminiDiff?.payload as { previousEntry: HarnessCapabilityEntry }).previousEntry.primary,
    ).toBe(false);
    expect((geminiDiff?.payload as { newEntry: HarnessCapabilityEntry }).newEntry.primary).toBe(
      true,
    );
  });

  test("setPrimaryHarnessId is a no-op when target is already primary", () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const events: GatewayBusEvent<unknown>[] = [];
    bus.subscribe((e) => events.push(e));

    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController().controller,
    });

    const entry = mgr.setPrimaryHarnessId("opencode");
    expect(entry.id).toBe("opencode");
    expect(mgr.getPrimaryHarnessId()).toBe("opencode");
    // No card-changed events on no-op.
    expect(events.filter((e) => e.type === "gateway.harness.card-changed")).toHaveLength(0);
  });

  test("setPrimaryHarnessId throws on unknown harnessId", () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController().controller,
    });
    expect(() => mgr.setPrimaryHarnessId("nonexistent")).toThrow(/unknown harnessId/);
    // Primary is unchanged on a failed switch.
    expect(mgr.getPrimaryHarnessId()).toBe("opencode");
  });

  test("setPrimaryHarnessId throws when manager is destroyed", () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController().controller,
    });
    mgr.destroy();
    expect(() => mgr.setPrimaryHarnessId("gemini")).toThrow(/destroyed/);
  });

  test("after primary switch, getOrSpawnLane on the new primary spawns its harness; old primary's existing lanes stay alive", async () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const spawnedHarnesses: string[] = [];
    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async (entry) => {
        spawnedHarnesses.push(entry.id);
        return createMockController({ pid: entry.id === "opencode" ? 100 : 200 }).controller;
      },
    });

    // Spawn one lane on the original primary (opencode).
    const opencodeLane = await mgr.getOrSpawnLane("opencode", "ctx-pre-switch");
    expect(spawnedHarnesses).toEqual(["opencode"]);
    expect(mgr.hasLiveLanesForHarness("opencode")).toBe(true);

    // Flip primary to gemini.
    mgr.setPrimaryHarnessId("gemini");
    expect(mgr.getPrimaryHarnessId()).toBe("gemini");

    // The opencode lane is still alive — primary-target switches do
    // NOT destroy lanes for the previously primary harness.
    expect(mgr.hasLiveLanesForHarness("opencode")).toBe(true);
    expect(opencodeLane).toBeDefined();

    // The next spawn against the new primary spawns gemini's harness.
    await mgr.getOrSpawnLane(mgr.getPrimaryHarnessId(), "ctx-post-switch");
    expect(spawnedHarnesses).toEqual(["opencode", "gemini"]);
    expect(mgr.hasLiveLanesForHarness("gemini")).toBe(true);
  });

  test("hasHarness reflects fleet membership", () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => createMockController().controller,
    });
    expect(mgr.hasHarness("opencode")).toBe(true);
    expect(mgr.hasHarness("gemini")).toBe(true);
    expect(mgr.hasHarness("nonexistent")).toBe(false);
  });

  test("hasLiveLanesForHarness returns false before spawn, true after spawn, false after exit", async () => {
    const bus = createGatewayBus();
    const { entries, card } = buildFleet();
    const mock = createMockController({ pid: 7777 });
    const mgr = new HarnessLaneManager({
      entries,
      gatewayCard: card,
      bus,
      createController: async () => mock.controller,
    });

    expect(mgr.hasLiveLanesForHarness("opencode")).toBe(false);
    await mgr.getOrSpawnLane("opencode", "ctx-1");
    expect(mgr.hasLiveLanesForHarness("opencode")).toBe(true);

    mock.triggerExit({
      pid: 7777,
      exitCode: 0,
      signal: null,
      crash: false,
      durationMs: 1,
    });
    expect(mgr.hasLiveLanesForHarness("opencode")).toBe(false);
  });
});
