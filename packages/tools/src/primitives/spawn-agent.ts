/**
 * `spawnAgent` — tool-facing subagent dispatch primitive.
 *
 * Wraps the gateway-layer {@link spawnSubSession} with the @agents-js/tools
 * surface concerns: provenance tagging (Source[]), TraceEmitter
 * parent-child threading, self-spawn depth enforcement, and the tool
 * registry shape used by {@link findTools}.
 *
 * See `hub/agents-js/cognee-claude/spawn-agent-design-2026-04-22.md`
 * for the full design rationale. v1 scope matches the gateway layer's
 * v1 — bounded mode only, trial-agent harness only, explicit-harness
 * fail-closed — plus the tool-layer additions below.
 *
 * Tool-layer additions on top of the gateway primitive:
 *
 * - **Provenance.** Every completed spawn yields a single {@link Source}
 *   carrying the harness + session_id via the `tool://spawn-agent/...`
 *   URI scheme (current shipped SourceType `"tool"`; migration to a
 *   substrate-neutral `"subagent"` shape follows when the types.ts
 *   rewrite lands per the design doc's "Provenance shape" note).
 * - **Parent/root trace threading.** When the caller supplies a
 *   {@link TraceEmitter}, the spawn call is recorded as a single
 *   `SpawnAgent` tool-call-trace. The emitted record's `event_id`
 *   becomes the composition root for any nested traces the subagent
 *   produces. Subagents that do not emit tool-call-traces themselves
 *   (trial-agent in v1) do not produce child records; the parent
 *   record stands alone.
 * - **Self-spawn depth limit.** Callers pass `depth` (0-indexed) and
 *   optionally `maxDepth` (default 1). When `depth >= maxDepth` the
 *   call fails closed with status `"depth_limit_exceeded"` — prevents
 *   runaway recursion in harnesses that can call spawnAgent from
 *   within a subtask.
 */

import {
  type SpawnSubSessionHints,
  type SpawnSubSessionOptions,
  type SpawnSubSessionResult,
  type SpawnSubSessionStatus,
  spawnSubSession,
} from "@agents-js/gateway-runtime";
import type { TraceEmitter } from "../trace.ts";
import type { Source } from "../types.ts";

/** Default self-spawn depth cap. Configurable per-call. */
export const SPAWN_AGENT_DEFAULT_MAX_DEPTH = 1;

/** Re-export gateway hints for tool-layer callers. */
export type SpawnAgentHints = SpawnSubSessionHints;

/** Terminal status of {@link spawnAgent}, including tool-layer-specific cases. */
export type SpawnAgentStatus = SpawnSubSessionStatus | "depth_limit_exceeded";

/**
 * Input shape. `subtask` is positional. Every other field is optional
 * and carries a sensible default. `parent_session_id` is carried so
 * trace / audit records can correlate to the spawning session; v1
 * treats an empty string as "no parent" and does not error.
 */
export interface SpawnAgentOptions {
  /** Identity of the caller session for audit + trace correlation. */
  parent_session_id?: string;
  hints?: SpawnAgentHints;
  /** v1 only. Detached + handle-based mode ships in a follow-on. */
  mode?: "bounded";
  timeout_ms?: number;
  /**
   * Current composition depth (0-indexed).
   *
   * - `depth: 0` (or undefined) — top-level call from a human-initiated
   *   agent session. No prior spawnAgent frames above.
   * - `depth: 1` — one-level nested spawn; the parent caller was itself
   *   reached via a spawnAgent call.
   * - `depth: N` — N nested self-spawn frames above.
   *
   * With default `maxDepth=1` and `depth=0`, a top-level caller is
   * allowed through (0 < 1); a caller that passes `depth: 1` is
   * refused (1 >= 1 triggers depth_limit_exceeded) — i.e. v1 permits
   * a single spawn but refuses grandchild spawns.
   *
   * v1 check happens at spawnAgent entry only; callers responsible
   * for incrementing depth when threading down into subagents. Auto-
   * propagation via env var / session metadata is a follow-on when a
   * self-spawning harness ships.
   */
  depth?: number;
  /**
   * Maximum allowed depth. Default {@link SPAWN_AGENT_DEFAULT_MAX_DEPTH}
   * (=1, permits a single level of spawning from human-initiated
   * sessions). When `depth >= maxDepth` the call fails closed with
   * status `"depth_limit_exceeded"`.
   */
  maxDepth?: number;
  /**
   * Optional parent-session trace emitter. When present, the spawn
   * call is recorded as a `SpawnAgent` tool-call-trace on it; the
   * emitted record's `event_id` can be threaded into a subagent's own
   * emitter as `parentEventId` + `rootEventId` (trial-agent does not
   * carry an emitter in v1).
   */
  traceEmitter?: TraceEmitter;
  /** Timestamp source for Source.observed_at / retrieved_at. */
  now?: () => Date;
  /** DI seam for tests; defaults to the real {@link spawnSubSession}. */
  spawnSubSessionFn?: typeof spawnSubSession;
  /** Options passed through to {@link spawnSubSession}. */
  subSessionOptions?: SpawnSubSessionOptions;
}

/**
 * Result of a tool-layer spawn. Mirrors the gateway result with
 * provenance (`sources`) added and status widened to include
 * `"depth_limit_exceeded"`.
 */
