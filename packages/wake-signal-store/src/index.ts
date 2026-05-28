/**
 * `@agents-js/wake-signal-store` — durable wake-signal store for the
 * AJS-89 HYBRID gateway substrate.
 *
 * **Scaffold status (2026-05-28)**: this is the interface + in-memory
 * stub scaffold landed in PR opening the wake-signal-store package per
 * lane split with ajs-claude (matrix event
 * `$ytUsW1dHJUAt7JS5AtxZRugmhPKCy2cFKhNuZMM0OVY`). The actual durable
 * backends (SQLite, Postgres) land in follow-up PRs.
 *
 * ## Responsibility
 *
 * Gateway-side persistence of wake signals. The publisher writes signals
 * into the store; per-harness terminal adapters (e.g.
 * `@agents-js/claude-channel-adapter` for Claude Code) read signals
 * destined for their harness and mark them delivered. The store enforces
 * at-least-once delivery semantics via idempotency-key dedup.
 *
 * ## Architecture (per ADR-0007)
 *
 * The store is the SOURCE half of the AJS-89 HYBRID architecture. It
 * lives in a separate package (not folded into `@agents-js/host` or
 * `@agents-js/gateway-runtime`) so that:
 *
 * 1. Multiple consumers (publisher, channel adapters, future harness
 *    adapters) can depend on it without pulling host/gateway transitive
 *    deps.
 * 2. The persistence backend can be swapped (in-memory → SQLite →
 *    Postgres) without touching consumer code. The `Backend` interface
 *    is the swap point.
 *
 * The Backend interface intentionally narrow: read/write/delete/list
 * primitives only. Higher-level semantics (TTL handling,
 * idempotency-key dedup, GC) live in `WakeSignalStore` so all backends
 * inherit identical correctness.
 *
 * @packageDocumentation
 */

import type {
  WakeAdapter,
  WakeIdempotencyKey,
  WakeSignalId,
  WakeTarget,
} from "@agents-js/wake-types";

// ============================================================================
// Stored record shape
// ============================================================================

/**
 * The shape persisted into the store. Carries the full {@link WakeAdapter}
 * payload alongside store-side metadata (creation time, delivery state).
 *
 * Receivers MUST NOT mutate this record directly — go through the store
 * interface so dedup + GC invariants stay correct.
 */
export interface WakeSignalRecord {
  /** Signal id, allocated by the gateway at signal-creation time. */
  readonly signalId: WakeSignalId;

  /** Idempotency key for at-least-once dedup. Stable across retries. */
  readonly idempotencyKey: WakeIdempotencyKey;

  /** Target the wake should be delivered to. */
  readonly target: WakeTarget;

  /** Wake-adapter payload (shape-discriminated; see `@agents-js/wake-types`). */
  readonly adapter: WakeAdapter;

  /** Wall-clock time when the gateway wrote this signal. */
  readonly createdAtMs: number;

  /**
   * Wall-clock expiry. Signals are GC'd after this time. Receivers drop
   * arriving signals where `Date.now() >= expiresAtMs` (per AJS-96
   * contract).
   */
  readonly expiresAtMs: number;

  /**
   * Set when the signal has been handed to a terminal adapter for delivery.
   * Used to enforce at-least-once via dedup — the store does not re-deliver
   * a signal whose `(signalId, idempotencyKey)` pair has been marked
   * delivered, even if the publisher retries.
   *
   * Undefined means not yet delivered.
   */
  readonly deliveredAtMs?: number;
}

// ============================================================================
// Backend interface — the persistence swap point
// ============================================================================

