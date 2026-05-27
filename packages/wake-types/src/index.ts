/**
 * `@agents-js/wake-types` — BASE type + shape-discriminated union for the
 * AJS-89 HYBRID wake-transport architecture.
 *
 * **AJS-89 HYBRID** (decision banked 2026-05-26): the gateway owns the
 * durable signal store; the harness side owns the wake transport. Different
 * harnesses have fundamentally different lifecycle and wake-receive
 * capabilities — the gateway picks an adapter per target at dispatch time.
 *
 * Per the **SHAPES axis call** (cognee-claude, 2026-05-27 cid
 * `cognee-claude-mcp-triggers-shapes-1355z`), wake adapters fall into three
 * structural shapes, each with fundamentally different lifecycle and
 * failure-mode assumptions:
 *
 *   1. **in-session-push** — harness has a warm MCP-aware session; the
 *      adapter delivers the signal via MCP `notifications/message` or a
 *      future MCP Triggers callback. AJS-96 owns the first impl.
 *   2. **translator-inject** — harness is an NDJSON-RPC child without
 *      MCP-client receive (e.g. Pi). Adapter injects synthetic incoming
 *      message at the translator layer.
 *   3. **spawn-with-signal** — harness is per-turn-spawn (e.g. Droid).
 *      No warm session; adapter spawns a fresh turn with the signal as
 *      initial prompt context.
 *
 * The {@link WakeAdapter} discriminated union forces gateway-side dispatch
 * to handle all three shapes exhaustively (via `assertNever`). A
 * {@link WakeAdapterBase} carries common metadata (signal-id, target, ttl,
 * idempotency-key) regardless of shape.
 *
 * This package is **types-only** — no runtime, no side effects. Adapter
 * runtimes live in shape-specific packages (e.g. a future
 * `@agents-js/wake-mcp-triggers` for in-session-push) that import the
 * type from here.
 *
 * @packageDocumentation
 */

/**
 * Branded string identifier for a wake signal. Allocated by the gateway
 * at signal-creation time. The brand prevents accidentally passing a
 * plain string where a signal id is required.
 *
 * Use {@link makeWakeSignalId} to construct one from a raw string (e.g.
 * a ULID or UUID); the brand is erased at runtime.
 */
export type WakeSignalId = string & { readonly __brand: "WakeSignalId" };

/**
 * Branded idempotency key for at-least-once wake delivery without
 * double-wake. Receivers MUST deduplicate by this key within the signal's
 * TTL window. Gateway re-emit on retry uses the same key so the receiver
 * collapses the duplicate.
 */
export type WakeIdempotencyKey = string & { readonly __brand: "WakeIdempotencyKey" };

/**
 * Target the wake should be delivered to.
 *
 *   - `session`: a specific live session, identified by its session id.
 *     Used when the gateway knows the receiver's session (warm channel).
 *   - `agent`: a logical agent identity. The adapter resolves to a
 *     concrete session (or spawns one for the `spawn-with-signal` shape).
 *
 * Adding a new target kind is a deliberate widening — every read site
 * that switches on `target.kind` must widen in lockstep (boundary-
 * narrowing-drift rule). Prefer `assertNever`-enforced exhaustive
 * switches over inline equality chains.
 */
export type WakeTarget =
  | { readonly kind: "session"; readonly sessionId: string }
  | { readonly kind: "agent"; readonly agentName: string };

/**
 * Common metadata carried by every wake-adapter invocation, regardless of
 * shape. Gateway emits this envelope into the per-shape adapter; each
 * shape extends with shape-specific fields (payload, injectedText, etc.).
 *
 * **Invariants** the gateway is responsible for upholding:
 *   - `signalId` is unique per signal across the gateway's lifetime.
 *   - `idempotencyKey` is stable across retries of the same signal —
 *     receivers MUST deduplicate by this key.
 *   - `expiresAtMs` is a wall-clock millisecond timestamp; signals past
 *     this time MUST NOT be delivered.
 */
export interface WakeAdapterBase {
  /** Stable id allocated by the gateway when the signal is created. */
  readonly signalId: WakeSignalId;
  /** Wake target (session-scoped or agent-scoped). */
  readonly target: WakeTarget;
  /**
   * Wall-clock ms at which the signal becomes ineligible for delivery.
   * Receivers MUST drop signals where `Date.now() >= expiresAtMs`.
   */
  readonly expiresAtMs: number;
  /**
   * Idempotency key. Receivers MUST deduplicate by this key within the
   * signal's TTL window. Gateway re-emit on retry uses the same key.
   */
  readonly idempotencyKey: WakeIdempotencyKey;
  /**
   * Optional correlation id, propagated from the originating bus event.
   * Useful for tracing a wake back to its source event across the
   * gateway → adapter → harness boundary.
   */
  readonly correlationId?: string;
}

/**
 * Discriminator literal for the three structural wake-adapter shapes.
 * Adding a shape is a structural change — see the SHAPES axis call
 * (cognee-claude, 2026-05-27): each shape has different lifecycle and
 * failure-mode assumptions, so widening this union requires a new
 * adapter package, not just a new field.
 */
export type WakeAdapterShape = "in-session-push" | "translator-inject" | "spawn-with-signal";

/**
 * In-session push shape: harness has a warm MCP-aware session; the
 * adapter delivers the signal via an MCP `notifications/message` (or
 * future MCP Triggers `triggers/event`) into that session.
 *
 * **First impl: AJS-96** (MCP Triggers in-session-push adapter).
 * **Applicable harnesses** (per the AJS-96 sub-ticket per-harness table):
 *   - `claude` (proven via Claude Code Channels)
 *   - `opencode`, `gemini` (plausible — gating on upstream verification)
 *   - explicitly NOT codex/pi/droid (sibling sub-tickets for those)
 */
