/**
 * `@agents-js/wake-channel-bridge` — gateway-side composition that closes
 * the AJS-89 HYBRID SOURCE → CC receiver loop.
 *
 * Per ADR-0007 (revised 2026-05-28), this bridge sits at the seam between
 * the gateway-side wake-signal store and the Claude Code receiver-side
 * adapter:
 *
 * ```
 *   WakeSignalStore (durable signals)            ← @agents-js/wake-signal-store
 *           │
 *           │ pullPending(target)
 *           ▼
 *   WakeChannelBridge (this package)             ← @agents-js/wake-channel-bridge
 *           │
 *           │ emitChannelMessage({content, sender, meta})
 *           ▼
 *   ClaudeChannelServer (MCP server)             ← @agents-js/claude-channel-adapter
 *           │
 *           │ notifications/claude/channel
 *           ▼
 *   Claude Code session (receives push)
 * ```
 *
 * The bridge is intentionally a thin composition layer. It does NOT own:
 * - signal lifecycle (the store does)
 * - emit semantics or sender-gate / sanitizer (the adapter does)
 * - polling schedule (caller does — bridge exposes drain and dispatch
 *   primitives; an external scheduler decides cadence)
 *
 * **Critique-first reasoning (boundaries/defaults/contracts/safety/validation)**
 *
 * - **Boundary**: this is the ONLY module that knows about both halves.
 *   wake-signal-store doesn't know about claude-channel-adapter; the
 *   adapter doesn't know about the store. The bridge is the seam.
 * - **Defaults**: caller supplies sender + content resolvers. There is
 *   no default mapping from `WakeSignalRecord.adapter` to channel
 *   message — the caller knows the semantic meaning of their wake
 *   adapter payload, not us.
 * - **Contracts**: `drainPending(target)` processes ALL pending signals
 *   for a target in store-order (createdAtMs ascending). Each signal
 *   produces exactly one `BridgeAttemptResult`. The store's at-least-once
 *   semantic is preserved: emitted signals are marked delivered; rejected
 *   signals (sender-gate or sanitizer) are NOT marked, leaving them for
 *   retry on the next drain.
 * - **Safety**: emit-then-mark order matters. If the bridge marked
 *   delivered BEFORE emit, a rejected emit would silently drop the
 *   signal. If we marked after emit but before the store ack, a crash
 *   between would re-emit on next drain — that's acceptable under
 *   at-least-once (receiver dedups by idempotencyKey per AJS-96 contract).
 * - **Validation**: integration tests cover: empty pending, single-emit
 *   round-trip, gate-rejection-not-marked, multi-signal ordering, and
 *   no-double-mark on retry.
 *
 * **Why "bridge" not "router" or "consumer"**
 *
 * It's a two-port adapter: store on one side, channel server on the
 * other. "Router" implies multi-destination; this bridge is per-target.
 * "Consumer" implies the bridge owns the lifecycle of what it consumes,
 * but the store owns lifecycle. "Bridge" is the most accurate noun.
 *
 * @packageDocumentation
 */

import type { ClaudeChannelServer } from "@agents-js/claude-channel-adapter";
import type { WakeSignalRecord, WakeSignalStore } from "@agents-js/wake-signal-store";
import type { WakeIdempotencyKey, WakeSignalId, WakeTarget } from "@agents-js/wake-types";

// ============================================================================
// Resolver protocol — caller maps WakeSignalRecord to channel-message fields
// ============================================================================

/**
 * Caller-supplied mapping from a stored wake signal record to the
 * channel-message fields the adapter emits. Caller knows the semantic
 * meaning of their wake payload; the bridge doesn't.
 */
export interface BridgeResolvers {
  /**
   * Derive the sender agent identity for sender-gate evaluation.
   * Caller decides whether to read it from the record's adapter payload,
   * a peer routing table, or wherever else makes sense.
   */
  sender(record: WakeSignalRecord): string;

  /**
   * Derive the text content for the `<channel>` body. Caller decides the
   * format — could be the wake adapter's payload as JSON, or a
   * pretty-printed prompt, or an arbitrary string.
   */
  content(record: WakeSignalRecord): string;

  /**
   * OPTIONAL: derive the meta record for the `<channel>` tag attributes.
   * Sanitizer requires identifier-shaped keys (underscores only); see
   * `@agents-js/claude-channel-adapter` `sanitizeMetaForChannel`.
   * Returning `undefined` is equivalent to no meta.
   */
  meta?(record: WakeSignalRecord): Readonly<Record<string, unknown>> | undefined;
}

// ============================================================================
// Attempt results — what happened per signal
// ============================================================================

/**
 * Result of attempting to drain a single signal through the bridge.
 * Discriminated union: caller can `switch` on `outcome` with
 * `assertNever`-enforced exhaustiveness.
 */
export type BridgeAttemptResult =
  | {
      readonly outcome: "emitted-and-marked";
      readonly signalId: WakeSignalId;
      readonly idempotencyKey: WakeIdempotencyKey;
    }
  | {
      readonly outcome: "emitted-but-dedup";
      readonly signalId: WakeSignalId;
      readonly idempotencyKey: WakeIdempotencyKey;
    }
  | {
      readonly outcome: "rejected-by-sender-gate";
      readonly signalId: WakeSignalId;
      readonly sender: string;
    }
  | {
      readonly outcome: "rejected-by-sanitizer";
      readonly signalId: WakeSignalId;
      readonly reason: string;
    }
  | {
      readonly outcome: "transport-error";
      readonly signalId: WakeSignalId;
      readonly error: string;
    }
  | {
      readonly outcome: "resolver-error";
      readonly signalId: WakeSignalId;
      readonly error: string;
    }
  | {
      readonly outcome: "emitted-but-mark-failed";
      readonly signalId: WakeSignalId;
      readonly idempotencyKey: WakeIdempotencyKey;
      readonly error: string;
    };

