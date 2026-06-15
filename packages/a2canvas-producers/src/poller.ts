/**
 * A2Canvas poller (M0) — the I/O layer that drives the pure mappers and calls
 * the board-host `ingest` seam.
 *
 * Per the (a)-split with ajs-claude:
 *   poller (this) -> matrixEventToUpdate | planeWorkItemToUpdate -> boardHost.ingest(update)
 * The board state, ordering, and change-notification are owned host-side
 * (`createA2CanvasBoardHost` in @agents-js/a2canvas). This layer owns ONLY:
 *   - source I/O (injected — no hard-coded transport here, stays testable)
 *   - de-duplication (Matrix: by event_id; Plane: by state-transition detection)
 *   - mapping via the pure producers
 *
 * The real Matrix/Plane fetchers are injected so the loop logic is unit-testable
 * without a network and so credentials/endpoints live in the caller, not here.
 */

import type { A2CanvasAgentUpdate } from "@agents-js/a2canvas";
import {
  type MatrixProducerOptions,
  type MatrixRoomEvent,
  matrixEventToUpdate,
  type PlaneProducerOptions,
  planeWorkItemToUpdate,
} from "./index.ts";

/** A current-state snapshot of a Plane work item (what `fetchPlaneItems` returns). */
export interface PlaneIssueSnapshot {
  readonly sequenceId: number;
  readonly projectIdentifier: string;
  readonly issueName: string;
  /** Current state name (e.g. "In Progress"). */
  readonly stateName: string;
  readonly actor: string;
  readonly actorKind?: "agent" | "human";
  /** ISO-8601 last-updated; used as the card ts on a transition. */
  readonly updatedAt: string;
  readonly issueUrl: string;
}

export interface PollerDeps {
  /** Fetch recent Matrix room events (e.g. read-matrix --json rows). */
  readonly fetchMatrixEvents: () => Promise<readonly MatrixRoomEvent[]>;
  /** Fetch current Plane work-item snapshots. */
  readonly fetchPlaneItems: () => Promise<readonly PlaneIssueSnapshot[]>;
  /** The board-host sink: `createA2CanvasBoardHost().ingest`. */
  readonly ingest: (ev: A2CanvasAgentUpdate) => void;
  readonly matrixOpts?: MatrixProducerOptions;
  readonly planeOpts?: PlaneProducerOptions;
}

export interface Poller {
  /** Run one poll pass across both sources. Returns the number of updates ingested. */
  pollOnce: () => Promise<number>;
  /** Start polling every `intervalMs`. Returns a stop function. */
  start: (intervalMs: number) => () => void;
}

/**
 * Build a poller. Pure de-dup/transition state is held in the closure:
 *   - Matrix: a new event_id is ingested exactly once.
 *   - Plane: an item is ingested only when its state CHANGES (first sighting is
 *     recorded silently — avoids flooding the board with every backlog item at
 *     startup; the Matrix producer carries the continuous live demo content).
 */
export function createPoller(deps: PollerDeps): Poller {
  const seenMatrix = new Set<string>();
  const lastPlaneState = new Map<string, string>();

  async function pollOnce(): Promise<number> {
    let count = 0;

    for (const ev of await deps.fetchMatrixEvents()) {
      if (seenMatrix.has(ev.event_id)) continue;
      seenMatrix.add(ev.event_id);
      deps.ingest(matrixEventToUpdate(ev, deps.matrixOpts));
      count++;
    }

    for (const it of await deps.fetchPlaneItems()) {
      const key = `${it.projectIdentifier}-${it.sequenceId}`;
      const prev = lastPlaneState.get(key);
      if (prev === it.stateName) continue; // no change
      lastPlaneState.set(key, it.stateName);
      if (prev === undefined) continue; // first sighting: record only, don't flood
      deps.ingest(
        planeWorkItemToUpdate(
          {
            sequenceId: it.sequenceId,
            projectIdentifier: it.projectIdentifier,
            issueName: it.issueName,
            actor: it.actor,
            actorKind: it.actorKind,
            fromState: prev,
            toState: it.stateName,
            createdAt: it.updatedAt,
            issueUrl: it.issueUrl,
          },
          deps.planeOpts,
        ),
      );
      count++;
    }

    return count;
  }

  function start(intervalMs: number): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        await pollOnce();
      } catch {
        // swallow a transient source error; next tick retries
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  return { pollOnce, start };
}
