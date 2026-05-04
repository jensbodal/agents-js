import type { AgentRegistryRecord } from "./registry.ts";

/**
 * Per-target health/probe status as seen by a UI client. Discovery
 * implementations can map their own probe results to this triplet:
 * `online` (target responded), `offline` (probe failed), `unknown`
 * (probe not yet attempted or in-flight).
 */
export type TargetReachability = "online" | "offline" | "unknown";

/**
 * Input shape consumed by {@link groupDiscoveredTargets}. Wraps a
 * registry record with the optional probe-derived reachability +
 * error reason. Consumers produce these from `AgentRegistry.list()`
 * results paired with their own probing strategy.
 */
export interface DiscoveredTarget {
  record: AgentRegistryRecord;
  reachability?: TargetReachability;
  /** Optional human-readable error from the most recent probe. */
  errorReason?: string;
}

/**
 * Output of {@link groupDiscoveredTargets} — one bucket per unique
 * agent name. The `preferred` entry is the canonical pick under the
 * configured policy; `alternates` carries the rest of the duplicates
 * (gateway-vs-registry, online-vs-offline, etc.).
 */
export interface DiscoveredTargetGroup {
  /** Common agent name across this bucket. */
  name: string;
  /** The canonical pick under the active policy. */
  preferred: DiscoveredTarget;
  /** Other registry entries with the same name. May be empty. */
  alternates: DiscoveredTarget[];
}

/**
 * Behavior knobs for {@link groupDiscoveredTargets}. All flags default
 * to `false` so the helper is a pass-through unless callers opt in.
 */
export interface GroupDiscoveredTargetsOptions {
  /**
   * When `true`, prefer entries whose `record.name === "gateway"` or
   * whose `record.kind === "a2a"` AND `agent_id` ends in `.gateway`,
   * placing them as `preferred` over same-name peer entries.
   * Default: `false`.
   */
  preferGateway?: boolean;
  /**
   * When `true`, demote entries whose `reachability === "offline"`
   * to `alternates`, keeping an online same-name entry as
   * `preferred` when one exists. Offline entries are still
   * returned (per brief: "Do not remove raw discovery data").
   * Default: `false`.
   */
  demoteOffline?: boolean;
  /**
   * When `true`, completely omit offline entries from the grouped
   * output. Use with care: this hides diagnostic data. Defaults to
   * `false` so consumers maintaining an "advanced view" still see
   * everything.
   * Default: `false`.
   */
  hideOffline?: boolean;
}

/**
 * Group/dedupe a raw list of discovered targets by `name`, picking a
 * canonical `preferred` entry per group under the configured policy.
 *
 * The function is pure and opt-in — passing no `options` (or `{}`)
 * preserves the original ordering inside each bucket: first record
 * wins, rest go to `alternates`. Same-name targets on different ports
 * remain visible (per brief: "Same-name targets on different ports
 * remain distinguishable").
 *
 * Policy rules apply in this order when an option is enabled:
 *
 * 1. `hideOffline` — drop offline entries before grouping
 * 2. `preferGateway` — promote gateway-ish entries within a group
 * 3. `demoteOffline` — demote offline entries within a group
 *
 * Original input order is otherwise preserved as a tiebreaker.
 */
export function groupDiscoveredTargets(
  targets: DiscoveredTarget[],
  options: GroupDiscoveredTargetsOptions = {},
): DiscoveredTargetGroup[] {
  const filtered = options.hideOffline
    ? targets.filter((t) => t.reachability !== "offline")
    : [...targets];

  // Group preserving insertion order via Map (first-seen-name comes first).
  const buckets = new Map<string, DiscoveredTarget[]>();
  for (const target of filtered) {
    const name = target.record.name;
    const bucket = buckets.get(name);
    if (bucket) {
      bucket.push(target);
    } else {
      buckets.set(name, [target]);
    }
  }

  const groups: DiscoveredTargetGroup[] = [];
  for (const [name, members] of buckets) {
    const ordered = orderMembers(members, options);
    const [preferred, ...alternates] = ordered;
    if (!preferred) {
      // Defensive: groupings should always have ≥1 member because the
      // map only stores non-empty buckets.
      continue;
    }
    groups.push({ name, preferred, alternates });
  }

  return groups;
}

/**
 * Sort a same-name bucket so the canonical `preferred` entry is first.
 * The caller drops the head as `preferred` and keeps the tail as
 * `alternates`, so this is just a stable promotion sort.
 */
function orderMembers(
  members: DiscoveredTarget[],
  options: GroupDiscoveredTargetsOptions,
): DiscoveredTarget[] {
  // Score lower = more-preferred. Stable sort preserves original order
  // among entries with equal scores.
  const scored = members.map((target, index) => ({
    target,
    index,
    score: scoreTarget(target, options),
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score;
    }
    return a.index - b.index;
  });
  return scored.map((s) => s.target);
}

function scoreTarget(target: DiscoveredTarget, options: GroupDiscoveredTargetsOptions): number {
  let score = 0;
  if (options.preferGateway && isGatewayLike(target.record)) {
    score -= 100;
  }
  if (options.demoteOffline && target.reachability === "offline") {
    score += 50;
  }
  return score;
}

function isGatewayLike(record: AgentRegistryRecord): boolean {
  if (record.name === "gateway") {
    return true;
  }
  if (record.kind === "a2a" && record.agent_id?.endsWith(".gateway")) {
    return true;
  }
  return false;
}
