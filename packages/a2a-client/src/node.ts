/**
 * Node.js-only entry point for `@agents-js/a2a-client/node`.
 *
 * Re-exports registry, sync, and autoregister primitives.  The gateway
 * startup helper (`startRegistrySync`) is inlined here rather than
 * re-exported from startup.ts because tsgo v7.0.0-dev cannot follow
 * re-exports to NEW files (files not present in the original compilation
 * unit) when resolving from the root workspace tsconfig.
 */

import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import type { AuditEmitter } from "@agents-js/a2a/audit";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  startAutoRegisterHeartbeat,
  type UrlProvider,
} from "./auto-register-heartbeat.ts";
import { readAgentRegistryRecords, resolveSharedAgentRegistryPath } from "./node-autoregister.ts";
import { type AgentEntry, AgentRegistryConfigError } from "./registry.ts";
import type { SyncLogger } from "./sync.ts";
import { createSyncEndpointHandler, syncFromPeer } from "./sync.ts";
import type { AgentTargetInput } from "./types.ts";

export {
  type AutoRegisterHeartbeatHandle,
  DEFAULT_HEARTBEAT_INITIAL_BACKOFF_MS,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_MAX_BACKOFF_MS,
  type HeartbeatLogger,
  type StartAutoRegisterHeartbeatOptions,
  startAutoRegisterHeartbeat,
  type UrlProvider,
} from "./auto-register-heartbeat.ts";
export {
  type AutoRegisterA2AOptions,
  type AutoRegisterACPOptions,
  type AutoRegisterOptions,
  type AutoRegisterOptionsBase,
  autoRegister,
  readAgentRegistryRecords,
  resolveSharedAgentRegistryPath,
  serializeRecords,
} from "./node-autoregister.ts";
export {
  type A2AAgentEntry,
  type ACPAgentEntry,
  type AgentActorType,
  type AgentEntry,
  type AgentKind,
  AgentRegistry,
  type AgentRegistryOptions,
  type AgentRegistryRecord,
  type AgentRegistrySource,
} from "./registry.ts";
export {
  AGENTS_JS_REGISTRY_WELL_KNOWN_PATH,
  type AgentsJsRegistrySyncPayload,
  buildSyncPayload,
  createSyncEndpointHandler,
  type FetchPeerRecordsOptions,
  fetchPeerRecords,
  mergeRecords,
  PeerSyncError,
  type SyncAction,
  type SyncEndpointHandlerOptions,
  type SyncFromPeerOptions,
  type SyncLogger,
  type SyncSummary,
  syncFromPeer,
} from "./sync.ts";

// ---------------------------------------------------------------------------
// startRegistrySync — inlined from startup.ts to work around tsgo limitation
// ---------------------------------------------------------------------------

/** Default peer-sync interval: 5 minutes. */
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** Console-shaped logger subset used by {@link startRegistrySync}. */
export type StartupLogger = Pick<Console, "log" | "warn" | "error"> & {
  debug?: SyncLogger["debug"];
};

/** Options for {@link startRegistrySync}. */
export interface StartRegistrySyncOptions {
  /** Local agent name — written to the registry as the `name` field. */
  name: string;
  /**
   * Base URL of this gateway (e.g. `http://192.0.2.5:8080`). Used as
   * the A2A entry point URL. Accepts a {@link UrlProvider} callback
   * when the URL may change between heartbeat ticks (DDNS / roaming).
   */
  url: string | UrlProvider;
  /** Registry file path. Defaults to {@link resolveSharedAgentRegistryPath}. */
  configPath?: string;
  /**
   * Peer-sync interval in milliseconds. Controls the outbound pull
   * cadence against known peers. Defaults to 300 000 (5 min). Pass `0`
   * to disable the periodic sync (syncHandler still works for inbound
   * pull requests from peers). Independent of {@link heartbeatIntervalMs}.
   */
  intervalMs?: number;
  /**
   * Host-address heartbeat interval in milliseconds (AJS-87). Controls
   * how often this gateway re-publishes its own `(name, url)` record to
   * the local registry so peers see a fresh `registered_at` on their
   * next pull. Defaults to {@link DEFAULT_HEARTBEAT_INTERVAL_MS} (60 s).
   * Pass `0` (and see {@link heartbeatEnabled}) to disable the loop —
   * the initial registration still runs once on startup. Independent
   * of the peer-pull {@link intervalMs}.
   */
  heartbeatIntervalMs?: number;
  /**
   * When `false`, suppress the periodic heartbeat entirely — only the
   * initial fire-and-forget registration runs. Defaults to `true`.
   */
  heartbeatEnabled?: boolean;
  /** Logger — defaults to `console`. */
  logger?: StartupLogger;
  /** Override the local gateway identifier. Defaults to `os.hostname()`. */
  gatewayId?: string;
  /** Optional structural audit emitter for registry sync events. */
  audit?: AuditEmitter;
}

