/**
 * Matrix-shaped bridge publisher.
 *
 * Thin wrapper over `@agents-js/host`'s generic
 * {@link buildBridgeBusEvent} / {@link publishBridgeEventToBus}
 * primitives. The core agents-js packages stay source-agnostic; this
 * package adds the Matrix-specific knobs (canonical topic, sender
 * MXID → source-principal mapping, the payload shape mirroring
 * `matrix_nio_bridge.py`'s extracts).
 *
 * Architectural boundary: `@agents-js/host` ships the generic bridge
 * primitive and never mentions Matrix; this package depends on host
 * one-way and adds the Matrix-flavored defaults. Any future bridge
 * (Slack, GitHub webhooks, Discord) gets its own
 * `@agents-js/<source>-bridge` extras package alongside this one and
 * reuses the same host primitive.
 *
 * Why ship a builder when the actual Matrix bridge process is Python?
 *
 * 1. **Reference shape.** `matrix_nio_bridge.py` and any future
 *    Matrix consumers (in-process tests, alternative bridge variants)
 *    need to produce envelopes that match what `/admin/publish`
 *    validates and what SSE subscribers can statically type against.
 *    A canonical TS builder eliminates drift.
 * 2. **Source-principal convention.** Matrix events have a natural
 *    source identity (the sender MXID). Centralizing the default
 *    `{ kind: "matrix", id: "<sender>" }` mapping here keeps
 *    audit/correlation surfaces consistent across bridge variants
 *    and tests.
 *
 * Topic naming
 *
 * V1 emits a single topic — `gateway.matrix.event-received`. Finer
 * routing (per-Matrix-event-type, per-room, etc.) is a v2 concern;
 * for the demo milestone the consumer filters on `payload.type` /
 * `payload.roomId` if it wants narrower selection.
 */

import {
  buildBridgeBusEvent,
  type GatewayBus,
  type GatewayBusEvent,
  type IdentityPrincipal,
  publishBridgeEventToBus,
} from "@agents-js/host";

/**
 * Minimum Matrix event shape that the gateway bridge contract
 * accepts. Mirrors the subset of fields that `matrix_nio_bridge.py`
 * already extracts from incoming `m.room.message` (and related)
 * events. All extension fields are intentionally absent — bridges
 * that need richer payloads must publish a different topic.
 */
export interface MatrixBridgeEventInput {
  /** Matrix room identifier (`!roomid:server`). */
  roomId: string;
  /** Sender MXID (`@user:server`). */
  sender: string;
  /** Matrix event type, e.g. `"m.room.message"`, `"m.reaction"`. */
  type: string;
  /** Server-assigned Matrix event id (`$eventid`), when known. */
  eventId?: string;
  /** Message body, when the Matrix event has one. */
  body?: string;
  /** Pass-through msgtype (`"m.text"`, `"m.notice"`, etc.). */
  msgtype?: string;
}

/** Topic for every Matrix bridge event in v1. */
export const MATRIX_BRIDGE_EVENT_TOPIC = "gateway.matrix.event-received" as const;

/** Canonical `kind` for Matrix-sourced source principals. */
export const MATRIX_SOURCE_PRINCIPAL_KIND = "matrix" as const;

/** Options for {@link buildMatrixBusEvent}. */
export interface BuildMatrixBusEventOptions {
  /** The Matrix event to translate. */
  matrixEvent: MatrixBridgeEventInput;
  /**
   * Optional correlation token threaded through downstream
   * consumers. Useful when one Matrix event triggers a multi-step
   * gateway operation (e.g. a `@mention` dispatch) and the bus
   * subscriber wants to follow the full causal chain.
   */
  correlationId?: string;
  /**
   * Source-principal override. Defaults to
   * `{ kind: "matrix", id: <matrixEvent.sender> }` so subscribers can
   * filter events by Matrix author without parsing the payload.
   */
  sourcePrincipal?: IdentityPrincipal;
}

/**
 * Build a `gateway.matrix.event-received` bus envelope from a Matrix
 * event. The returned envelope is ready to be `bus.publish(...)`'d
 * in-process or serialized into the `/admin/publish` JSON body for
 * out-of-process bridges.
 *
 * The Matrix event becomes the envelope `payload` verbatim — no
 * field renaming, no content stripping. Subscribers see exactly what
 * the bridge captured.
 */
export function buildMatrixBusEvent(
  options: BuildMatrixBusEventOptions,
): GatewayBusEvent<MatrixBridgeEventInput> {
  return buildBridgeBusEvent<MatrixBridgeEventInput>({
    topic: MATRIX_BRIDGE_EVENT_TOPIC,
    payload: options.matrixEvent,
    sourcePrincipal:
      options.sourcePrincipal ?? defaultMatrixSourcePrincipal(options.matrixEvent.sender),
    correlationId: options.correlationId,
  });
}

/** Options for {@link publishMatrixEventToBus}. */
export interface PublishMatrixEventToBusOptions extends BuildMatrixBusEventOptions {
  /** The bus to publish onto. */
  bus: GatewayBus;
}

/**
 * In-process convenience: build the envelope and publish it on the
 * supplied bus. Returns the envelope so callers can inspect/assert
 * on the server-populated `id` + `ts` fields.
 *
 * Out-of-process bridges (like `matrix_nio_bridge.py`) do NOT use
 * this — they build the envelope with {@link buildMatrixBusEvent}
 * and POST it to `/admin/publish` over HTTP. This helper exists for
 * tests and any future in-process bridge integrations.
 */
export function publishMatrixEventToBus(
  options: PublishMatrixEventToBusOptions,
): GatewayBusEvent<MatrixBridgeEventInput> {
  return publishBridgeEventToBus<MatrixBridgeEventInput>({
    bus: options.bus,
    topic: MATRIX_BRIDGE_EVENT_TOPIC,
    payload: options.matrixEvent,
    sourcePrincipal:
      options.sourcePrincipal ?? defaultMatrixSourcePrincipal(options.matrixEvent.sender),
    correlationId: options.correlationId,
  });
}

function defaultMatrixSourcePrincipal(sender: string): IdentityPrincipal {
  return { kind: MATRIX_SOURCE_PRINCIPAL_KIND, id: sender };
}