/**
 * Summary of a drain pass. `attempts` is in store-order (createdAtMs
 * ascending — the same order the store returns).
 */
export interface BridgeDrainResult {
  readonly target: WakeTarget;
  readonly attempts: readonly BridgeAttemptResult[];
}

// ============================================================================
// Bridge handle
// ============================================================================

/**
 * Dependencies for {@link createWakeChannelBridge}.
 */
export interface WakeChannelBridgeDeps {
  readonly store: WakeSignalStore;
  readonly server: ClaudeChannelServer;
  readonly resolvers: BridgeResolvers;
}

/**
 * Wake channel bridge handle. Caller drives drain/dispatch primitives;
 * an external scheduler decides cadence.
 */
export interface WakeChannelBridge {
  /**
   * Pull all pending signals for the target and attempt to emit each.
   * Returns per-signal attempt results in store-order.
   */
  drainPending(target: WakeTarget): Promise<BridgeDrainResult>;

  /**
   * Dispatch a single signal by id. Returns the per-signal result.
   * Returns `transport-error` if the signal is absent or already
   * delivered (so caller sees a discrete failure rather than silent skip).
   */
  dispatchOne(signalId: WakeSignalId): Promise<BridgeAttemptResult>;
}

/**
 * Construct a wake channel bridge over the store + adapter + resolvers.
 *
 * @example
 * ```ts
 * const bridge = createWakeChannelBridge({
 *   store: createWakeSignalStore({ backend: new InMemoryWakeSignalStoreBackend() }),
 *   server: createClaudeChannelServer({ ... }),
 *   resolvers: {
 *     sender: (r) => r.adapter.shape === "in-session-push" ? "matrix-bot" : "unknown",
 *     content: (r) => JSON.stringify(r.adapter.payload),
 *   },
 * });
 *
 * await bridge.drainPending({ kind: "session", sessionId: "alice-123" });
 * ```
 */
export function createWakeChannelBridge(deps: WakeChannelBridgeDeps): WakeChannelBridge {
  const { store, server, resolvers } = deps;

  async function emitAndMark(record: WakeSignalRecord): Promise<BridgeAttemptResult> {
    // Resolver exceptions contained per-signal: a thrown resolver does
    // NOT abort the entire drain. Per cognee-codex PR #96 review
    // (matrix event $VzFAeRIJpKm3xKFKuBaoPPNt199k-UPU6KfufYP19Jw).
    let sender: string;
    let content: string;
    let meta: Readonly<Record<string, unknown>> | undefined;
    try {
      sender = resolvers.sender(record);
      content = resolvers.content(record);
      meta = resolvers.meta?.(record);
    } catch (err) {
      return {
        outcome: "resolver-error",
        signalId: record.signalId,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    let emitResult: Awaited<ReturnType<ClaudeChannelServer["emitChannelMessage"]>>;
    try {
      emitResult = await server.emitChannelMessage({ content, sender, meta });
    } catch (err) {
      return {
        outcome: "transport-error",
        signalId: record.signalId,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    switch (emitResult.status) {
      case "emitted": {
        // markDelivered exceptions contained: a thrown markDelivered after
        // a successful emit produces emitted-but-mark-failed so caller can
        // see the exact state for retry/debug. Per cognee-codex PR #96 review.
        let newlyDelivered: boolean;
        try {
          newlyDelivered = await store.markDelivered(record.signalId, record.idempotencyKey);
        } catch (err) {
          return {
            outcome: "emitted-but-mark-failed",
            signalId: record.signalId,
            idempotencyKey: record.idempotencyKey,
            error: err instanceof Error ? err.message : String(err),
          };
        }
        return newlyDelivered
          ? {
              outcome: "emitted-and-marked",
              signalId: record.signalId,
              idempotencyKey: record.idempotencyKey,
            }
          : {
              outcome: "emitted-but-dedup",
              signalId: record.signalId,
              idempotencyKey: record.idempotencyKey,
            };
      }
      case "rejected-by-sender-gate":
        return {
          outcome: "rejected-by-sender-gate",
          signalId: record.signalId,
          sender: emitResult.sender,
        };
      case "rejected-by-sanitizer":
        return {
          outcome: "rejected-by-sanitizer",
          signalId: record.signalId,
          reason: emitResult.reason,
        };
      default: {
        // Future emit-result kinds: surface as transport-error until the
        // bridge's discriminated union is widened.
        const _exhaustive: never = emitResult;
        return {
          outcome: "transport-error",
          signalId: record.signalId,
          error: `unhandled emit-result: ${JSON.stringify(_exhaustive)}`,
        };
      }
    }
  }

  return {
    async drainPending(target) {
      const pending = await store.pullPending(target);
      const attempts: BridgeAttemptResult[] = [];
      for (const record of pending) {
        attempts.push(await emitAndMark(record));
      }
      return { target, attempts };
    },

    async dispatchOne(signalId) {
      const record = await store.get(signalId);
      if (record === undefined) {
        return {
          outcome: "transport-error",
          signalId,
          error: "signalId absent or expired in store",
        };
      }
      if (record.deliveredAtMs !== undefined) {
        return {
          outcome: "emitted-but-dedup",
          signalId,
          idempotencyKey: record.idempotencyKey,
        };
      }
      return await emitAndMark(record);
    },
  };
}