/** Handle returned by {@link startRegistrySync}. */
export interface RegistrySyncHandle {
  /**
   * Fetch handler for `GET /.well-known/agents-js-registry.json`. Compose
   * this into `UniversalA2AServerOptions.additionalFetch` alongside any
   * other pre-routing hooks. Returns `null` for non-matching paths.
   */
  syncHandler: (req: Request) => Promise<Response | null>;
  /** Clear the periodic sync interval. Call from SIGINT / SIGTERM. */
  stop: () => void;
}

/**
 * Wire auto-registration and peer-sync into a gateway startup path. Returns
 * immediately — auto-registration is fire-and-forget.
 *
 * @example
 * ```ts
 * const sync = startRegistrySync({ name: "my-gateway", url: baseUrl });
 * // compose syncHandler into additionalFetch:
 * const a2aServer = new UniversalA2AServer(executor, gatewayCard, undefined, {
 *   additionalFetch: async (req) => (await aguiHandler(req)) ?? sync.syncHandler(req),
 * });
 * // ...on shutdown:
 * process.on("SIGINT", () => { sync.stop(); server.stop(true); process.exit(); });
 * ```
 */
export function startRegistrySync(options: StartRegistrySyncOptions): RegistrySyncHandle {
  const logger = options.logger ?? console;
  const configPath = options.configPath ?? resolveSharedAgentRegistryPath();
  const localGatewayId = options.gatewayId ?? hostname();
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;

  // Periodic host-address heartbeat (AJS-87). Covers the one-shot
  // registration too — the first tick fires immediately on the
  // microtask queue. When `heartbeatEnabled === false`, pass
  // `intervalMs: 0` so the heartbeat helper still runs the initial
  // registration but never reschedules.
  const heartbeatEnabled = options.heartbeatEnabled ?? true;
  const heartbeat = startAutoRegisterHeartbeat({
    name: options.name,
    url: options.url,
    configPath,
    gatewayId: localGatewayId,
    intervalMs: heartbeatEnabled
      ? (options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS)
      : 0,
    logger,
  });

  // Sync endpoint handler for inbound pull requests from peers.
  const syncHandler = createSyncEndpointHandler({
    configPath,
    logger: options.logger?.debug ? { debug: options.logger.debug } : undefined,
    audit: options.audit,
  });

  // Periodic peer-sync for outbound pulls to known peers.
  let intervalHandle: ReturnType<typeof setInterval> | undefined;

  if (intervalMs > 0) {
    const runSync = async (): Promise<void> => {
      let records: Awaited<ReturnType<typeof readAgentRegistryRecords>>;
      try {
        records = await readAgentRegistryRecords({ configPath });
      } catch (err: unknown) {
        logger.warn(
          "[agents-js/registry] Peer sync: failed to read local registry (skipping):",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }

      // Collect unique peer URLs: a2a-kind only, not ourselves, not already-synced-from-us.
      const seenUrls = new Set<string>();
      const peerUrls: string[] = [];
      for (const record of records) {
        if (record.kind !== "a2a") continue;
        if (!record.url) continue;
        if (record.gateway_id === localGatewayId) continue;
        if (seenUrls.has(record.url)) continue;
        seenUrls.add(record.url);
        peerUrls.push(record.url);
      }

      if (peerUrls.length === 0) return;

      for (const peerUrl of peerUrls) {
        try {
          const summary = await syncFromPeer({
            peerUrl,
            configPath,
            localGatewayId,
            audit: options.audit,
          });
          if (summary.added.length > 0 || summary.updated.length > 0) {
            logger.log(
              `[agents-js/registry] Synced from ${peerUrl}: +${summary.added.length} updated:${summary.updated.length}`,
            );
          }
        } catch (err: unknown) {
          logger.warn(
            `[agents-js/registry] Peer sync from ${peerUrl} failed (non-fatal):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    };

    intervalHandle = setInterval(() => {
      void runSync();
    }, intervalMs);

    // Prevent the interval from keeping the process alive.
    if (
      typeof intervalHandle === "object" &&
      intervalHandle !== null &&
      "unref" in intervalHandle
    ) {
      (intervalHandle as NodeJS.Timeout).unref();
    }
  }

  return {
    syncHandler,
    stop() {
      heartbeat.stop();
      if (intervalHandle !== undefined) {
        clearInterval(intervalHandle);
        intervalHandle = undefined;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SharedAgentRegistry — kept in node.ts (original implementation)
// ---------------------------------------------------------------------------

export interface SharedAgentRegistry {
  resolve(name: string): Promise<AgentTargetInput | null>;
  list(): Promise<AgentEntry[]>;
  refresh(): void;
  getConfigPath(): string;
}

export interface SharedAgentRegistryOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

function isRegistryConfigError(error: unknown): boolean {
  return error instanceof AgentRegistryConfigError;
}

/**
 * Normalize a raw registry entry read from disk. Mirrors `registry.ts::normalizeEntry`;
 * kept in sync by hand because this shared helper rereads the file on every call and
 * does not share the cached config instance.
 */
function normalizeRawEntry(name: string, entry: unknown, configPath: string): AgentEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new AgentRegistryConfigError(`[a2a-client] Invalid registry config at ${configPath}`);
  }
  const record = entry as Record<string, unknown>;
  const kind = record.kind;
  if (kind === "acp") {
    const harness = record.harness;
    if (typeof harness !== "string" || harness.trim().length === 0) {
      throw new AgentRegistryConfigError(
        `[a2a-client] Invalid registry config at ${configPath}: agent "${name}" has kind "acp" but is missing a "harness" string`,
      );
    }
    const result: AgentEntry = { kind: "acp", name, harness };
    if (typeof record.command === "string") result.command = record.command;
    if (Array.isArray(record.args) && record.args.every((a) => typeof a === "string")) {
      result.args = record.args as string[];
    }
    if (
      typeof record.env === "object" &&
      record.env !== null &&
      Object.values(record.env as Record<string, unknown>).every((v) => typeof v === "string")
    ) {
      result.env = record.env as Record<string, string>;
    }
    if (typeof record.workspaceFlag === "string") result.workspaceFlag = record.workspaceFlag;
    return result;
  }
  if (kind !== undefined && kind !== "a2a") {
    throw new AgentRegistryConfigError(
      `[a2a-client] Invalid registry config at ${configPath}: agent "${name}" has unknown kind "${String(kind)}"`,
    );
  }
  const url = record.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new AgentRegistryConfigError(`[a2a-client] Invalid registry config at ${configPath}`);
  }
  return { kind: "a2a", name, url };
}

export function createSharedAgentRegistry(
  options: SharedAgentRegistryOptions = {},
): SharedAgentRegistry {
  const configPath = resolveSharedAgentRegistryPath(options);

  async function loadEntries(): Promise<AgentEntry[]> {
    let raw: string;
    try {
      raw = await readFile(configPath, "utf-8");
    } catch (error) {
      throw new AgentRegistryConfigError(
        `[a2a-client] Failed to read registry config at ${configPath}`,
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AgentRegistryConfigError(`[a2a-client] Invalid registry config at ${configPath}`, {
        cause: error,
      });
    }

    const agents =
      typeof parsed === "object" && parsed !== null && "agents" in parsed
        ? (parsed as { agents?: unknown }).agents
        : undefined;
    if (typeof agents !== "object" || agents === null) {
      throw new AgentRegistryConfigError(`[a2a-client] Invalid registry config at ${configPath}`);
    }

    const out: AgentEntry[] = [];
    for (const [name, entry] of Object.entries(agents)) {
      out.push(normalizeRawEntry(name, entry, configPath));
    }
    return out;
  }

  return {
    async resolve(name) {
      try {
        const entry = (await loadEntries()).find((e) => e.name === name);
        if (!entry) return null;
        if (entry.kind !== "a2a") return null;
        return { url: entry.url };
      } catch (error) {
        if (isRegistryConfigError(error)) {
          return null;
        }
        throw error;
      }
    },
    async list() {
      try {
        return await loadEntries();
      } catch (error) {
        if (isRegistryConfigError(error)) {
          return [];
        }
        throw error;
      }
    },
    refresh() {
      // This shared helper rereads the registry file on every access, so there is no cache to clear.
    },
    getConfigPath() {
      return configPath;
    },
  };
}
