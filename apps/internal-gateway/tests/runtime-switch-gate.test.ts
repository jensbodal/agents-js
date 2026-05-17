import { describe, expect, test } from "bun:test";
import { describeRuntimeSwitchBlockingActivity } from "../main.ts";

/**
 * Scoped-down primary-switch semantics: the gate only blocks on
 * AG-UI runs. Cross-harness in-flight A2A tasks / dispatch / lanes / pending
 * spawns no longer block a primary-routing-target switch — those
 * sessions stay bound to their original harness's controller, so the
 * switch has no conflict with them.
 *
 * AG-UI remains a blocker because it's a multi-prompt coordinated flow:
 * switching primary mid-run would route the next prompt to the new
 * primary while the prior prompts ran on the old, which is a UX
 * footgun (operator UI shows one runtime but the run is on another).
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

const BUSY_SNAPSHOT: ActivitySnapshot = {
  activeTaskCount: 5,
  activeDispatchCount: 2,
  activeLaneCount: 4,
  inFlightLaneCount: 3,
  pendingLaneCount: 1,
};

describe("describeRuntimeSwitchBlockingActivity (scoped-down per primary-flip semantics)", () => {
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

  test("A2A tasks in flight do NOT block a primary-target switch", () => {
    // Existing in-flight A2A tasks stay bound to their original
    // harness's controller; the primary flip only affects future
    // sessions, so no conflict.
    expect(
      describeRuntimeSwitchBlockingActivity({
        executor: makeExecutorStub({ ...IDLE_SNAPSHOT, activeTaskCount: 3 }),
        aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
      }),
    ).toBeNull();
  });

  test("@@dispatch in flight does NOT block (bound to original harness)", () => {
    expect(
      describeRuntimeSwitchBlockingActivity({
        executor: makeExecutorStub({ ...IDLE_SNAPSHOT, activeDispatchCount: 2 }),
        aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
      }),
    ).toBeNull();
  });

  test("in-flight A2A lanes do NOT block (bound to original harness)", () => {
    expect(
      describeRuntimeSwitchBlockingActivity({
        executor: makeExecutorStub({ ...IDLE_SNAPSHOT, inFlightLaneCount: 1 }),
        aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
      }),
    ).toBeNull();
  });

  test("pending lane construction does NOT block", () => {
    // The lane manager spawn is bound to the harnessId the call was
    // made under, not to a global primary cell; an in-flight spawn
    // resolves to its original target regardless of who's primary at
    // the moment. (Past TOCTOU concern: a factory call mid-flight
    // resolving to the wrong runtime — closed by per-call binding.)
    expect(
      describeRuntimeSwitchBlockingActivity({
        executor: makeExecutorStub({ ...IDLE_SNAPSHOT, pendingLaneCount: 2 }),
        aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
      }),
    ).toBeNull();
  });

  test("idle lanes do NOT block", () => {
    expect(
      describeRuntimeSwitchBlockingActivity({
        executor: makeExecutorStub({ ...IDLE_SNAPSHOT, activeLaneCount: 4 }),
        aguiCoordinator: makeAguiCoordStub({ isActive: false, activeRunId: null }),
      }),
    ).toBeNull();
  });

  test("AG-UI active wins over busy executor (only blocker that survives scoping-down)", () => {
    const reason = describeRuntimeSwitchBlockingActivity({
      executor: makeExecutorStub(BUSY_SNAPSHOT),
      aguiCoordinator: makeAguiCoordStub({ isActive: true, activeRunId: "run-1" }),
    });
    expect(reason).toContain("AG-UI");
    expect(reason).toContain("run-1");
  });

  test("AG-UI active with unknown runId → reason still produces a usable message", () => {
    const reason = describeRuntimeSwitchBlockingActivity({
      executor: makeExecutorStub(IDLE_SNAPSHOT),
      aguiCoordinator: makeAguiCoordStub({ isActive: true, activeRunId: null }),
    });
    expect(reason).toContain("AG-UI");
    expect(reason).toContain("(unknown)");
  });
});
