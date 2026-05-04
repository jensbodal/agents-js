/**
 * Tool-call-trace emission for `@agents-js/tools`.
 *
 * Two layers:
 *
 * 1. **Sinks** — pluggable destinations for persisted records. Ships three
 *    built-in sinks (JSONL file, in-memory for tests, no-op) and a
 *    `TraceSink` interface so consumers can plug in an HTTP forwarder, a
 *    database writer, etc. without changing emitter code.
 *
 * 2. **Emitter + wrap helper** — `TraceEmitter` wraps a `TraceSink` with
 *    the schema-level invariants (schema_version, event_id generation,
 *    timestamp, agent_id, redaction application). `wrapToolWithTrace`
 *    returns a new `ToolDefinition` whose `invoke` records a terminal
 *    trace event around the real implementation. The wrapped tool is
 *    observationally equivalent to the original modulo the emitted record.
 *
 * Redaction is applied at emit time (not invoke time): the tool's own
 * args/result values pass through unchanged; only the persisted record
 * gets sanitized per the tool's `redaction` spec. Secrets never travel
 * through the sink.
 *
 * Scope of v0.1:
 *
 * - Top-level key redaction only. Recursive / pattern-based redaction is
 *   a v0.2 concern.
 * - No blob-store indirection (args_ref / result_ref). Large payloads are
 *   inlined; truncation is a follow-on.
 * - Top-level tool calls only; composition chains (parent_event_id /
 *   root_event_id threading across nested invokes) require explicit
 *   context plumbing. Emitter accepts parent context as an option so
 *   callers building compositions can set it manually. Automatic
 *   threading is outside this package's v0.1 contract.
 * - Sync (best-effort) error handling: a sink failure is logged to
 *   stderr but does not fail the tool invocation. Observability must
 *   not break the agent.
 */

import { randomUUID } from "node:crypto";
import type { RedactionSpec, ToolDefinition } from "./types.ts";

/** Current schema version emitted by this module. */
export const TOOL_CALL_TRACE_SCHEMA_VERSION = "0.1.0";

/** Sentinel used to replace redacted field values. */
export const REDACTION_SENTINEL = "REDACTED";

/**
 * Single tool invocation event. Mirrors the JSON shape defined in the
 * schema spec. `result` is optional because not every terminal record
 * carries a success payload (error cases may have `null`); `args` is
 * optional because some tools intentionally take no input.
 */
export interface ToolCallTrace {
  schema_version: string;
  event_id: string;
  timestamp: string;
  agent_id: string;
  session_id: string | null;
  tool_name: string;
  args?: unknown;
  result?: unknown;
  duration_ms: number;
  status: "ok" | "error";
  error?: { code: string; message: string };
  parent_event_id: string | null;
  root_event_id: string;
  tags?: string[];
}

/**
 * Destination for persisted trace records. Implementations must be
 * idempotent with respect to concurrent writes — the emitter does not
 * serialize calls.
 */
export interface TraceSink {
  emit(record: ToolCallTrace): Promise<void>;
}

/**
 * Construction options for {@link TraceEmitter}. Test seams for `now` and
 * `generateEventId` exist so tests can produce deterministic records
 * without monkey-patching globals.
 */
export interface TraceEmitterOptions {
  sink: TraceSink;
  agentId: string;
  sessionId?: string | null;
  now?: () => Date;
  generateEventId?: () => string;
  /**
   * Parent event id for the top-level tool call. When set, emitted
   * records carry `parent_event_id = parentEventId`. When unset, each
   * emitted record is treated as a root (parent_event_id = null,
   * root_event_id = own event_id).
   */
  parentEventId?: string | null;
  /**
   * Root event id override. When composing nested tool calls the caller
   * threads the outermost ancestor id down so every record in the chain
   * shares a root. Omit for top-level emissions; the emitter then uses
   * the newly-generated event_id as its own root.
   */
  rootEventId?: string | null;
}

