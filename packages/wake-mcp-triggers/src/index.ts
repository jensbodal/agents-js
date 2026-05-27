/**
 * `@agents-js/wake-mcp-triggers` — in-session-push wake-adapter runtime.
 *
 * **AJS-96** — first impl of the AJS-89 HYBRID `in-session-push` shape.
 * Gateway side: serialize an {@link InSessionPushWakeAdapter} into an MCP
 * server-initiated notification frame and dispatch it via a caller-supplied
 * notification sink. Harness side: dedupe by {@link WakeIdempotencyKey} and
 * drop signals whose wall-clock expiry has passed before the harness handler
 * runs.
 *
 * The runtime is intentionally framework-free — it takes function
 * dependencies (notification sink, audit hook, clock) and returns small
 * objects, so it composes with any MCP server impl (e.g.
 * `extras/mcp-bus-bridge`'s `createMcpBusBridgeServer`, or a future native
 * MCP server inside agents-js).
 *
 * Contract invariants (per the AJS-96 critique reduction):
 *   - Adapter MUST NOT mutate signal state in the gateway store — gateway
 *     dedups before re-emit; the adapter is stateless.
 *   - Adapter MUST drop expired signals at dispatch time (audit only;
 *     never wire-emit a signal whose `expiresAtMs` has passed).
 *   - Receiver MUST drop signals where `Date.now() >= expiresAtMs` on
 *     arrival (clock-drift across the gateway↔harness boundary is tolerated
 *     because both sides use wall-clock; the receiver is the source of
 *     truth for "did this signal arrive too late to act on").
 *   - Receiver MUST deduplicate by `idempotencyKey` for at least the TTL
 *     window. Gateway re-emit on retry uses the same key so the receiver
 *     collapses duplicates.
 *
 * @packageDocumentation
 */

import {
  type InSessionPushWakeAdapter,
  isWakeSignalExpired,
  type WakeIdempotencyKey,
  type WakeSignalId,
} from "@agents-js/wake-types";

/**
 * MCP server-initiated notification frame (subset of JSON-RPC notification
 * shape — `method` + `params` only, no `id`). Mirrors the shape used by
 * `extras/mcp-bus-bridge/src/event-mapper.ts` so dispatchers + bridges can
 * share a sink without coupling to either side's package.
 */
