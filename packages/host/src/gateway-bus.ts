/**
 * In-process server-push event bus for the agents-js gateway (AJS-8).
 *
 * Publishers register named producer roles (`gateway.session.*`,
 * `gateway.harness.*`, `gateway.permission.*`, etc.) and emit events.
 * Subscribers attach a callback and receive every published event.
 * Delivery is fan-out best-effort within the process; subscribers that
 * throw are isolated and do not affect other subscribers.
 *
 * Transport (SSE / WebSocket / MCP adapter) sits on top of this bus and
 * is delivered in a later AJS-8 PR. This module ships the foundational
 * publish/subscribe primitive only.
 *
 * ## Envelope shape
 *
 * Every event carries an opaque event id, a dotted topic name, an
 * ISO-8601 timestamp, and a typed payload. Two optional metadata slots
 * — `sourcePrincipal` (who emitted) and `correlationId` (which
 * operator action this is part of) — are present in v1 with enforcement
 * deferred per the AJS-8 AC. Subscribers consuming the slots should
 * tolerate their absence.
 *
 * Repo-specific data lives in `payload`, never in protocol-shaped
 * envelope fields. Keeps the envelope reusable across publishers.
 *
 * ## What this bus is NOT
 *
 * - Not a network primitive — in-process only. The SSE endpoint
 *   (separate PR) is what crosses the process boundary.
 * - Not durable — subscribers miss events emitted while disconnected.
 *   Backed-storage durability is a v2 concern.
 * - Not topic-filtered at the bus layer — every subscriber sees every
 *   event. Filtering happens in the subscriber or the transport
 *   adapter, not here. Keeps the bus core minimal.
 */

/**
 * Identity principal slot. Placeholder until the agents-js/identity
 * phase-1 types land per DOT-392 — at that point this alias is replaced
 * with the imported type. Kept loose (open record) so the eventual
 * replacement does not require a wire break.
 */
export interface IdentityPrincipal {
  /** Principal classification (e.g. `"matrix"`, `"a2a-peer"`, `"workload"`). */
  kind: string;
  /** Stable identifier within the principal's namespace. */
  id: string;
  /** Optional human-readable display name. */
  displayName?: string;
}

/** Typed envelope for every gateway bus event. */
export interface GatewayBusEvent<TPayload = unknown> {
  /** Opaque event id, unique per event (UUID v4 in v1). */
  id: string;
  /** Dotted topic name. e.g. `"gateway.session.created"`. */
  type: string;
  /** ISO-8601 UTC timestamp the event was published. */
  ts: string;
  /** Who/what emitted. Optional in v1 (enforcement deferred). */
  sourcePrincipal?: IdentityPrincipal;
  /** Ties related events together. Optional in v1. */
  correlationId?: string;
  /** Repo-specific data. Lives here, never in envelope fields above. */
  payload: TPayload;
}

/** Subscriber callback shape. Receives every published event. */
export type GatewayBusSubscriber = (event: GatewayBusEvent<unknown>) => void;

/** Unsubscribe handle returned from `subscribe`. */
export type GatewayBusUnsubscribe = () => void;

/** Public surface of the bus primitive. */
export interface GatewayBus {
  /**
   * Publish an event to every attached subscriber. Subscribers that
   * throw are isolated — their errors are caught and reported to the
   * optional `onSubscriberError` hook supplied at construction.
   */
  publish<TPayload>(event: GatewayBusEvent<TPayload>): void;
  /**
   * Attach a subscriber. Returns an unsubscribe function. Calling the
   * unsubscribe handle is idempotent.
   */
  subscribe(subscriber: GatewayBusSubscriber): GatewayBusUnsubscribe;
  /** Number of currently attached subscribers (useful for tests / metrics). */
  subscriberCount(): number;
}

/** Optional construction-time hooks. */
export interface CreateGatewayBusOptions {
  /**
   * Called when a subscriber throws. Default behavior: `console.warn`
   * with the event id and error. Tests can override to assert isolation
   * without polluting test output.
   */
  onSubscriberError?: (error: unknown, event: GatewayBusEvent<unknown>) => void;
}

const defaultSubscriberErrorHandler = (error: unknown, event: GatewayBusEvent<unknown>): void => {
  console.warn(`[gateway-bus] subscriber threw on event id=${event.id} type=${event.type}`, error);
};

/**
 * Create a new in-process gateway bus. Each call returns an
 * independent bus instance — typical gateway deployments instantiate
 * exactly one and pass the handle to publishers and transport
 * adapters.
 */
export function createGatewayBus(options: CreateGatewayBusOptions = {}): GatewayBus {
  const subscribers = new Set<GatewayBusSubscriber>();
  const onSubscriberError = options.onSubscriberError ?? defaultSubscriberErrorHandler;

  return {
    publish(event) {
      // Snapshot subscribers so that a subscriber calling unsubscribe
      // (or another subscribe) during delivery does not perturb the
      // current fan-out pass.
      const snapshot = Array.from(subscribers);
      for (const subscriber of snapshot) {
        try {
          subscriber(event);
        } catch (error) {
          onSubscriberError(error, event);
        }
      }
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(subscriber);
      };
    },
    subscriberCount() {
      return subscribers.size;
    },
  };
}

/**
 * Construct a `GatewayBusEvent` envelope with the standard `id` + `ts`
 * fields populated. Publishers should use this rather than building
 * envelopes inline so that the id generation + timestamp shape stays
 * uniform across the codebase.
 */
export function buildGatewayBusEvent<TPayload>(input: {
  type: string;
  payload: TPayload;
  sourcePrincipal?: IdentityPrincipal;
  correlationId?: string;
}): GatewayBusEvent<TPayload> {
  return {
    id: crypto.randomUUID(),
    type: input.type,
    ts: new Date().toISOString(),
    ...(input.sourcePrincipal !== undefined && { sourcePrincipal: input.sourcePrincipal }),
    ...(input.correlationId !== undefined && { correlationId: input.correlationId }),
    payload: input.payload,
  };
}
