/**
 * Internal publishers for the gateway bus.
 *
 * Publishers are named producer roles that turn existing gateway state
 * into structured `GatewayBusEvent` envelopes. Each publisher wraps or
 * observes a specific lifecycle surface (audit emitter, ACPSessionController,
 * harness child process, ...) and re-emits onto the bus as a typed event.
 *
 * This module ships the **audit-emitter wrapper publisher** that
 * republishes every recorded audit event onto the bus as a
 * `gateway.audit.<event-kind>` event. Subscribers can fan out a UI
 * banner, a log stream, or any other consumer without polling the
 * audit ring buffer.
 *
 * Follow-up publishers will cover:
 * - `gateway.session.*` from ACPSessionController lifecycle hooks
 * - `gateway.harness.*` from harness child spawn/exit + agent-card changes
 * - Structured failure events (model-unresolved, auth-failed) from
 *   in-repo harness adapters
 *
 * The wrapper pattern (return a `{ record, recent, reset }` that
 * delegates to the underlying emitter + publishes on the bus) keeps
 * the AuditEmitter consumer API unchanged — callers swap the wrapped
 * instance in at construction time and nothing else has to know.
 */

import type { HarnessCapabilityEntry } from "@agents-js/a2a";

import type { AuditEmitter, AuditEvent } from "./audit.ts";
import { buildGatewayBusEvent, type GatewayBus, type IdentityPrincipal } from "./gateway-bus.ts";

/**
 * Map an audit event's `kind` to a dotted bus topic name.
 *
 * Existing audit kinds use kebab-case (`agui-run-started`,
 * `a2a-task-finished`, `mention-dispatch-blocked`, ...). The bus topic
 * convention uses dots (`gateway.audit.agui-run-started`,
 * `gateway.session.created`, etc.). For v1 we preserve the original
 * kebab string as the topic suffix; consumers wanting finer routing
 * can still filter on the kind via the payload field.
 */
function topicForAuditEvent(event: AuditEvent): string {
  return `gateway.audit.${event.kind}`;
}

/** Options for the audit-emitter wrapper publisher. */
export interface WrapAuditEmitterAsBusPublisherOptions {
  /** The bus to publish onto. */
  bus: GatewayBus;
  /** The underlying audit emitter to wrap. */
  emitter: AuditEmitter;
  /**
   * Optional source-principal annotation applied to every published
   * bus event. Useful for distinguishing audit-publisher emissions
   * from other gateway-internal publishers. Defaults to
   * `{ kind: "workload", id: "gateway-audit-publisher" }`.
   */
  sourcePrincipal?: IdentityPrincipal;
}

const DEFAULT_AUDIT_PUBLISHER_PRINCIPAL: IdentityPrincipal = {
  kind: "workload",
  id: "gateway-audit-publisher",
};

/**
 * Wrap an existing {@link AuditEmitter} so every recorded event is
 * also published on the gateway bus. The wrapped emitter has the same
 * shape as the underlying one — callers swap it in at construction
 * and nothing else has to change.
 *
 * The returned emitter:
 *
 * - Delegates `record` to the underlying emitter and uses its
 *   stamped-event return value to publish a `gateway.audit.<kind>`
 *   event on the bus, with the audit event as the `payload`. The
 *   audit event's `correlationId` is propagated to the bus envelope
 *   so subscribers can correlate across surfaces. Reading the return
 *   value (rather than the ring buffer) means the publish path works
 *   for any `bufferSize`, including `0`.
 * - Delegates `recent` and `reset` to the underlying emitter
 *   unchanged. The bus does not retain history — that's the
 *   underlying emitter's job.
 *
 * Multiple publishers can wrap a single emitter; calls to the wrapped
 * `record` short-circuit through to the same underlying buffer.
 */
export function wrapAuditEmitterAsBusPublisher(
  options: WrapAuditEmitterAsBusPublisherOptions,
): AuditEmitter {
  const { bus, emitter } = options;
  const sourcePrincipal = options.sourcePrincipal ?? DEFAULT_AUDIT_PUBLISHER_PRINCIPAL;

  return {
    record(eventInput) {
      const stamped = emitter.record(eventInput);
      bus.publish(
        buildGatewayBusEvent({
          type: topicForAuditEvent(stamped),
          payload: stamped,
          correlationId: stamped.correlationId,
          sourcePrincipal,
        }),
      );
      return stamped;
    },
    recent(limit) {
      return emitter.recent(limit);
    },
    reset() {
      emitter.reset();
    },
  };
}

