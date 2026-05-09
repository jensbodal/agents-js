import type { A2ASessionState, SessionStatusAction, SessionStatusViewModel } from "./types.ts";

/**
 * Map an {@link A2ASessionState} to a polished, protocol-neutral
 * {@link SessionStatusViewModel} suitable for rendering in UI clients
 * (Raycast, web-ui, Obsidian plugin, terminal CLIs, etc.).
 *
 * Discriminator priority — `taskState` takes precedence over `status` because
 * `status` is a lower-resolution session axis that flips to "connected" once
 * any agent text arrives, even when the underlying task is still suspended:
 *
 * 1. `state.lastError` set → error severity (auth-fail / send-fail copy)
 * 2. `taskState === "input-required"` → actionable, primary "Provide input"
 * 3. `taskState === "auth-required"` → actionable, primary "Authenticate"
 * 4. `taskState === "failed"` → error severity, terminal
 * 5. `taskState === "canceled"` → info severity, terminal
 * 6. `taskState === "completed"` → info severity, terminal "Completed"
 * 7. `status === "sending"` / `"waiting"` / `"connecting"` → busy
 * 8. otherwise → idle/connected → "Ready"
 *
 * The function is pure: same input → same output. Consumers can override
 * the `label` of any action without forking the helper because the action
 * descriptor is discriminated by `kind`.
 */
export function describeSessionStatus(state: A2ASessionState): SessionStatusViewModel {
  // Error path — distinct from auth/input failure because lastError is the
  // SDK error channel, not a protocol-level state. We surface it here so
  // consumers can render "Send failed" / "Cancel failed" without inspecting
  // the event stream.
  if (state.lastError) {
    return {
      label: "Error",
      helperText: state.lastError,
      severity: "error",
      busy: false,
      terminal: false,
      recoverable: true,
      primaryAction: { kind: "retry", label: "Retry" },
      secondaryAction: { kind: "reset", label: "Reset" },
    };
  }

  // Protocol-level state takes priority over the lower-resolution `status`
  // field. See module doc for rationale.
  switch (state.taskState) {
    case "input-required":
      return {
        label: "Awaiting input",
        helperText: state.activeElicitation?.message,
        severity: "actionable",
        busy: false,
        terminal: false,
        recoverable: true,
        primaryAction: { kind: "respond_input", label: "Provide input" },
        secondaryAction: { kind: "cancel", label: "Cancel" },
      };
    case "auth-required":
      return {
        label: "Authentication required",
        helperText: state.activeAuth?.message,
        severity: "actionable",
        busy: false,
        terminal: false,
        recoverable: true,
        primaryAction: { kind: "respond_auth", label: "Authenticate" },
        secondaryAction: { kind: "cancel", label: "Cancel" },
      };
    case "failed":
      return {
        label: "Failed",
        severity: "error",
        busy: false,
        terminal: true,
        recoverable: true,
        primaryAction: { kind: "retry", label: "Retry" },
      };
    case "canceled":
      return {
        label: "Canceled",
        severity: "info",
        busy: false,
        terminal: true,
        recoverable: true,
        primaryAction: { kind: "retry", label: "Retry" },
      };
    case "rejected":
      return {
        label: "Rejected",
        severity: "error",
        busy: false,
        terminal: true,
        recoverable: false,
      };
    case "completed":
      return {
        label: "Completed",
        severity: "info",
        busy: false,
        terminal: true,
        recoverable: false,
      };
  }

  // Session-status axis (only consulted when taskState didn't decide).
  switch (state.status) {
    case "sending":
      return {
        label: "Sending",
        severity: "busy",
        busy: true,
        terminal: false,
        recoverable: false,
        primaryAction: { kind: "cancel", label: "Cancel" },
      };
    case "waiting":
      return {
        label: "Working…",
        severity: "busy",
        busy: true,
        terminal: false,
        recoverable: false,
        primaryAction: { kind: "cancel", label: "Cancel" },
      };
    case "connecting":
      return {
        label: "Connecting",
        severity: "busy",
        busy: true,
        terminal: false,
        recoverable: false,
      };
    case "connected":
      return {
        label: "Ready",
        severity: "info",
        busy: false,
        terminal: false,
        recoverable: false,
      };
    case "idle":
      return {
        label: "Idle",
        severity: "info",
        busy: false,
        terminal: false,
        recoverable: false,
      };
    case "input_required":
      // Defensive: status said input_required but taskState didn't (rare).
      // Treat the same as taskState === "input-required".
      return {
        label: "Awaiting input",
        helperText: state.activeElicitation?.message,
        severity: "actionable",
        busy: false,
        terminal: false,
        recoverable: true,
        primaryAction: { kind: "respond_input", label: "Provide input" },
        secondaryAction: { kind: "cancel", label: "Cancel" },
      };
    case "auth_required":
      return {
        label: "Authentication required",
        helperText: state.activeAuth?.message,
        severity: "actionable",
        busy: false,
        terminal: false,
        recoverable: true,
        primaryAction: { kind: "respond_auth", label: "Authenticate" },
        secondaryAction: { kind: "cancel", label: "Cancel" },
      };
    case "completed":
      return {
        label: "Completed",
        severity: "info",
        busy: false,
        terminal: true,
        recoverable: false,
      };
    case "error":
      return {
        label: "Error",
        helperText: state.lastError,
        severity: "error",
        busy: false,
        terminal: false,
        recoverable: true,
        primaryAction: { kind: "retry", label: "Retry" },
      };
  }
}

/** Re-export for convenience — consumers can override action labels. */
export type { SessionStatusAction, SessionStatusViewModel };
