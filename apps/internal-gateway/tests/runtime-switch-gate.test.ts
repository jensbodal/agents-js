import { describe, expect, test } from "bun:test";
import { describeRuntimeSwitchBlockingActivity } from "../main.ts";

/**
 * Pure check that decides whether the gateway should reject a runtime
 * switch. Without this gate, `setRuntime` would call
 * `session.switchRuntime()` while AG-UI/A2A/lane work is in flight,
 * cutting turns mid-stream or leaving lane controllers bound to the
 * outgoing runtime.
 *
 * Cover every blocking branch + the idle case so future regressions
 * (e.g. someone forgets to count active dispatches) fail loudly.
 */

interface ActivitySnapshot {
  activeTaskCount: number;
  activeDispatchCount: number;
  activeLaneCount: number;
  inFlightLaneCount: number;
  pendingLaneCount: number;
}

function makeExecutorStub(snapshot: ActivitySnapshot) {
  return { getActivitySnapshot: () => snapshot };
}

function makeAguiCoordStub(args: { isActive: boolean; activeRunId: string | null }) {
  return { isActive: args.isActive, activeRunId: args.activeRunId };
}

const IDLE_SNAPSHOT: ActivitySnapshot = {
  activeTaskCount: 0,
  activeDispatchCount: 0,
  activeLaneCount: 0,
  inFlightLaneCount: 0,
  pendingLaneCount: 0,
};

describe("describeRuntimeSwitchBlockingActivity", () => {
  test("idle gateway → switch allowed (returns null)", () => {
    expect(
      describeRuntimeSwitchBlockingActivity({
        executor: makeExecutorStub(IDLE_SNAPSHOT),
        aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
      }),
    ).toBeNull();
  });

  test("AG-UI run in flight → switch rejected with runId", () => {
    const reason = describeRuntimeSwitchBlockingActivity({
      executor: makeExecutorStub(IDLE_SNAPSHOT),
      aguiCoordinator: makeAguiCoordStub({ isActive: true, activeRunId: "run-abc" }),
    });
    expect(reason).not.toBeNull();
    expect(reason).toContain("AG-UI");
    expect(reason).toContain("run-abc");
  });

  test("@@dispatch in flight → switch rejected (priority over plain A2A task count)", () => {
    const reason = describeRuntimeSwitchBlockingActivity({
      executor: makeExecutorStub({
        ...IDLE_SNAPSHOT,
        activeTaskCount: 5,
        activeDispatchCount: 2,
      }),
      aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
    });
    expect(reason).toContain("@@dispatch");
    expect(reason).toContain("2");
  });

  test("A2A tasks in flight → switch rejected with count", () => {
    const reason = describeRuntimeSwitchBlockingActivity({
      executor: makeExecutorStub({ ...IDLE_SNAPSHOT, activeTaskCount: 3 }),
      aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
    });
    expect(reason).toContain("A2A task");
    expect(reason).toContain("3");
  });

  test("lane holding in-flight prompt → switch rejected", () => {
    // activeTaskCount could be 0 transiently (the task is registered
    // and removed quickly, but the lane's mutex is held longer).
    const reason = describeRuntimeSwitchBlockingActivity({
      executor: makeExecutorStub({ ...IDLE_SNAPSHOT, inFlightLaneCount: 1 }),
      aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
    });
    expect(reason).toContain("lane");
  });

  test("pending lane construction (controllerFactory in flight) blocks the switch", () => {
    // TOCTOU close: a factory call is awaiting; the lane has not
    // yet been registered. Without this guard the switch would
    // proceed and the freshly-spawned controller would be bound
    // to the wrong runtime.
    const reason = describeRuntimeSwitchBlockingActivity({
      executor: makeExecutorStub({ ...IDLE_SNAPSHOT, pendingLaneCount: 2 }),
      aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
    });
    expect(reason).toContain("currently being constructed");
    expect(reason).toContain("2");
  });

  test("idle lane (factory-spawned, no in-flight prompt) does NOT block — eviction handles it", () => {
    // activeLaneCount > 0 but inFlightLaneCount === 0 means the lanes
    // are warm but doing nothing. Switch should proceed; the caller
    // is expected to call destroyIdleLanes() after switchRuntime.
    expect(
      describeRuntimeSwitchBlockingActivity({
        executor: makeExecutorStub({ ...IDLE_SNAPSHOT, activeLaneCount: 4 }),
        aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
      }),
    ).toBeNull();
  });

  test("AG-UI active wins over executor activity in the message ordering", () => {
    const reason = describeRuntimeSwitchBlockingActivity({
      executor: makeExecutorStub({
        ...IDLE_SNAPSHOT,
        activeTaskCount: 9,
        activeDispatchCount: 9,
      }),
      aguiCoordinator: makeAguiCoordStub({ isActive: true, activeRunId: "run-1" }),
    });
    expect(reason).toContain("AG-UI");
    expect(reason).not.toContain("@@dispatch");
  });
});
