/**
 * Matrix bus consumer (E4.0-b, ADR 0002 surface #2 + #3 + #4).
 *
 * Subscribes to the gateway bus, filters for `gateway.matrix.event-received`
 * topic, parses `@@target` dispatch directives from the Matrix message
 * body, invokes the supplied dispatch handler (typically wired to
 * `HostA2AExecutor` via the gateway's own A2A endpoint), and publishes
 * the result back as a `gateway.matrix.reply-sent` event for the bridge
 * (or any other consumer) to relay to Matrix.
 *
 * Why a separate consumer instead of HostA2AExecutor reading the bus
 * directly: ADR 0002 surface #3 keeps the dispatcher transport-
 * invariant — it doesn't know about Matrix, Slack, or any specific
 * bridge. This consumer is one of N transport-specific bridges (Matrix
 * today; Slack/webhook/audio later) that translate transport-native
 * events into the substrate dispatch path.
 *
 * Per cognee-claude's E4.0-b reviewer scope (locked 2026-05-18 20:11
 * PDT): preserves DOT-393 Phase B fallback semantics — when the
 * dispatch callback returns a non-success result, the consumer emits
 * a typed failure event but does NOT take down the subscription. The
 * out-of-process bridge (matrix_nio_bridge.py) is expected to fall
 * back to direct HTTP A2A on persistent failures, but that decision
 * lives in the bridge, not here.
 *
 * Status: skeleton + test stubs landed; full dispatch wiring + bridge
 * swap follow-up commits per the locked tests-first discipline.
 */

import type { DispatchFailureReason } from "@agents-js/policy";
import {
  buildGatewayBusEvent,
  type GatewayBus,
  type GatewayBusEvent,
  type GatewayBusUnsubscribe,
  type IdentityPrincipal,
} from "./gateway-bus.ts";

/**
 * Legacy kebab-case failure-reason vocabulary used on the
 * `MatrixBusReplyPayload.failureReason` wire field. Three values mirror
 * the three dispatch-transport kinds in {@link DispatchFailureReason}.
 *
 * **AJS-79 PR3b-2 (additive widening, 2026-05-27):** retained alongside
 * the new typed {@link MatrixBusReplyPayload.failureReasonV2} field so
 * consumers (in-repo `apps/internal-gateway`, out-of-repo dot-matrix
 * `router.py`) can migrate at their own pace during the deprecation
 * window. Removal happens in AJS-79 PR3b-narrow after the dot-matrix
 * bridge adopts the typed shape.
 */
export type LegacyFailureReasonKebab =
  | "dispatch-error"
  | "consumer-unreachable"
  | "dispatch-timeout";

/**
 * Matrix event payload shape that this consumer recognizes. Mirrors
 * `MatrixBridgeEventInput` in `@agents-js/matrix-bridge` — duplicated
 * here as a structural type so this package does not depend on the
 * matrix-bridge extras package (avoid a host → extras dependency
 * cycle).
 */
export interface MatrixBusEventPayload {
  roomId: string;
  sender: string;
  type: string;
  eventId?: string;
  body?: string;
  msgtype?: string;
}

/**
 * Reply payload shape emitted by this consumer onto
 * `gateway.matrix.reply-sent`. The bridge (or any other consumer
 * subscribed to that topic) relays this back to the originating
 * Matrix room.
 */
