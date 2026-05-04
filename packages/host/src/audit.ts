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
 *
 * The union covers only surfaces the gateway *actually emits* today:
 * AG-UI run lifecycle, A2A task lifecycle, and ACP `@@dispatch`.
 *
 * Registry peer sync and ACP `@mention` audit variants were considered
 * but deferred — both surfaces live behind the published
 * `@agents-js/cli` (`packages/cli/src/serve.ts`) which does not depend
 * on `@agents-js/host`. Adding that dependency just to surface those
 * records would invert the current package layering. When those
 * surfaces grow a real audit emitter (or move into the host package),
 * extend this union — do not let the type imply coverage that the
 * source does not provide.
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
 * If any `AuditEvent` variant declares a `prompt`, `env`, `args`, or
 * `payload` key, the conditional type below evaluates to `never` for
 * that variant; the value-level assertion at the end of the file
 * surfaces the failure as a real typecheck error.
 *
 * The rule is intentionally rigid — convenience is not a reason to
 * expand this set. Operators who want to log raw payloads should do
 * it through a separate, gated, intentionally-not-here surface.
 */
type ForbiddenKey = "prompt" | "env" | "args" | "payload";
/**
 * Distributes over the discriminated union (each variant T is checked
 * individually) and returns `never` for any variant whose key set
 * intersects the forbidden set. Key-by-key intersection ensures even
 * a single forbidden key on one variant trips the check.
 */
type _NoSensitivePayload<T> = T extends unknown
  ? Extract<keyof T, ForbiddenKey> extends never
    ? T
    : never
  : never;

/**
 * Type-level assertion that every AuditEvent variant satisfies the
 * no-forbidden-key constraint.
 *
 * The check uses *bidirectional* assignability: if the violating
 * variant gets stripped to `never` by `_NoSensitivePayload<AuditEvent>`,
 * the resulting union is a strict subset of `AuditEvent` — and
 * `AuditEvent extends _NoSensitivePayload<AuditEvent>` becomes false.
 * The literal `true` then fails to assign to `false` and tsc rejects
 * the file.
 *
 * Declaring just a type alias does NOT fail typecheck on its own —
 * exporting an alias for `never` is perfectly legal. The `true`
 * assignment is what makes the guard load-bearing. Exporting the
 * `const` keeps biome's `noUnusedVariables` quiet without weakening
 * the check; consumers SHOULD NOT depend on this value (it is purely
 * a guard).
 */
type _AssertExhaustiveAuditEvent =
  AuditEvent extends _NoSensitivePayload<AuditEvent> ? true : false;
export const _AUDIT_EVENT_NO_SENSITIVE_PAYLOAD: _AssertExhaustiveAuditEvent = true;

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