/** Context carried per-invocation into {@link TraceEmitter.record}. */
export interface TraceInvocationContext {
  toolName: string;
  redaction?: RedactionSpec;
  args?: unknown;
  tags?: string[];
}

/**
 * Construct a {@link ToolCallTrace} and forward to the configured sink.
 * Callers typically don't use this directly — prefer
 * {@link wrapToolWithTrace} or {@link TraceEmitter.record} around an
 * arbitrary async call.
 */
export class TraceEmitter {
  readonly #sink: TraceSink;
  readonly #agentId: string;
  readonly #sessionId: string | null;
  readonly #now: () => Date;
  readonly #generateEventId: () => string;
  readonly #parentEventId: string | null;
  readonly #rootEventId: string | null;

  constructor(options: TraceEmitterOptions) {
    this.#sink = options.sink;
    this.#agentId = options.agentId;
    this.#sessionId = options.sessionId ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#generateEventId = options.generateEventId ?? randomUUID;
    // Composition-chain ids must match the schema pattern (ULID or UUID v4).
    // Invalid shapes get dropped to null with a stderr warning rather than
    // throwing, so a bad caller produces a partial-but-valid record instead
    // of crashing the observability path.
    this.#parentEventId = validateCompositionId(options.parentEventId, "parentEventId");
    this.#rootEventId = validateCompositionId(options.rootEventId, "rootEventId");
  }

  /**
   * Execute `fn` and emit a terminal trace record. If `fn` throws, the
   * emitted record has `status: "error"` with code/message derived from
   * the thrown value; the original error is re-thrown to the caller
   * (observability must not swallow errors).
   *
   * Sink failures are caught and reported to stderr — they do not
   * surface to the caller.
   */
  async record<T>(ctx: TraceInvocationContext, fn: () => Promise<T>): Promise<T> {
    const eventId = this.#generateEventId();
    const started = this.#now();
    const startedMs = started.getTime();

    let result: T | undefined;
    let caught: unknown;
    let status: "ok" | "error" = "ok";

    try {
      result = await fn();
    } catch (error) {
      caught = error;
      status = "error";
    }

    const ended = this.#now();
    const durationMs = Math.max(0, ended.getTime() - startedMs);

    const record: ToolCallTrace = {
      schema_version: TOOL_CALL_TRACE_SCHEMA_VERSION,
      event_id: eventId,
      timestamp: started.toISOString(),
      agent_id: this.#agentId,
      session_id: this.#sessionId,
      tool_name: ctx.toolName,
      duration_ms: durationMs,
      status,
      parent_event_id: this.#parentEventId,
      root_event_id: this.#rootEventId ?? eventId,
    };

    if (ctx.args !== undefined) {
      record.args = applyRedaction(ctx.args, ctx.redaction?.args);
    }
    if (status === "ok" && result !== undefined) {
      record.result = applyRedaction(result, ctx.redaction?.result);
    }
    if (status === "error") {
      record.error = toErrorShape(caught);
    }
    if (ctx.tags && ctx.tags.length > 0) {
      record.tags = [...ctx.tags];
    }

    try {
      await this.#sink.emit(record);
    } catch (sinkError) {
      process.stderr.write(
        `[agents-js/tools] trace sink emit failed for ${ctx.toolName}: ${
          sinkError instanceof Error ? sinkError.message : String(sinkError)
        }\n`,
      );
    }

    if (status === "error") {
      throw caught;
    }
    return result as T;
  }
}

/**
 * Return a new {@link ToolDefinition} whose `invoke` records a trace
 * record on every call. The returned tool retains the original name,
 * description, keywords, and redaction spec — drop-in replacement.
 *
 * The original `tool.invoke` is invoked with the raw (un-redacted)
 * input; only the emitted record is scrubbed. `tags` are appended to
 * every emitted record for this tool.
 */
