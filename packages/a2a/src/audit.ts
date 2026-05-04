/**
 * Shared correlation/audit primitives for gateway control-plane events.
 *
 * Audit records carry structural metadata only: IDs, names, routes,
 * counts, states, and durations. They must not carry prompt bodies,
 * environment values, command arguments, tool payloads, or raw errors.
 */

/** Stable correlation token. UUIDv4 strings in practice; consumers should treat as opaque. */
export type CorrelationId = string;

/** Generate a fresh correlation id. */
export function newCorrelationId(): CorrelationId {
  return crypto.randomUUID();
}

/** Common shape every audit record must satisfy. */
interface BaseAuditEvent {
  /** ISO-8601 timestamp the record was created. */
  at: string;
  /** Stable token tying multiple records to the same operator action. */
  correlationId: CorrelationId;
}

/**
 * Closed set of audit-event variants. Each carries only structural
 * metadata and covers surfaces that emit records in source.
 */
export type AuditEvent =
  // -- AG-UI run lifecycle ---------------------------------------------
  | (BaseAuditEvent & {
      kind: "agui-run-started";
      runId: string;
      threadId: string;
    })
  | (BaseAuditEvent & {
      kind: "agui-run-finished";
      runId: string;
      threadId: string;
      stopReason?: string;
      durationMs?: number;
    })
  | (BaseAuditEvent & {
      kind: "agui-run-error";
      runId: string;
      threadId: string;
      /** Short error category, never the raw error message verbatim. */
      errorCategory: string;
    })
  | (BaseAuditEvent & {
      kind: "agui-run-disconnect-cancel";
      runId: string;
      threadId: string;
    })
  // -- A2A task lifecycle ----------------------------------------------
  | (BaseAuditEvent & {
      kind: "a2a-task-started";
      taskId: string;
      contextId: string;
    })
  | (BaseAuditEvent & {
      kind: "a2a-task-finished";
      taskId: string;
      contextId: string;
      state: "completed" | "failed" | "canceled";
    })
  // -- Registry peer sync ----------------------------------------------
  | (BaseAuditEvent & {
      kind: "registry-sync-served";
      path: string;
      recordCount: number;
      totalRecordCount: number;
    })
  | (BaseAuditEvent & {
      kind: "registry-sync-fetched";
      peerUrl: string;
      recordCount: number;
    })
  | (BaseAuditEvent & {
      kind: "registry-sync-merged";
      peerUrl: string;
      addedCount: number;
      updatedCount: number;
      unchangedCount: number;
      skippedLoopCount: number;
      conflictCount: number;
    })
  // -- ACP @mention dispatch -------------------------------------------
  | (BaseAuditEvent & {
      kind: "mention-dispatch-started";
      agentName: string;
      sessionId?: string;
    })
  | (BaseAuditEvent & {
      kind: "mention-dispatch-succeeded";
      agentName: string;
      agentUrl: string;
      sessionId?: string;
      durationMs?: number;
    })
  | (BaseAuditEvent & {
      kind: "mention-dispatch-failed";
      agentName: string;
      sessionId?: string;
      errorCategory: string;
      durationMs?: number;
    })
  | (BaseAuditEvent & {
      kind: "mention-dispatch-unknown";
      agentName: string;
      sessionId?: string;
    })
  | (BaseAuditEvent & {
      kind: "mention-dispatch-blocked";
      agentName: string;
      sessionId?: string;
      reason: "policy";
    })
  // -- ACP @@dispatch ---------------------------------------------------
  | (BaseAuditEvent & {
      kind: "dispatch-started";
      agentName: string;
      harness: string;
      kindVariant: "a2a" | "acp";
      taskId: string;
    })
  | (BaseAuditEvent & {
      kind: "dispatch-finished";
      agentName: string;
      harness: string;
      kindVariant: "a2a" | "acp";
      taskId: string;
      state: "completed" | "failed";
      durationMs?: number;
    });

type ForbiddenKey = "prompt" | "env" | "args" | "command" | "payload";

type _NoSensitivePayload<T> = T extends unknown
  ? Extract<keyof T, ForbiddenKey> extends never
    ? T
    : never
  : never;

type _AssertExhaustiveAuditEvent =
  AuditEvent extends _NoSensitivePayload<AuditEvent> ? true : false;
export const _AUDIT_EVENT_NO_SENSITIVE_PAYLOAD: _AssertExhaustiveAuditEvent = true;

/** Logger surface the emitter writes to. Compatible with `console`. */
export type AuditLogger = Pick<Console, "log">;

export type AuditEventInput = AuditEvent extends infer T
  ? T extends AuditEvent
    ? Omit<T, "at"> & { at?: string }
    : never
  : never;

/** Public emitter handle. */
export interface AuditEmitter {
  /** Record an event. Stamps `at` automatically; caller supplies correlationId. */
  record(event: AuditEventInput): void;
  /** Most recent N records. Useful for debug endpoints and tests. */
  recent(limit?: number): AuditEvent[];
  /** Discard buffered records. */
  reset(): void;
}

/** Build a bounded in-process audit emitter with structured logging. */
export function createAuditEmitter(options?: {
  logger?: AuditLogger;
  bufferSize?: number;
  now?: () => Date;
}): AuditEmitter {
  const logger = options?.logger ?? console;
  const bufferSize = options?.bufferSize ?? 256;
  const now = options?.now ?? (() => new Date());
  const buffer: AuditEvent[] = [];

  return {
    record(event) {
      const stamped = { ...event, at: event.at ?? now().toISOString() } as AuditEvent;
      buffer.push(stamped);
      if (buffer.length > bufferSize) {
        buffer.splice(0, buffer.length - bufferSize);
      }
      logger.log("[agents-js/audit]", stamped);
    },

    recent(limit = bufferSize) {
      return buffer.slice(-limit);
    },

    reset() {
      buffer.length = 0;
    },
  };
}