export interface MatrixBusReplyPayload {
  /** Room to send the reply into — mirrors the inbound `roomId`. */
  roomId: string;
  /** The Matrix event id that triggered this reply, when known. */
  inReplyToEventId?: string;
  /** Reply body (text). */
  body: string;
  /** `"success"` from dispatch result, `"failure"` from a dispatch error. */
  kind: "success" | "failure";
  /**
   * Legacy kebab-case failure-reason discriminator. Present iff
   * `kind === "failure"`. Distinguishes the DOT-393 Phase B
   * retry-vs-surface decision at the federation boundary:
   *
   *   - `"dispatch-error"` — dispatch handler returned/threw a typed
   *     error from the agent runtime. Treat as legitimate agent failure;
   *     surface to user, do NOT retry via fallback.
   *   - `"consumer-unreachable"` — no dispatch handler responded (e.g.
   *     subscription not attached yet, in-process bus dropped the
   *     event, downstream consumer crashed). Bridge MAY retry via the
   *     direct HTTP A2A fallback path.
   *   - `"dispatch-timeout"` — handler accepted the request but did not
   *     return within the deadline. Bridge MAY retry but with longer
   *     deadline; surfacing to user is also acceptable.
   *
   * **AJS-79 PR3b-2 (additive widening, 2026-05-27):** preserved as the
   * deprecation-window compatibility surface. The typed
   * {@link failureReasonV2} field is emitted alongside this one — new
   * consumers SHOULD read `failureReasonV2` first and fall back to
   * `failureReason` only for receivers that have not yet migrated.
   * Use {@link extractFailureReason} to get a typed value from either
   * field in one call.
   *
   * Removed in a future AJS-79 PR3b-narrow once the dot-matrix bridge
   * `router.py` adopts the typed shape and the deprecation window
   * closes.
   */
  failureReason?: LegacyFailureReasonKebab;
  /**
   * Typed failure-reason payload (AJS-79 PR3b-2 additive widening).
   * Present iff `kind === "failure"`, emitted alongside
   * {@link failureReason} during the deprecation window.
   *
   * Consumers SHOULD prefer this field over the legacy
   * {@link failureReason} kebab string — it carries the same retry-
   * vs-surface semantics PLUS an optional `message` for human-readable
   * surface and, when produced by the permission gate, an
   * `operationClass` for diagnostic context.
   *
   * Use {@link extractFailureReason} to get a typed value from either
   * field — that helper preserves backward compatibility for receivers
   * that emit only the legacy field.
   */
  failureReasonV2?: DispatchFailureReason;
}

/**
 * Dispatch invocation interface. The consumer translates a Matrix
 * event into a `DispatchRequest` and the caller (typically wired to
 * the host runtime via the gateway's own A2A endpoint) runs it
 * and returns a `DispatchResult`.
 *
 * Keeping this as an injected callback (rather than calling the host
 * runtime directly) preserves ADR 0002's surface-3 transport-
 * invariance: the runtime doesn't need to know about Matrix; the
 * consumer doesn't need to depend on A2A internals.
 */
export interface DispatchRequest {
  /**
   * The target identifier extracted from `@@target` directive in
   * the Matrix message body. Empty string when no directive present.
   */
  target: string;
  /** Message text after the directive has been stripped. */
  message: string;
  /** Original Matrix event metadata, threaded through for audit. */
  matrixEvent: MatrixBusEventPayload;
  /** Correlation id from the inbound bus event envelope, if any. */
  correlationId?: string;
}

export interface DispatchResult {
  /** `"success"` when dispatch returned a usable reply; `"failure"` otherwise. */
  status: "success" | "failure";
  /** Reply body to relay back to Matrix. */
  body: string;
  /**
   * Legacy kebab-case failure discriminator. Optional and only meaningful
   * when `status === "failure"`. See
   * {@link MatrixBusReplyPayload.failureReason} for the DOT-393 retry-vs-
   * surface semantics each value implies.
   *
   * AJS-79 PR3b-2 (additive widening): handlers SHOULD also populate
   * {@link failureReasonV2} so the consumer can emit both fields onto
   * the wire payload. If only one of the two is set, the consumer
   * derives the other via {@link convertLegacyFailureReason} /
   * {@link extractFailureReason} so both wire fields are always present
   * during the deprecation window.
   */
  failureReason?: LegacyFailureReasonKebab;
  /**
   * Typed failure-reason payload (AJS-79 PR3b-2 additive widening).
   * Carries the snake_case {@link DispatchFailureReason} kind plus
   * an optional human-readable `message` (transport failures) or
   * `operationClass` (permission failures).
   */
  failureReasonV2?: DispatchFailureReason;
}

export type DispatchHandler = (request: DispatchRequest) => Promise<DispatchResult>;

/** Topic constants — kept in sync with `@agents-js/matrix-bridge`. */
export const MATRIX_INBOUND_TOPIC = "gateway.matrix.event-received" as const;
export const MATRIX_REPLY_TOPIC = "gateway.matrix.reply-sent" as const;

/** Optional construction-time hooks. */
export interface StartMatrixBusConsumerOptions {
  /** The bus to subscribe + publish on. */
  bus: GatewayBus;
  /** Dispatch invocation handler. */
  dispatch: DispatchHandler;
  /**
   * Source principal stamped on outbound reply events. Defaults to
   * `{ kind: "matrix-bus-consumer", id: "default" }`. Override when
   * multiple consumer instances coexist (testing, federation).
   */
  replySourcePrincipal?: IdentityPrincipal;
  /**
   * Called when the dispatch handler throws. Default: `console.warn`.
   * Tests override to assert isolation; production wires this to the
   * gateway's structured log.
   */
  onDispatchError?: (error: unknown, request: DispatchRequest) => void;
}