export function wrapToolWithTrace(
  tool: ToolDefinition,
  emitter: TraceEmitter,
  tags?: readonly string[],
): ToolDefinition {
  const invoke = (input: unknown): Promise<unknown> =>
    emitter.record(
      {
        toolName: tool.name,
        redaction: tool.redaction,
        args: input,
        tags: tags ? [...tags] : undefined,
      },
      () => tool.invoke(input),
    );

  const wrapped: ToolDefinition = {
    name: tool.name,
    description: tool.description,
    invoke,
  };
  if (tool.keywords !== undefined) {
    wrapped.keywords = [...tool.keywords];
  }
  if (tool.redaction !== undefined) {
    wrapped.redaction = tool.redaction;
  }
  return wrapped;
}

// ---------------------------------------------------------------------------
// Sinks
// ---------------------------------------------------------------------------

/**
 * No-op sink. Useful as an explicit default when trace infrastructure
 * is wired but emission should be disabled (e.g. in production prior
 * to a retention policy landing).
 */
export function createNoopSink(): TraceSink {
  return {
    async emit() {
      /* intentional no-op */
    },
  };
}

/**
 * In-memory sink. Retains every emitted record on a `records` array.
 * Primarily for tests.
 */
export function createMemorySink(): TraceSink & { readonly records: ToolCallTrace[] } {
  const records: ToolCallTrace[] = [];
  return {
    records,
    async emit(record) {
      records.push(record);
    },
  };
}

/**
 * Append-only JSONL sink. Each `emit` writes a single line
 * (JSON.stringify(record) + "\n") to the given path, creating the
 * parent directory if missing. Writes are serialized through a
 * per-sink promise chain so concurrent emits from ONE sink instance
 * don't interleave.
 *
 * **Concurrency caveat (single-process only).** The per-instance
 * promise chain prevents interleaving within this process. It does
 * NOT guard against multiple processes appending to the same JSONL
 * path. Multi-process deployments (two gateway-runtime instances
 * sharing a log file, or an operator cat'ing a live-tail) MAY
 * observe torn lines. If that shape becomes real, either (a) use a
 * per-process logPath with a post-hoc merge step, or (b) swap this
 * sink for one that holds a file lock (e.g. `proper-lockfile`) or
 * streams through a single-writer OS pipe. v0.1 assumes one writer
 * per file.
 *
 * Unserializable payload handling: falls back to a structured
 * `{ __unserializable: <reason> }` sentinel when `JSON.stringify`
 * throws (functions, circular refs, BigInts). Prevents silent
 * record loss — the record lands in the log with enough context to
 * identify the bad field.
 */
export function createJsonlFileSink(logPath: string): TraceSink {
  let chain: Promise<void> = Promise.resolve();
  return {
    emit(record) {
      const line = `${safeSerializeRecord(record)}\n`;
      const next = chain.then(() => appendLine(logPath, line));
      chain = next.catch(() => {
        /* swallow so the chain keeps flowing; TraceEmitter already logs the error */
      });
      return next;
    },
  };
}

async function appendLine(logPath: string, line: string): Promise<void> {
  const { dirname } = await import("node:path");
  const { appendFile, mkdir } = await import("node:fs/promises");
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, line, "utf-8");
}

/**
 * Serialize a `ToolCallTrace` record with a fallback for values that
 * `JSON.stringify` rejects (functions, circular refs, BigInt,
 * Symbol, etc.). The first attempt uses the native serializer; on
 * failure, `args` and `result` are each replaced with a typed
 * sentinel so the rest of the record still lands in the log.
 *
 * Without this, a single bad field would reject the whole record
 * and the caller (via TraceEmitter) would log a stderr warning but
 * the observability data disappears. Sentinel-based fallback keeps
 * the lineage fields (`event_id`, `parent_event_id`, `tool_name`,
 * etc.) visible even when the payload can't be round-tripped.
 */
