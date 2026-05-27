/**
 * Permission evaluation pipeline extracted from ACPSessionController.
 *
 * Implements the full auto-approve / rule-match / prompt-user flow
 * as a standalone async function so the controller only needs to call
 * `evaluatePermission(...)`.
 */
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import {
  assertNever,
  classifyOperation,
  type DispatchFailureReason,
  extractShellCommandPathArgs,
  isHighRisk,
  isKnownOperationClass,
  isReadOnly,
  isWithinWorkspace,
  type OperationClass,
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
 * Two-layer workspace-boundary check for `workspace.shell.*` auto-approve.
 *
 * Returns true iff every extracted path argument resolves inside the
 * workspace root both syntactically (Layer 2 `isWithinWorkspace`) AND after
 * symlink resolution (Layer 3 `fs.realpathSync` — AJS-77 PR1.5 CVE-class
 * defense).
 *
 * Resolves the workspace root through symlinks too, so the Layer 3 check
 * compares realpath-resolved arg against realpath-resolved workspace. This
 * matters on hosts where the workspace itself is reached via a symlink
 * prefix (macOS tmpdir `/var → /private/var`, Linux container bind mounts,
 * NixOS store paths). Falls back to the raw workspace path if realpath
 * fails on the workspace itself.
 *
 * Per-arg resolution anchors relative args to `workspaceRoot` (not
 * `process.cwd()`) by passing args through `path.resolve(workspaceRoot, arg)`
 * before `realpathSync`. Without this anchor, `cat AGENTS.md` regresses to
 * prompt because `realpathSync` would resolve against the host gateway
 * process's cwd, completely unrelated to the agent's workspace.
 *
 * Fail-closed: empty pathArgs, syntactic violation, broken symlink, ENOENT,
 * EACCES — all return false. NOT a crash.
 *
 * Shared by:
 *  - default / acceptEdits / plan modes (legacy auto-approve path)
 *  - unattendedGateway mode (PR2 auto-approve path)
 * to ensure the same CVE-class symlink-escape defense fires regardless of
 * permission mode. Callers are responsible for the operation-class
 * membership check (only call for `WORKSPACE_SHELL_OPERATIONS`).
 */
function passesWorkspaceShellBoundaryCheck(
  request: RequestPermissionRequest,
  workspaceRoot: string,
): boolean {
  const pathArgs = extractShellCommandPathArgs(request);
  if (pathArgs.length === 0) return false;

  let resolvedWorkspace: string;
  try {
    resolvedWorkspace = realpathSync(workspaceRoot);
  } catch {
    resolvedWorkspace = workspaceRoot;
  }

  return pathArgs.every((arg) => {
    if (!isWithinWorkspace(workspaceRoot, arg)) return false;
    const candidate = resolvePath(workspaceRoot, arg);
    let resolved: string;
    try {
      resolved = realpathSync(candidate);
    } catch {
      return false;
    }
    return isWithinWorkspace(resolvedWorkspace, resolved);
  });
}

/**
 * Full permission evaluation pipeline:
 * 1. beforePermission hook (fail-closed)
 * 2. bypassPermissions mode auto-approve
 * 3. unattendedGateway mode: auto-approve KNOWN operation classes,
 *    fail-closed (cancel) on UNKNOWN
 * 4. Read-only auto-approve (default/acceptEdits/plan)
 * 5. workspace.shell.* boundary-checked auto-approve
 * 6. Remembered rules
 * 7. Fall through to user prompt
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

  // unattendedGateway mode: auto-approve every KNOWN operation class EXCEPT
  // those flagged HIGH_RISK by the policy gate. Fail-closed (cancel) on
  // UNKNOWN / `tool.<name>` fallback. For `workspace.shell.*` classes, the
  // workspace-boundary realpath/symlink defense (AJS-77 PR1.5) MUST still
  // fire — the CVE-class symlink-escape check is an auto-approve safety
  // property, not a mode-specific concern, and bypassing it in unattended
  // mode would silently regress the security posture established by PR1.5
  // for one mode.
  //
  // HIGH_RISK exclusion order: check AFTER known-class + workspace-shell-
  // realpath checks so the failure reason precisely reflects which guard
  // refused the auto-approve. The {@link isHighRisk} helper covers both
  // literal HIGH_RISK_OPERATIONS membership and context-sensitive
  // escalation (terminal.create with shell-wrapper command). Carries the
  // typed `kind: "high_risk_operation"` failureReason so consumers can
  // distinguish "system refused to auto-approve" from "unknown class" or
  // "transport failure."
  if (ctx.permissionMode === "unattendedGateway") {
    const operationClass = classifyOperation(effectiveRequest);

    if (!isKnownOperationClass(operationClass)) {
      logPermissionDecision(
        ctx.permLog,
        effectiveRequest,
        ctx.permissionMode,
        "cancelled",
        "unattended-gateway: unknown operation class (fail-closed)",
        {
          operationClass,
          failureReason: {
            kind: "unknown_operation_class",
            operationClass,
          } satisfies DispatchFailureReason,
        },
      );
      const response: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
      void callHook(ctx.log, "afterPermission", () =>
        ctx.hooks?.afterPermission?.(effectiveRequest, response, ctx.sessionId),
      );
      return response;
    }

    // workspace.shell.* requires the AJS-77 boundary check even in unattended
    // mode. Fail-closed with structured failureReason when missing workspace
    // identity or when realpath escapes the workspace root.
    if (WORKSPACE_SHELL_OPERATIONS.has(operationClass)) {
      if (!ctx.workspaceIdentityPath) {
        logPermissionDecision(
          ctx.permLog,
          effectiveRequest,
          ctx.permissionMode,
          "cancelled",
          "unattended-gateway: no workspace identity (fail-closed for shell op)",
          {
            operationClass,
            failureReason: {
              kind: "no_workspace_identity_path",
              operationClass,
            } satisfies DispatchFailureReason,
          },
        );
        const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
        void callHook(ctx.log, "afterPermission", () =>
          ctx.hooks?.afterPermission?.(effectiveRequest, cancelled, ctx.sessionId),
        );
        return cancelled;
      }
      if (!passesWorkspaceShellBoundaryCheck(effectiveRequest, ctx.workspaceIdentityPath)) {
        logPermissionDecision(
          ctx.permLog,
          effectiveRequest,
          ctx.permissionMode,
          "cancelled",
          "unattended-gateway: workspace boundary check failed (fail-closed for shell op)",
          {
            operationClass,
            failureReason: {
              kind: "workspace_boundary_violation",
              operationClass,
            } satisfies DispatchFailureReason,
          },
        );
        const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
        void callHook(ctx.log, "afterPermission", () =>
          ctx.hooks?.afterPermission?.(effectiveRequest, cancelled, ctx.sessionId),
        );
        return cancelled;
      }
      // Boundary check passed; fall through to switch which will auto-approve.
    }

    // HIGH_RISK exclusion: even within KNOWN classes, certain operations
    // (terminal.shell, terminal.create, file.delete, workspace.command.execute,
    // and context-sensitive terminal.create-with-shell-wrapper) MUST require
    // explicit human approval — auto-approving them in unattended-gateway
    // mode is the security regression #142 closes. The {@link isHighRisk}
    // helper covers both literal Set membership AND context-sensitive
    // escalation. Fails closed with a typed `kind: "high_risk_operation"`
    // reason so wire consumers can distinguish "policy refused" from
    // "unknown class" or "transport failure."
    if (isHighRisk(operationClass, effectiveRequest)) {
      logPermissionDecision(
        ctx.permLog,
        effectiveRequest,
        ctx.permissionMode,
        "cancelled",
        "unattended-gateway: high-risk operation (fail-closed)",
        {
          operationClass,
          failureReason: {
            kind: "high_risk_operation",
            operationClass,
          } satisfies DispatchFailureReason,
        },
      );
      const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
      void callHook(ctx.log, "afterPermission", () =>
        ctx.hooks?.afterPermission?.(effectiveRequest, cancelled, ctx.sessionId),
      );
      return cancelled;
    }

    // Exhaustive switch over the narrowed OperationClass — every known class
    // auto-approves in this PR's minimal matrix. Adding a class to the union
    // forces this switch to widen (assertNever default arm). Non-shell KNOWN
    // classes (file.*, terminal.*, workspace.{search,command,data-query,navigate})
    // auto-approve directly; shell.* classes auto-approve only after the
    // pre-switch boundary check above passes.
    const narrowed: OperationClass = operationClass;
    switch (narrowed) {
      case "file.read":
      case "file.write":
      case "file.delete":
      case "terminal.create":
      case "workspace.search":
      case "workspace.command.execute":
      case "workspace.command.list":
      case "workspace.data-query":
      case "workspace.navigate":
      case "workspace.shell.read":
      case "workspace.shell.search":
      case "workspace.shell.list": {
        const allowOption = effectiveRequest.options?.find(
          (o) => o.kind === "allow_always" || o.kind === "allow_once",
        );
        if (allowOption) {
          logPermissionDecision(
            ctx.permLog,
            effectiveRequest,
            ctx.permissionMode,
            "auto_approve",
            "unattended-gateway: known operation class",
            { operationClass: narrowed },
          );
          const response: RequestPermissionResponse = {
            outcome: { outcome: "selected", optionId: allowOption.optionId },
          };
          void callHook(ctx.log, "afterPermission", () =>
            ctx.hooks?.afterPermission?.(effectiveRequest, response, ctx.sessionId),
          );
          return response;
        }
        // No allow option available — fail-closed.
        logPermissionDecision(
          ctx.permLog,
          effectiveRequest,
          ctx.permissionMode,
          "cancelled",
          "unattended-gateway: no allow option in request (fail-closed)",
          {
            operationClass: narrowed,
            failureReason: {
              kind: "no_allow_option",
              operationClass: narrowed,
            } satisfies DispatchFailureReason,
          },
        );
        const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
        void callHook(ctx.log, "afterPermission", () =>
          ctx.hooks?.afterPermission?.(effectiveRequest, cancelled, ctx.sessionId),
        );
        return cancelled;
      }
      default:
        return assertNever(narrowed);
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
    // inside the workspace root both syntactically AND after symlink
    // resolution. Delegated to `passesWorkspaceShellBoundaryCheck` so the
    // same two-layer defense fires in unattendedGateway mode (above).
    // Fail-closed on Layer 2/3 failure: fall through to prompt.
    if (
      WORKSPACE_SHELL_OPERATIONS.has(operationClass) &&
      ctx.workspaceIdentityPath &&
      passesWorkspaceShellBoundaryCheck(effectiveRequest, ctx.workspaceIdentityPath)
    ) {
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
            pathArgs: extractShellCommandPathArgs(effectiveRequest),
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
