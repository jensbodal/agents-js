/**
 * Cancel and reset helpers extracted from ACPSessionController.
 *
 * These functions cancel pending async operations (permissions, elicitations,
 * write gates) and manage the cancel safety timer. They accept state and an
 * emit callback so the session controller delegates without leaking `this`.
 */
import type { ACPSessionEvent, ACPSessionState } from "./types/session.ts";

/**
 * Cancel a pending permission request by resolving it as "cancelled".
 * Emits a `permission_resolved` event if there was a pending request.
 */
export function cancelPendingPermission(
  state: ACPSessionState,
  emit: (event: ACPSessionEvent) => void,
): void {
  const pending = state.currentTurn?.pendingPermission;
  if (pending) {
    pending.resolve({ outcome: { outcome: "cancelled" } });
    if (state.currentTurn) {
      state.currentTurn.pendingPermission = null;
    }
    emit({ type: "permission_resolved", cancelled: true });
  }
}

/**
 * Cancel a pending elicitation request by resolving it with "cancel" action.
 * Emits an `elicitation_resolved` event if there was a pending request.
 */
export function cancelPendingElicitation(
  state: ACPSessionState,
  emit: (event: ACPSessionEvent) => void,
): void {
  const pending = state.pendingElicitation;
  if (pending) {
    pending.resolve({ action: "cancel" });
    state.pendingElicitation = null;
    emit({ type: "elicitation_resolved", action: "cancel" });
  }
}

/**
 * Cancel a pending write-gate request by resolving it as "reject".
 * Emits a `write_gate_resolved` event if there was a pending gate.
 */
export function cancelPendingWriteGate(
  state: ACPSessionState,
  emit: (event: ACPSessionEvent) => void,
): void {
  const pending = state.pendingWriteGate;
  if (pending) {
    pending.resolve({ action: "reject" });
    state.pendingWriteGate = null;
    emit({ type: "write_gate_resolved", approved: false });
  }
}

/**
 * Clear the cancel safety timer, if active.
 * Returns `null` so the caller can assign back: `this.timer = clearCancelSafetyTimer(this.timer)`.
 */
export function clearCancelSafetyTimer(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) {
    clearTimeout(timer);
  }
  return null;
}
