/**
 * AJS-56 / AJS-58 — `agents.send_message` + `agents.get_messages` dispatcher.
 *
 * Implements the user-facing router-level tool surface from
 * `docs/research/agents-js-hosted-mcp-tool-provider-design-2026-05-20.md`
 * section 2.5 (Delivery router) plus AJS-58 AgentInbox routing. Bound by:
 *
 *  - Identity is server-resolved from a verified JWT (passed in by
 *    the MCP transport layer; never read from tool args).
 *  - Scope ACL enforced at dispatch time. Route presence in the
 *    target's directory entry determines the required scope, NOT
 *    whichever scope the caller happens to carry. If `entry.inbox`
 *    exists, `inbox.deliver` is MANDATORY. If `entry.matrix` exists
 *    AND caller has `matrix.send_message`, matrix-notify also fires.
 *    `inbox.read` is required for `agents.get_messages`.
 *  - Target routing resolved via {@link TargetDirectory} (v1 stub for
 *    the AJS-55 trust manifest).
 *  - **Route model** (AJS-65): inbox is the durable delivery substrate;
 *    matrix is the notification overlay. Every routable target advertises
 *    an inbox route. The dispatcher writes inbox FIRST (hard-fails with
 *    `inbox-write-failed` if it throws — matrix is NOT attempted;
 *    notification without storage would lie), then fires matrix-notify
 *    with a pointer-only body (`"see inbox: ${inbox_message_id}"`) when
 *    the target also advertises a Matrix route.
 *  - Scope-vs-routing mismatch surfaces as `scope-not-granted` with a
 *    message naming the missing scope, rather than `unknown-target`.
 *    Operators get the actionable hint without leaking target
 *    capability information through error-shape side-channels.
 *  - Unknown targets, missing scopes, and provider failures all return
 *    structured `{ ok: false, error, correlation_id, message }` rather
 *    than throwing — the transport layer maps these to HTTP status.
 *  - `agents.get_messages` is identity-bound in v1 — callers can read
 *    ONLY their own session's mailbox; cross-agent inbox read is
 *    deferred to an `inbox.read_all` scope in a follow-up ticket.
 *
 * V1 stubs (documented in PR body per cognee-claude directive):
 *  - AJS-55 trust manifest → in-memory {@link TargetDirectory}. The
 *    eventual loader will populate from signed peer records.
 *  - AJS-55 challenge verification → `/admin/mint` endpoint (mount layer).
 *  - Cross-agent inbox read (`inbox.read_all`) → deferred.
 *  - Matrix history (`matrix.get_messages`) → deferred; v1 read is
 *    inbox-only.
 */

import type { AuthenticatedIdentity } from "./jwt-verifier.ts";
import { checkScope } from "./scope-acl.ts";

/** Args passed to {@link MatrixTool.send}. Identity comes from the JWT only. */
export interface MatrixSendArgs {
  /** Server-resolved identity (from verified JWT `sub`). Never client-supplied. */
  identity: AuthenticatedIdentity;
  /** Logical recipient target resolved from the target directory. */
  target: string;
  /** Matrix room id (e.g. `"!abc:matrix.example"`). Resolved by the directory. */
  room: string;
  /** Message body. */
  body: string;
  /** Optional reply threading. */
  replyToEventId?: string;
  /**
   * AJS-67 structured recipient envelope for the Matrix bridge. Travels
   * alongside `body` rather than embedded in body text — bridge consumes
   * `recipients.explicit` directly for routing decisions and
   * `quorum_attested` as a defense-in-depth signal to its own quorum
   * guard. v1 emits directory-canonical target identifiers (target
   * names); the bridge maps name → MXID via its own registry.
   *
   * Present for matrix-notify calls whenever the call involves at least
   * one Matrix-visible target (single-target or multi-target). Absent
   * when all targets are inbox-only.
   */
  recipients?: {
    /** Directory-canonical target identifiers for matrix_visible_targets. */
    explicit: string[];
    /**
     * True iff recipient intent is satisfied, either by singular
     * Matrix-visible recipient inference (n=1) or by a satisfying
     * caller-supplied `recipient_quorum`.
     */
    quorum_attested: boolean;
  };
}

/** Result of a successful Matrix send. */
export interface MatrixSendResult {
  event_id: string;
}

/**
 * Matrix substrate. Implementations:
 *  - Subprocess wrapper around `send-matrix.py` (v1; see
 *    `apps/internal-gateway/agents-mcp-mount.ts`)
 *  - Future: native MatrixToolProvider per AJS-56 Phase 2
 */
export interface MatrixTool {
  send(args: MatrixSendArgs): Promise<MatrixSendResult>;
}

/** A target's routing capabilities, as registered in the directory. */
export interface TargetDirectoryEntry {
  /** Matrix routing record. When present, target is reachable over Matrix. */
  matrix?: {
    /** Matrix room id where messages to this target are delivered. */
    room: string;
  };
  /**
   * Agent inbox routing record. When present, target is reachable via
   * the persistent agent-msg mailbox. Used as a fallback when Matrix
   * isn't available, or as the only route for agents that aren't
   * Matrix-attached.
   */
  inbox?: {
    /**
     * Session name in the agent-msg mailbox. Almost always equal to
     * the target's canonical agent name, but kept as a separate field
     * so operators can alias if a target's session id differs from
     * its directory name.
     */
    session: string;
  };
}

/**
 * AJS-88 / DOT-502 v0.2 — Matrix-origin envelope for bridge-fanout inbox
 * rows. Carries the originating Matrix event metadata onto the durable
 * inbox row so consumers can correlate the inbox audit artifact back to
 * the Matrix room copy without re-deriving it from body text.
 *
 * Snake-case field names match the Matrix wire vocabulary (this is the
 * shape the bridge serialises directly to JSON and the gateway forwards
 * to the inbox CLI). Shared by {@link InboxDeliverArgs} and
 * {@link InboxMessage} so wire-shape grep is one-hop.
 *
 * Spec: `agents/bridge-mention-inbox-fanout-contract-spec-2026-05-26.md` §8.
 */
