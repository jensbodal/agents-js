/**
 * Periodic host-address heartbeat for the federated registry (AJS-87).
 *
 * Gateway hosts on roaming networks (Pi nodes on DHCP leases, laptops
 * crossing access points) can drift their advertised host:port between
 * boots. The one-shot `autoRegister` call captures the URL at boot and
 * never re-publishes — peers pulling the local sync endpoint see a stale
 * record and cross-host A2A calls fail with `ECONNREFUSED` to the prior
 * IP even though the runtime is alive on a new one.
 *
 * This module re-publishes the local `(name, url)` record on a timer.
 * Each tick re-runs `autoRegister`, which rewrites the in-place record
 * with a fresh `registered_at`. Peers fetch the refreshed record on
 * their next sync interval, so the staleness window is bounded by
 * `(heartbeat_interval + peer_sync_interval)`.
 *
 * URL freshness is delegated to the caller via {@link urlProvider} —
 * a static string captured at boot covers the common DNS-hostname
 * deployment, while a callback hook lets a future interface-IP detector
 * plug in without a v2 breaking change. The provider runs on each tick;
 * if it throws, the tick is treated as a transient failure and retried
 * with backoff.
 *
 * Receiver-side TTL expiry — the consumer of `registered_at` /
 * `expires_at` watermarks — is out of scope for this module. See the
 * follow-up tracker for the registry-expiry contract.
 */

import {
  type AutoRegisterA2AOptions,
  type AutoRegisterOptions,
  autoRegister,
} from "./node-autoregister.ts";

/** Default heartbeat cadence — 60 seconds, matches the AJS-87 spec. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

/** Initial backoff after a failed `autoRegister` call. */
export const DEFAULT_HEARTBEAT_INITIAL_BACKOFF_MS = 5_000;

/** Backoff cap — never wait longer than this between retries. */
export const DEFAULT_HEARTBEAT_MAX_BACKOFF_MS = 60_000;

/** Console-shaped logger subset used by the heartbeat loop. */
export type HeartbeatLogger = Pick<Console, "log" | "warn" | "error">;

/**
 * URL resolver evaluated at every heartbeat tick. Implementations may
 * return a static string (closure-captured at boot) or recompute the
 * advertised host on each call. Both sync and async returns are accepted
 * so a future implementation can re-resolve DNS or sniff network
 * interfaces without forcing every existing caller to become async.
 */
export type UrlProvider = () => string | Promise<string>;

