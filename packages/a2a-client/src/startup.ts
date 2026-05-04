/**
 * Gateway startup helpers for auto-registration and peer sync.
 *
 * {@link startRegistrySync} is the single entry point both gateway startup
 * paths call. It wires three concerns in order:
 *   1. Auto-register this gateway in the local registry (fire-and-forget).
 *   2. Return a sync endpoint handler to mount on the HTTP server.
 *   3. Start a periodic peer-sync interval to pull remote registries.
 *
 * Consumers receive `{ syncHandler, stop }`:
 *   - `syncHandler` — compose into `UniversalA2AServerOptions.additionalFetch`
 *     alongside any other pre-routing hooks (e.g. the AG-UI handler). It
 *     returns `null` for non-matching paths so the host can chain multiple
 *     handlers.
 *   - `stop()` — call from SIGINT / SIGTERM to clear the interval.
 *
 * Placement rationale: same as sync.ts — startup.ts carries its own
 * coherent concern and re-exports through node.ts so consumers keep the
 * single `@agents-js/a2a-client/node` entrypoint.
 */

import { hostname } from "node:os";
import {
  autoRegister,
  readAgentRegistryRecords,
  resolveSharedAgentRegistryPath,
} from "./node-autoregister.ts";
import type { SyncLogger } from "./sync.ts";
import { createSyncEndpointHandler, syncFromPeer } from "./sync.ts";

export type { SyncLogger };

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
   * Base URL of this gateway (e.g. `http://192.168.1.5:8080`). Used as
   * the A2A entry point URL.
   */
  url: string;
  /** Registry file path. Defaults to {@link resolveSharedAgentRegistryPath}. */
  configPath?: string;
  /**
   * Peer-sync interval in milliseconds. Defaults to 300 000 (5 min).
   * Pass `0` to disable the periodic sync (syncHandler still works for
   * inbound pull requests from peers).
   */
  intervalMs?: number;
  /** Logger — defaults to `console`. */
  logger?: StartupLogger;
  /** Override the local gateway identifier. Defaults to `os.hostname()`. */
  gatewayId?: string;
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

  // Fire-and-forget auto-registration.
  void autoRegister({
    name: options.name,
    kind: "a2a",
    url: options.url,
    configPath,
    gatewayId: localGatewayId,
  })
    .then((record) => {
      logger.log("[agents-js/registry] Auto-registered", {
        agent_id: record.agent_id,
        url: record.url,
      });
    })
    .catch((err: unknown) => {
      logger.warn(
        "[agents-js/registry] Auto-registration failed (non-fatal):",
        err instanceof Error ? err.message : String(err),
      );
    });

  // Sync endpoint handler for inbound pull requests from peers.
  const syncHandler = createSyncEndpointHandler({
    configPath,
    logger: options.logger?.debug ? { debug: options.logger.debug } : undefined,
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
      if (intervalHandle !== undefined) {
        clearInterval(intervalHandle);
        intervalHandle = undefined;
      }
    },
  };
}