export interface MatrixOriginEnvelope {
  /** Originating Matrix event id (e.g. `"$abc...:matrix.example"`). */
  event_id: string;
  /** Originating Matrix room id (e.g. `"!room:matrix.example"`). */
  room_id: string;
  /** Originating Matrix sender MXID (e.g. `"@user:matrix.example"`). */
  sender: string;
  /** Origin server timestamp; milliseconds since epoch (Matrix wire shape). */
  origin_server_ts: number;
  /** Present iff the originating Matrix event is itself a reply. */
  reply_to_event_id?: string;
}

/**
 * AJS-88 / DOT-502 v0.2 — discriminator on durable inbox rows. Distinguishes
 * bridge-fanout-origin rows from native-`agents.send_message`-origin rows.
 *
 * **Open extension:** when deserializing rows from the persistence
 * substrate (which may carry future variants written by a newer writer),
 * consumers MUST handle unknown values with a sensible default (treat as
 * `"agents_message"`). Future additions like `"sms_inbound"` are allowed
 * without a contract break — use {@link normalizeInboxKind} at every
 * read boundary so the default-when-unknown semantic is uniform.
 *
 * Spec: §7.
 */
export type InboxKind = "matrix_room_mention" | "agents_message";

/**
 * Known-kind set, captured separately from the union so the read-boundary
 * predicate ({@link normalizeInboxKind}) can be written without inlining
 * an equality chain. Widening the union requires adding to this set in
 * lockstep — typed enforcement against the banked boundary-narrowing
 * drift pattern.
 */
export const KNOWN_INBOX_KINDS: ReadonlySet<InboxKind> = new Set<InboxKind>([
  "matrix_room_mention",
  "agents_message",
]);

/**
 * Normalise a raw `kind` value (possibly absent, possibly an unrecognised
 * future variant) to a known {@link InboxKind}. Per spec §7 back-compat:
 * absent / unknown → `"agents_message"`. Use at every consumer read
 * boundary so the open-extension semantic stays uniform.
 */
export function normalizeInboxKind(raw: unknown): InboxKind {
  if (typeof raw === "string" && (KNOWN_INBOX_KINDS as ReadonlySet<string>).has(raw)) {
    return raw as InboxKind;
  }
  return "agents_message";
}

/** Args passed to {@link AgentInboxTool.deliver}. */
export interface InboxDeliverArgs {
  identity: AuthenticatedIdentity;
  /** Target session in the mailbox (resolved from the directory). */
  toSession: string;
  /** Message body. */
  body: string;
  /** Optional correlation id; the inbox CLI generates one if omitted. */
  correlationId?: string;
  /**
   * AJS-88 / DOT-502 v0.2 — caller-supplied idempotency key. When set,
   * the inbox substrate enforces uniqueness on `(toSession, idempotencyKey)`
   * via a partial UNIQUE index; a duplicate insert returns the existing
   * row's id + `already_delivered: true` on {@link InboxDeliverResult}.
   *
   * Bridge fanout sets this to `${matrix_event_id}:${target_session}`.
   * Native `agents.send_message` callers leave it undefined (NULL row).
   */
  idempotencyKey?: string;
  /**
   * AJS-88 / DOT-502 v0.2 — Matrix-origin envelope for bridge-fanout
   * writes. Stored as structured fields on the inbox row, NOT embedded
   * in body. Absent for native `agents.send_message` callers.
   */
  matrixOrigin?: MatrixOriginEnvelope;
  /**
   * AJS-88 / DOT-502 v0.2 — origin discriminator. Native
   * `agents.send_message` callers pass `"agents_message"`; bridge fanout
   * passes `"matrix_room_mention"`.
   */
  kind: InboxKind;
}

/** Result of a successful inbox delivery. */
export interface InboxDeliverResult {
  message_id: string;
  created_at: string;
  /**
   * AJS-88 / DOT-502 v0.2 — true iff the insert was a no-op because
   * `(toSession, idempotencyKey)` already existed. Substrate returns the
   * EXISTING row's `message_id` + `created_at` so callers can treat the
   * collision as success without retry. Absent (or false) on a fresh
   * insert. Bridge consumers treat `already_delivered: true` as success.
   *
   * Type-level surface even when the underlying CLI does not yet return
   * the flag — additive consumers (bridge fanout, audit logging) can
   * pattern against it from day one.
   */
  already_delivered?: boolean;
}

/** A single inbox message, returned by {@link AgentInboxTool.read}. */
export interface InboxMessage {
  message_id: string;
  from_session: string;
  to_session: string;
  created_at: string;
  body: string;
  priority?: "low" | "normal" | "high";
  /**
   * AJS-88 / DOT-502 v0.2 — present on rows written by bridge fanout
   * (see spec §2). Absent on rows from native `agents.send_message`.
   */
  matrix_origin?: MatrixOriginEnvelope;
  /**
   * AJS-88 / DOT-502 v0.2 — origin discriminator. Per spec §7:
   * existing rows written before this contract have no `kind` column /
   * NULL value; consumers SHALL treat absent `kind` as `"agents_message"`.
   * Only NEW bridge-fanout rows carry `"matrix_room_mention"`. Use
   * {@link normalizeInboxKind} at consumer read boundaries.
   *
   * Note: `idempotency_key` is deliberately NOT surfaced here. Per spec
   * §8 hand-off list, only `matrix_origin` + `kind` are read back through
   * `agents_get_messages`; the key is a write-side enforcement detail.
   */
  kind?: InboxKind;
}

/** Args passed to {@link AgentInboxTool.read}. */
export interface InboxReadArgs {
  identity: AuthenticatedIdentity;
  /**
   * Session whose mailbox is being read. v1 ALWAYS equals
   * `identity.agentName` — the dispatcher enforces self-only read.
   * The arg is kept explicit so the cross-agent extension (post-
   * `inbox.read_all` scope) doesn't require a contract change.
   */
  session: string;
  /** Max messages to return. */
  limit?: number;
}

/**
 * AgentInbox substrate. Implementations:
 *  - Subprocess wrapper around the `agent-msg` CLI (v1; see
 *    `apps/internal-gateway/agents-mcp-mount.ts`).
 *  - Future: native AgentInboxProvider per AJS-58 follow-up.
 */
export interface AgentInboxTool {
  deliver(args: InboxDeliverArgs): Promise<InboxDeliverResult>;
  read(args: InboxReadArgs): Promise<InboxMessage[]>;
}

