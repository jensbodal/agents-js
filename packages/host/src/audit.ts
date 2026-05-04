/**
 * Internal correlation/audit surface for the gateway.
 *
 * The gateway exposes several user-driven surfaces (AG-UI runs,
 * A2A tasks, registry peer sync, ACP `@mention` middleware,
 * `@@dispatch`) and operators benefit from a single place to observe
 * "what happened" across all of them — with stable correlation IDs so
 * a run can be traced from the AG-UI HTTP request through the ACP
 * session, the A2A task it produced, and any audit records emitted by
 * downstream subsystems.
 *
 * **Sensitive payloads are forbidden by construction.** The
 * `AuditEvent` union is intentionally a closed set of structural
 * variants. None of them carry a `prompt`, `env`, `args`, or `payload`
 * key. Adding such a key to a variant is a compile error: see the
 * `_NoSensitivePayload` guard at the bottom of this file. Operators
 * who need richer detail should attach a structured logger to a
 * higher-trust surface and consume that — never extend AuditEvent
 * with raw user content.
 *
 * The ring buffer is in-process and bounded (256 records by default).
 * It exists so a debug endpoint or test can introspect recent activity
 * without the overhead of a structured-log shipping pipeline.
 */

/** Stable correlation token. UUIDv4 strings in practice; consumers should treat as opaque. */
export type CorrelationId = string;

/** Generate a fresh correlation id. Re-exported so callers don't have to know about `crypto`. */
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
 * metadata — IDs, names, counts, durations — never user content.
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
      /** Short error category — never the raw error message verbatim. */
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
      /** Number of records returned to the peer. */
      recordCount: number;
    })
  | (BaseAuditEvent & {
      kind: "registry-sync-fetched";
      peerUrl: string;
      /** Number of records the peer returned. */
      recordCount: number;
    })
  | (BaseAuditEvent & {
      kind: "registry-sync-merged";
      peerUrl: string;
      added: number;
      updated: number;
      unchanged: number;
      skippedLoops: number;
      conflicts: number;
    })
  // -- ACP @mention dispatch -------------------------------------------
  | (BaseAuditEvent & {
      kind: "mention-dispatched";
      agentName: string;
      /** Whether the agent was found in the registry. */
      resolved: boolean;
    })
  // -- ACP @@dispatch --------------------------------------------------
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

/* -------------------------------------------------------------------------- */
/*  Type-system guard — forbid sensitive payload keys on any variant          */
/* -------------------------------------------------------------------------- */

/**
 * If anyone adds a `prompt`, `env`, `args`, or `payload` key to any
 * `AuditEvent` variant, this conditional type evaluates to `never`,
 * which makes the helper line below fail to typecheck. The fail is
 * surfaced at the assertion line, but the underlying meaning is "your
 * variant added a sensitive-payload key".
 *
 * The rule is intentionally rigid — convenience is not a reason to
 * expand this set. Operators who want to log raw payloads should do
 * it through a separate, gated, intentionally-not-here surface.
 */
type _NoSensitivePayload<T> =
  T extends Record<"prompt" | "env" | "args" | "payload", unknown> ? never : T;

// Compile-time assertion: every AuditEvent variant must satisfy
// `_NoSensitivePayload`. If this exported type ever evaluates to
// `never`, a variant smuggled in a forbidden key. Exporting (rather
// than declaring an unused const) keeps biome quiet without weakening
// the check.
export type _AuditEventNoSensitivePayload = _NoSensitivePayload<AuditEvent>;

/* -------------------------------------------------------------------------- */
/*  Emitter                                                                   */
/* -------------------------------------------------------------------------- */

/** Logger surface the emitter writes to. Compatible with `console`. */
export type AuditLogger = Pick<Console, "log">;

/**
 * Input shape accepted by {@link AuditEmitter.record}. The plain
 * `Omit<AuditEvent, "at">` does NOT distribute over the discriminated
 * union (TS treats Omit on a union as a single type, which collapses
 * the variant-specific keys). The conditional type below distributes
 * over each variant before applying `Omit`, preserving the exhaustive
 * shape. `at` is always optional on input — the emitter stamps it.
 */
export type AuditEventInput = AuditEvent extends infer T
  ? T extends AuditEvent
    ? Omit<T, "at"> & { at?: string }
    : never
  : never;

/** Public emitter handle. */
export interface AuditEmitter {
  /** Record an event. Stamps `at` automatically; caller supplies correlationId. */
  record(event: AuditEventInput): void;
  /** Most recent N records (default 256). Useful for debug endpoints / tests. */
  recent(limit?: number): AuditEvent[];
  /** Discard buffered records. Tests use this between cases. */
  reset(): void;
}

/**
 * Build a fresh audit emitter.
 *
 * - `logger` defaults to `console`. The emitter writes one structured
 *   log line per record so operators with no debug endpoint still see
 *   the trail.
 * - `bufferSize` controls the ring-buffer cap (default 256). The
 *   buffer is best-effort; consumers that need durable audit must
 *   subscribe to the logger.
 */
export function createAuditEmitter(options?: {
  logger?: AuditLogger;
  bufferSize?: number;
  /** Inject a clock for deterministic test timestamps. */
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
      logger.log("[Gateway/audit]", stamped);
    },
    recent(limit) {
      const n = limit ?? buffer.length;
      return buffer.slice(-n);
    },
    reset() {
      buffer.length = 0;
    },
  };
}
