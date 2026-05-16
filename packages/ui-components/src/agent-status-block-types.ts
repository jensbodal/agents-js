/**
 * Pass-through shape for one row inside a `StatusSnapshot.agents[]` payload
 * served over the network by a status endpoint. Only `name`, `mxid`, and
 * `online` are required; the producer may omit any of the remaining fields
 * when a fresh reading wasn't available at snapshot time.
 *
 * Declared inline (rather than imported from a shared schema package) so
 * the consumer's pass-through discipline surfaces any producer-side
 * drift as a compile error on the consumer.
 */
export interface StatusSnapshotAgent {
  name: string;
  mxid: string;
  online: boolean;
  tmux_session?: string;
  harness?: string;
  workspace?: string;
  transport?: string;
  pane_state?: string;
  pane_detail?: string;
  activity_age_seconds?: number;
  deferred_messages?: number;
  gateway_url?: string;
  gateway_healthy?: boolean;
}

/**
 * Four bucketed visual states the block renders distinct affordances for.
 * Bucketing is intentional: hosts that want a finer scale derive their own
 * from `activity_age_seconds` directly without re-running this function.
 */
export type AgentVisualState = "online-active" | "online-idle" | "offline-recent" | "offline-stale";

export interface DerivedAgentVisual {
  state: AgentVisualState;
  stateLabel: string;
  activityLabel: string;
}

export interface DeriveAgentVisualOptions {
  /**
   * Seconds since last activity below which an online agent is "active".
   * Default 300s = 5 min, matching the Matrix presence convention.
   */
  activeThresholdSeconds?: number;
  /**
   * Seconds since last activity above which an offline agent is "stale"
   * (likely abandoned or crashed, not just briefly disconnected). Default
   * 3600s = 1 hour.
   */
  staleThresholdSeconds?: number;
}

const DEFAULT_ACTIVE_THRESHOLD_SECONDS = 300;
const DEFAULT_STALE_THRESHOLD_SECONDS = 3600;

/**
 * Bucket one agent's raw `StatusSnapshotAgent` into a visual state plus a
 * short human-readable activity label. Pure function, no side effects, no
 * DOM access — usable from non-component contexts (CLI status table,
 * Slack/Matrix summary, etc.).
 */
export function deriveAgentVisualState(
  agent: Pick<StatusSnapshotAgent, "online" | "activity_age_seconds">,
  options?: DeriveAgentVisualOptions,
): DerivedAgentVisual {
  const activeT = options?.activeThresholdSeconds ?? DEFAULT_ACTIVE_THRESHOLD_SECONDS;
  const staleT = options?.staleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_SECONDS;
  const age = agent.activity_age_seconds;

  let state: AgentVisualState;
  if (agent.online) {
    state = age !== undefined && age < activeT ? "online-active" : "online-idle";
  } else {
    state = age !== undefined && age < staleT ? "offline-recent" : "offline-stale";
  }

  return {
    state,
    stateLabel: visualStateLabel(state),
    activityLabel: formatActivityAge(age),
  };
}

function visualStateLabel(state: AgentVisualState): string {
  switch (state) {
    case "online-active":
      return "Active";
    case "online-idle":
      return "Idle";
    case "offline-recent":
      return "Offline";
    case "offline-stale":
      return "Offline · stale";
  }
}

/**
 * Format an activity age (seconds) as a compact "Ns ago" / "Nm ago" /
 * "Nh ago" / "Nd ago" string. Returns "unknown" when the age is absent,
 * which is the upstream signal that the status provider had no reading.
 */
export function formatActivityAge(seconds: number | undefined): string {
  if (seconds === undefined) return "unknown";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
