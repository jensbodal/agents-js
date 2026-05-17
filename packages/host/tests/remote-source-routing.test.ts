/**
 * Remote-source routing guard-rail — PLACEHOLDER for v2.
 *
 * AJS-23 v1 ships the discriminated-union TYPE
 * (`HarnessCapabilityEntry` with `source: "local" | "remote"`) so that
 * federation peers can already observe the wire shape and downstream
 * code can already narrow on `source`. The host-side dispatch path,
 * however, does NOT yet branch on `source` in v1 — `HarnessLaneManager`
 * unconditionally spawns the ACP child via the injected `createController`
 * factory regardless of whether the fleet entry's backing harness is
 * local or remote.
 *
 * The guard-rail this file pins down — `getOrSpawnLane` MUST refuse to
 * spawn locally when the fleet entry's `source === "remote"` — becomes
 * a real assertion in v2 once the lane manager learns to dispatch to a
 * child gateway instead of running `createController` itself. Today
 * (v1), it is a `test.todo()` so the contract is registered in CI
 * output and any future change to `HarnessFleetEntry` that drops the
 * `source` slot shows up as a stale-todo signal.
 */

import { describe, test } from "bun:test";

describe("HarnessLaneManager — remote source routing (guard-rail)", () => {
  // v2 contract — placeholder. When the lane manager learns to branch
  // on `HarnessFleetEntry.source`, this becomes a real test that
  // constructs a fleet with one `source: "remote"` entry and asserts
  // `getOrSpawnLane(remoteHarnessId, ctx)` rejects (or returns a remote
  // proxy controller) instead of invoking `createController` locally.
  test.todo("getOrSpawnLane refuses to spawn locally when fleet entry has source: 'remote'", () => {});
});
