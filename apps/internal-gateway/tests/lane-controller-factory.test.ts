/**
 * Identity-preservation regression catch for the per-lane controller factory.
 *
 * AJS-7 PR2's multi-harness invariant requires that every lane controller
 * spawned by the composition root reads `permissionEngine` /
 * `permissionStore` from the SAME process-wide `HostSession`. The earlier
 * structural test in `multi-harness-invariants.test.ts` flagged a residual
 * gap: a closure-captured mock factory passes whether or not the
 * production `createController` body forks stores per harness. This test
 * closes that gap by exercising `buildLaneControllerFactory` — the
 * extracted production factory builder — with a stub host-controller
 * constructor that captures the configs it receives.
 */

import { describe, expect, test } from "bun:test";
import type { HostSurfaceAdapter } from "@agents-js/a2ui-host/acp-host";
import type { PermissionEngine, PermissionStore } from "@agents-js/acp-host";
import type { ResolvedGatewayRuntime } from "@agents-js/gateway-runtime";
import type {
  createStandaloneHostController,
  GatewayHostController,
  HarnessFleetEntry,
  HostSession,
} from "@agents-js/host";
import { buildLaneControllerFactory } from "../lane-controller-factory.ts";

function buildMockHostSession(): HostSession {
  return {
    controller: {} as GatewayHostController,
    permissionEngine: { mockEngine: true } as unknown as PermissionEngine,
    permissionStore: { mockStore: true } as unknown as PermissionStore,
    workspacePath: "/tmp/mock-workspace",
    destroy: async () => {},
  } as unknown as HostSession;
}

function buildFleetEntries(): HarnessFleetEntry[] {
  const fakeRuntime = {} as ResolvedGatewayRuntime;
  return [
    { id: "harness-a", displayName: "Harness A", primary: true, runtime: fakeRuntime },
    { id: "harness-b", displayName: "Harness B", primary: false, runtime: fakeRuntime },
  ];
}

describe("buildLaneControllerFactory", () => {
  test("every factory invocation receives the SAME permissionEngine + permissionStore reference", async () => {
    const session = buildMockHostSession();
    const capturedConfigs: Array<Parameters<typeof createStandaloneHostController>[0]> = [];
    const stubCreateController: typeof createStandaloneHostController = async (config) => {
      capturedConfigs.push(config);
      return {} as GatewayHostController;
    };

    const factory = buildLaneControllerFactory({
      session,
      workspacePath: "/tmp/mock-workspace",
      permissionMode: "ask",
      createController: stubCreateController,
    });

    const [a, b] = buildFleetEntries();
    if (!a || !b) throw new Error("fleet entries malformed");
    await factory(a);
    await factory(b);
    await factory(a); // third call same entry to catch caching regressions too

    expect(capturedConfigs).toHaveLength(3);
    // Identity (===) check: all three calls must thread through the same
    // session.permissionStore reference. Reference identity is the load-bearing
    // assertion — value-equality would still pass if a future change
    // accidentally cloned the store per call.
    expect(capturedConfigs[0]?.permissionStore).toBe(session.permissionStore);
    expect(capturedConfigs[1]?.permissionStore).toBe(session.permissionStore);
    expect(capturedConfigs[2]?.permissionStore).toBe(session.permissionStore);

    expect(capturedConfigs[0]?.permissionEngine).toBe(session.permissionEngine);
    expect(capturedConfigs[1]?.permissionEngine).toBe(session.permissionEngine);
    expect(capturedConfigs[2]?.permissionEngine).toBe(session.permissionEngine);
  });

  test("threads per-entry runtime into the host controller config", async () => {
    const session = buildMockHostSession();
    const capturedConfigs: Array<Parameters<typeof createStandaloneHostController>[0]> = [];
    const stubCreateController: typeof createStandaloneHostController = async (config) => {
      capturedConfigs.push(config);
      return {} as GatewayHostController;
    };

    const fleet = buildFleetEntries();
    const factory = buildLaneControllerFactory({
      session,
      workspacePath: "/tmp/mock-workspace",
      permissionMode: "ask",
      createController: stubCreateController,
    });

    for (const entry of fleet) {
      await factory(entry);
    }

    // Each invocation forwards the entry's runtime — fan-out happens at
    // the runtime axis, while permission surface stays shared.
    expect(capturedConfigs).toHaveLength(2);
    expect(capturedConfigs[0]?.runtime).toBe(fleet[0]?.runtime);
    expect(capturedConfigs[1]?.runtime).toBe(fleet[1]?.runtime);
  });

  test("forwards surfaceAdapter when provided; omits the key when undefined", async () => {
    const session = buildMockHostSession();
    const capturedConfigs: Array<Parameters<typeof createStandaloneHostController>[0]> = [];
    const stubCreateController: typeof createStandaloneHostController = async (config) => {
      capturedConfigs.push(config);
      return {} as GatewayHostController;
    };

    const surfaceAdapter = { mockSurface: true } as unknown as HostSurfaceAdapter;
    const fleet = buildFleetEntries();
    const a = fleet[0];
    if (!a) throw new Error("fleet entries malformed");

    const factoryWithSurface = buildLaneControllerFactory({
      session,
      workspacePath: "/tmp/mock-workspace",
      permissionMode: "ask",
      surfaceAdapter,
      createController: stubCreateController,
    });
    await factoryWithSurface(a);
    expect(capturedConfigs[0]?.surfaceAdapter).toBe(surfaceAdapter);

    const factoryWithoutSurface = buildLaneControllerFactory({
      session,
      workspacePath: "/tmp/mock-workspace",
      permissionMode: "ask",
      createController: stubCreateController,
    });
    await factoryWithoutSurface(a);
    expect(capturedConfigs[1]?.surfaceAdapter).toBeUndefined();
  });
});