/**
 * Target directory — the AJS-55 trust manifest's read surface.
 *
 * V1 implementation is an in-memory Map populated from env. The AJS-55
 * loader will swap in a signed-peer-record-backed implementation
 * without changing this contract.
 */
export interface TargetDirectory {
  /** Look up the routing entry for a target name. Returns null when unknown. */
  resolve(target: string): TargetDirectoryEntry | null;
}

/**
 * Arguments for `agents.send_message`.
 *
 * Two call shapes, mutually exclusive:
 *
 * - **Single-target** (`target: string`): single-recipient call shape.
 *   Returns a success result with top-level `inbox_message_id` / `event_id`.
 * - **Multi-target fan-out** (`targets: string[]`): server-side fan-out
 *   to multiple recipients with optional quorum + per-target timeout.
 *   Returns a success result with `results: PerTargetResult[]` plus the
 *   aggregate `delivered`/`failed`/`in_flight`/`threshold_met` fields.
 *
 * Validation rejects calls that set both `target` + `targets`, neither,
 * an empty `targets` array, duplicates within `targets`, more targets
 * than {@link FAN_OUT_TARGET_CAP}, a `threshold.at_least` outside
 * `1..targets.length`, or `threshold` set alongside `target` (single).
 */
export interface SendMessageArgs {
  /** Single-target call shape. Mutually exclusive with `targets`. */
  target?: string;
  /**
   * Multi-target fan-out call shape. Each target is resolved independently
   * through the same directory + scope rules as a single-target call.
   * Mutually exclusive with `target`. Empty array and duplicates are
   * rejected.
   */
  targets?: string[];
  /** Message body. Shared across all targets when fanning out. */
  body: string;
  /** Optional reply threading; ignored if not a string. */
  reply_to_event_id?: string;
  /**
   * Optional bridge-fanout idempotency key. Native callers omit this;
   * Matrix bridge fanout sets it so duplicate event processing resolves
   * to the existing inbox row instead of creating a second delivery.
   */
  idempotencyKey?: string;
  /**
   * Optional Matrix-origin envelope for bridge-fanout rows. Native
   * callers omit this; bridge fanout passes the Matrix event metadata so
   * `agents.get_messages` consumers can correlate the row to the room
   * event without parsing body text.
   */
  matrixOrigin?: MatrixOriginEnvelope;
  /**
   * Optional origin discriminator. Defaults to `"agents_message"` for
   * native callers; bridge fanout passes `"matrix_room_mention"`.
   */
  kind?: InboxKind;
  /**
   * Optional quorum. Absent → "wait for every target to reach a terminal
   * state; success is the all-terminal state". Present → "return when
   * `at_least` targets have delivered OR when remaining targets cannot
   * possibly reach the threshold". Multi-target only.
   */
  threshold?: { at_least: number };
  /**
   * When true (default), the call returns as soon as `threshold` is met
   * or the remaining-targets short-circuit fires; in-flight per-target
   * sends continue server-side but their results are not surfaced to
   * the caller. When false, the call waits for every target to reach
   * a terminal state regardless of threshold. Multi-target only.
   */
  early_return?: boolean;
  /**
   * Per-target send timeout in milliseconds. Defaults to
   * {@link DEFAULT_TARGET_TIMEOUT_MS}. A target whose send exceeds this
   * surface as a per-target result with `status: "timeout"` and counts
   * toward the `failed` aggregate. Multi-target only.
   */
  target_timeout_ms?: number;
  /**
   * Recipient-intent quorum for Matrix-visible recipients. ORTHOGONAL to
   * delivery `threshold`: `threshold` answers "when may the tool return
   * success?" (dispatcher accounting); `recipient_quorum` answers "did
   * the caller explicitly mean to notify/broadcast to this Matrix-visible
   * recipient set?" (caller-intent safety check). A caller's `threshold`
   * does NOT satisfy a `recipient_quorum` requirement; the two are
   * independently asserted.
   *
   * Multi-target only. Required when more than one target in the fan-out
   * resolves to a Matrix-visible directory entry; recommended for clarity
   * on single Matrix-visible target (gateway infers `at_least: 1` from
   * the singular). `at_least` must be an integer in
   * `[1, matrix_visible_targets.length]`.
   *
   * See AJS-67 design doc for the full contract surface (vault path:
   * `agents-js/docs/protocols/ajs-67-recipient-intent-quorum.md`).
   */
  recipient_quorum?: { at_least: number };
  /**
   * Any other field a caller might pass — `as_agent`, `sender`,
   * `from`, `identity` — is IGNORED. Identity is server-resolved
   * from the JWT. This rest-prop documents the security invariant at
   * the type boundary.
   */
  [extraField: string]: unknown;
}

/** Hard upper bound on multi-target fan-out. DoS bound. */
export const FAN_OUT_TARGET_CAP = 50;

/** Default per-target timeout for multi-target fan-out (30s). */
export const DEFAULT_TARGET_TIMEOUT_MS = 30_000;

/**
 * Per-target result inside a multi-target {@link SendMessageResult}.
 *
 * `status: "delivered"` mirrors the single-target success shape: an
 * `inbox_message_id` is present iff the durable inbox-write succeeded;
 * an `event_id` is present iff the matrix-notify fired AND succeeded;
 * a `matrix_notification_error` is present iff the matrix-notify fired
 * AND failed (degraded delivered, mirroring single-target semantics).
 *
 * `status: "failed"` carries the same error reasons the single-target
 * shape uses (`unknown-target`, `scope-not-granted`, `inbox-write-failed`,
 * `send-failed`, `invalid-args`). `scope-not-granted` populates
 * `offending_scopes` with the scope(s) the caller lacked for this
 * target, matching the AJS-55 mint-redeem `invalid-scope` shape.
 *
 * `status: "timeout"` indicates the per-target send did not reach a
 * terminal state before `target_timeout_ms` elapsed. Distinguished from
 * `failed` so callers can detect dead-peer vs explicit-NACK shapes.
 */