/** Handle returned from `startMatrixBusConsumer`. */
export interface MatrixBusConsumerHandle {
  /** Idempotent unsubscribe; stops further dispatch invocations. */
  stop: () => void;
  /** Whether the consumer is currently subscribed. */
  readonly active: boolean;
}

/**
 * Start consuming `gateway.matrix.event-received` events from the bus
 * and invoking the supplied dispatch handler. Returns a handle that
 * can stop the subscription.
 *
 * Subscriber isolation: a throwing `dispatch` handler does NOT take
 * down the consumer — the error is reported through `onDispatchError`
 * (or `console.warn` by default) and the consumer continues. Same for
 * malformed payloads (logged + skipped, never thrown out of the
 * subscriber).
 */
export function startMatrixBusConsumer(
  opts: StartMatrixBusConsumerOptions,
): MatrixBusConsumerHandle {
  const onDispatchError = opts.onDispatchError ?? defaultDispatchErrorHandler;
  const replyPrincipal = opts.replySourcePrincipal ?? defaultReplySourcePrincipal();

  let active = true;
  let unsubscribe: GatewayBusUnsubscribe | null = null;

  unsubscribe = opts.bus.subscribe((event) => {
    if (!active) return;
    if (event.type !== MATRIX_INBOUND_TOPIC) return;
    if (!isMatrixPayload(event.payload)) {
      onDispatchError(new Error(`malformed matrix payload on event id=${event.id}`), {
        target: "",
        message: "",
        matrixEvent: {} as MatrixBusEventPayload,
        correlationId: event.correlationId,
      });
      return;
    }

    const matrixEvent = event.payload;
    const { target, message } = parseDispatchDirective(matrixEvent.body ?? "");
    const request: DispatchRequest = {
      target,
      message,
      matrixEvent,
      ...(event.correlationId !== undefined && { correlationId: event.correlationId }),
    };

    // Fire-and-forget — the consumer doesn't block the bus subscriber
    // loop on the dispatch round-trip. Errors thrown by the handler
    // are isolated to this event.
    void opts
      .dispatch(request)
      .then((result) => {
        publishReply({
          bus: opts.bus,
          replyPrincipal,
          inboundEvent: event,
          matrixEvent,
          result,
        });
      })
      .catch((error: unknown) => {
        onDispatchError(error, request);
        const message = stringifyError(error);
        publishReply({
          bus: opts.bus,
          replyPrincipal,
          inboundEvent: event,
          matrixEvent,
          result: {
            status: "failure",
            body: message,
            failureReason: "dispatch-error",
            failureReasonV2: { kind: "dispatch_error", message },
          },
        });
      });
  });

  return {
    stop: () => {
      if (!active) return;
      active = false;
      unsubscribe?.();
    },
    get active() {
      return active;
    },
  };
}

/**
 * Parse `@@target ...rest` from a Matrix message body. Returns
 * `target: ""` when no directive prefix is present (consumer treats
 * that as "no dispatch", but the body may still be useful for audit
 * subscribers).
 *
 * The directive recognizer mirrors the host runtime's `@@target`
 * convention so the consumer and runtime agree on what counts as a
 * dispatch request without parsing runtime internals.
 */
export function parseDispatchDirective(body: string): { target: string; message: string } {
  // Strict format: `@@<target>` followed by whitespace then the rest.
  // Leading whitespace is tolerated; trailing whitespace on the
  // target token is the delimiter.
  const trimmed = body.trimStart();
  if (!trimmed.startsWith("@@")) return { target: "", message: body };
  const afterPrefix = trimmed.slice(2);
  const wsMatch = /\s/.exec(afterPrefix);
  if (wsMatch === null) {
    // Body is exactly `@@target` with no message. Empty message; target is the rest.
    return { target: afterPrefix, message: "" };
  }
  const target = afterPrefix.slice(0, wsMatch.index);
  const message = afterPrefix.slice(wsMatch.index + wsMatch[0].length);
  return { target, message };
}