export function safeSerializeRecord(record: ToolCallTrace): string {
  try {
    // The replacer handles values JSON.stringify can't represent OR would
    // silently drop (functions, BigInt, Symbol). Returning the sentinel
    // from the replacer keeps the field present in the output with a
    // typed marker instead of losing it to silent omission.
    return JSON.stringify(record, replaceUnserializable);
  } catch {
    // Remaining failure modes (primarily circular refs) throw even with
    // the replacer. Scrub args + result with a composite sentinel and
    // retry; preserves lineage fields even when the payload is hopeless.
    const sanitized: ToolCallTrace = { ...record };
    if (sanitized.args !== undefined) {
      sanitized.args = unserializableSentinel(sanitized.args);
    }
    if (sanitized.result !== undefined) {
      sanitized.result = unserializableSentinel(sanitized.result);
    }
    try {
      return JSON.stringify(sanitized, replaceUnserializable);
    } catch {
      return JSON.stringify({
        ...sanitized,
        args: { __unserializable: "unknown" },
        result: { __unserializable: "unknown" },
      });
    }
  }
}

/**
 * JSON.stringify replacer that intercepts values the native serializer
 * can't (or doesn't, by default) round-trip. Functions and Symbols
 * are silently dropped without this replacer; BigInt throws. Either
 * way the lineage of the record is preserved by swapping the bad
 * value for a structured sentinel that identifies the type at fault.
 */
function replaceUnserializable(_key: string, value: unknown): unknown {
  if (typeof value === "function") return { __unserializable: "function" };
  if (typeof value === "bigint") return { __unserializable: "bigint" };
  if (typeof value === "symbol") return { __unserializable: "symbol" };
  return value;
}

function unserializableSentinel(value: unknown): { __unserializable: string } {
  if (typeof value === "function") return { __unserializable: "function" };
  if (typeof value === "bigint") return { __unserializable: "bigint" };
  if (typeof value === "symbol") return { __unserializable: "symbol" };
  if (value && typeof value === "object") return { __unserializable: "circular-or-nested" };
  return { __unserializable: String(typeof value) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply a top-level redaction spec to an object. Returns a shallow copy
 * with listed keys replaced by {@link REDACTION_SENTINEL}. Non-object
 * inputs pass through unchanged (no way to redact a scalar by key).
 *
 * v0.1 intentionally top-level only. Nested/recursive redaction is a
 * v0.2 concern per the schema spec §3.
 */
export function applyRedaction(value: unknown, keys: readonly string[] | undefined): unknown {
  if (!keys || keys.length === 0) {
    return value;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const source = value as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...source };
  for (const key of keys) {
    if (key in copy) {
      copy[key] = REDACTION_SENTINEL;
    }
  }
  return copy;
}

/** Coerce an arbitrary thrown value into the schema's error shape. */
function toErrorShape(caught: unknown): { code: string; message: string } {
  if (caught instanceof Error) {
    const code = (caught as Error & { code?: string }).code ?? "tools/invoke-failed";
    return { code, message: caught.message };
  }
  return { code: "tools/invoke-failed", message: String(caught) };
}

/**
 * Pattern from the tool-call-trace v0.1 schema §2 for `event_id`:
 * Crockford-base32 ULID (26 chars) OR RFC 4122 UUID (8-4-4-4-12 hex).
 * Same shape applies to `parent_event_id` and `root_event_id`.
 */
const COMPOSITION_ID_PATTERN =
  /^[0-9A-HJKMNP-TV-Z]{26}$|^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Validate a composition-chain id (parent or root event id). Accepts:
 * - `null` / `undefined` — legitimate "no parent / no root override"
 * - ULID or UUID v4 matching {@link COMPOSITION_ID_PATTERN}
 *
 * Invalid shapes emit a stderr warning and return `null` so the
 * emitted record still lands (just without the broken lineage link).
 * This keeps observability from breaking when a caller threads a
 * malformed id — a bad audit tag shouldn't crash the agent.
 */
export function validateCompositionId(
  value: string | null | undefined,
  fieldLabel: string,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && COMPOSITION_ID_PATTERN.test(value)) {
    return value;
  }
  process.stderr.write(
    `[agents-js/tools] Invalid ${fieldLabel} "${value}" — expected ULID or UUID v4; dropping to null.\n`,
  );
  return null;
}
