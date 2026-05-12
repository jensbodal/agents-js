/**
 * Generic external-bridge publisher primitive for the gateway bus.
 *
 * The gateway does not connect to any specific external system — no
 * Matrix client, no Slack SDK, no GitHub library — that would pull
 * source-specific dependencies into the gateway process and conflate
 * concerns. Instead, external bridges (a Python Matrix sync watcher,
 * a Slack webhook receiver, etc.) capture events server-side and
 * POST them to the gateway's `/admin/publish` endpoint (see
 * {@link createBusPublishHandler}). This module is the canonical
 * envelope builder those bridges target: a pure function that turns
 * a caller-supplied `(topic, payload)` pair into a fully-typed
 * {@link GatewayBusEvent} matching the bus contract.
 *
 * Why ship a builder when external bridges are usually in other
 * languages?
 *
 * 1. **Reference shape.** The envelope contract (`id`, `ts`, `type`,
 *    `payload`, optional `sourcePrincipal`, optional `correlationId`)
 *    is what `/admin/publish` validates and what SSE subscribers
 *    statically type against. A canonical builder eliminates drift
 *    between the language a bridge happens to be written in and the
 *    shape the gateway expects.
 * 2. **In-process tests + in-process bridges.** Any code inside the
 *    monorepo that wants to inject bus events with bridge semantics
 *    (integration tests, in-process bridge variants) uses the same
 *    builder rather than reinventing the envelope.
 *
 * Topic and source semantics are **caller-supplied**. agents-js core
 * does not enumerate sources — every bridge picks its own topic
 * string (convention: `gateway.<source>.<verb>`) and supplies its
 * own `sourcePrincipal.kind` if it wants source-attributed
 * filtering. Source-specific helpers (e.g. Matrix-shaped defaults)
 * live in their own packages outside `@agents-js/host`.
 */

import type { IdentityPrincipal } from "./gateway-bus.ts";
import { buildGatewayBusEvent, type GatewayBus, type GatewayBusEvent } from "./gateway-bus.ts";

/** Options for {@link buildBridgeBusEvent}. */
export interface BuildBridgeBusEventOptions<TPayload> {
  /**
   * Bus topic for this event. Convention: `gateway.<source>.<verb>`
   * (e.g. `gateway.matrix.event-received`, `gateway.slack.message`,
   * `gateway.github.webhook`). Caller-owned — agents-js does not
   * enumerate sources.
   */
  topic: string;
  /** The bridge event payload. Shape is caller-defined. */
  payload: TPayload;
  /**
   * Optional source principal so subscribers can filter by author
   * without parsing the payload. Caller supplies; no default.
   */
  sourcePrincipal?: IdentityPrincipal;
  /**
   * Optional correlation token threaded through downstream
   * consumers. Useful when one bridge event triggers a multi-step
   * gateway operation and a bus subscriber wants to follow the full
   * causal chain.
   */
  correlationId?: string;
}

/**
 * Build a bus envelope from a caller-supplied topic + payload. The
 * returned envelope is ready for in-process publishing through
 * {@link GatewayBus.publish}, or for serialization into the
 * `/admin/publish` JSON body used by out-of-process bridges.
 *
 * The payload becomes the envelope `payload` verbatim — no field
 * renaming, no content stripping. Subscribers see exactly what the
 * bridge captured.
 */
export function buildBridgeBusEvent<TPayload>(
  options: BuildBridgeBusEventOptions<TPayload>,
): GatewayBusEvent<TPayload> {
  return buildGatewayBusEvent<TPayload>({
    type: options.topic,
    payload: options.payload,
    sourcePrincipal: options.sourcePrincipal,
    correlationId: options.correlationId,
  });
}

/** Options for {@link publishBridgeEventToBus}. */
export interface PublishBridgeEventToBusOptions<TPayload>
  extends BuildBridgeBusEventOptions<TPayload> {
  /** The bus to publish onto. */
  bus: GatewayBus;
}

/**
 * In-process convenience: build the envelope and publish it on the
 * supplied bus. Returns the envelope so callers can inspect or
 * assert on the server-populated `id` + `ts` fields.
 *
 * Out-of-process bridges (typically written in Python) do NOT use
 * this — they POST the JSON body to `/admin/publish` over HTTP. This
 * helper exists for tests and in-process bridge integrations.
 */
export function publishBridgeEventToBus<TPayload>(
  options: PublishBridgeEventToBusOptions<TPayload>,
): GatewayBusEvent<TPayload> {
  const envelope = buildBridgeBusEvent(options);
  options.bus.publish(envelope);
  return envelope;
}
