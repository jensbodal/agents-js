/**
 * Phase 2 cross-gateway registry sync primitives.
 *
 * Pull-model peer sync: a local gateway fetches another gateway's
 * `/.well-known/agents-js-registry.json`, filters out records that
 * originated on the local gateway (loop prevention), and merges the
 * remainder into the local registry with `source="sync"` and a
 * `last_synced_at` watermark.
 *
 * Each gateway's sync endpoint serves only records it *originated*
 * (`source != "sync"`) — never re-serves records it received from
 * peers. Combined with the receive-side self-gateway filter this
 * prevents A→B→A fan-back loops and the load-multiplication that
 * would otherwise result from multi-hop gossip.
 *
 * No authentication: Phase 2 is trust-based within the tailnet. Auth
 * layers in during Phase 3 or when Agent Zero's A2A auth primitive
 * (DOT-280) lands, whichever comes first. See the task scope-out
 * section and the record-shape spec's "Known limitations" block.
 *
 * Placement rationale (see node.ts for autoRegister alongside this):
 * node.ts already carried three concerns (shared-registry resolution,
 * v1→v2 migration, auto-register). Adding sync's HTTP fetch, merge
 * semantics, and endpoint-handler factory as a fourth concern was the
 * tipping point — a dedicated module keeps each file coherent. This
 * module is re-exported from node.ts so consumers keep the single
 * `@agents-js/a2a-client/node` entrypoint.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { HTTP_STATUS } from "@agents-js/a2a";
import {
  readAgentRegistryRecords,
  resolveSharedAgentRegistryPath,
  serializeRecords,
} from "./node-autoregister.ts";
import type { AgentRegistryRecord } from "./registry.ts";

/** Well-known path the peer sync endpoint is mounted at. */
export const AGENTS_JS_REGISTRY_WELL_KNOWN_PATH = "/.well-known/agents-js-registry.json";

/** Wire-format payload served by the sync endpoint and consumed by peers. */
export interface AgentsJsRegistrySyncPayload {
  version: 2;
  records: AgentRegistryRecord[];
}

/** Default peer-fetch timeout — matches AgentRegistry.cardFetchTimeoutMs. */
const DEFAULT_SYNC_FETCH_TIMEOUT_MS = 10_000;

/** Logger shape — compatible with `console` and the gateway's A2ALogger subset we use. */
export interface SyncLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
}

/** Options for {@link fetchPeerRecords}. */
export interface FetchPeerRecordsOptions {
  /** Base URL of the peer gateway (e.g. `http://peer.tail.ts.net:8080`). Path gets appended. */
  peerUrl: string;
  /** Override the well-known path. Defaults to {@link AGENTS_JS_REGISTRY_WELL_KNOWN_PATH}. */
  path?: string;
  /** Custom fetch implementation (for testing). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Request timeout in ms. Defaults to 10 000. */
  timeoutMs?: number;
}

/** Thrown when a peer's sync endpoint is unreachable, non-200, or returns an invalid payload. */
export class PeerSyncError extends Error {
  override readonly cause: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "PeerSyncError";
    this.cause = options?.cause;
  }
}