function publishReply(args: {
  bus: GatewayBus;
  replyPrincipal: IdentityPrincipal;
  inboundEvent: GatewayBusEvent<unknown>;
  matrixEvent: MatrixBusEventPayload;
  result: DispatchResult;
}): void {
  // AJS-79 PR3b-2 (additive): emit both legacy kebab + typed V2 on the
  // wire. If the dispatch handler populated only one of the two,
  // derive the other so consumers always see both during the
  // deprecation window. After AJS-79 PR3b-narrow lands, only V2 will
  // remain.
  const legacyKebab = args.result.failureReason;
  const typedV2 =
    args.result.failureReasonV2 ??
    (legacyKebab !== undefined ? convertLegacyFailureReason(legacyKebab) : undefined);
  const replyPayload: MatrixBusReplyPayload = {
    roomId: args.matrixEvent.roomId,
    body: args.result.body,
    kind: args.result.status,
    ...(args.matrixEvent.eventId !== undefined && { inReplyToEventId: args.matrixEvent.eventId }),
    ...(legacyKebab !== undefined && { failureReason: legacyKebab }),
    ...(typedV2 !== undefined && { failureReasonV2: typedV2 }),
  };
  args.bus.publish(
    buildGatewayBusEvent<MatrixBusReplyPayload>({
      type: MATRIX_REPLY_TOPIC,
      payload: replyPayload,
      sourcePrincipal: args.replyPrincipal,
      ...(args.inboundEvent.correlationId !== undefined && {
        correlationId: args.inboundEvent.correlationId,
      }),
    }),
  );
}

function isMatrixPayload(value: unknown): value is MatrixBusEventPayload {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.roomId === "string" && typeof v.sender === "string" && typeof v.type === "string";
}

function defaultReplySourcePrincipal(): IdentityPrincipal {
  return { kind: "matrix-bus-consumer", id: "default" };
}

function defaultDispatchErrorHandler(error: unknown, request: DispatchRequest): void {
  console.warn(
    `[matrix-bus-consumer] dispatch failed target=${request.target} room=${request.matrixEvent.roomId}`,
    error,
  );
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Map a legacy kebab-case {@link LegacyFailureReasonKebab} to the
 * typed {@link DispatchFailureReason} shape. Used by {@link publishReply}
 * to derive the V2 field when the dispatch handler populated only the
 * legacy field, and by {@link extractFailureReason} for receivers
 * reading the legacy field on inbound payloads.
 *
 * Mapping (snake_case typed kind on left, kebab on right):
 *   - `dispatch_error` ← `"dispatch-error"`
 *   - `consumer_unreachable` ← `"consumer-unreachable"`
 *   - `dispatch_timeout` ← `"dispatch-timeout"`
 *
 * Adding a new {@link LegacyFailureReasonKebab} member is a structural
 * widening — every site that switches on the kebab union (including
 * this function) must widen in lockstep. The function uses an
 * exhaustive switch with `assertNever`-style fallthrough so a missing
 * mapping is a typecheck error.
 *
 * AJS-79 PR3b-2 (additive widening, 2026-05-27).
 */
export function convertLegacyFailureReason(
  legacy: LegacyFailureReasonKebab,
): DispatchFailureReason {
  switch (legacy) {
    case "dispatch-error":
      return { kind: "dispatch_error" };
    case "consumer-unreachable":
      return { kind: "consumer_unreachable" };
    case "dispatch-timeout":
      return { kind: "dispatch_timeout" };
    default: {
      const _exhaustive: never = legacy;
      throw new Error(`unreachable legacy failure-reason kebab: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Read the failure-reason from a {@link MatrixBusReplyPayload} (or any
 * structurally-compatible carrier) and return a typed
 * {@link DispatchFailureReason} or `undefined`.
 *
 * Resolution order:
 *   1. If `failureReasonV2` is present, return it.
 *   2. Else if `failureReason` (legacy kebab) is present, convert
 *      it via {@link convertLegacyFailureReason} and return.
 *   3. Otherwise return `undefined`.
 *
 * Use this helper in any read site that needs the typed shape — it
 * preserves backward compatibility for receivers that emit only the
 * legacy field during the deprecation window.
 *
 * AJS-79 PR3b-2 (additive widening, 2026-05-27).
 */
export function extractFailureReason(
  payload: Pick<MatrixBusReplyPayload, "failureReason" | "failureReasonV2">,
): DispatchFailureReason | undefined {
  if (payload.failureReasonV2 !== undefined) return payload.failureReasonV2;
  if (payload.failureReason !== undefined) return convertLegacyFailureReason(payload.failureReason);
  return undefined;
}