export interface PerTargetResult {
  /** Target agent name (mirrors the `targets[]` entry that produced this). */
  target: string;
  /** Terminal disposition for this target. */
  status: "delivered" | "failed" | "timeout";
  /** Present iff status === "delivered" AND inbox-write succeeded. */
  inbox_message_id?: string;
  /** Present iff inbox_message_id present. */
  inbox_created_at?: string;
  /** Present iff status === "delivered" AND matrix-notify succeeded. */
  event_id?: string;
  /** Present iff matrix-notify fired AND failed (status remains "delivered"). */
  matrix_notification_error?: string;
  /** Present iff status === "failed". */
  error?: SendMessageError;
  /** Present iff error === "scope-not-granted". */
  offending_scopes?: string[];
  /** Free-text diagnostic; present on every non-delivered status. */
  message?: string;
  /** ISO 8601 UTC when this target reached terminal. */
  timestamp: string;
}

/** Structured error reasons. Stable string union for transport mapping. */
export type SendMessageError =
  | "invalid-args"
  | "scope-not-granted"
  | "unknown-target"
  | "send-failed"
  | "inbox-write-failed"
  /** Per-target only; surfaces inside `PerTargetResult.error`. */
  | "timeout"
  /**
   * AJS-67 top-level only. Multi-target fan-out with more than one
   * Matrix-visible target supplied no `recipient_quorum`. Pre-send
   * rejection (no per-target sends initiated). Per-target results
   * cannot carry this error.
   */
  | "recipient-intent-required"
  /**
   * AJS-67 top-level only. `recipient_quorum.at_least` is outside the
   * range `[1, matrix_visible_targets.length]`, either because the
   * caller asked for more confirmations than there are Matrix-visible
   * recipients, or because no Matrix-visible recipients exist for the
   * call shape. Pre-send rejection (no per-target sends initiated).
   * Per-target results cannot carry this error.
   */
  | "recipient-quorum-unsatisfiable";

/**
 * Result of a {@link AgentsDispatcher.sendMessage} call.
 *
 * AJS-65 route-model: inbox is the durable substrate; matrix is the
 * notification overlay. Success-shape carries flat fields rather than a
 * `delivery` discriminator — `inbox_message_id` is always present on a
 * single-target success, and `event_id` joins it when the target also
 * advertises a Matrix route + the caller holds `matrix.send_message`.
 *
 * Shape semantics (runtime invariants):
 * - `inbox_message_id` + `inbox_created_at` always present on single-target
 *   success (inbox is the mandatory durable substrate)
 * - `event_id` present iff matrix-notify fired AND succeeded
 * - `matrix_notification_error` present iff matrix-notify fired AND failed
 *   (degraded success — inbox-write took, matrix-notify did not)
 *
 * Hard-fail (ok=false) shapes:
 * - `inbox-write-failed`: caller has inbox.deliver scope + dispatcher
 *   attempted inbox-write + it threw. Matrix MUST NOT have been attempted
 *   (no notification without durable storage).
 * - `send-failed`: the inbox substrate is not configured on the gateway.
 * - `scope-not-granted` / `unknown-target` / `invalid-args`: unchanged.
 */
export type SendMessageResult =
  | {
      // Single-target success. Distinguished from the multi-target shape
      // by the absence of the `results` field.
      ok: true;
      /** The durable inbox-write id (always present on single-target success). */
      inbox_message_id: string;
      /** Inbox-write timestamp (always present on single-target success). */
      inbox_created_at: string;
      /** Present iff matrix notification fired AND succeeded. */
      event_id?: string;
      /** Present iff matrix notification fired AND failed (degraded success). */
      matrix_notification_error?: string;
    }
  | {
      // Multi-target fan-out success. Distinguished from single-target
      // by the presence of `results`. `ok: true` here means the request
      // was well-formed and the fan-out executed — per-target failures
      // surface in `results[].status` and the `failed`/`delivered` counts.
      // Callers wanting "did the whole broadcast succeed" should check
      // `threshold_met`.
      ok: true;
      /** Count of `results[]` entries with status === "delivered". */
      delivered: number;
      /** Count of `results[]` entries with status in {"failed", "timeout"}. */
      failed: number;
      /**
       * Count of targets whose send was still in flight when the call
       * returned. Always 0 unless `early_return: true` (default) AND the
       * threshold short-circuit fired before all targets terminated.
       */
      in_flight: number;
      /**
       * True iff `delivered >= (threshold?.at_least ?? targets.length)`
       * at return time. The aggregate "did the broadcast succeed" flag.
       */
      threshold_met: boolean;
      /** Per-target results. Length === targets.length - in_flight. */
      results: PerTargetResult[];
      /**
       * AJS-67: recipient-intent observability. Present when at least one
       * fan-out target resolved to a Matrix-visible directory entry;
       * absent when every target is inbox-only (or unknown). Callers can
       * cross-reference `matrix_visible_targets` against `results[]` by
       * the `target` field to identify which deliveries also carried
       * recipient-intent semantics.
       */
      recipient_intent?: {
        /**
         * True iff `matrix_visible_targets.length > 1` (the caller MUST
         * have supplied a `recipient_quorum` for the call to succeed).
         * False when intent was inferred from a singular Matrix-visible
         * recipient.
         */
        required: boolean;
        /**
         * True iff either (a) caller supplied a satisfying
         * `recipient_quorum`, or (b) intent was inferred from a singular
         * Matrix-visible recipient. Mirrors the bridge envelope's
         * `recipients.quorum_attested` value.
         */
        satisfied: boolean;
        /**
         * Directory-canonical target identifiers for the Matrix-visible
         * subset of `targets[]`. Cross-references PerTargetResult by
         * name (callers can `results.filter(r => mvt.includes(r.target))`).
         */
        matrix_visible_targets: string[];
      };
    }
  | {
      ok: false;
      error: SendMessageError;
      target?: string;
      correlation_id: string;
      message: string;
    };

/**
 * Type guard: narrow a {@link SendMessageResult} to the multi-target
 * success shape. Useful for consumers that need to enumerate per-target
 * outcomes without a runtime field-presence check.
 */
export function isFanOutSendResult(
  result: SendMessageResult,
): result is Extract<SendMessageResult, { results: PerTargetResult[] }> {
  return result.ok === true && Array.isArray((result as { results?: unknown }).results);
}

