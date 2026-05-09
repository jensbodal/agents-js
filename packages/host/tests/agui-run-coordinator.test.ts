import { describe, expect, test } from "bun:test";
import { AguiRunBusyError, AguiRunCoordinator } from "../src/agui-run-coordinator.ts";

/**
 * The coordinator is the gate between AG-UI's `POST /agent` and the
 * shared primary controller. It must:
 *
 *   1. Reject the second concurrent acquire with a typed error so the
 *      endpoint can map it to HTTP 409 *before* opening the SSE stream.
 *   2. Free the slot on release so the next acquire succeeds.
 *   3. Be idempotent on release — the endpoint releases in both the
 *      stream's `start()` finally and its `cancel()` handler, and a
 *      double release must not corrupt state.
 *   4. Not let a stale release wipe the next active run's slot
 *      (acquire/release/acquire happens in tight loops in tests).
 */
describe("AguiRunCoordinator", () => {
  test("acquire returns a lease when idle", () => {
    const coord = new AguiRunCoordinator();
    expect(coord.isActive).toBe(false);

    const lease = coord.acquire("run-1");
    expect(lease.runId).toBe("run-1");
    expect(coord.isActive).toBe(true);
    expect(coord.activeRunId).toBe("run-1");
  });

  test("second concurrent acquire throws AguiRunBusyError exposing the active runId", () => {
    const coord = new AguiRunCoordinator();
    coord.acquire("run-1");

    expect(() => coord.acquire("run-2")).toThrow(AguiRunBusyError);
    try {
      coord.acquire("run-2");
    } catch (err) {
      expect(err).toBeInstanceOf(AguiRunBusyError);
      expect((err as AguiRunBusyError).activeRunId).toBe("run-1");
    }
  });

  test("release frees the slot for the next acquire", () => {
    const coord = new AguiRunCoordinator();
    const lease = coord.acquire("run-1");
    lease.release();

    expect(coord.isActive).toBe(false);
    const next = coord.acquire("run-2");
    expect(next.runId).toBe("run-2");
  });

  test("release is idempotent — second release on the same lease is a no-op", () => {
    const coord = new AguiRunCoordinator();
    const lease = coord.acquire("run-1");
    lease.release();
    lease.release(); // must not throw, must not affect future state
    expect(coord.isActive).toBe(false);

    const next = coord.acquire("run-2");
    lease.release(); // stale release of the OLD lease
    // The stale release must NOT have wiped the new active slot.
    expect(coord.isActive).toBe(true);
    expect(coord.activeRunId).toBe("run-2");
    next.release();
  });

  test("activeRunId is null when idle", () => {
    const coord = new AguiRunCoordinator();
    expect(coord.activeRunId).toBeNull();
  });
});
