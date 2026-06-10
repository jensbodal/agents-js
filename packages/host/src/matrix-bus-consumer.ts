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

import { parseDispatchDirective as parseStrictDispatchDirective } from "@agents-js/a2a-client";
import type { DispatchFailureReason } from "@agents-js/policy";
import {
  buildGatewayBusEvent,
  type GatewayBus,
  type GatewayBusEvent,
  type GatewayBusUnsubscribe,
  type IdentityPrincipal,
} from "./gateway-bus.ts";

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
   * Typed failure-reason discriminator. Present iff `kind === "failure"`.
   * Lets the bridge (or any reply consumer) distinguish the DOT-393
   * Phase B retry-vs-surface decision:
   *
   *   - `{ kind: "dispatch_error", message? }` — dispatch handler
   *     returned/threw a typed error from the agent runtime. Surface
   *     to user; do NOT retry via fallback.
   *   - `{ kind: "consumer_unreachable", message? }` — no dispatch
   *     handler responded (subscription not attached yet, in-process
   *     bus dropped the event, downstream consumer crashed). Bridge
   *     MAY retry via the direct HTTP A2A fallback path.
   *   - `{ kind: "dispatch_timeout", message? }` — handler accepted
   *     the request but did not return within the deadline. Bridge MAY
   *     retry but with longer deadline; surfacing is also acceptable.
   *   - Permission-layer kinds (`workspace_boundary_violation`,
   *     `no_allow_option`, `unknown_operation_class`,
   *     `no_workspace_identity_path`) — emitted by `@agents-js/acp-host`
   *     permission gate. Surface to user; do NOT retry (deterministic
   *     denial would hit the same gate).
   *
   * **Wire shape (AJS-79 PR3b, flip-in-place, 2026-05-27):** typed
   * `DispatchFailureReason` object on the SAME `failureReason` field
   * the legacy kebab-string union used to occupy. PR #29 in dot-matrix
   * bridge (`router.py` `_normalize_failure_reason`) accepts BOTH
   * shapes on this field name during the in-place transition — no V2
   * field, no migration window, breaking change. There are no external
   * consumers of this wire shape; only dot-matrix bridge reads it, and
   * the bridge has already been updated + deployed.
   */
  failureReason?: DispatchFailureReason;
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
   * Typed failure discriminator. Optional and only meaningful when
   * `status === "failure"`. See {@link MatrixBusReplyPayload.failureReason}
   * for the DOT-393 retry-vs-surface semantics each kind implies.
   */
  failureReason?: DispatchFailureReason;
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
        publishReply({
          bus: opts.bus,
          replyPrincipal,
          inboundEvent: event,
          matrixEvent,
          result: {
            status: "failure",
            body: stringifyError(error),
            failureReason: { kind: "dispatch_error", message: stringifyError(error) },
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
  // Single source of truth for `@@agent-name` recognition: the strict
  // alphanumeric-dash contract in `@agents-js/a2a-client`. This keeps the
  // Matrix consumer and the host runtime agreeing on what counts as a dispatch
  // (a name that isn't alphanumeric-dash is NOT a directive). The local
  // `{ target, message }` shape is preserved for existing callers; when no
  // directive is present we return the body verbatim as the (non-dispatch)
  // message so audit subscribers still see it.
  const directive = parseStrictDispatchDirective(body);
  if (!directive) return { target: "", message: body };
  return { target: directive.agentName, message: directive.payload };
}

function publishReply(args: {
  bus: GatewayBus;
  replyPrincipal: IdentityPrincipal;
  inboundEvent: GatewayBusEvent<unknown>;
  matrixEvent: MatrixBusEventPayload;
  result: DispatchResult;
}): void {
  const replyPayload: MatrixBusReplyPayload = {
    roomId: args.matrixEvent.roomId,
    body: args.result.body,
    kind: args.result.status,
    ...(args.matrixEvent.eventId !== undefined && { inReplyToEventId: args.matrixEvent.eventId }),
    ...(args.result.failureReason !== undefined && { failureReason: args.result.failureReason }),
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