/** Args for `agents.get_messages`. */
export interface GetMessagesArgs {
  /**
   * Target session to read. v1 must equal identity.agentName; any
   * other value is rejected with `error: "forbidden-target"` until
   * the `inbox.read_all` scope is implemented (AJS-58 follow-up).
   * If omitted, defaults to identity's own session.
   */
  target?: string;
  /** Max messages to return. Defaults to 20. */
  limit?: number;
  /** Other fields silently ignored. */
  [extraField: string]: unknown;
}

/** Structured error reasons for {@link AgentsDispatcher.getMessages}. */
export type GetMessagesError =
  | "invalid-args"
  | "scope-not-granted"
  | "forbidden-target"
  | "read-failed";

/** Result of a {@link AgentsDispatcher.getMessages} call. */
export type GetMessagesResult =
  | { ok: true; messages: InboxMessage[] }
  | {
      ok: false;
      error: GetMessagesError;
      correlation_id: string;
      message: string;
    };

/** Options for {@link createAgentsDispatcher}. */
export interface AgentsDispatcherOptions {
  matrixTool: MatrixTool;
  /**
   * AgentInbox substrate. Optional — if omitted, inbox routing in
   * the directory resolves to `scope-not-granted` (with a hint that
   * the operator must configure the inbox backend) and `getMessages`
   * unconditionally returns `read-failed`. Making this optional keeps
   * the gateway bootable in dev without the inbox dep.
   */
  agentInboxTool?: AgentInboxTool;
  targetDirectory: TargetDirectory;
  /** Optional logger for send-failed warnings. Defaults to `console`. */
  logger?: Pick<Console, "warn" | "error">;
}

/**
 * The MCP-side dispatcher surface. Exposes `sendMessage` (router-level
 * agents.send_message; routes Matrix or inbox based on target + scope)
 * and `getMessages` (agents.get_messages; v1 inbox-only, self-session).
 * No admin tools. Keys of this object are pinned by the contract test
 * `dispatcher exposes only sendMessage + getMessages; no admin tool surface`.
 */
export interface AgentsDispatcher {
  sendMessage(args: SendMessageArgs, identity: AuthenticatedIdentity): Promise<SendMessageResult>;
  getMessages(args: GetMessagesArgs, identity: AuthenticatedIdentity): Promise<GetMessagesResult>;
}

/**
 * Build the dispatcher. Pure factory — no side effects until a
 * `sendMessage` / `getMessages` call.
 */