/**
 * Persistence backend for the wake-signal store. The Backend handles raw
 * storage primitives; the `WakeSignalStore` wrapper layers TTL/dedup/GC
 * semantics on top.
 *
 * Implementations:
 *  - {@link InMemoryWakeSignalStoreBackend} — process-local, lost on
 *    gateway restart. Useful for tests + single-replica gateway with no
 *    durability requirements.
 *  - SQLite backend (deferred follow-up PR) — durable per-gateway.
 *  - Postgres backend (deferred follow-up PR) — durable + multi-replica.
 *
 * The Backend is intentionally minimal: it does NOT know about TTL or
 * dedup. Those live in the WakeSignalStore wrapper so all backends share
 * one correctness story.
 */
export interface WakeSignalStoreBackend {
  /** Insert a new record. Throws if the signalId is already present. */
  put(record: WakeSignalRecord): Promise<void>;

  /** Fetch a record by id. Returns undefined if absent. */
  get(signalId: WakeSignalId): Promise<WakeSignalRecord | undefined>;

  /** Update an existing record (e.g. setting `deliveredAtMs`). */
  update(record: WakeSignalRecord): Promise<void>;

  /** Remove a record. No-op if absent. */
  delete(signalId: WakeSignalId): Promise<void>;

  /**
   * List records whose target matches the given filter. Used by terminal
   * adapters to pull their queued signals. Records returned should be in
   * `createdAtMs` ascending order (oldest first) so the adapter delivers
   * in publish order.
   */
  listByTarget(target: WakeTarget): Promise<readonly WakeSignalRecord[]>;

  /**
   * List records that have expired (`expiresAtMs <= now`). Used by GC.
   */
  listExpired(nowMs: number): Promise<readonly WakeSignalRecord[]>;
}

// ============================================================================
// In-memory backend
// ============================================================================

/**
 * Process-local in-memory implementation of {@link WakeSignalStoreBackend}.
 *
 * **Durability**: none. Records are lost on gateway restart. Use for
 * tests + single-replica deployments where signal-loss-on-restart is
 * acceptable.
 *
 * **Concurrency**: thread-safe within a single JS event loop (V8/Bun
 * single-threaded execution model). For cross-process concurrency, use
 * SQLite or Postgres backend.
 *
 * Implementation note: uses a `Map<WakeSignalId, WakeSignalRecord>` keyed
 * by signal id. `listByTarget` does a linear scan + filter; acceptable
 * for the gateway's expected signal volume (low thousands max at any
 * given moment). If volume grows, swap to a durable backend.
 */
export class InMemoryWakeSignalStoreBackend implements WakeSignalStoreBackend {
  private readonly records = new Map<WakeSignalId, WakeSignalRecord>();

  async put(record: WakeSignalRecord): Promise<void> {
    if (this.records.has(record.signalId)) {
      throw new Error(
        `wake-signal-store: signalId ${String(record.signalId)} already present`,
      );
    }
    this.records.set(record.signalId, record);
  }

  async get(signalId: WakeSignalId): Promise<WakeSignalRecord | undefined> {
    return this.records.get(signalId);
  }

  async update(record: WakeSignalRecord): Promise<void> {
    if (!this.records.has(record.signalId)) {
      throw new Error(
        `wake-signal-store: signalId ${String(record.signalId)} not present (update)`,
      );
    }
    this.records.set(record.signalId, record);
  }

  async delete(signalId: WakeSignalId): Promise<void> {
    this.records.delete(signalId);
  }

  async listByTarget(target: WakeTarget): Promise<readonly WakeSignalRecord[]> {
    const matches: WakeSignalRecord[] = [];
    for (const record of this.records.values()) {
      if (targetEquals(record.target, target)) {
        matches.push(record);
      }
    }
    matches.sort((a, b) => a.createdAtMs - b.createdAtMs);
    return matches;
  }

  async listExpired(nowMs: number): Promise<readonly WakeSignalRecord[]> {
    const expired: WakeSignalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.expiresAtMs <= nowMs) {
        expired.push(record);
      }
    }
    return expired;
  }
}

// ============================================================================
// High-level store wrapper — TTL + dedup semantics live here
// ============================================================================

/**
 * Dependencies for {@link createWakeSignalStore}.
 */