/** Options for {@link startAutoRegisterHeartbeat}. */
export interface StartAutoRegisterHeartbeatOptions {
  /** Local agent name — the registry row this heartbeat keeps fresh. */
  name: string;
  /**
   * Either a static URL string captured at boot, or a provider callback
   * invoked on every tick. Provider form is preferred when the URL may
   * change between ticks (DDNS / interface-IP roaming).
   */
  url: string | UrlProvider;
  /** Registry file path. Defaults to the shared registry location. */
  configPath?: string;
  /** Override the gateway identifier. Defaults to `os.hostname()`. */
  gatewayId?: string;
  /**
   * Heartbeat cadence in milliseconds. Defaults to
   * {@link DEFAULT_HEARTBEAT_INTERVAL_MS} (60 000).
   *
   * Pass `0` or a negative number to disable all scheduling — the initial
   * fire-and-forget registration runs once, and crucially **no retry is
   * scheduled** even if that initial registration fails. The intent of
   * `intervalMs <= 0` is "fire once, don't keep running"; honoring it on
   * the success path but reverting to backoff on the failure path would
   * silently violate that contract (the heartbeat would still keep ticking
   * via the exponential-backoff loop). Callers that need
   * resilient-but-not-periodic semantics should pass a small `intervalMs`
   * and `stop()` the handle once the first success arrives.
   */
  intervalMs?: number;
  /**
   * Initial backoff after a transient failure. Defaults to
   * {@link DEFAULT_HEARTBEAT_INITIAL_BACKOFF_MS} (5 000). The backoff
   * doubles after each failure and is capped at {@link maxBackoffMs}.
   */
  initialBackoffMs?: number;
  /**
   * Backoff ceiling. Defaults to {@link DEFAULT_HEARTBEAT_MAX_BACKOFF_MS}
   * (60 000). Once reached the heartbeat retries at this fixed cadence
   * until a tick succeeds, at which point the cadence resets to
   * {@link intervalMs}.
   */
  maxBackoffMs?: number;
  /** Logger — defaults to `console`. */
  logger?: HeartbeatLogger;
  /**
   * Optional injection hook for tests. Defaults to {@link autoRegister}.
   * Replacing the call lets unit tests assert tick count + payload shape
   * without touching the filesystem.
   */
  registerFn?: (options: AutoRegisterOptions) => Promise<unknown>;
  /**
   * Optional injection hook for tests. Defaults to `setTimeout` /
   * `clearTimeout`. The heartbeat schedules itself one tick at a time
   * (no `setInterval`) so injecting a deterministic scheduler is enough
   * to drive the loop without real wall time.
   */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

/** Handle returned by {@link startAutoRegisterHeartbeat}. */
export interface AutoRegisterHeartbeatHandle {
  /**
   * Cancel the next scheduled tick. Idempotent — calling `stop()`
   * after the loop has already cancelled is a no-op. An in-flight
   * `autoRegister` call is not aborted; it completes and its
   * follow-up tick is suppressed.
   */
  stop: () => void;
}

async function resolveUrl(provider: string | UrlProvider): Promise<string> {
  if (typeof provider === "string") return provider;
  return await provider();
}

/**
 * Start a self-scheduling heartbeat loop that re-publishes the local
 * `(name, url)` record at `intervalMs`. Returns immediately — the first
 * registration runs fire-and-forget on the next microtask.
 *
 * The loop uses a single self-rescheduling `setTimeout` rather than
 * `setInterval` so a slow registration call cannot overlap with the
 * next tick. After a failure the next tick is scheduled at the current
 * backoff value (initial → doubling → capped); after success the
 * backoff resets and the next tick is scheduled at `intervalMs`.
 */
export function startAutoRegisterHeartbeat(
  options: StartAutoRegisterHeartbeatOptions,
): AutoRegisterHeartbeatHandle {
  const logger = options.logger ?? console;
  const registerFn = options.registerFn ?? autoRegister;
  const scheduler =
    options.scheduler ??
    ({ setTimeout, clearTimeout } as StartAutoRegisterHeartbeatOptions["scheduler"] & {});
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_HEARTBEAT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_HEARTBEAT_MAX_BACKOFF_MS;

  let stopped = false;
  let timerHandle: unknown;
  let currentBackoffMs = initialBackoffMs;

  const buildRegisterOptions = (url: string): AutoRegisterA2AOptions => ({
    name: options.name,
    kind: "a2a",
    url,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
    ...(options.gatewayId !== undefined ? { gatewayId: options.gatewayId } : {}),
  });

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const url = await resolveUrl(options.url);
      await registerFn(buildRegisterOptions(url));
      currentBackoffMs = initialBackoffMs;
      if (intervalMs > 0) schedule(intervalMs);
    } catch (err: unknown) {
      // Honor `intervalMs <= 0` on the failure path too — the docstring
      // promises "fire once, don't keep running," and silently reverting
      // to backoff retries here would violate that. Operators who want
      // resilient-but-not-periodic should pass a small intervalMs and
      // stop() after first success.
      if (intervalMs <= 0) {
        logger.warn(
          "[agents-js/registry] Heartbeat failed (intervalMs<=0 — not retrying):",
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      logger.warn(
        "[agents-js/registry] Heartbeat failed (will retry):",
        err instanceof Error ? err.message : String(err),
      );
      const retryDelay = Math.min(currentBackoffMs, maxBackoffMs);
      currentBackoffMs = Math.min(currentBackoffMs * 2, maxBackoffMs);
      schedule(retryDelay);
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timerHandle = scheduler.setTimeout(() => {
      void tick();
    }, delayMs);
    if (
      typeof timerHandle === "object" &&
      timerHandle !== null &&
      "unref" in timerHandle &&
      typeof (timerHandle as { unref: () => void }).unref === "function"
    ) {
      (timerHandle as { unref: () => void }).unref();
    }
  };

  // Fire the initial registration immediately (fire-and-forget) so a
  // synchronous `stop()` right after construction cannot cancel the
  // boot-time write. Subsequent ticks are scheduled via setTimeout and
  // ARE cancellable through `stop()`.
  void tick();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timerHandle !== undefined) {
        scheduler.clearTimeout(timerHandle);
        timerHandle = undefined;
      }
    },
  };
}