export interface SpawnAgentResult {
  session_id: string;
  summary: string;
  status: SpawnAgentStatus;
  duration_ms: number;
  harness: string;
  sources: Source[];
  error?: { code: string; message: string };
}

/**
 * Structured error thrown when a caller passes invalid input to
 * {@link spawnAgent}. Separate from the result-shape failure modes
 * (`harness_unavailable`, `depth_limit_exceeded`, etc.) because
 * invalid input is a caller-side bug, not a legitimate runtime
 * outcome — fail fast at the boundary rather than producing a weird
 * gateway call.
 */
export class SpawnAgentInvalidInputError extends Error {
  readonly code = "tools/spawn-agent-invalid-input";
  constructor(message: string) {
    super(message);
    this.name = "SpawnAgentInvalidInputError";
  }
}

/**
 * Spawn a subagent, run the subtask, return the terminal summary with
 * tool-layer provenance. See module docstring for scope. The call is
 * purely a wrapper over {@link spawnSubSession} — all process spawn /
 * ACP handshake / timeout mechanics live at the gateway layer.
 *
 * **Trace emission caveat (secret exposure).** When a `traceEmitter`
 * is supplied, the emitted `ToolCallTrace.args` record carries the
 * raw `subtask` string verbatim. If the parent agent is composing a
 * subtask from a context that includes secrets (tokens, passwords,
 * API keys paraphrased into prose), those secrets land in the
 * append-only log. Callers wiring SpawnAgent in a secret-carrying
 * context should either:
 *
 * - Register a custom ToolDefinition for SpawnAgent with a
 *   {@link ToolDefinition.redaction} spec that scrubs `subtask` and
 *   any sensitive `hints` keys before persistence, OR
 * - Invoke this SDK function directly without passing a
 *   `traceEmitter` to bypass the tool-layer trace entirely.
 *
 * The default registry registration does NOT apply redaction —
 * trial-agent usage is local + low-risk, and redacting `subtask` by
 * default would kill "what was this subagent asked to do?" as a
 * load-bearing diagnostic. Explicit opt-in when the risk is real.
 *
 * Throws {@link SpawnAgentInvalidInputError} (code
 * `tools/spawn-agent-invalid-input`) when `subtask` is not a
 * non-empty string. Failing fast at the boundary prevents a silent
 * `subtask: undefined` from flowing through to the gateway and
 * producing a confusing subagent call.
 */
export async function spawnAgent(
  subtask: string,
  options: SpawnAgentOptions = {},
): Promise<SpawnAgentResult> {
  if (typeof subtask !== "string" || subtask.trim().length === 0) {
    throw new SpawnAgentInvalidInputError(
      `spawnAgent requires a non-empty string "subtask"; got ${
        subtask === undefined ? "undefined" : JSON.stringify(subtask)
      }.`,
    );
  }

  const depth = options.depth ?? 0;
  const maxDepth = options.maxDepth ?? SPAWN_AGENT_DEFAULT_MAX_DEPTH;
  const harness = options.hints?.harness ?? "trial";
  const now = options.now ?? (() => new Date());

  if (depth >= maxDepth) {
    return {
      session_id: "",
      summary: "",
      status: "depth_limit_exceeded",
      duration_ms: 0,
      harness,
      sources: [],
      error: {
        code: "tools/spawn-depth-exceeded",
        message: `spawnAgent depth=${depth} >= maxDepth=${maxDepth}; refusing to recurse further.`,
      },
    };
  }

  const spawner = options.spawnSubSessionFn ?? spawnSubSession;
  const subSessionParams = {
    parent_session_id: options.parent_session_id ?? "",
    subtask,
    hints: options.hints,
    mode: "bounded" as const,
    timeout_ms: options.timeout_ms,
  };

  const execute = async (): Promise<SpawnSubSessionResult> =>
    spawner(subSessionParams, options.subSessionOptions);

  let gatewayResult: SpawnSubSessionResult;
  if (options.traceEmitter) {
    gatewayResult = await options.traceEmitter.record(
      {
        toolName: "SpawnAgent",
        args: { subtask, hints: options.hints ?? null, depth, maxDepth },
        tags: ["spawn-agent"],
      },
      execute,
    );
  } else {
    gatewayResult = await execute();
  }

  return translateGatewayResult(gatewayResult, now);
}

/**
 * Convert a gateway {@link SpawnSubSessionResult} into a tool-layer
 * {@link SpawnAgentResult} by attaching provenance. Exposed for tests
 * that want to assert on the mapping without spawning anything.
 */
export function translateGatewayResult(
  result: SpawnSubSessionResult,
  now: () => Date = () => new Date(),
): SpawnAgentResult {
  const sources: Source[] = [];
  if (result.session_id) {
    const timestamp = now().toISOString();
    sources.push({
      source_type: "tool",
      source_ref: `tool://spawn-agent/${result.harness}/${result.session_id}`,
      observed_at: timestamp,
      retrieved_at: timestamp,
      confidence: "responsible",
    });
  }
  const base: SpawnAgentResult = {
    session_id: result.session_id,
    summary: result.summary,
    status: result.status,
    duration_ms: result.duration_ms,
    harness: result.harness,
    sources,
  };
  if (result.error) {
    base.error = result.error;
  }
  return base;
}