export interface InSessionPushWakeAdapter extends WakeAdapterBase {
  readonly shape: "in-session-push";
  /**
   * Payload delivered to the MCP notification body. Adapter is responsible
   * for serialization; harness side parses per its MCP wiring. Schema
   * negotiated per-harness — common ground is JSON-encodable values.
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Translator-inject shape: harness is an NDJSON-RPC child (e.g. Pi
 * `pi --mode rpc`) without an MCP-client surface for receiving server-
 * pushed notifications mid-session. Adapter writes a synthetic incoming
 * message at the translator layer (`extras/pi-acp/src/translator.ts` for
 * the Pi case).
 *
 * **Applicable harnesses** (per the AJS-89 spec):
 *   - `pi` (NDJSON RPC, no MCP client receive)
 *   - any future translator-mediated harness without warm MCP push
 */
export interface TranslatorInjectWakeAdapter extends WakeAdapterBase {
  readonly shape: "translator-inject";
  /**
   * Human-readable text injected as a synthetic user-turn equivalent.
   * Adapter wraps this in the translator's incoming-message shape
   * before writing to the harness child's stdin.
   */
  readonly injectedText: string;
  /**
   * Optional source-identification metadata for audit on the translator
   * side. The translator emits this in its audit event so post-hoc
   * inspection can attribute injected turns vs. user-originated turns.
   */
  readonly sourceTag?: string;
}

/**
 * Spawn-with-signal shape: harness is per-turn-spawn (e.g. Droid
 * `droid exec --output-format stream-json`); no warm session exists.
 * Adapter spawns a fresh turn with the signal payload as the initial
 * prompt context.
 *
 * **Applicable harnesses** (per the AJS-89 spec):
 *   - `droid` (per-turn-spawn, no warm session)
 *   - any future cold-spawn harness without persistent session
 *
 * Failure-mode note: spawn-with-signal has no in-session dedup — the
 * receiver-side {@link WakeIdempotencyKey} guard must be enforced
 * BEFORE spawn (at the adapter level), since the spawned process has
 * no awareness of prior identical-signal spawns.
 */
export interface SpawnWithSignalWakeAdapter extends WakeAdapterBase {
  readonly shape: "spawn-with-signal";
  /**
   * Prompt that becomes the initial input of the spawned turn. Adapter
   * is responsible for any shape conversion (e.g. wrapping in a JSON
   * envelope, prefixing with role markers) per the target harness's
   * exec convention.
   */
  readonly initialPrompt: string;
  /**
   * Optional environment overrides for the spawned process. Adapter
   * merges these onto the gateway's base env before spawn. Use
   * sparingly — leaking env into the spawned process is an attack
   * surface; prefer signaling through {@link initialPrompt} when
   * the value is data-shaped.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Discriminated union of all wake-adapter shapes. Gateway-side dispatch
 * code SHOULD switch on `adapter.shape` with an exhaustive default
 * (`assertNever`) so adding a shape to this union forces every dispatch
 * site to widen in lockstep.
 */
export type WakeAdapter =
  | InSessionPushWakeAdapter
  | TranslatorInjectWakeAdapter
  | SpawnWithSignalWakeAdapter;

/**
 * Type-checked record mapping every {@link WakeAdapterShape} to `true`.
 * Mirrors the {@link import("@agents-js/policy").KNOWN_OPERATION_CLASSES}
 * pattern: forces a typecheck error when a shape is added to the union
 * but not to the runtime set.
 */
const KNOWN_WAKE_ADAPTER_SHAPES_RECORD: Record<WakeAdapterShape, true> = {
  "in-session-push": true,
  "translator-inject": true,
  "spawn-with-signal": true,
};

/**
 * Canonical set of wake-adapter shape strings, derived from
 * {@link KNOWN_WAKE_ADAPTER_SHAPES_RECORD} so adding a shape to
 * {@link WakeAdapterShape} forces this set to widen in lockstep.
 */
export const KNOWN_WAKE_ADAPTER_SHAPES: ReadonlySet<WakeAdapterShape> = new Set(
  Object.keys(KNOWN_WAKE_ADAPTER_SHAPES_RECORD) as WakeAdapterShape[],
);

/**
 * Narrow an arbitrary string to {@link WakeAdapterShape} via set
 * membership. Useful at boundary read sites (parsing serialized
 * envelopes, validating external input).
 */
export function isKnownWakeAdapterShape(value: string): value is WakeAdapterShape {
  return KNOWN_WAKE_ADAPTER_SHAPES.has(value as WakeAdapterShape);
}

/**
 * Construct a {@link WakeSignalId} from a raw string. Pure brand
 * application — no validation. The gateway is responsible for ensuring
 * uniqueness of the underlying value (typically a ULID or UUID).
 */
export function makeWakeSignalId(raw: string): WakeSignalId {
  return raw as WakeSignalId;
}

/**
 * Construct a {@link WakeIdempotencyKey} from a raw string. Pure brand
 * application — no validation. The gateway is responsible for ensuring
 * the key is stable across retries of the same logical signal.
 */
export function makeWakeIdempotencyKey(raw: string): WakeIdempotencyKey {
  return raw as WakeIdempotencyKey;
}

/**
 * Return `true` if the signal has expired (wall-clock past
 * {@link WakeAdapterBase.expiresAtMs}). Optional `now` parameter for
 * deterministic testing — defaults to `Date.now()`.
 */
export function isWakeSignalExpired(
  signal: Pick<WakeAdapterBase, "expiresAtMs">,
  now: () => number = Date.now,
): boolean {
  return now() >= signal.expiresAtMs;
}
