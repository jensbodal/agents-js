/**
 * A2Canvas source adapters (M0) — the real I/O that feeds `createPoller`.
 *
 * These are the gateway-targeted `fetchMatrixEvents` / `fetchPlaneItems`
 * implementations. They live in the I/O layer (NOT the pure mappers): doing
 * transport is their whole job. Boundary discipline still holds:
 *   - Credentials are INJECTED via config (from the gateway's env), never
 *     hard-coded here.
 *   - They only READ source systems and normalize — no board/reducer/renderer
 *     writes (the reducer stays the sole board writer, host-side).
 *   - `fetchImpl` is injectable so the mapping logic is unit-testable offline.
 */

import type { MatrixRoomEvent } from "./index.ts";
import type { PlaneIssueSnapshot } from "./poller.ts";

// ---------------------------------------------------------------------------
// Matrix — Client-Server API /messages
// ---------------------------------------------------------------------------

export interface MatrixFetcherConfig {
  /** e.g. "https://matrix.tail019e7.ts.net". */
  readonly homeserverUrl: string;
  /** Access token (from gateway env — never hard-coded). */
  readonly accessToken: string;
  /** Room id, e.g. "!cJxcDspkqBHcoALJCy:matrix.tail019e7.ts.net". */
  readonly roomId: string;
  /** How many recent events to pull per poll (default 30). */
  readonly limit?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

interface MatrixApiEvent {
  readonly type?: string;
  readonly event_id?: string;
  readonly sender?: string;
  readonly origin_server_ts?: number;
  readonly content?: { readonly body?: unknown; readonly msgtype?: string };
}

/**
 * Build a `fetchMatrixEvents` adapter. Returns recent `m.room.message` events,
 * oldest-first (the API returns newest-first for `dir=b`; we reverse so the
 * poller sees natural chronological order).
 */
export function createMatrixFetcher(cfg: MatrixFetcherConfig): () => Promise<MatrixRoomEvent[]> {
  const doFetch = cfg.fetchImpl ?? fetch;
  return async () => {
    const url =
      `${cfg.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(cfg.roomId)}` +
      `/messages?dir=b&limit=${cfg.limit ?? 30}`;
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
    });
    if (!res.ok) throw new Error(`matrix /messages returned ${res.status}`);
    const body = (await res.json()) as { chunk?: readonly MatrixApiEvent[] };
    const out: MatrixRoomEvent[] = [];
    for (const ev of body.chunk ?? []) {
      if (ev.type !== "m.room.message") continue;
      const text = ev.content?.body;
      if (typeof text !== "string" || text.length === 0) continue;
      if (!ev.event_id || !ev.sender || typeof ev.origin_server_ts !== "number") continue;
      out.push({
        event_id: ev.event_id,
        sender: ev.sender,
        timestamp: new Date(ev.origin_server_ts).toISOString(),
        body: text,
      });
    }
    return out.reverse();
  };
}

// ---------------------------------------------------------------------------
// Plane — REST issues per project
// ---------------------------------------------------------------------------

export interface PlaneProjectRef {
  /** Plane project UUID. */
  readonly id: string;
  /** Identifier prefix used in keys, e.g. "DOT". */
  readonly identifier: string;
}

export interface PlaneFetcherConfig {
  /** e.g. "https://plane.q4m.dev". */
  readonly baseUrl: string;
  /** Plane PAT (from gateway env — never hard-coded). Sent as X-API-Key. */
  readonly apiKey: string;
  /** Workspace slug, e.g. "dot". */
  readonly workspaceSlug: string;
  readonly projects: readonly PlaneProjectRef[];
  /** stateId -> human state name (Plane issues carry `state` as a UUID). */
  readonly stateNames: Readonly<Record<string, string>>;
  /**
   * Actor label for Plane cards. A plain issue snapshot does not say WHO moved
   * the state, so M0 attributes transitions to a configured label (default
   * "plane"); the Matrix producer carries real agent identities.
   */
  readonly actor?: string;
  readonly actorKind?: "agent" | "human";
  /** Build the public issue URL; defaults to a Plane web path. */
  readonly issueUrl?: (p: {
    workspaceSlug: string;
    projectId: string;
    issueId: string;
    sequenceId: number;
  }) => string;
  readonly fetchImpl?: typeof fetch;
}

interface PlaneApiIssue {
  readonly id?: string;
  readonly sequence_id?: number;
  readonly name?: string;
  readonly state?: string;
  readonly updated_at?: string;
}

/** Build a `fetchPlaneItems` adapter returning current snapshots across projects. */
export function createPlaneFetcher(cfg: PlaneFetcherConfig): () => Promise<PlaneIssueSnapshot[]> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const makeUrl =
    cfg.issueUrl ??
    ((p) => `${cfg.baseUrl}/${p.workspaceSlug}/projects/${p.projectId}/issues/${p.issueId}`);
  return async () => {
    const out: PlaneIssueSnapshot[] = [];
    for (const proj of cfg.projects) {
      const url =
        `${cfg.baseUrl}/api/v1/workspaces/${cfg.workspaceSlug}` +
        `/projects/${proj.id}/issues/?per_page=100`;
      const res = await doFetch(url, { headers: { "X-API-Key": cfg.apiKey } });
      if (!res.ok) throw new Error(`plane issues returned ${res.status}`);
      const body = (await res.json()) as { results?: readonly PlaneApiIssue[] };
      for (const it of body.results ?? []) {
        if (!it.id || typeof it.sequence_id !== "number" || !it.state) continue;
        out.push({
          sequenceId: it.sequence_id,
          projectIdentifier: proj.identifier,
          issueName: it.name ?? `${proj.identifier}-${it.sequence_id}`,
          stateName: cfg.stateNames[it.state] ?? "unknown",
          actor: cfg.actor ?? "plane",
          actorKind: cfg.actorKind,
          updatedAt: it.updated_at ?? new Date(0).toISOString(),
          issueUrl: makeUrl({
            workspaceSlug: cfg.workspaceSlug,
            projectId: proj.id,
            issueId: it.id,
            sequenceId: it.sequence_id,
          }),
        });
      }
    }
    return out;
  };
}