export interface WakeSignalStoreDeps {
  readonly backend: WakeSignalStoreBackend;

  /** Clock injection point. Defaults to `() => Date.now()` if not provided. */
  readonly now?: () => number;
}

/**
 * Wake signal store handle. Wraps the persistence backend with TTL +
 * dedup + GC semantics. Terminal adapters and publishers consume through
 * this interface, not the raw Backend.
 */
export interface WakeSignalStore {
  /**
   * Write a new signal. Throws if the signalId is already present
   * (publisher must ensure uniqueness; gateway typically allocates via
   * monotonic counter + ULID).
   */
  put(record: WakeSignalRecord): Promise<void>;

  /**
   * Fetch a signal. Returns undefined if absent or expired.
   */
  get(signalId: WakeSignalId): Promise<WakeSignalRecord | undefined>;

  /**
   * Pull signals destined for a target, excluding expired and
   * already-delivered records. Returned in createdAtMs ascending order.
   */
  pullPending(target: WakeTarget): Promise<readonly WakeSignalRecord[]>;

  /**
   * Mark a signal as delivered. Idempotent — calling twice with the same
   * `(signalId, idempotencyKey)` returns the same result (delivered).
   * Returns true if the signal was newly marked delivered, false if it
   * was already delivered (dedup hit).
   *
   * Throws if the signalId is absent or the idempotency key doesn't match
   * the stored record's key.
   */
  markDelivered(
    signalId: WakeSignalId,
    idempotencyKey: WakeIdempotencyKey,
  ): Promise<boolean>;

  /**
   * Physically remove expired signals. Returns the count removed.
   * Callers run this on a schedule; the store itself does not auto-GC.
   */
  gcExpired(): Promise<number>;
}

/**
 * Construct a wake signal store over a persistence backend.
 *
 * The store enforces:
 *  - TTL filtering on `get` and `pullPending` (expired signals are
 *    invisible to readers even before GC runs).
 *  - At-least-once dedup via `markDelivered` — calling twice with the
 *    same idempotency key returns false on the second call.
 *  - Explicit GC: `gcExpired()` physically removes expired records.
 */
export function createWakeSignalStore(
  deps: WakeSignalStoreDeps,
): WakeSignalStore {
  const { backend } = deps;
  const now = deps.now ?? (() => Date.now());

  return {
    async put(record) {
      await backend.put(record);
    },

    async get(signalId) {
      const record = await backend.get(signalId);
      if (record === undefined) return undefined;
      if (record.expiresAtMs <= now()) return undefined;
      return record;
    },

    async pullPending(target) {
      const all = await backend.listByTarget(target);
      const nowMs = now();
      return all.filter(
        (r) => r.expiresAtMs > nowMs && r.deliveredAtMs === undefined,
      );
    },

    async markDelivered(signalId, idempotencyKey) {
      const record = await backend.get(signalId);
      if (record === undefined) {
        throw new Error(
          `wake-signal-store: cannot mark delivered, signalId ${String(signalId)} absent`,
        );
      }
      if (record.idempotencyKey !== idempotencyKey) {
        throw new Error(
          `wake-signal-store: idempotency key mismatch on ${String(signalId)}`,
        );
      }
      if (record.deliveredAtMs !== undefined) {
        return false; // already delivered — dedup hit
      }
      await backend.update({ ...record, deliveredAtMs: now() });
      return true;
    },

    async gcExpired() {
      const nowMs = now();
      const expired = await backend.listExpired(nowMs);
      for (const record of expired) {
        await backend.delete(record.signalId);
      }
      return expired.length;
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function targetEquals(a: WakeTarget, b: WakeTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "session" && b.kind === "session") {
    return a.sessionId === b.sessionId;
  }
  if (a.kind === "agent" && b.kind === "agent") {
    return a.agentName === b.agentName;
  }
  // unreachable — kinds already compared
  return false;
}
