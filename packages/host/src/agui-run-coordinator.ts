/**
 * In-process AG-UI run coordinator.
 *
 * For restricted-beta AG-UI is the primary browser/operator run surface
 * but does not yet have per-thread lane isolation (see
 * `release-readiness-agui-primary-plan.md` §31). The coordinator
 * enforces single-active-run behavior against the shared primary
 * controller: a second `POST /agent` while a run is in flight is
 * rejected with a clear busy response instead of being multiplexed
 * onto the same controller.
 *
 * Why this is a separate module: the AG-UI endpoint (HTTP routing,
 * SSE framing) and the AG-UI run session (subscription + translation)
 * are already two coherent concerns. The "is anything running" gate
 * has its own lifecycle (acquire / release, error fan-out) and
 * deserves a small dedicated home — that also makes the gate testable
 * without standing up an HTTP server.
 *
 * The coordinator is intentionally scoped to a *single* gateway host
 * controller. If we ever ship per-thread AG-UI lanes, each lane will
 * own its own coordinator instance.
 */

/**
 * Thrown by {@link AguiRunCoordinator.acquire} when a run is already
 * active. Endpoint code maps this to HTTP 409 (Conflict) before
 * opening the SSE stream.
 */
export class AguiRunBusyError extends Error {
  /** RunId of the active run that is blocking this acquire attempt. */
  readonly activeRunId: string;
  constructor(activeRunId: string) {
    super(`AG-UI run coordinator busy (active runId=${activeRunId})`);
    this.name = "AguiRunBusyError";
    this.activeRunId = activeRunId;
  }
}

/**
 * Lease handle returned by {@link AguiRunCoordinator.acquire}.
 *
 * `release()` is idempotent so callers can wire it into both the
 * happy-path `finally` and a separate abort-cancellation handler
 * without worrying about double-release.
 */
export interface AguiRunLease {
  runId: string;
  release(): void;
}

/**
 * Single-active-run coordinator for the shared primary controller.
 *
 * Concurrency model: AG-UI run-session work runs in the JavaScript
 * event loop (no shared-memory concurrency to worry about), so the
 * "in-flight" state is a simple nullable cell rather than an atomic.
 * `acquire` is synchronous and either returns a lease or throws.
 */
export class AguiRunCoordinator {
  private active: { runId: string } | null = null;

  /**
   * Try to acquire the run slot. Throws {@link AguiRunBusyError}
   * synchronously when another run is already active — the endpoint
   * relies on this to short-circuit *before* opening the SSE stream so
   * the busy response is a plain JSON 409, not an SSE error frame.
   */
  acquire(runId: string): AguiRunLease {
    if (this.active !== null) {
      throw new AguiRunBusyError(this.active.runId);
    }
    this.active = { runId };
    let released = false;
    return {
      runId,
      release: () => {
        if (released) return;
        released = true;
        // Defensive: only clear if the active runId still matches.
        // A stale release after a rapid acquire/release/acquire would
        // otherwise wipe the next run's slot.
        if (this.active?.runId === runId) {
          this.active = null;
        }
      },
    };
  }

  /** True iff a run is currently in flight. */
  get isActive(): boolean {
    return this.active !== null;
  }

  /** RunId of the active run, or `null` if idle. */
  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }
}
