/**
 * AJS-56 / AJS-58 — `agents.send_message` + `agents.get_messages` dispatcher.
 *
 * Implements the user-facing router-level tool surface from
 * `docs/research/agents-js-hosted-mcp-tool-provider-design-2026-05-20.md`
 * section 2.5 (Delivery router) plus AJS-58 AgentInbox routing. Bound by:
 *
 *  - Identity is server-resolved from a verified JWT (passed in by
 *    the MCP transport layer; never read from tool args).
 *  - Scope ACL enforced at dispatch time. Matrix path needs
 *    `matrix.send_message`; inbox-deliver path needs `inbox.deliver`;
 *    inbox-read path needs `inbox.read`.
 *  - Target routing resolved via {@link TargetDirectory} (v1 stub for
 *    the AJS-55 trust manifest).
 *  - Router precedence: matrix > inbox > unknown. Matrix is preferred
 *    when both routes exist because it delivers synchronously
 *    (notification) vs the asynchronous mailbox semantics of inbox.
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
  | "send-failed";

/** Result of a {@link AgentsDispatcher.sendMessage} call. */
export type SendMessageResult =
  | { ok: true; delivery: "matrix"; event_id: string }
  | { ok: true; delivery: "inbox"; message_id: string; created_at: string }
  | {
      ok: false;
      error: SendMessageError;
      target?: string;
      correlation_id: string;
      message: string;
    };

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

      // Router precedence: matrix > inbox. Matrix is synchronous
      // delivery (notification); inbox is async-persistent. When both
      // routes exist, prefer Matrix so the recipient gets the live
      // ping. If the caller lacks the matrix scope, fall through to
      // inbox if the route + scope exist.
      const matrixScope = checkScope(identity, "matrix.send_message");
      const inboxScope = checkScope(identity, "inbox.deliver");

      if (entry.matrix && matrixScope.ok) {
        const matrixArgs: MatrixSendArgs = {
          identity,
          room: entry.matrix.room,
          body: args.body,
          ...(typeof args.reply_to_event_id === "string"
            ? { replyToEventId: args.reply_to_event_id }
            : {}),
        };
        try {
          const result = await options.matrixTool.send(matrixArgs);
          return { ok: true, delivery: "matrix", event_id: result.event_id };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("[agents-tool-surface] matrix send failed", {
            target: args.target,
            correlation_id,
            message,
          });
          return {
            ok: false,
            error: "send-failed",
            target: args.target,
            correlation_id,
            message,
          };
        }
      }

      if (entry.inbox && inboxScope.ok) {
        if (!options.agentInboxTool) {
          // Directory advertises inbox routing but operator hasn't
          // wired the substrate. Operator-friendly error rather than
          // a generic 500.
          logger.warn(
            "[agents-tool-surface] inbox routing requested but agentInboxTool not configured",
            {
              target: args.target,
              correlation_id,
            },
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
          const result = await options.agentInboxTool.deliver({
            identity,
            toSession: entry.inbox.session,
            body: args.body,
            correlationId: correlation_id,
          });
          return {
            ok: true,
            delivery: "inbox",
            message_id: result.message_id,
            created_at: result.created_at,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("[agents-tool-surface] inbox deliver failed", {
            target: args.target,
            correlation_id,
            message,
          });
          return {
            ok: false,
            error: "send-failed",
            target: args.target,
            correlation_id,
            message,
          };
        }
      }

      // Target HAS a route but caller lacks the matching scope.
      // Surface this as scope-not-granted with a message naming the
      // missing scope, so operators get an actionable hint.
      const missingScope = entry.matrix ? "matrix.send_message" : "inbox.deliver";
      return {
        ok: false,
        error: "scope-not-granted",
        target: args.target,
        correlation_id,
        message: `scope ${missingScope} not granted to ${identity.agentName}`,
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