export function createAgentsDispatcher(options: AgentsDispatcherOptions): AgentsDispatcher {
  const logger = options.logger ?? console;

  // ============================================================================
  // Per-target send (used by both single-target and multi-target fan-out
  // paths). Returns a PerTargetResult — never throws on per-target failures
  // (errors surface as status: "failed"). Capturing this as a closure rather
  // than a free function keeps logger + options access local and avoids
  // exposing implementation details on the module surface.
  //
  // AJS-65 route-model: inbox is the mandatory durable substrate
  // (`inbox.deliver` always required); inbox-write fires FIRST, then a
  // pointer-only matrix-notify overlay when the target advertises a Matrix
  // route. See the original sendMessage commit (13142c27) for the rationale.
  // ============================================================================
  async function sendOne(opts: {
    target: string;
    body: string;
    replyToEventId?: string;
    identity: AuthenticatedIdentity;
    /**
     * AJS-67 bridge envelope passed through to the matrix-notify call.
     * Single-target back-compat path computes this inline for n=1
     * Matrix-visible inference; multi-target path computes once for the
     * whole broadcast and passes the same envelope to every per-target
     * matrix-notify (so every matrix event carries the same broadcast
     * recipient set). Absent when no targets in the call are Matrix-visible.
     */
    recipientsEnvelope?: { explicit: string[]; quorum_attested: boolean };
    idempotencyKey?: string;
    matrixOrigin?: MatrixOriginEnvelope;
    kind?: InboxKind;
  }): Promise<PerTargetResult> {
    const {
      target,
      body,
      replyToEventId,
      identity,
      recipientsEnvelope,
      idempotencyKey,
      matrixOrigin,
      kind,
    } = opts;
    const correlation_id = identity.correlationId;
    const timestamp = (): string => new Date().toISOString();

    const entry = options.targetDirectory.resolve(target);
    // Inbox is the durable delivery substrate — every routable target
    // advertises an inbox route. Matrix, when present, is a notification
    // overlay on top of the inbox write.
    if (!entry?.inbox) {
      return {
        target,
        status: "failed",
        error: "unknown-target",
        message: `target '${target}' has no inbox routing`,
        timestamp: timestamp(),
      };
    }

    const matrixScope = checkScope(identity, "matrix.send_message");
    const inboxScope = checkScope(identity, "inbox.deliver");

    // Scope gating: inbox is the mandatory durable substrate, so
    // `inbox.deliver` is always required. Missing scope surfaces the
    // offending scope set to the caller — matches AJS-55 mint-redeem
    // `invalid-scope` shape.
    if (!inboxScope.ok) {
      return {
        target,
        status: "failed",
        error: "scope-not-granted",
        offending_scopes: ["inbox.deliver"],
        message: `scope inbox.deliver not granted to ${identity.agentName}; entry '${target}' advertises inbox route and inbox is the durable substrate`,
        timestamp: timestamp(),
      };
    }

    // Step 1: inbox-write. Required to succeed before matrix-notify is
    // attempted. No notification without durable storage.
    if (!options.agentInboxTool) {
      logger.warn(
        "[agents-tool-surface] inbox routing requested but agentInboxTool not configured",
        { target, correlation_id },
      );
      return {
        target,
        status: "failed",
        error: "send-failed",
        message: "inbox substrate not configured",
        timestamp: timestamp(),
      };
    }
    let inboxResult: InboxDeliverResult;
    try {
      inboxResult = await options.agentInboxTool.deliver({
        identity,
        toSession: entry.inbox.session,
        body,
        correlationId: correlation_id,
        ...(typeof idempotencyKey === "string" && idempotencyKey.length > 0
          ? { idempotencyKey }
          : {}),
        ...(matrixOrigin !== undefined ? { matrixOrigin } : {}),
        kind: kind ?? "agents_message",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("[agents-tool-surface] inbox deliver failed", {
        target,
        correlation_id,
        message,
      });
      return {
        target,
        status: "failed",
        error: "inbox-write-failed",
        message,
        timestamp: timestamp(),
      };
    }

    // Step 2: matrix-notify (pointer-only overlay). The durable body lives
    // in the inbox; the Matrix event carries a pointer to it.
    let matrixEventId: string | null = null;
    let matrixNotificationError: string | null = null;
    if (entry.matrix && matrixScope.ok) {
      const matrixArgs: MatrixSendArgs = {
        identity,
        target,
        room: entry.matrix.room,
        body: `see inbox: ${inboxResult.message_id}`,
        ...(typeof replyToEventId === "string" ? { replyToEventId } : {}),
        ...(recipientsEnvelope !== undefined ? { recipients: recipientsEnvelope } : {}),
      };
      try {
        const result = await options.matrixTool.send(matrixArgs);
        matrixEventId = result.event_id;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("[agents-tool-surface] matrix notify failed", {
          target,
          correlation_id,
          message,
        });
        // Degraded success: the durable inbox write took, so delivery is
        // real even though the notification overlay failed.
        matrixNotificationError = message;
      }
    }

    // Delivered. `inbox_message_id` is always present (durable write
    // succeeded); the matrix overlay fields are present iff matrix-notify
    // fired.
    const result: PerTargetResult = {
      target,
      status: "delivered",
      inbox_message_id: inboxResult.message_id,
      inbox_created_at: inboxResult.created_at,
      timestamp: timestamp(),
    };
    if (matrixEventId) {
      result.event_id = matrixEventId;
    }
    if (matrixNotificationError) {
      result.matrix_notification_error = matrixNotificationError;
    }
    return result;
  }

  // Pinned to `["sendMessage", "getMessages"]` keys — see contract test
  // `dispatcher exposes only sendMessage + getMessages; no admin tool surface`.
  // Adding other methods here requires updating that test deliberately.
  return {
    async sendMessage(
      args: SendMessageArgs,
      identity: AuthenticatedIdentity,
    ): Promise<SendMessageResult> {
      const correlation_id = identity.correlationId;

      // Common arg validation (applies to both single + multi paths).
      if (typeof args?.body !== "string") {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: "`body` (string) is required",
        };
      }

      const hasTarget = typeof args.target === "string" && args.target.length > 0;
      const hasTargets = Array.isArray(args.targets);

      // Mutually-exclusive call shapes.
      if (hasTarget && hasTargets) {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: "`target` and `targets` are mutually exclusive — provide exactly one",
        };
      }
      if (!hasTarget && !hasTargets) {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: "`target` (string) or `targets` (string[]) is required",
        };
      }

      // Single-target back-compat path. Projects PerTargetResult into the
      // pre-AJS-63 SendMessageResult shape: success → top-level
      // {inbox_message_id, event_id, ...}; failure → outer
      // {ok: false, error, target, correlation_id, message}.
      if (hasTarget) {
        // Reject multi-target-only knobs supplied with single-target call —
        // silently ignoring them would surprise callers when their threshold
        // doesn't do anything.
        if (args.threshold !== undefined) {
          return {
            ok: false,
            error: "invalid-args",
            correlation_id,
            message: "`threshold` is multi-target only (use `targets`)",
          };
        }
        const replyToEventId =
          typeof args.reply_to_event_id === "string" ? args.reply_to_event_id : undefined;
        const target = args.target as string;
        const idempotencyKey =
          typeof args.idempotencyKey === "string" && args.idempotencyKey.length > 0
            ? args.idempotencyKey
            : undefined;
        const matrixOrigin =
          typeof args.matrixOrigin === "object" && args.matrixOrigin !== null
            ? args.matrixOrigin
            : undefined;
        const kind = normalizeInboxKind(args.kind);
        // AJS-67 single-target envelope: n=1 Matrix-visible inference.
        // Resolve once here for envelope computation; sendOne re-resolves
        // for its own routing logic (back-compat with the per-target
        // dispatch pattern; double-resolve cost is negligible at the
        // hot-path layer above this).
        const singleEntry = options.targetDirectory.resolve(target);
        const singleRecipientsEnvelope =
          singleEntry?.matrix !== undefined
            ? { explicit: [target], quorum_attested: true }
            : undefined;
        const per = await sendOne({
          target,
          body: args.body,
          replyToEventId,
          identity,
          ...(singleRecipientsEnvelope !== undefined
            ? { recipientsEnvelope: singleRecipientsEnvelope }
            : {}),
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          ...(matrixOrigin !== undefined ? { matrixOrigin } : {}),
          kind,
        });
        if (per.status !== "delivered") {
          return {
            ok: false,
            error: per.error ?? "send-failed",
            target,
            correlation_id,
            message: per.message ?? "send failed",
          };
        }
        // A delivered single target always carries the durable inbox id —
        // inbox is the mandatory substrate and `sendOne` sets both fields on
        // the "delivered" branch. Assert rather than paper over a missing id
        // (a success without durable storage would violate the route model).
        if (per.inbox_message_id === undefined || per.inbox_created_at === undefined) {
          throw new Error(
            "[agents-tool-surface] delivered single-target result missing durable inbox id (invariant violated)",
          );
        }
        const out: Extract<SendMessageResult, { inbox_message_id: string }> = {
          ok: true,
          inbox_message_id: per.inbox_message_id,
          inbox_created_at: per.inbox_created_at,
        };
        if (per.event_id !== undefined) {
          out.event_id = per.event_id;
        }
        if (per.matrix_notification_error !== undefined) {
          out.matrix_notification_error = per.matrix_notification_error;
        }
        return out;
      }

      // Multi-target fan-out path.
      const targets = args.targets as string[];

      // Multi-target arg validation. Loud-failure on shape errors;
      // partial-validity (e.g. some targets exist, some don't) is NOT a
      // validation failure — those surface as per-target results.
      if (!targets.every((t) => typeof t === "string" && t.length > 0)) {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: "`targets` must be a non-empty array of non-empty strings",
        };
      }
      if (targets.length === 0) {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: "`targets` must contain at least one entry",
        };
      }
      if (targets.length > FAN_OUT_TARGET_CAP) {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: `\`targets\` exceeds fan-out cap of ${FAN_OUT_TARGET_CAP}; got ${targets.length}`,
        };
      }
      if (new Set(targets).size !== targets.length) {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: "`targets` contains duplicate entries",
        };
      }

      // Implicit threshold (absent) means "wait for all terminal" — the
      // early-fail short-circuit does NOT fire. Explicit threshold opts
      // into both the delivered>=N early-return AND the
      // remaining-cannot-satisfy short-circuit.
      let thresholdAtLeast: number = targets.length;
      let thresholdExplicit = false;
      if (args.threshold !== undefined) {
        thresholdExplicit = true;
        if (
          typeof args.threshold !== "object" ||
          args.threshold === null ||
          typeof (args.threshold as { at_least?: unknown }).at_least !== "number"
        ) {
          return {
            ok: false,
            error: "invalid-args",
            correlation_id,
            message: "`threshold.at_least` (number) is required when `threshold` is set",
          };
        }
        const n = (args.threshold as { at_least: number }).at_least;
        if (!Number.isInteger(n) || n < 1 || n > targets.length) {
          return {
            ok: false,
            error: "invalid-args",
            correlation_id,
            message: `\`threshold.at_least\` must be an integer in [1, targets.length=${targets.length}]; got ${n}`,
          };
        }
        thresholdAtLeast = n;
      }

      let targetTimeoutMs: number = DEFAULT_TARGET_TIMEOUT_MS;
      if (args.target_timeout_ms !== undefined) {
        if (
          typeof args.target_timeout_ms !== "number" ||
          !Number.isFinite(args.target_timeout_ms) ||
          args.target_timeout_ms <= 0
        ) {
          return {
            ok: false,
            error: "invalid-args",
            correlation_id,
            message: "`target_timeout_ms` must be a positive number",
          };
        }
        targetTimeoutMs = args.target_timeout_ms;
      }

      const earlyReturn = args.early_return !== false; // default true

      const replyToEventId =
        typeof args.reply_to_event_id === "string" ? args.reply_to_event_id : undefined;

      // ====================================================================
      // AJS-67 RECIPIENT-INTENT VALIDATION (pre-send).
      //
      // Runs BEFORE any per-target send is initiated. Failure rejects at
      // the top-level — no per-target results, no in-flight cleanup, no
      // leaked setTimeout handles. Design doc:
      //   agents-js/docs/protocols/ajs-67-recipient-intent-quorum.md
      //
      // 1. Resolve every target's directory entry. Unknown targets
      //    contribute null entries (they later surface as per-target
      //    `unknown-target` failures, but for visibility computation
      //    they're treated as not-Matrix-visible).
      // 2. Compute matrix_visible_targets via the existing
      //    `entry.matrix !== undefined` predicate (AJS-65 dual-route /
      //    matrix-only entries both qualify).
      // 3. Apply intent rules:
      //    - matrix_visible.length > 1 + no recipient_quorum →
      //      reject `recipient-intent-required`
      //    - recipient_quorum.at_least not in [1, matrix_visible.length] →
      //      reject `recipient-quorum-unsatisfiable` (collapses the
      //      "supplied quorum for an all-inbox call" case via the
      //      at_least > 0 visible check; message hint distinguishes)
      // 4. Build the per-broadcast recipients envelope shared across
      //    every per-target matrix-notify call.
      // ====================================================================
      const matrixVisibleTargets = targets.filter((t) => {
        const entry = options.targetDirectory.resolve(t);
        return entry?.matrix !== undefined;
      });
      const recipientIntentRequired = matrixVisibleTargets.length > 1;

      if (recipientIntentRequired && args.recipient_quorum === undefined) {
        return {
          ok: false,
          error: "recipient-intent-required",
          correlation_id,
          message: `multi-target call has ${matrixVisibleTargets.length} Matrix-visible recipients (${matrixVisibleTargets.join(", ")}); explicit \`recipient_quorum.at_least\` is required to confirm broadcast intent`,
        };
      }

      let recipientQuorumAtLeast: number | null = null;
      if (args.recipient_quorum !== undefined) {
        if (
          typeof args.recipient_quorum !== "object" ||
          args.recipient_quorum === null ||
          typeof (args.recipient_quorum as { at_least?: unknown }).at_least !== "number"
        ) {
          return {
            ok: false,
            error: "invalid-args",
            correlation_id,
            message:
              "`recipient_quorum.at_least` (number) is required when `recipient_quorum` is set",
          };
        }
        const n = (args.recipient_quorum as { at_least: number }).at_least;
        if (!Number.isInteger(n) || n < 1) {
          return {
            ok: false,
            error: "recipient-quorum-unsatisfiable",
            correlation_id,
            message: `\`recipient_quorum.at_least\` must be an integer >= 1; got ${n}`,
          };
        }
        if (matrixVisibleTargets.length === 0) {
          return {
            ok: false,
            error: "recipient-quorum-unsatisfiable",
            correlation_id,
            message: `\`recipient_quorum\` supplied but no Matrix-visible targets in \`targets\` (all entries are inbox-only or unknown); recipient-intent semantics do not apply`,
          };
        }
        if (n > matrixVisibleTargets.length) {
          return {
            ok: false,
            error: "recipient-quorum-unsatisfiable",
            correlation_id,
            message: `\`recipient_quorum.at_least\` (${n}) exceeds Matrix-visible target count (${matrixVisibleTargets.length}); cannot be satisfied`,
          };
        }
        recipientQuorumAtLeast = n;
      }

      // Build the bridge envelope shared across every per-target
      // matrix-notify. `quorum_attested` is TRUE in both paths that reach
      // here: singular Matrix-visible target (intent inferred from n=1) OR
      // multi-target with a satisfying recipient_quorum (validated above).
      // The envelope is undefined when no targets are Matrix-visible so
      // bridges don't see synthetic empty `recipients.explicit` arrays.
      const recipientsEnvelope =
        matrixVisibleTargets.length > 0
          ? { explicit: [...matrixVisibleTargets], quorum_attested: true }
          : undefined;

      // Per-target dispatch. Each target's send is wrapped in a timeout
      // race; the timeout result surfaces as status: "timeout". We track
      // terminal results as they resolve so the early-return /
      // threshold-short-circuit logic can fire without waiting for the
      // slowest in-flight target.
      const results = new Array<PerTargetResult | undefined>(targets.length);
      const TIMEOUT_SENTINEL = Symbol("timeout");

      let delivered = 0;
      let terminalFailed = 0;
      let terminalCount = 0;

      // Resolve the outer promise as soon as one of:
      //   (a) every per-target promise terminated, OR
      //   (b) early_return && delivered >= thresholdAtLeast, OR
      //   (c) early_return && terminalCount === targets.length (all done; threshold
      //       may or may not be met), OR
      //   (d) early_return && (targets.length - terminalCount + delivered) < thresholdAtLeast
      //       (remaining-targets short-circuit: even if every in-flight
      //       target delivers, threshold cannot be met — return now).
      await new Promise<void>((resolveOuter) => {
        let outerResolved = false;
        const resolveOnce = (): void => {
          if (outerResolved) return;
          outerResolved = true;
          resolveOuter();
        };
        const maybeShortCircuit = (): void => {
          if (terminalCount === targets.length) {
            resolveOnce();
            return;
          }
          if (!earlyReturn) return;
          if (delivered >= thresholdAtLeast) {
            resolveOnce();
            return;
          }
          // Remaining-cannot-satisfy short-circuit ONLY fires on explicit
          // threshold. Implicit threshold (== targets.length) means
          // "wait for every target terminal so caller can inspect every
          // per-target result" — short-circuiting after the first failure
          // would discard in-flight per-target results the caller needs.
          if (!thresholdExplicit) return;
          const stillReachable = delivered + (targets.length - terminalCount);
          if (stillReachable < thresholdAtLeast) {
            resolveOnce();
          }
        };

        targets.forEach((target, idx) => {
          const sendPromise = sendOne({
            target,
            body: args.body,
            replyToEventId,
            identity,
            ...(recipientsEnvelope !== undefined ? { recipientsEnvelope } : {}),
          });
          let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
          const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((res) => {
            timeoutHandle = setTimeout(() => res(TIMEOUT_SENTINEL), targetTimeoutMs);
          });

          Promise.race([sendPromise, timeoutPromise])
            .finally(() => {
              // Clear the per-target timer regardless of which promise won
              // the race, so a fast-completing send doesn't leak a 30s timer
              // (default) into the event loop.
              if (timeoutHandle !== null) clearTimeout(timeoutHandle);
            })
            .then((settled) => {
              // Guard against late resolution after outer already returned.
              if (outerResolved) return;
              let per: PerTargetResult;
              if (settled === TIMEOUT_SENTINEL) {
                per = {
                  target,
                  status: "timeout",
                  error: "timeout",
                  message: `target send did not terminate within ${targetTimeoutMs}ms`,
                  timestamp: new Date().toISOString(),
                };
              } else {
                per = settled;
              }
              results[idx] = per;
              terminalCount += 1;
              if (per.status === "delivered") {
                delivered += 1;
              } else {
                terminalFailed += 1;
              }
              maybeShortCircuit();
            })
            .catch((err) => {
              // sendOne is contracted not to throw; this catches the
              // hypothetical unhandled-rejection case so the outer call
              // doesn't hang.
              if (outerResolved) return;
              const message = err instanceof Error ? err.message : String(err);
              const per: PerTargetResult = {
                target,
                status: "failed",
                error: "send-failed",
                message,
                timestamp: new Date().toISOString(),
              };
              results[idx] = per;
              terminalCount += 1;
              terminalFailed += 1;
              maybeShortCircuit();
            });
        });
      });

      const reachedTerminal = results.filter((r): r is PerTargetResult => r !== undefined);
      const out: Extract<SendMessageResult, { results: PerTargetResult[] }> = {
        ok: true,
        delivered,
        failed: terminalFailed,
        in_flight: targets.length - reachedTerminal.length,
        threshold_met: delivered >= thresholdAtLeast,
        results: reachedTerminal,
      };
      // AJS-67 recipient_intent metadata. Populate when any target was
      // Matrix-visible (caller observability per design doc §6.2). Absent
      // for all-inbox-only multi-target calls to keep the response shape
      // minimal when intent semantics didn't apply.
      if (matrixVisibleTargets.length > 0) {
        out.recipient_intent = {
          required: recipientIntentRequired,
          // Satisfied iff we passed the pre-send gate: either n=1 inference
          // (recipientIntentRequired === false) or a satisfying quorum
          // (recipientQuorumAtLeast set).
          satisfied: !recipientIntentRequired || recipientQuorumAtLeast !== null,
          matrix_visible_targets: [...matrixVisibleTargets],
        };
      }
      return out;
    },

    async getMessages(
      args: GetMessagesArgs,
      identity: AuthenticatedIdentity,
    ): Promise<GetMessagesResult> {
      const correlation_id = identity.correlationId;

      const scope = checkScope(identity, "inbox.read");
      if (!scope.ok) {
        return {
          ok: false,
          error: "scope-not-granted",
          correlation_id,
          message: scope.message,
        };
      }

      if (!options.agentInboxTool) {
        return {
          ok: false,
          error: "read-failed",
          correlation_id,
          message: "inbox substrate not configured",
        };
      }

      // v1 enforces self-only read: `target` (if supplied) MUST equal
      // identity.agentName. Cross-agent read requires the `inbox.read_all`
      // scope, which isn't implemented in this slice.
      const requestedSession =
        typeof args?.target === "string" && args.target.length > 0
          ? args.target
          : identity.agentName;
      if (requestedSession !== identity.agentName) {
        return {
          ok: false,
          error: "forbidden-target",
          correlation_id,
          message: `cross-agent read requires inbox.read_all scope (not implemented in v1); requested '${requestedSession}' but identity is '${identity.agentName}'`,
        };
      }

      const limit = typeof args?.limit === "number" && args.limit > 0 ? args.limit : 20;

      try {
        const messages = await options.agentInboxTool.read({
          identity,
          session: identity.agentName,
          limit,
        });
        return { ok: true, messages };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("[agents-tool-surface] inbox read failed", {
          session: identity.agentName,
          correlation_id,
          message,
        });
        return {
          ok: false,
          error: "read-failed",
          correlation_id,
          message,
        };
      }
    },
  };
}
