/**
 * Subscription, event emission, and readiness-wait utilities for
 * ACPSessionController.
 */
import type { Logger } from "./logger.ts";
import type { ACPSessionEvent, ACPSessionState } from "./types/session.ts";

export type Listener = (event: ACPSessionEvent, state: ACPSessionState) => void;

/**
 * Emit an event to all registered listeners.
 * Individual listener errors are caught and logged so one bad listener
 * does not break others.
 */
export function emitEvent(
  listeners: Set<Listener>,
  event: ACPSessionEvent,
  state: ACPSessionState,
  log: Logger,
): void {
  for (const listener of listeners) {
    try {
      listener(event, state);
    } catch (err) {
      log.error("Listener error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Returns a promise that resolves when the session status becomes "ready",
 * or rejects after the given timeout.
 */
export function waitForReady(
  state: ACPSessionState,
  subscribe: (listener: Listener) => () => void,
  timeoutMs: number,
): Promise<void> {
  if (state.status === "ready") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`steer(): timed out waiting for ready, status is "${state.status}"`));
    }, timeoutMs);
    const unsub = subscribe((event) => {
      if (event.type === "status_changed" && state.status === "ready") {
        clearTimeout(timer);
        unsub();
        resolve();
      }
    });
  });
}
