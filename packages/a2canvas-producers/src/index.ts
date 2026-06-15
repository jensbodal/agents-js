/**
 * A2Canvas producers (M0) — pure mappers from real agent activity to
 * `A2CanvasAgentUpdate` events.
 *
 * Transport split (ratified with ajs-claude, option (a)):
 *   - THIS module: pure `(sourceEvent) => A2CanvasAgentUpdate` mappers + (later)
 *     a poller. No reducer, no transport, no I/O in the mappers.
 *   - The gateway board loop (ajs's side) mounts them:
 *       poll -> mapper -> applyA2CanvasUpdate -> toA2CanvasView -> /events SSE.
 *     The reducer stays the single writer; producers never touch the board.
 *
 * Identity honesty (M0, pre-verifier):
 *   - Every produced update is `signed:false` / `assertedVia:"none"` — there is
 *     no JWT verifier yet, so the card MUST render 'unverified'. We never assert
 *     a trusted identity from a self-reported Matrix sender / Plane actor.
 *   - `host` is resolved from an INJECTED authoritative roster, never inferred
 *     from an agent-name prefix. Unknown -> "unknown" (honest), not a guess.
 *   - `next.actions[].ref` is always a policy-governed reference (a Matrix
 *     permalink or a Plane issue URL) — never an embedded credential/capability.
 */

import type { A2CanvasAgentUpdate } from "@agents-js/a2canvas";

export {
  createPoller,
  type PlaneIssueSnapshot,
  type Poller,
  type PollerDeps,
} from "./poller.ts";

/** Injected, authoritative principal-id -> host map. Missing => "unknown". */
export type HostRoster = Readonly<Record<string, string>>;

const UNKNOWN_HOST = "unknown";

/** Resolve a host for a principal from the injected roster; honest "unknown" otherwise. */
function resolveHost(principalId: string, roster?: HostRoster): string {
  return roster?.[principalId] ?? UNKNOWN_HOST;
}

/** Trim a free-text body to a single-line card summary. */
function summarize(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// Producer 1 — Matrix coordination-room activity
// ---------------------------------------------------------------------------

/** A normalized Matrix room event (shape of `read-matrix.py --json` rows). */
export interface MatrixRoomEvent {
  readonly event_id: string;
  /** Shortname ("cognee-claude") or full MXID ("@cognee-claude:server"). */
  readonly sender: string;
  /** ISO-8601 timestamp, e.g. "2026-06-15T14:55:30Z". */
  readonly timestamp: string;
  readonly body: string;
}

export interface MatrixProducerOptions {
  /** Authoritative principal-id -> host map (injected by the mount/poller). */
  readonly roster?: HostRoster;
  /** Matrix room id, used to build a matrix.to permalink for next.actions. */
  readonly roomId?: string;
  /** Homeserver used to reconstruct an mxid when sender is a shortname. */
  readonly homeserver?: string;
}

/** Split a sender into (shortname, mxid?) whether given a shortname or a full MXID. */
function parseSender(sender: string, homeserver?: string): { shortname: string; mxid?: string } {
  if (sender.startsWith("@")) {
    const shortname = sender.slice(1).split(":")[0] ?? sender;
    return { shortname, mxid: sender };
  }
  return { shortname: sender, mxid: homeserver ? `@${sender}:${homeserver}` : undefined };
}

/**
 * Pure mapper: a Matrix room event -> an `agent.update`.
 * Deterministic given its input (timestamp parsed, no clock read).
 */
export function matrixEventToUpdate(
  ev: MatrixRoomEvent,
  opts: MatrixProducerOptions = {},
): A2CanvasAgentUpdate {
  const { shortname, mxid } = parseSender(ev.sender, opts.homeserver);
  const principalId = `agent:${shortname}`;
  const ts = Date.parse(ev.timestamp);
  const actions =
    opts.roomId !== undefined
      ? [{ label: "open in Matrix", ref: `https://matrix.to/#/${opts.roomId}/${ev.event_id}` }]
      : [];
  return {
    kind: "agent.update",
    principal: { id: principalId, signed: false, ...(mxid ? { mxid } : {}) },
    host: resolveHost(principalId, opts.roster),
    task: { label: "matrix room activity" },
    authority: { scopes: [], assertedVia: "none" },
    change: { kind: "message", summary: summarize(ev.body) },
    ...(actions.length ? { next: { actions } } : {}),
    ts,
    correlationId: ev.event_id,
  };
}

// ---------------------------------------------------------------------------
// Producer 2 — Plane work-item state activity
// ---------------------------------------------------------------------------

/**
 * A normalized Plane work-item state transition (assembled by the poller from the
 * REST `/activities/` + issue records — field="state" rows).
 */
export interface PlaneWorkItemUpdate {
  /** Plane issue sequence id (the number in "DOT-533"). */
  readonly sequenceId: number;
  /** Project identifier prefix, e.g. "DOT" / "AJS". */
  readonly projectIdentifier: string;
  readonly issueName: string;
  /** Actor display name / agent name who made the change. */
  readonly actor: string;
  /** Whether the actor is one of our agents or a human. Defaults to agent. */
  readonly actorKind?: "agent" | "human";
  /** Previous state name (omitted on first assignment). */
  readonly fromState?: string;
  readonly toState: string;
  /** ISO-8601 created_at of the activity row. */
  readonly createdAt: string;
  /** Policy-governed reference: the Plane issue URL. */
  readonly issueUrl: string;
}

export interface PlaneProducerOptions {
  readonly roster?: HostRoster;
}

/** Lowercase + dash a free-text actor into a principal slug. */
function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pure mapper: a Plane work-item state transition -> an `agent.update`.
 * Carries the task id (DOT-###) and the issue URL as a policy-governed ref.
 */
export function planeWorkItemToUpdate(
  wi: PlaneWorkItemUpdate,
  opts: PlaneProducerOptions = {},
): A2CanvasAgentUpdate {
  const taskId = `${wi.projectIdentifier}-${wi.sequenceId}`;
  const principalId = `${wi.actorKind === "human" ? "human" : "agent"}:${slug(wi.actor)}`;
  const ts = Date.parse(wi.createdAt);
  return {
    kind: "agent.update",
    principal: { id: principalId, signed: false },
    host: resolveHost(principalId, opts.roster),
    task: { id: taskId, label: wi.issueName },
    authority: { scopes: [], assertedVia: "none" },
    change: {
      kind: "state-change",
      summary: `${wi.fromState ?? "—"} → ${wi.toState}`,
    },
    next: { actions: [{ label: "open in Plane", ref: wi.issueUrl }] },
    ts,
    correlationId: `plane:${taskId}:${ts}`,
  };
}
