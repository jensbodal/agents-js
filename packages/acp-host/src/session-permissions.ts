/**
 * Permission evaluation pipeline extracted from ACPSessionController.
 *
 * Implements the full auto-approve / rule-match / prompt-user flow
 * as a standalone async function so the controller only needs to call
 * `evaluatePermission(...)`.
 */
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  classifyOperation,
  extractShellCommandPathArgs,
  isReadOnly,
  isWithinWorkspace,
  WORKSPACE_SHELL_OPERATIONS,
} from "@agents-js/policy";
import type { Logger } from "./logger.ts";
import type { PermissionEngine } from "./permission-engine.ts";
import type { PermissionStore } from "./permission-store.ts";
import { callHook } from "./session-hooks.ts";
import type { PermissionMode } from "./session-state.ts";
import type { SessionHooks } from "./types/hooks.ts";

/** Log a structured permission decision. */
export function logPermissionDecision(
  permLog: Logger,
  request: RequestPermissionRequest,
  permissionMode: PermissionMode,
  decision: "auto_approve" | "prompt_user" | "rule_match" | "cancelled",
  reason: string,
  extra?: Record<string, unknown>,
): void {
  const operationClass = classifyOperation(request);
  permLog.info("Permission decision", {
    tool: request.toolCall?.title,
    operationClass,
    permissionMode,
    decision,
    reason,
    ...extra,
  });
}

export interface PermissionEvaluationContext {
  permissionMode: PermissionMode;
  hooks: SessionHooks | null;
  permissionEngine: PermissionEngine | null;
  permissionStore: PermissionStore | null;
  agentName: string | null;
  workspaceIdentityPath: string | null;
  sessionId: string | null;
  log: Logger;
  permLog: Logger;
  /** Callback to present the permission prompt to the user */
  handlePermissionRequest: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
}

/**
 * Full permission evaluation pipeline:
 * 1. beforePermission hook (fail-closed)
 * 2. YOLO mode auto-approve
 * 3. Read-only auto-approve
 * 4. Remembered rules
 * 5. Fall through to user prompt
 */
