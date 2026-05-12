/**
 * Internal publishers for the gateway bus (AJS-8).
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
 * Follow-up PRs will add publishers for:
 * - `gateway.session.*` from ACPSessionController lifecycle hooks
 * - `gateway.harness.*` from harness child spawn/exit + agent-card changes
 * - Structured failure events (model-unresolved, auth-failed) from
 *   in-repo harness adapters per the AJS-8 AC's revised approach
 *
 * The wrapper pattern (return a `{ record, recent, reset }` that
 * delegates to the underlying emitter + publishes on the bus) keeps
 * the AuditEmitter consumer API unchanged — callers swap the wrapped
 * instance in at construction time and nothing else has to know.
 */

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