function normalizeSyncEndpointUrl(peerUrl: string, path: string): string {
  const base = peerUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Narrow an arbitrary `unknown` into an `AgentRegistryRecord` or return null. Mirrors migrateRecord's required-field gates. */
function parseWireRecord(raw: unknown): AgentRegistryRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string" || r.name.length === 0) return null;
  if (typeof r.agent_id !== "string" || r.agent_id.length === 0) return null;
  if (r.kind !== "a2a" && r.kind !== "acp") return null;
  if (typeof r.gateway_id !== "string" || r.gateway_id.length === 0) return null;
  if (r.source !== "auto-reg" && r.source !== "manual" && r.source !== "sync") return null;
  if (typeof r.registered_at !== "string" || r.registered_at.length === 0) return null;

  const rec: AgentRegistryRecord = {
    name: r.name,
    agent_id: r.agent_id,
    kind: r.kind,
    gateway_id: r.gateway_id,
    source: r.source,
    registered_at: r.registered_at,
  };
  if (r.actor_type === "human" || r.actor_type === "machine") rec.actor_type = r.actor_type;
  if (typeof r.url === "string") rec.url = r.url;
  if (typeof r.harness === "string") rec.harness = r.harness;
  if (typeof r.command === "string") rec.command = r.command;
  if (Array.isArray(r.args) && r.args.every((a) => typeof a === "string")) {
    rec.args = r.args as string[];
  }
  if (
    typeof r.env === "object" &&
    r.env !== null &&
    Object.values(r.env as Record<string, unknown>).every((v) => typeof v === "string")
  ) {
    rec.env = r.env as Record<string, string>;
  }
  if (typeof r.workspaceFlag === "string") rec.workspaceFlag = r.workspaceFlag;
  if (typeof r.last_synced_at === "string") rec.last_synced_at = r.last_synced_at;
  if (typeof r.protocol_version === "string") rec.protocol_version = r.protocol_version;
  if (typeof r.card_cache_refreshed_at === "string") {
    rec.card_cache_refreshed_at = r.card_cache_refreshed_at;
  }
  if (typeof r.preferred_gateway_id === "string") {
    rec.preferred_gateway_id = r.preferred_gateway_id;
  }
  if (typeof r.expires_at === "string") rec.expires_at = r.expires_at;
  if (typeof r.health_check_url === "string") rec.health_check_url = r.health_check_url;
  if (typeof r.description === "string") rec.description = r.description;
  return rec;
}

/**
 * GET the peer gateway's sync endpoint and return the records it serves.
 * Throws {@link PeerSyncError} on network failure, non-2xx, or malformed payload.
 */
