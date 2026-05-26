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
    // inside the workspace root both syntactically AND after symlink
    // resolution. The classifier itself is context-free and cannot perform
    // either check.
    //
    // Two-layer host check (Layer 2 syntactic + Layer 3 realpath):
    //  - Layer 2: `isWithinWorkspace` uses `path.resolve` (syntactic only;
    //    does NOT follow symlinks). Defeats absolute out-of-workspace paths
    //    (`/etc/passwd`) and `..` traversal.
    //  - Layer 3: `fs.realpathSync` resolves symlinks to the on-disk target,
    //    then re-checks workspace membership. Defeats an in-workspace
    //    symlink pointing to an out-of-workspace target (the CVE-class gap
    //    that PR1 explicitly documented as a known limitation).
    //
    // Failure modes:
    //  - Broken symlink / ENOENT / EACCES on `realpathSync` -> fall through
    //    to prompt (fail-closed). NOT a crash.
    //  - Path doesn't exist yet -> fall through to prompt (we cannot verify
    //    the eventual target).
    if (WORKSPACE_SHELL_OPERATIONS.has(operationClass) && ctx.workspaceIdentityPath) {
      const pathArgs = extractShellCommandPathArgs(effectiveRequest);
      const workspaceRoot = ctx.workspaceIdentityPath;
      // Resolve workspace root through symlinks too, so the Layer 3 check
      // compares realpath-resolved arg against realpath-resolved workspace.
      // This matters on hosts where the workspace itself is reached via a
      // symlink prefix (common with macOS tmpdir /var → /private/var, Linux
      // container bind mounts, NixOS store paths, etc.). Fall back to the
      // raw workspace path if realpath fails on the workspace itself.
      let resolvedWorkspace: string;
      try {
        resolvedWorkspace = realpathSync(workspaceRoot);
      } catch {
        resolvedWorkspace = workspaceRoot;
      }
      const allInWorkspace =
        pathArgs.length > 0 &&
        pathArgs.every((arg) => {
          // Layer 2: syntactic workspace-boundary check (fast, no I/O).
          if (!isWithinWorkspace(workspaceRoot, arg)) return false;
          // Layer 3: realpath check (semantic; resolves symlinks).
          //
          // Resolve the arg against workspaceRoot FIRST so the realpath
          // baseline matches Layer 2's baseline. `path.resolve` keeps
          // absolute args unchanged but anchors relative args to the
          // workspace root rather than `process.cwd()` (which would be the
          // host gateway process's cwd, completely unrelated to the agent's
          // workspace). Without this, `cat AGENTS.md` regresses from
          // auto-approve to prompt because realpathSync resolves
          // `AGENTS.md` against process.cwd() rather than workspaceRoot.
          //
          // Fail-closed on any resolution error (broken symlink, ENOENT,
          // EACCES) — prompt rather than auto-approve when we cannot verify
          // the on-disk target.
          const candidate = resolvePath(workspaceRoot, arg);
          let resolved: string;
          try {
            resolved = realpathSync(candidate);
          } catch {
            return false;
          }
          return isWithinWorkspace(resolvedWorkspace, resolved);
        });
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
