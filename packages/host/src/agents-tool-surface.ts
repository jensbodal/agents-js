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
 *  - **Route model** (AJS-65 — replaces the prior matrix > inbox
 *    exclusive precedence): inbox is the durable delivery substrate;
 *    matrix is the notification overlay. For a dual-route entry, the
 *    dispatcher writes inbox FIRST (hard-fails with `inbox-write-failed`
 *    if it throws — matrix is NOT attempted; notification without
 *    storage would lie), then fires matrix-notify with a pointer-only
 *    body (`"see inbox: ${inbox_message_id}"`). For a matrix-only
 *    legacy back-compat entry, full-body matrix-send is preserved.
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

/** Args passed to {@link AgentInboxTool.deliver}. */
export interface InboxDeliverArgs {
  identity: AuthenticatedIdentity;
  /** Target session in the mailbox (resolved from the directory). */
  toSession: string;
  /** Message body. */
  body: string;
  /** Optional correlation id; the inbox CLI generates one if omitted. */
  correlationId?: string;
}

/** Result of a successful inbox delivery. */
export interface InboxDeliverResult {
  message_id: string;
  created_at: string;
}

/** A single inbox message, returned by {@link AgentInboxTool.read}. */
export interface InboxMessage {
  message_id: string;
  from_session: string;
  to_session: string;
  created_at: string;
  body: string;
  priority?: "low" | "normal" | "high";
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
 * - **Single-target** (`target: string`): legacy back-compat call shape.
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
  | "timeout";

/**
 * Result of a {@link AgentsDispatcher.sendMessage} call.
 *
 * AJS-65 route-model: inbox is the durable substrate; matrix is the
 * notification overlay. Success-shape carries flat fields rather than a
 * `delivery` discriminator — both `inbox_message_id` and `event_id`
 * may be present together when target has both routes + caller has both
 * scopes.
 *
 * Shape semantics (runtime invariants):
 * - `inbox_message_id` + `inbox_created_at` present iff inbox-write succeeded
 *   (i.e. target had inbox.session + caller had inbox.deliver scope)
 * - `event_id` present iff matrix-notify fired AND succeeded
 * - `matrix_notification_error` present iff matrix-notify fired AND failed
 *   (degraded success — inbox-write took, matrix-notify did not)
 * - At least one of {inbox_message_id, event_id} is present when ok=true
 *
 * **Back-compat for matrix-only legacy targets**: targets registered with
 * matrix.room but NO inbox.session skip the inbox-write entirely. Success
 * response then has `event_id` but no `inbox_message_id`. This is the
 * pre-AJS-65 contract preserved during the TARGETS_JSON migration window;
 * post-migration (every entity gets inbox.session), matrix-only targets
 * disappear and `inbox_message_id` becomes effectively-always-present.
 * Callers that REQUIRE the durable-storage guarantee at the type level
 * use the {@link isDurableSendResult} type guard to narrow.
 *
 * Hard-fail (ok=false) shapes:
 * - `inbox-write-failed`: target has inbox.session + caller has inbox.deliver
 *   scope + dispatcher attempted inbox-write + it threw. Matrix MUST NOT
 *   have been attempted (no notification without durable storage).
 * - `send-failed`: matrix-only target + matrix-send threw (no inbox to
 *   fall back to). Back-compat path for matrix-only targets.
 * - `scope-not-granted` / `unknown-target` / `invalid-args`: unchanged.
 */
export type SendMessageResult =
  | {
      // Single-target success (back-compat). Distinguished from the
      // multi-target shape by the absence of the `results` field.
      ok: true;
      /** Present iff durable inbox-write succeeded (target had inbox.session + scope). */
      inbox_message_id?: string;
      /** Present iff inbox_message_id present. */
      inbox_created_at?: string;
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

/**
 * A {@link SendMessageResult} that carries the durable-storage invariant
 * at the type level: `ok === true` AND `inbox_message_id` is present.
 * The matrix overlay fields (`event_id`, `matrix_notification_error`)
 * remain optional because the matrix path is independent of the durable
 * storage path.
 *
 * Used by callers that need to consume the durable inbox id without
 * a null-check — e.g. audit logging, reply-routing, message threading.
 *
 * @internal exported for {@link isDurableSendResult}; consumers should
 *           use the type guard rather than the type directly.
 */
export type DurableSendMessageResult = {
  ok: true;
  inbox_message_id: string;
  inbox_created_at: string;
  event_id?: string;
  matrix_notification_error?: string;
};

/**
 * Narrow a {@link SendMessageResult} to the durable-storage shape.
 * Returns true iff the call succeeded AND a durable inbox message was
 * written (the canonical AJS-65 path). Returns false for matrix-only
 * back-compat successes (event_id without inbox_message_id) and for all
 * failure shapes.
 *
 * Callers that REQUIRE the durable id should pattern this guard:
 *
 *     const result = await dispatcher.sendMessage(args, identity);
 *     if (!isDurableSendResult(result)) {
 *       // matrix-only back-compat OR failure — handle accordingly
 *       return;
 *     }
 *     // result.inbox_message_id is now guaranteed string at the type level
 *     audit.record(result.inbox_message_id, ...);
 *
 * Why a type guard instead of a stricter `SendMessageResult` shape:
 * matrix-only back-compat targets (no inbox.session) legitimately produce
 * success without `inbox_message_id` during the TARGETS_JSON migration
 * window. Forcing inbox_message_id at the type level would force a
 * coordinated TARGETS_JSON migration before AJS-65 lands, which would
 * couple two changes that should be sequenced independently.
 */
export function isDurableSendResult(result: SendMessageResult): result is DurableSendMessageResult {
  // Multi-target results never satisfy this guard — their per-target inbox
  // ids live under `results[].inbox_message_id`. Callers fanning out should
  // enumerate `results[]` directly (via {@link isFanOutSendResult}) and
  // check each entry's `status` + `inbox_message_id`.
  if (isFanOutSendResult(result)) return false;
  return (
    result.ok === true &&
    typeof (result as { inbox_message_id?: unknown }).inbox_message_id === "string"
  );
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
  // Per-target send (used by both single-target back-compat and multi-target
  // fan-out paths). Returns a PerTargetResult — never throws on per-target
  // failures (errors surface as status: "failed"). Capturing this as a
  // closure rather than a free function keeps logger + options access local
  // and avoids exposing implementation details on the module surface.
  //
  // AJS-65 route-model rules preserved in full (route presence determines
  // required scope, inbox-write FIRST then matrix-notify, pointer-only body
  // for dual-route, full body for matrix-only back-compat). See the original
  // sendMessage commit (13142c27) for the design rationale.
  // ============================================================================
  async function sendOne(opts: {
    target: string;
    body: string;
    replyToEventId?: string;
    identity: AuthenticatedIdentity;
  }): Promise<PerTargetResult> {
    const { target, body, replyToEventId, identity } = opts;
    const correlation_id = identity.correlationId;
    const timestamp = (): string => new Date().toISOString();

    const entry = options.targetDirectory.resolve(target);
    if (!entry || (!entry.matrix && !entry.inbox)) {
      return {
        target,
        status: "failed",
        error: "unknown-target",
        message: `target '${target}' has no Matrix or inbox routing`,
        timestamp: timestamp(),
      };
    }

    const matrixScope = checkScope(identity, "matrix.send_message");
    const inboxScope = checkScope(identity, "inbox.deliver");

    // Scope gating: route presence determines required scope, NOT whichever
    // scope happens to be present (AJS-65 P1 rule). Missing scope surfaces
    // the offending scope set to the caller — matches AJS-55 mint-redeem
    // `invalid-scope` shape.
    if (entry.inbox && !inboxScope.ok) {
      return {
        target,
        status: "failed",
        error: "scope-not-granted",
        offending_scopes: ["inbox.deliver"],
        message: `scope inbox.deliver not granted to ${identity.agentName}; entry '${target}' advertises inbox route and inbox is the durable substrate`,
        timestamp: timestamp(),
      };
    }
    if (!entry.inbox && entry.matrix && !matrixScope.ok) {
      return {
        target,
        status: "failed",
        error: "scope-not-granted",
        offending_scopes: ["matrix.send_message"],
        message: `scope matrix.send_message not granted to ${identity.agentName}`,
        timestamp: timestamp(),
      };
    }

    // Step 1: inbox-write. Required to succeed before matrix-notify is
    // attempted. No notification without durable storage.
    let inboxResult: InboxDeliverResult | null = null;
    if (entry.inbox) {
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
      try {
        inboxResult = await options.agentInboxTool.deliver({
          identity,
          toSession: entry.inbox.session,
          body,
          correlationId: correlation_id,
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
    }

    // Step 2: matrix-notify. Body shape depends on route shape — dual-route
    // sends pointer-only ("see inbox: <id>"), matrix-only legacy back-compat
    // sends the full body (matrix IS the storage for those entries).
    let matrixEventId: string | null = null;
    let matrixNotificationError: string | null = null;
    if (entry.matrix && matrixScope.ok) {
      const matrixBody = inboxResult !== null ? `see inbox: ${inboxResult.message_id}` : body;
      const matrixArgs: MatrixSendArgs = {
        identity,
        target,
        room: entry.matrix.room,
        body: matrixBody,
        ...(typeof replyToEventId === "string" ? { replyToEventId } : {}),
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
        matrixNotificationError = message;
        // Back-compat: matrix-only target (no inbox to fall back on) +
        // matrix-send fails = hard fail. Without the inbox safety net,
        // there's no durable record to claim delivered on.
        if (inboxResult === null) {
          return {
            target,
            status: "failed",
            error: "send-failed",
            message,
            timestamp: timestamp(),
          };
        }
      }
    }

    // Delivered. At least one of {inbox_message_id, event_id} is present.
    const result: PerTargetResult = {
      target,
      status: "delivered",
      timestamp: timestamp(),
    };
    if (inboxResult) {
      result.inbox_message_id = inboxResult.message_id;
      result.inbox_created_at = inboxResult.created_at;
    }
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
        const per = await sendOne({ target, body: args.body, replyToEventId, identity });
        if (per.status !== "delivered") {
          return {
            ok: false,
            error: per.error ?? "send-failed",
            target,
            correlation_id,
            message: per.message ?? "send failed",
          };
        }
        const out: SendMessageResult & { ok: true } = { ok: true };
        if (per.inbox_message_id !== undefined) {
          out.inbox_message_id = per.inbox_message_id;
        }
        if (per.inbox_created_at !== undefined) {
          out.inbox_created_at = per.inbox_created_at;
        }
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
          const sendPromise = sendOne({ target, body: args.body, replyToEventId, identity });
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
      return {
        ok: true,
        delivered,
        failed: terminalFailed,
        in_flight: targets.length - reachedTerminal.length,
        threshold_met: delivered >= thresholdAtLeast,
        results: reachedTerminal,
      };
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