export async function fetchPeerRecords(
  options: FetchPeerRecordsOptions,
): Promise<AgentRegistryRecord[]> {
  const url = normalizeSyncEndpointUrl(
    options.peerUrl,
    options.path ?? AGENTS_JS_REGISTRY_WELL_KNOWN_PATH,
  );
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.timeoutMs ?? DEFAULT_SYNC_FETCH_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (error) {
    throw new PeerSyncError(`[a2a-client] Peer sync fetch failed: ${url}`, { cause: error });
  }

  if (!response.ok) {
    throw new PeerSyncError(
      `[a2a-client] Peer sync endpoint returned ${response.status} ${response.statusText}: ${url}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new PeerSyncError(`[a2a-client] Peer sync payload was not JSON: ${url}`, {
      cause: error,
    });
  }

  if (typeof body !== "object" || body === null) {
    throw new PeerSyncError(`[a2a-client] Peer sync payload was not an object: ${url}`);
  }
  const shape = body as { version?: unknown; records?: unknown };
  if (shape.version !== 2) {
    throw new PeerSyncError(
      `[a2a-client] Peer sync payload version mismatch (expected 2, got ${String(shape.version)}): ${url}`,
    );
  }
  if (!Array.isArray(shape.records)) {
    throw new PeerSyncError(`[a2a-client] Peer sync payload .records was not an array: ${url}`);
  }

  const out: AgentRegistryRecord[] = [];
  for (const raw of shape.records) {
    const rec = parseWireRecord(raw);
    if (rec !== null) out.push(rec);
  }
  return out;
}

/** Why a single record changed (or did not change) during a sync merge. */
export type SyncAction =
  | { kind: "added"; name: string; agent_id: string }
  | { kind: "updated"; name: string; agent_id: string; reason: "peer-newer" | "preferred-peer" }
  | {
      kind: "unchanged";
      name: string;
      agent_id: string;
      reason: "same-gateway-local-newer" | "preferred-local" | "last-writer-local";
    }
  | { kind: "skipped-loop"; name: string; agent_id: string }
  | {
      kind: "conflict-resolved";
      name: string;
      winner_gateway_id: string;
      resolution: "preferred_gateway_id" | "last-writer-wins";
    };

/** Summary returned by {@link syncFromPeer}. Each record surfaces in exactly one array + one action. */
export interface SyncSummary {
  peerUrl: string;
  peerRecordsReceived: number;
  actions: SyncAction[];
  added: string[];
  updated: string[];
  unchanged: string[];
  skippedLoops: string[];
  conflicts: Extract<SyncAction, { kind: "conflict-resolved" }>[];
}

/** Options for {@link syncFromPeer}. */
export interface SyncFromPeerOptions extends FetchPeerRecordsOptions {
  /**
   * Local gateway identifier. Used for loop prevention: peer records with
   * `gateway_id === localGatewayId` are dropped (we originated them).
   * Defaults to `os.hostname()` — match what `autoRegister` defaults to.
   */
  localGatewayId?: string;
  /** Override the registry path. Defaults to {@link resolveSharedAgentRegistryPath}. */
  configPath?: string;
  /** Inject a clock for deterministic `last_synced_at` in tests. */
  now?: () => Date;
  /** Debug logger for conflict/skip events. */
  logger?: SyncLogger;
}

/**
 * Merge-branch decision core. Extracted as a pure function so each branch
 * is testable without disk I/O and so reviewers can audit conflict-resolution
 * rules at a single site.
 *
 * Returns `{ next, action }` where `next` is the record to store locally
 * (or `null` to leave the local untouched) and `action` is the reason.
 */
function resolveMergeBranch(
  local: AgentRegistryRecord | undefined,
  peer: AgentRegistryRecord,
  now: string,
): { next: AgentRegistryRecord | null; action: SyncAction } {
  // --- Branch 1: first-sync — no local record for this name. -----------
  // WHY: peer is introducing a new agent to us. Adopt with source="sync"
  // and stamp last_synced_at so the next sync can short-circuit.
  if (!local) {
    const next: AgentRegistryRecord = {
      ...peer,
      source: "sync",
      last_synced_at: now,
    };
    return {
      next,
      action: { kind: "added", name: peer.name, agent_id: peer.agent_id },
    };
  }

  // --- Branch 2: same-gateway (agent we previously received from peer). ---
  // WHY: peer is re-asserting a record we already store under their
  // gateway_id. Compare registered_at — peer is authoritative over its
  // own records but an older peer record would be a regression, so
  // local-wins on tie or when local is newer. When peer wins, we still
  // carry source="sync" and refresh last_synced_at.
  if (local.gateway_id === peer.gateway_id) {
    if (peer.registered_at > local.registered_at) {
      const next: AgentRegistryRecord = {
        ...peer,
        source: "sync",
        last_synced_at: now,
      };
      return {
        next,
        action: {
          kind: "updated",
          name: peer.name,
          agent_id: peer.agent_id,
          reason: "peer-newer",
        },
      };
    }
    // No field changes, but bump last_synced_at so stale-detection later
    // can distinguish "haven't talked in a while" from "haven't changed".
    const next: AgentRegistryRecord = { ...local, last_synced_at: now };
    return {
      next,
      action: {
        kind: "unchanged",
        name: peer.name,
        agent_id: peer.agent_id,
        reason: "same-gateway-local-newer",
      },
    };
  }

  // --- Branch 3: cross-gateway conflict on `name`. --------------------
  // Same name surfaced on two different gateways. Phase 2 spec locks
  // preferred_gateway_id as the explicit tiebreaker; last-writer-wins
  // is the fallback.
  //
  // Subtlety the spec's task description doesn't fully pin down:
  //   - If only one side has preferred_gateway_id set → use it.
  //   - If both sides have it AND agree → use it.
  //   - If both sides have it AND disagree → operator misconfiguration;
  //     fall through to last-writer-wins (deterministic, no silent
  //     bias toward whichever side we happened to ask).
  //   - If preferred_gateway_id matches NEITHER gateway_id → the
  //     operator is pointing at a third gateway neither record
  //     represents; also fall through to last-writer-wins.
  // Spec addendum committed alongside this file captures the same rules.
  const localPref = local.preferred_gateway_id;
  const peerPref = peer.preferred_gateway_id;
  let preferredId: string | undefined;
  if (localPref !== undefined && peerPref !== undefined) {
    if (localPref === peerPref) preferredId = localPref;
  } else if (localPref !== undefined) {
    preferredId = localPref;
  } else if (peerPref !== undefined) {
    preferredId = peerPref;
  }

  if (preferredId === local.gateway_id) {
    return {
      next: null,
      action: {
        kind: "unchanged",
        name: peer.name,
        agent_id: peer.agent_id,
        reason: "preferred-local",
      },
    };
  }
  if (preferredId === peer.gateway_id) {
    const next: AgentRegistryRecord = {
      ...peer,
      source: "sync",
      last_synced_at: now,
    };
    return {
      next,
      action: {
        kind: "updated",
        name: peer.name,
        agent_id: peer.agent_id,
        reason: "preferred-peer",
      },
    };
  }

  // Last-writer-wins by registered_at. Ties favor the local record
  // (minimize churn — if both claim the same ISO timestamp we keep
  // the current local state).
  if (peer.registered_at > local.registered_at) {
    const next: AgentRegistryRecord = {
      ...peer,
      source: "sync",
      last_synced_at: now,
    };
    return {
      next,
      action: {
        kind: "updated",
        name: peer.name,
        agent_id: peer.agent_id,
        reason: "peer-newer",
      },
    };
  }
  return {
    next: local,
    action: {
      kind: "unchanged",
      name: peer.name,
      agent_id: peer.agent_id,
      reason: "last-writer-local",
    },
  };
}

/** Pure-function merge surface — exported for white-box tests of the matrix. */
export function mergeRecords(
  localRecords: AgentRegistryRecord[],
  peerRecords: AgentRegistryRecord[],
  options: { localGatewayId: string; now: string; logger?: SyncLogger },
): { merged: Record<string, AgentRegistryRecord>; actions: SyncAction[] } {
  const byName: Record<string, AgentRegistryRecord> = {};
  for (const r of localRecords) byName[r.name] = r;

  const actions: SyncAction[] = [];
  for (const peer of peerRecords) {
    // Loop prevention: the receiver drops any record peer claims we
    // originated. Defense in depth beyond the sender-side filter.
    if (peer.gateway_id === options.localGatewayId) {
      actions.push({ kind: "skipped-loop", name: peer.name, agent_id: peer.agent_id });
      options.logger?.debug("[a2a-client] sync: skipped loop record", {
        name: peer.name,
        agent_id: peer.agent_id,
        gateway_id: peer.gateway_id,
      });
      continue;
    }

    const local = byName[peer.name];
    const { next, action } = resolveMergeBranch(local, peer, options.now);

    // Cross-gateway conflict emits an extra conflict-resolved log record
    // so operators have a tracer they can grep for even when the merge
    // outcome is "no change" (e.g. preferred-local).
    if (local && local.gateway_id !== peer.gateway_id) {
      const winnerGatewayId = next?.gateway_id ?? local.gateway_id;
      const resolution =
        action.kind === "unchanged" && action.reason === "preferred-local"
          ? "preferred_gateway_id"
          : action.kind === "updated" && action.reason === "preferred-peer"
            ? "preferred_gateway_id"
            : "last-writer-wins";
      const conflict: Extract<SyncAction, { kind: "conflict-resolved" }> = {
        kind: "conflict-resolved",
        name: peer.name,
        winner_gateway_id: winnerGatewayId,
        resolution,
      };
      actions.push(conflict);
      options.logger?.debug("[a2a-client] sync: cross-gateway conflict resolved", {
        name: peer.name,
        local_gateway_id: local.gateway_id,
        peer_gateway_id: peer.gateway_id,
        winner_gateway_id: winnerGatewayId,
        resolution,
      });
    }

    actions.push(action);
    if (next !== null) byName[peer.name] = next;
  }

  return { merged: byName, actions };
}

function summarize(peerUrl: string, actions: SyncAction[], peerCount: number): SyncSummary {
  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const skippedLoops: string[] = [];
  const conflicts: Extract<SyncAction, { kind: "conflict-resolved" }>[] = [];
  for (const a of actions) {
    switch (a.kind) {
      case "added":
        added.push(a.name);
        break;
      case "updated":
        updated.push(a.name);
        break;
      case "unchanged":
        unchanged.push(a.name);
        break;
      case "skipped-loop":
        skippedLoops.push(a.name);
        break;
      case "conflict-resolved":
        conflicts.push(a);
        break;
    }
  }
  return {
    peerUrl,
    peerRecordsReceived: peerCount,
    actions,
    added,
    updated,
    unchanged,
    skippedLoops,
    conflicts,
  };
}

/**
 * Pull-sync from a single peer. Fetches the peer's sync endpoint, drops
 * self-originated records, merges the rest into the local registry, and
 * writes the result to disk.
 *
 * Returns a {@link SyncSummary} describing what happened. Throws
 * {@link PeerSyncError} if the peer cannot be reached — call sites that
 * sync multiple peers should catch per-peer.
 */
export async function syncFromPeer(options: SyncFromPeerOptions): Promise<SyncSummary> {
  const configPath = options.configPath ?? resolveSharedAgentRegistryPath();
  const localGatewayId = options.localGatewayId ?? hostname();
  const now = (options.now ?? (() => new Date()))().toISOString();

  const peerRecords = await fetchPeerRecords(options);
  const localRecords = await readAgentRegistryRecords({ configPath });

  const { merged, actions } = mergeRecords(localRecords, peerRecords, {
    localGatewayId,
    now,
    logger: options.logger,
  });

  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(serializeRecords(merged), null, 2)}\n`);

  return summarize(options.peerUrl, actions, peerRecords.length);
}

/**
 * Produce the wire payload this gateway would serve at its sync endpoint.
 * Filters out `source="sync"` records — loop prevention on the send side.
 */
export function buildSyncPayload(records: AgentRegistryRecord[]): AgentsJsRegistrySyncPayload {
  return {
    version: 2,
    records: records.filter((r) => r.source !== "sync"),
  };
}

/** Options for {@link createSyncEndpointHandler}. */
export interface SyncEndpointHandlerOptions {
  /** Registry path to serve from. Defaults to {@link resolveSharedAgentRegistryPath}. */
  configPath?: string;
  /** Path to mount at. Defaults to {@link AGENTS_JS_REGISTRY_WELL_KNOWN_PATH}. */
  path?: string;
  /** Emit debug logs. Matches the shape used by {@link syncFromPeer}. */
  logger?: SyncLogger;
}

/**
 * Build a `(req: Request) => Promise<Response | null>` compatible with
 * `UniversalA2AServerOptions.additionalFetch`. The gateway wires this
 * into its existing fetch hook so the sync endpoint lives on the same
 * port + CORS surface as the A2A JSON-RPC endpoint — mirrors the
 * `/agent` AG-UI pattern in `apps/internal-gateway/agui-endpoint.ts`.
 *
 * Returns `null` when the request is not a GET to the configured path,
 * letting the host server fall through to its next routing layer.
 */
export function createSyncEndpointHandler(
  options: SyncEndpointHandlerOptions = {},
): (req: Request) => Promise<Response | null> {
  const path = options.path ?? AGENTS_JS_REGISTRY_WELL_KNOWN_PATH;
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== path) return null;
    if (req.method !== "GET") return null;

    const records = await readAgentRegistryRecords({ configPath: options.configPath });
    const payload = buildSyncPayload(records);
    options.logger?.debug("[a2a-client] served sync endpoint", {
      path,
      served: payload.records.length,
      total: records.length,
    });
    return new Response(JSON.stringify(payload), {
      status: HTTP_STATUS.OK,
      headers: { "Content-Type": "application/json" },
    });
  };
}
