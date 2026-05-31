/**
 * `InboxPoller` — harness-agnostic poll/dedup/identity-guard loop.
 *
 * **Critique-first reasoning (boundaries/defaults/contracts/safety)**
 *
 * - **Boundary**: pulls durable-inbox rows via an injected {@link GatewayInboxClient}
 *   and hands each NEW row to an injected `onMessage` sink. It knows nothing
 *   about Claude Code channels or Matrix — the Claude Code launcher passes a
 *   sink that calls `emitChannelMessage`; the Codex launcher will pass its own.
 *   This is the reusable core across harnesses.
 * - **Default**: poll interval ~15s (README latency bar is <60s median),
 *   `limit` 10 rows/poll. Both overridable.
 * - **Contract**: dedup key is `idempotency_key ?? message_id` — bridge-fanout
 *   rows carry the key, native sends carry NULL so they fall back to id. A row
 *   is delivered to the sink AT MOST ONCE across the persisted window, and only
 *   after a successful sink call is it marked seen (a throwing sink leaves the
 *   row unseen so the next poll retries — wake delivery should not be silently
 *   dropped). Rows are delivered oldest-first.
 * - **Safety**: IDENTITY GUARD. If `getMessages` returns an `identity` that does
 *   not match the requested one, the poller STOPS, reports, and emits nothing —
 *   it must never surface another agent's inbox into this session. Transport
 *   errors trigger exponential backoff, not a crash.
 */

import type { CursorState, CursorStore } from "./cursor-store.ts";
import type { GatewayInboxClient, InboxMessage } from "./gateway-inbox-client.ts";

/** Minimal logger contract — `console` satisfies it. */
export interface PollerLogger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface InboxPollerOptions {
  readonly client: GatewayInboxClient;
  /** Identity whose inbox to read; the identity guard pins to this value. */
  readonly identity: string;
  /** Invoked once per new row, awaited, oldest-first. */
  onMessage(row: InboxMessage): void | Promise<void>;
  readonly cursorStore: CursorStore;
  readonly signal: AbortSignal;
  /** Poll interval (ms). Default 15000. */
  readonly intervalMs?: number;
  /** Rows fetched per poll. Default 10. */
  readonly limit?: number;
  /** Max dedup keys retained across restarts. Default 256. */
  readonly seenCap?: number;
  /** Max backoff (ms) after repeated transport errors. Default 60000. */
  readonly backoffMaxMs?: number;
  readonly logger?: PollerLogger;
  /** Sleep override (tests/fake clocks). */
  sleepImpl?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Dedup key: bridge-fanout idempotency key, else message id. */
export function dedupKey(row: InboxMessage): string {
  return (row.idempotency_key ?? undefined) || row.message_id;
}

/** Stable oldest-first order by `created_at` when present; else input order. */
function orderedOldestFirst(rows: InboxMessage[]): InboxMessage[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const ta = toTs(a.row.created_at);
      const tb = toTs(b.row.created_at);
      if (ta !== tb) return ta - tb;
      return a.i - b.i;
    })
    .map((x) => x.row);
}

function toTs(v: string | number | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * Run the poll loop until `signal` aborts. Returns on abort or on a fatal
 * identity-guard violation. Never throws on transport errors (backoff instead).
 */
export async function runInboxPoller(options: InboxPollerOptions): Promise<void> {
  const logger = options.logger ?? console;
  const intervalMs = options.intervalMs ?? 15_000;
  const limit = options.limit ?? 10;
  const seenCap = options.seenCap ?? 256;
  const backoffMaxMs = options.backoffMaxMs ?? 60_000;
  const sleep = options.sleepImpl ?? sleepWithAbort;

  const state: CursorState = options.cursorStore.load();
  const seen = new Set(state.seen);
  let backoffMs = intervalMs;

  const persist = (): void => {
    const trimmed = Array.from(seen).slice(-seenCap);
    seen.clear();
    for (const k of trimmed) seen.add(k);
    options.cursorStore.save({ seen: trimmed });
  };

  while (!options.signal.aborted) {
    let failed = false;
    try {
      const res = await options.client.getMessages({ identity: options.identity, limit });

      // IDENTITY GUARD — fatal. Never surface another identity's inbox.
      if (res.identity !== options.identity) {
        logger.error("[inbox-poller] identity mismatch — halting", {
          requested: options.identity,
          returned: res.identity,
        });
        return;
      }

      if (res.ok) {
        for (const row of orderedOldestFirst(res.messages)) {
          if (options.signal.aborted) break;
          const key = dedupKey(row);
          if (seen.has(key)) continue;
          try {
            await options.onMessage(row);
            // Mark seen only after a successful sink so a transient sink
            // failure retries on the next poll rather than dropping the wake.
            seen.add(key);
            persist();
          } catch (err) {
            logger.warn("[inbox-poller] sink failed; will retry next poll", {
              key,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } else {
        logger.warn("[inbox-poller] getMessages returned ok:false");
        failed = true;
      }
    } catch (err) {
      if (options.signal.aborted) return;
      logger.warn("[inbox-poller] getMessages error", {
        error: err instanceof Error ? err.message : String(err),
      });
      failed = true;
    }

    if (options.signal.aborted) return;
    await sleep(failed ? backoffMs : intervalMs, options.signal);
    backoffMs = failed ? Math.min(backoffMs * 2, backoffMaxMs) : intervalMs;
  }
}

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
