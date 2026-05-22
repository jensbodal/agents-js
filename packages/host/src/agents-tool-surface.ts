/**
 * AJS-56 Phase 1 first-slice — `agents.send_message` dispatcher.
 *
 * Implements the user-facing router-level tool surface from
 * `docs/research/agents-js-hosted-mcp-tool-provider-design-2026-05-20.md`
 * section 2.5 (Delivery router). Bound by:
 *
 *  - Identity is server-resolved from a verified JWT (passed in by
 *    the MCP transport layer; never read from tool args).
 *  - Scope ACL enforced at dispatch time (`matrix.send_message`
 *    required for the Matrix path).
 *  - Target routing resolved via {@link TargetDirectory} (v1 stub for
 *    the AJS-55 trust manifest).
 *  - Unknown targets, missing scopes, and provider failures all return
 *    structured `{ ok: false, error, correlation_id, message }` rather
 *    than throwing — the transport layer maps these to HTTP status.
 *  - ONLY `sendMessage` is exposed. No admin tools. No `get_messages`
 *    yet (deferred to first-slice follow-up).
 *
 * V1 stubs (documented in PR body per cognee-claude directive):
 *  - AJS-55 trust manifest → in-memory {@link TargetDirectory}. The
 *    eventual loader will populate from signed peer records.
 *  - AJS-58 AgentInbox routing → not implemented; directory entries
 *    without `.matrix` resolve to `"unknown-target"` (operator-
 *    friendly hint that Matrix routing must be registered).
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
  | { ok: true; event_id: string }
  | {
      ok: false;
      error: SendMessageError;
      target?: string;
      correlation_id: string;
      message: string;
    };

/** Options for {@link createAgentsDispatcher}. */
export interface AgentsDispatcherOptions {
  matrixTool: MatrixTool;
  targetDirectory: TargetDirectory;
  /** Optional logger for send-failed warnings. Defaults to `console`. */
  logger?: Pick<Console, "warn" | "error">;
}

/**
 * The MCP-side dispatcher surface. v1 first-slice exposes ONLY
 * `sendMessage` — no admin tools, no get_messages. Keys of this
 * object are pinned by test
 * `dispatcher exposes only sendMessage; no admin tool surface`.
 */
export interface AgentsDispatcher {
  sendMessage(args: SendMessageArgs, identity: AuthenticatedIdentity): Promise<SendMessageResult>;
}

/**
 * Build the dispatcher. Pure factory — no side effects until a
 * `sendMessage` call.
 */
export function createAgentsDispatcher(options: AgentsDispatcherOptions): AgentsDispatcher {
  const logger = options.logger ?? console;

  // Pinned to `["sendMessage"]` keys — see contract test
  // `dispatcher exposes only sendMessage; no admin tool surface`.
  // Adding other methods here requires updating that test deliberately.
  return {
    async sendMessage(
      args: SendMessageArgs,
      identity: AuthenticatedIdentity,
    ): Promise<SendMessageResult> {
      const correlation_id = identity.correlationId;

      // Scope ACL first — even before arg validation. Reduces the
      // chance a malformed-args attack leaks information about the
      // target directory before auth is checked.
      const scope = checkScope(identity, "matrix.send_message");
      if (!scope.ok) {
        return {
          ok: false,
          error: "scope-not-granted",
          correlation_id,
          message: scope.message,
        };
      }

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
      if (!entry?.matrix) {
        return {
          ok: false,
          error: "unknown-target",
          target: args.target,
          correlation_id,
          message: `target '${args.target}' has no Matrix routing`,
        };
      }

      // Build the provider args from SERVER state only. The caller's
      // raw args object is NOT forwarded — any `as_agent` / `sender`
      // / `from` keys an attacker injected are silently dropped here.
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
        return { ok: true, event_id: result.event_id };
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
    },
  };
}