/**
 * Payload for `gateway.harness.child-spawned` bus events. Emitted when
 * the gateway successfully spawns an ACP child process for a curated
 * harness (whether eagerly at startup or lazily on first routed session).
 *
 * Includes the full `capabilities.harnesses` snapshot so subscribers can
 * observe the fleet state at the spawn moment without separately
 * polling the agent-card surface.
 */
export interface GatewayHarnessChildSpawnedPayload {
  /** Curated harness id. */
  harnessId: string;
  /**
   * OS pid of the spawned ACP child, `null` when the injected
   * `createProcess` (mock) returns no real child. Typed as `number | null`
   * (not `undefined`) so the field survives `JSON.stringify` on the
   * `/events` SSE wire — `undefined` properties are omitted entirely
   * by `JSON.stringify`, which would break subscribers expecting a
   * stable shape.
   */
  pid: number | null;
  /** Display name from the runtime definition. */
  harnessDisplayName: string;
  /** Full capabilities.harnesses snapshot at spawn time. */
  capabilities: HarnessCapabilityEntry[];
}

/**
 * Payload for `gateway.harness.child-exited` bus events.
 * Emitted when the ACP child for a curated harness exits — either as
 * part of gateway-initiated teardown (`crash: false`) or unexpectedly
 * (`crash: true`).
 *
 * `crash: true` covers any exit not preceded by a gateway destroy()
 * call, including code===0 self-exit (agent walked away unilaterally).
 */
export interface GatewayHarnessChildExitedPayload {
  harnessId: string;
  /** Same `number | null` convention as `child-spawned` to survive JSON.stringify. */
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  /** True when exit was unexpected (no gateway destroy() call), false for gateway-initiated teardown. */
  crash: boolean;
  /** Wall-clock spawn-to-exit duration in milliseconds. */
  durationMs: number;
}

/**
 * Payload for `gateway.harness.card-changed` bus events. Emitted when
 * the per-harness slice of `capabilities.harnesses` changes after
 * subscribed lifecycle events (`mode_changed`, `permission_gating_status`,
 * `config_option_changed`) — only on diff, never on no-op recomputes.
 */
export interface GatewayHarnessCardChangedPayload {
  harnessId: string;
  /** capabilities.harnesses entry for this harness before the change. */
  previousEntry: HarnessCapabilityEntry;
  /** capabilities.harnesses entry for this harness after the change. */
  newEntry: HarnessCapabilityEntry;
}

/**
 * Publish a `gateway.harness.child-spawned` event onto the bus. The
 * source principal is annotated as `{ kind: "harness", id: harnessId }`
 * so subscribers can route per-harness without inspecting the payload.
 */
export function publishHarnessChildSpawned(
  bus: GatewayBus,
  payload: GatewayHarnessChildSpawnedPayload,
): void {
  bus.publish(
    buildGatewayBusEvent({
      type: "gateway.harness.child-spawned",
      payload,
      sourcePrincipal: { kind: "harness", id: payload.harnessId },
    }),
  );
}

/**
 * Publish a `gateway.harness.child-exited` event onto the bus. The
 * `crash` boolean on the payload distinguishes gateway-initiated
 * teardown from unexpected exit; both flow through this single
 * publisher so subscribers see a uniform event shape.
 */
export function publishHarnessChildExited(
  bus: GatewayBus,
  payload: GatewayHarnessChildExitedPayload,
): void {
  bus.publish(
    buildGatewayBusEvent({
      type: "gateway.harness.child-exited",
      payload,
      sourcePrincipal: { kind: "harness", id: payload.harnessId },
    }),
  );
}

/**
 * Publish a `gateway.harness.card-changed` event onto the bus. Callers
 * are responsible for diffing — this publisher does not. Including both
 * `previousEntry` and `newEntry` in the payload keeps subscribers from
 * having to maintain their own shadow state of the agent card.
 */
export function publishHarnessCardChanged(
  bus: GatewayBus,
  payload: GatewayHarnessCardChangedPayload,
): void {
  bus.publish(
    buildGatewayBusEvent({
      type: "gateway.harness.card-changed",
      payload,
      sourcePrincipal: { kind: "harness", id: payload.harnessId },
    }),
  );
}