export interface McpNotification {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Default MCP notification method namespace for in-session-push wake
 * dispatch. Bridge servers route notifications by method prefix; this is
 * the wake-adapter's canonical namespace.
 */
export const DEFAULT_WAKE_NOTIFICATION_METHOD = "notifications/wake";

/**
 * Audit event emitted by the dispatcher. Audit is **lossless** — every
 * dispatch attempt produces exactly one event (dispatched or
 * expired_on_dispatch). Receivers emit their own audit shape (see
 * {@link InSessionPushReceiverAuditEvent}).
 */
export type InSessionPushDispatcherAuditEvent =
  | {
      readonly kind: "dispatched";
      readonly signalId: WakeSignalId;
      readonly idempotencyKey: WakeIdempotencyKey;
      readonly nowMs: number;
    }
  | {
      readonly kind: "expired_on_dispatch";
      readonly signalId: WakeSignalId;
      readonly idempotencyKey: WakeIdempotencyKey;
      readonly expiresAtMs: number;
      readonly nowMs: number;
    };

/**
 * Outcome of a single dispatch attempt. `dispatched` means the
 * notification was handed to the sink (sink errors propagate via
 * thrown exceptions, not via this discriminator). `expired_on_dispatch`
 * means the signal was already expired when the dispatcher ran — no
 * wire emission happened.
 */
export type DispatchOutcome =
  | { readonly status: "dispatched" }
  | {
      readonly status: "expired_on_dispatch";
      readonly expiresAtMs: number;
      readonly nowMs: number;
    };

/** Deps for {@link createInSessionPushDispatcher}. */
export interface InSessionPushDispatcherDeps {
  /**
   * Sink that delivers the notification to whatever MCP server the
   * gateway is fronting. Throws propagate to the caller (gateway).
   */
  readonly notificationSink: (notification: McpNotification) => Promise<void>;
  /**
   * Wall-clock millisecond source. Default: {@link Date.now}. Override
   * for deterministic testing.
   */
  readonly now?: () => number;
  /**
   * Optional audit hook. Called exactly once per dispatch attempt
   * (after the sink for `dispatched`, before any wire activity for
   * `expired_on_dispatch`). Audit errors are swallowed — the dispatcher
   * never lets telemetry failures shadow real dispatch outcomes.
   */
  readonly audit?: (event: InSessionPushDispatcherAuditEvent) => void;
  /**
   * Notification method to use. Defaults to
   * {@link DEFAULT_WAKE_NOTIFICATION_METHOD}. Override only if
   * coordinating with a non-default harness-side handler.
   */
  readonly method?: string;
}

/** Handle returned from {@link createInSessionPushDispatcher}. */
export interface InSessionPushDispatcher {
  /**
   * Serialize `adapter` to an MCP notification and dispatch via the
   * sink. Drops + audits expired signals without wire emission.
   */
  dispatch(adapter: InSessionPushWakeAdapter): Promise<DispatchOutcome>;
}

/**
 * Construct the gateway-side dispatcher for the in-session-push shape.
 */
export function createInSessionPushDispatcher(
  deps: InSessionPushDispatcherDeps,
): InSessionPushDispatcher {
  const now = deps.now ?? Date.now;
  const method = deps.method ?? DEFAULT_WAKE_NOTIFICATION_METHOD;
  const emitAudit = (event: InSessionPushDispatcherAuditEvent): void => {
    if (!deps.audit) return;
    try {
      deps.audit(event);
    } catch {
      // Audit hook errors are swallowed; the dispatcher's job is signal
      // delivery, not telemetry reliability.
    }
  };

  return {
    async dispatch(adapter: InSessionPushWakeAdapter): Promise<DispatchOutcome> {
      const nowMs = now();
      if (isWakeSignalExpired(adapter, () => nowMs)) {
        emitAudit({
          kind: "expired_on_dispatch",
          signalId: adapter.signalId,
          idempotencyKey: adapter.idempotencyKey,
          expiresAtMs: adapter.expiresAtMs,
          nowMs,
        });
        return {
          status: "expired_on_dispatch",
          expiresAtMs: adapter.expiresAtMs,
          nowMs,
        };
      }

      const notification = serializeInSessionPushAdapter(adapter, method);
      await deps.notificationSink(notification);

      emitAudit({
        kind: "dispatched",
        signalId: adapter.signalId,
        idempotencyKey: adapter.idempotencyKey,
        nowMs,
      });

      return { status: "dispatched" };
    },
  };
}

/**
 * Serialize an in-session-push adapter into the on-the-wire MCP
 * notification shape. Pure function — exported for symmetry with
 * {@link parseInSessionPushNotification} so harnesses can assert the
 * round-trip on tests.
 */
export function serializeInSessionPushAdapter(
  adapter: InSessionPushWakeAdapter,
  method: string = DEFAULT_WAKE_NOTIFICATION_METHOD,
): McpNotification {
  return {
    method,
    params: {
      shape: adapter.shape,
      signalId: adapter.signalId,
      target: adapter.target,
      expiresAtMs: adapter.expiresAtMs,
      idempotencyKey: adapter.idempotencyKey,
      ...(adapter.correlationId !== undefined ? { correlationId: adapter.correlationId } : {}),
      payload: adapter.payload,
    },
  };
}

/**
 * Reason a parsed notification was rejected by
 * {@link parseInSessionPushNotification}. Receivers can switch on this
 * with `assertNever`-enforced exhaustiveness so adding a new validation
 * path is a structural change.
 */
export type ParseRejectionReason =
  | "wrong_method"
  | "missing_shape"
  | "wrong_shape"
  | "missing_signal_id"
  | "missing_target"
  | "missing_expires_at"
  | "missing_idempotency_key"
  | "missing_payload";

/**
 * Result of {@link parseInSessionPushNotification}: either a typed
 * adapter ready for receiver dedup/expiry checks, or a rejection with
 * a reason code. Never throws on shape mismatch — the harness should
 * audit-log the rejection and continue.
 */
export type ParseResult =
  | { readonly ok: true; readonly adapter: InSessionPushWakeAdapter }
  | { readonly ok: false; readonly reason: ParseRejectionReason };

/**
 * Parse an MCP notification frame back into a typed
 * {@link InSessionPushWakeAdapter}. Harness-side helper — the inverse
 * of {@link serializeInSessionPushAdapter}.
 */
export function parseInSessionPushNotification(
  notification: McpNotification,
  expectedMethod: string = DEFAULT_WAKE_NOTIFICATION_METHOD,
): ParseResult {
  if (notification.method !== expectedMethod) {
    return { ok: false, reason: "wrong_method" };
  }
  const params = notification.params;
  if (typeof params.shape !== "string") {
    return { ok: false, reason: "missing_shape" };
  }
  if (params.shape !== "in-session-push") {
    return { ok: false, reason: "wrong_shape" };
  }
  if (typeof params.signalId !== "string") {
    return { ok: false, reason: "missing_signal_id" };
  }
  if (typeof params.target !== "object" || params.target === null) {
    return { ok: false, reason: "missing_target" };
  }
  if (typeof params.expiresAtMs !== "number") {
    return { ok: false, reason: "missing_expires_at" };
  }
  if (typeof params.idempotencyKey !== "string") {
    return { ok: false, reason: "missing_idempotency_key" };
  }
  if (typeof params.payload !== "object" || params.payload === null) {
    return { ok: false, reason: "missing_payload" };
  }

  const adapter: InSessionPushWakeAdapter = {
    shape: "in-session-push",
    signalId: params.signalId as InSessionPushWakeAdapter["signalId"],
    target: params.target as InSessionPushWakeAdapter["target"],
    expiresAtMs: params.expiresAtMs,
    idempotencyKey: params.idempotencyKey as InSessionPushWakeAdapter["idempotencyKey"],
    ...(typeof params.correlationId === "string" ? { correlationId: params.correlationId } : {}),
    payload: params.payload as Readonly<Record<string, unknown>>,
  };
  return { ok: true, adapter };
}

/**
 * Audit event emitted by the receiver. Mirrors the dispatcher's
 * audit-once invariant: every `accept()` call produces exactly one
 * event.
 */
export type InSessionPushReceiverAuditEvent =
  | {
      readonly kind: "accepted";
      readonly signalId: WakeSignalId;
      readonly idempotencyKey: WakeIdempotencyKey;
      readonly nowMs: number;
    }
  | {
      readonly kind: "expired_on_receipt";
      readonly signalId: WakeSignalId;
      readonly idempotencyKey: WakeIdempotencyKey;
      readonly expiresAtMs: number;
      readonly nowMs: number;
    }
  | {
      readonly kind: "duplicate_suppressed";
      readonly signalId: WakeSignalId;
      readonly idempotencyKey: WakeIdempotencyKey;
      readonly firstSeenExpiresAtMs: number;
      readonly nowMs: number;
    };

/**
 * Outcome of a single receiver `accept()` call. `accepted` means the
 * harness should process the signal; the other two mean the harness
 * should drop it silently from a processing standpoint (the receiver
 * already audited the drop).
 */
export type AcceptOutcome =
  | { readonly status: "accepted" }
  | {
      readonly status: "expired_on_receipt";
      readonly expiresAtMs: number;
      readonly nowMs: number;
    }
  | {
      readonly status: "duplicate_suppressed";
      readonly firstSeenExpiresAtMs: number;
      readonly nowMs: number;
    };

/** Deps for {@link createInSessionPushReceiver}. */
export interface InSessionPushReceiverDeps {
  /**
   * Wall-clock millisecond source. Default: {@link Date.now}. Override
   * for deterministic testing.
   */
  readonly now?: () => number;
  /**
   * Caller-owned dedup cache: `idempotencyKey → expiresAtMs`. The
   * receiver writes into this map on `accepted` and reads from it to
   * detect duplicates. Caller is responsible for periodically pruning
   * entries with `expiresAtMs <= now` — `dropExpiredEntries` is
   * provided as a convenience.
   *
   * Why caller-owned: harness lifecycles vary (long-lived MCP session,
   * per-turn process, multi-tenant) and the right pruning cadence is
   * harness-specific. The receiver doesn't own a background timer.
   */
  readonly dedupCache: Map<WakeIdempotencyKey, number>;
  /**
   * Optional audit hook. See {@link InSessionPushReceiverAuditEvent}.
   * Errors are swallowed (same rationale as the dispatcher's audit).
   */
  readonly audit?: (event: InSessionPushReceiverAuditEvent) => void;
}

/** Handle returned from {@link createInSessionPushReceiver}. */
export interface InSessionPushReceiver {
  /**
   * Decide whether to process `adapter`. Returns `accepted` only if
   * the signal is unexpired AND not a duplicate by idempotency key.
   * Audits exactly one event regardless of outcome.
   */
  accept(adapter: InSessionPushWakeAdapter): AcceptOutcome;
  /**
   * Prune dedup entries whose `expiresAtMs <= now()`. Returns the
   * number of entries removed. Safe to call on any cadence — pure
   * convenience. The dedup cache is owned by the caller; this just
   * walks it.
   */
  dropExpiredEntries(): number;
}

/**
 * Construct the harness-side receiver for the in-session-push shape.
 */
export function createInSessionPushReceiver(
  deps: InSessionPushReceiverDeps,
): InSessionPushReceiver {
  const now = deps.now ?? Date.now;
  const emitAudit = (event: InSessionPushReceiverAuditEvent): void => {
    if (!deps.audit) return;
    try {
      deps.audit(event);
    } catch {
      // Receiver audit errors are swallowed; see dispatcher rationale.
    }
  };

  return {
    accept(adapter: InSessionPushWakeAdapter): AcceptOutcome {
      const nowMs = now();
      if (isWakeSignalExpired(adapter, () => nowMs)) {
        emitAudit({
          kind: "expired_on_receipt",
          signalId: adapter.signalId,
          idempotencyKey: adapter.idempotencyKey,
          expiresAtMs: adapter.expiresAtMs,
          nowMs,
        });
        return {
          status: "expired_on_receipt",
          expiresAtMs: adapter.expiresAtMs,
          nowMs,
        };
      }

      const firstSeenExpiresAtMs = deps.dedupCache.get(adapter.idempotencyKey);
      if (firstSeenExpiresAtMs !== undefined) {
        emitAudit({
          kind: "duplicate_suppressed",
          signalId: adapter.signalId,
          idempotencyKey: adapter.idempotencyKey,
          firstSeenExpiresAtMs,
          nowMs,
        });
        return {
          status: "duplicate_suppressed",
          firstSeenExpiresAtMs,
          nowMs,
        };
      }

      deps.dedupCache.set(adapter.idempotencyKey, adapter.expiresAtMs);
      emitAudit({
        kind: "accepted",
        signalId: adapter.signalId,
        idempotencyKey: adapter.idempotencyKey,
        nowMs,
      });
      return { status: "accepted" };
    },
    dropExpiredEntries(): number {
      const nowMs = now();
      let removed = 0;
      for (const [key, expiresAtMs] of deps.dedupCache) {
        if (expiresAtMs <= nowMs) {
          deps.dedupCache.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