export async function evaluatePermission(
  request: RequestPermissionRequest,
  ctx: PermissionEvaluationContext,
): Promise<RequestPermissionResponse> {
  // Apply beforePermission hook -- may transform the request.
  // Fail-closed: if the hook throws, cancel the permission request.
  let hookErrored = false;
  const hookRequest = await (async () => {
    if (!ctx.hooks?.beforePermission) return undefined;
    try {
      return await ctx.hooks.beforePermission(request, ctx.sessionId);
    } catch (err) {
      ctx.log.warn("Hook error in beforePermission", {
        hook: "beforePermission",
        error: err instanceof Error ? err.message : String(err),
      });
      hookErrored = true;
      return undefined;
    }
  })();

  if (hookErrored) {
    return { outcome: { outcome: "cancelled" } };
  }
  const effectiveRequest = hookRequest ?? request;

  // bypassPermissions mode: auto-approve everything
  if (ctx.permissionMode === "bypassPermissions") {
    const allowOption = effectiveRequest.options?.find(
      (o) => o.kind === "allow_always" || o.kind === "allow_once",
    );
    if (allowOption) {
      logPermissionDecision(
        ctx.permLog,
        effectiveRequest,
        ctx.permissionMode,
        "auto_approve",
        "bypassPermissions mode",
      );
      const response: RequestPermissionResponse = {
        outcome: { outcome: "selected", optionId: allowOption.optionId },
      };
      void callHook(ctx.log, "afterPermission", () =>
        ctx.hooks?.afterPermission?.(effectiveRequest, response, ctx.sessionId),
      );
      return response;
    }
  }

  // plan / default / acceptEdits: auto-approve read-only operations
  if (ctx.permissionMode !== "bypassPermissions") {
    const operationClass = classifyOperation(effectiveRequest);
    if (isReadOnly(operationClass)) {
      const allowOption = effectiveRequest.options?.find(
        (o) => o.kind === "allow_always" || o.kind === "allow_once",
      );
      if (allowOption) {
        logPermissionDecision(
          ctx.permLog,
          effectiveRequest,
          ctx.permissionMode,
          "auto_approve",
          "read operation",
          {
            operationClass,
          },
        );
        const response: RequestPermissionResponse = {
          outcome: { outcome: "selected", optionId: allowOption.optionId },
        };
        void callHook(ctx.log, "afterPermission", () =>
          ctx.hooks?.afterPermission?.(effectiveRequest, response, ctx.sessionId),
        );
        return response;
      }
    }

    // workspace.shell.* auto-approve gate: classifier produces the typed
    // namespace for known read-only shell commands (cat, head, grep, ...),
    // but auto-approval requires that ALL extracted path arguments resolve
    // syntactically inside the workspace root. The classifier itself is
    // context-free and cannot perform this check.
    //
    // Known limitation (deferred to a follow-up): an in-workspace symlink
    // pointing to an out-of-workspace target bypasses this syntactic gate
    // because `path.resolve` does not follow symlinks. Host-layer realpath
    // resolution is required to defeat that escape; until it lands, deployers
    // who allow MCP-exposed shell wrappers must ensure no traversal symlinks
    // exist inside their workspace roots.
    if (WORKSPACE_SHELL_OPERATIONS.has(operationClass) && ctx.workspaceIdentityPath) {
      const pathArgs = extractShellCommandPathArgs(effectiveRequest);
      const workspaceRoot = ctx.workspaceIdentityPath;
      const allInWorkspace =
        pathArgs.length > 0 && pathArgs.every((arg) => isWithinWorkspace(workspaceRoot, arg));
      if (allInWorkspace) {
        const allowOption = effectiveRequest.options?.find(
          (o) => o.kind === "allow_always" || o.kind === "allow_once",
        );
        if (allowOption) {
          logPermissionDecision(
            ctx.permLog,
            effectiveRequest,
            ctx.permissionMode,
            "auto_approve",
            "workspace-rooted read-only shell command",
            {
              operationClass,
              pathArgs,
            },
          );
          const response: RequestPermissionResponse = {
            outcome: { outcome: "selected", optionId: allowOption.optionId },
          };
          void callHook(ctx.log, "afterPermission", () =>
            ctx.hooks?.afterPermission?.(effectiveRequest, response, ctx.sessionId),
          );
          return response;
        }
      }
    }
  }

  // Check remembered permission rules
  if (ctx.permissionEngine && ctx.agentName && ctx.workspaceIdentityPath) {
    const match = ctx.permissionEngine.evaluate(
      effectiveRequest,
      ctx.agentName,
      ctx.workspaceIdentityPath,
    );

    if (match.matched && match.rule) {
      if (match.rule.lifetime === "persistent") {
        ctx.permissionStore?.persistRules();
      }

      if (match.rule.outcome === "reject") {
        logPermissionDecision(
          ctx.permLog,
          effectiveRequest,
          ctx.permissionMode,
          "rule_match",
          "remembered rule: reject",
          {
            ruleId: match.rule.id,
            operationClass: match.rule.operationClass,
            resourceScope: match.rule.resourceScope,
          },
        );
        const response: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
        void callHook(ctx.log, "afterPermission", () =>
          ctx.hooks?.afterPermission?.(effectiveRequest, response, ctx.sessionId),
        );
        return response;
      }

      if (match.rule.selectedOptionId) {
        logPermissionDecision(
          ctx.permLog,
          effectiveRequest,
          ctx.permissionMode,
          "rule_match",
          "remembered rule: allow",
          {
            ruleId: match.rule.id,
            operationClass: match.rule.operationClass,
            resourceScope: match.rule.resourceScope,
          },
        );
        const response: RequestPermissionResponse = {
          outcome: {
            outcome: "selected",
            optionId: match.rule.selectedOptionId,
          },
        };
        void callHook(ctx.log, "afterPermission", () =>
          ctx.hooks?.afterPermission?.(effectiveRequest, response, ctx.sessionId),
        );
        return response;
      }
    }
  }

  // Fall through to user prompt
  // Note: afterPermission hook is NOT called here -- it is called by
  // resolvePermission() which has access to the user's selectedScope.
  logPermissionDecision(
    ctx.permLog,
    effectiveRequest,
    ctx.permissionMode,
    "prompt_user",
    "no auto-approve rule matched",
  );
  return ctx.handlePermissionRequest(effectiveRequest);
}
