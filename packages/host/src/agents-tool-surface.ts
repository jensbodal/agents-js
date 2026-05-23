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

/** Arguments for `agents.send_message`. */
export interface SendMessageArgs {
  /** Target agent name (e.g. `"ajs-claude"`). Looked up in the directory. */
  target: string;
  /** Message body. */
  body: string;
  /** Optional reply threading; ignored if not a string. */
  reply_to_event_id?: string;
  /**
   * Any other field a caller might pass — `as_agent`, `sender`,
   * `from`, `identity` — is IGNORED. Identity is server-resolved
   * from the JWT. This rest-prop documents the security invariant at
   * the type boundary.
   */
  [extraField: string]: unknown;
}

/** Structured error reasons. Stable string union for transport mapping. */
export type SendMessageError =
  | "invalid-args"
  | "scope-not-granted"
  | "unknown-target"
  | "send-failed"
  | "inbox-write-failed";

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
      ok: false;
      error: SendMessageError;
      target?: string;
      correlation_id: string;
      message: string;
    };

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
  return result.ok === true && typeof result.inbox_message_id === "string";
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

  // Pinned to `["sendMessage", "getMessages"]` keys — see contract test
  // `dispatcher exposes only sendMessage + getMessages; no admin tool surface`.
  // Adding other methods here requires updating that test deliberately.
  return {
    async sendMessage(
      args: SendMessageArgs,
      identity: AuthenticatedIdentity,
    ): Promise<SendMessageResult> {
      const correlation_id = identity.correlationId;

      // Structural arg validation. Loose runtime check because the
      // MCP transport's schema validation runs at the transport
      // boundary; direct test/dev callers bypass it.
      if (typeof args?.target !== "string" || args.target.length === 0) {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: "`target` (string) is required",
        };
      }
      if (typeof args?.body !== "string") {
        return {
          ok: false,
          error: "invalid-args",
          correlation_id,
          message: "`body` (string) is required",
        };
      }

      const entry = options.targetDirectory.resolve(args.target);
      if (!entry || (!entry.matrix && !entry.inbox)) {
        return {
          ok: false,
          error: "unknown-target",
          target: args.target,
          correlation_id,
          message: `target '${args.target}' has no Matrix or inbox routing`,
        };
      }

      // AJS-65 route-model (Jens via codex-hostname-null 2026-05-23
      // event $LaPSo1WDFUGT4xccWpsdrM130shpI8-hwExtQDi_J_I; refined by
      // malar-codex-app P1 review on 6f21372a): inbox is the durable
      // delivery substrate; matrix is the notification overlay.
      //
      // **Scope-gating rule** (malar-codex-app P1, contract blocker):
      // route presence in the directory entry is what determines required
      // scopes, NOT the scopes the caller happens to carry. If the entry
      // advertises an inbox route, `inbox.deliver` is MANDATORY — a caller
      // with only `matrix.send_message` cannot bypass inbox-write by
      // accidentally lacking the inbox scope. Reversing this would
      // re-introduce the notification-without-storage failure mode AJS-65
      // is supposed to fix.
      //
      // Algorithm:
      //   1. If entry.inbox exists → caller MUST have `inbox.deliver`.
      //      Missing scope → scope-not-granted (matrix NOT attempted).
      //      Then attempt inbox-write FIRST. Hard-fail if it throws.
      //   2. If entry.matrix exists AND caller has `matrix.send_message` →
      //      attempt matrix-notify. Degraded success if it throws.
      //      The notification body is shape-dependent (see body-shape rule
      //      below).
      //   3. If entry is matrix-only (no inbox.session — legacy back-compat) →
      //      caller MUST have `matrix.send_message`. Missing → scope-not-granted.
      //      Then attempt matrix-send with FULL body (legacy contract).
      //
      // **Body-shape rule** (malar-codex-app P2): in the dual-route case
      // (entry has both inbox + matrix), the matrix notification carries a
      // POINTER ONLY (`see inbox: ${inbox_message_id}`), not the full
      // body. Inbox is the single source of truth; matrix is the wake
      // signal. The matrix-only legacy back-compat case keeps the full
      // body (matrix IS the storage for those entries).
      const matrixScope = checkScope(identity, "matrix.send_message");
      const inboxScope = checkScope(identity, "inbox.deliver");

      // Scope gating: route presence determines required scope, NOT
      // whichever scope happens to be present. This is the P1 fix.
      if (entry.inbox && !inboxScope.ok) {
        return {
          ok: false,
          error: "scope-not-granted",
          target: args.target,
          correlation_id,
          message: `scope inbox.deliver not granted to ${identity.agentName}; entry '${args.target}' advertises inbox route and inbox is the AJS-65 durable substrate`,
        };
      }
      // Matrix-only target (legacy back-compat) requires matrix.send_message.
      if (!entry.inbox && entry.matrix && !matrixScope.ok) {
        return {
          ok: false,
          error: "scope-not-granted",
          target: args.target,
          correlation_id,
          message: `scope matrix.send_message not granted to ${identity.agentName}`,
        };
      }

      // Step 1: inbox-write. Required to succeed before matrix-notify
      // is attempted (no notification without durable storage).
      let inboxResult: InboxDeliverResult | null = null;
      if (entry.inbox) {
        if (!options.agentInboxTool) {
          // Directory advertises inbox routing but operator hasn't
          // wired the substrate. Operator-friendly error.
          logger.warn(
            "[agents-tool-surface] inbox routing requested but agentInboxTool not configured",
            { target: args.target, correlation_id },
          );
          return {
            ok: false,
            error: "send-failed",
            target: args.target,
            correlation_id,
            message: "inbox substrate not configured",
          };
        }
        try {
          inboxResult = await options.agentInboxTool.deliver({
            identity,
            toSession: entry.inbox.session,
            body: args.body,
            correlationId: correlation_id,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("[agents-tool-surface] inbox deliver failed", {
            target: args.target,
            correlation_id,
            message,
          });
          // Hard fail: matrix MUST NOT be attempted. Notification
          // without durable storage would lie to the recipient.
          return {
            ok: false,
            error: "inbox-write-failed",
            target: args.target,
            correlation_id,
            message,
          };
        }
      }

      // Step 2: matrix-notify. Fires iff target has matrix.room AND caller
      // has matrix.send_message scope. Body shape depends on route shape:
      //   - dual-route (inbox + matrix): pointer-only (`see inbox: ${id}`)
      //   - matrix-only (legacy back-compat): full body
      let matrixEventId: string | null = null;
      let matrixNotificationError: string | null = null;
      if (entry.matrix && matrixScope.ok) {
        // P2 body-shape rule: pointer-only for dual-route, full body for
        // matrix-only back-compat. Inbox is single source of truth; the
        // matrix notification is just the wake signal in the dual case.
        const matrixBody =
          inboxResult !== null ? `see inbox: ${inboxResult.message_id}` : args.body;
        const matrixArgs: MatrixSendArgs = {
          identity,
          target: args.target,
          room: entry.matrix.room,
          body: matrixBody,
          ...(typeof args.reply_to_event_id === "string"
            ? { replyToEventId: args.reply_to_event_id }
            : {}),
        };
        try {
          const result = await options.matrixTool.send(matrixArgs);
          matrixEventId = result.event_id;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("[agents-tool-surface] matrix notify failed", {
            target: args.target,
            correlation_id,
            message,
          });
          matrixNotificationError = message;
          // Back-compat: matrix-only target (no inbox-write to fall back on)
          // + matrix-send fails = hard fail. Without the inbox safety net,
          // there's no durable record to claim success on.
          if (inboxResult === null) {
            return {
              ok: false,
              error: "send-failed",
              target: args.target,
              correlation_id,
              message,
            };
          }
        }
      }

      // Assemble success result. At least one of {inbox_message_id, event_id}
      // is present when we reach here (we returned early if neither path was
      // exercisable).
      const out: SendMessageResult & { ok: true } = { ok: true };
      if (inboxResult) {
        out.inbox_message_id = inboxResult.message_id;
        out.inbox_created_at = inboxResult.created_at;
      }
      if (matrixEventId) {
        out.event_id = matrixEventId;
      }
      if (matrixNotificationError) {
        out.matrix_notification_error = matrixNotificationError;
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
