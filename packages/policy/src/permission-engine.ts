/**
 * ACP permission policy -- stateless evaluation functions.
 *
 * All functions are pure: they take rules as input and return results
 * without mutating the input array. Hosts own rule storage and lifecycle.
 *
 * Consolidated from earlier host integrations to provide one canonical
 * policy evaluation engine for agents-js consumers.
 */

import { posix } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { closestParentFolder } from "./path-utils.ts";
import type {
  PermissionEvaluationResult,
  PermissionRule,
  RememberedLifetime,
  ScopeCandidate,
  ScopeLevel,
} from "./permission-types.ts";
import {
  HIGH_RISK_OPERATIONS,
  READ_ONLY_SHELL_COMMANDS,
  READ_OPERATIONS,
  SHELL_COMMANDS,
} from "./permission-types.ts";

let fallbackRuleIdCounter = 0;

function createRuleIdSuffix(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID().slice(0, 8);
  }
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(4));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // Rule IDs are readability identifiers, not auth tokens; this covers runtimes
  // without Web Crypto so rule creation still works.
  fallbackRuleIdCounter = (fallbackRuleIdCounter + 1) >>> 0;
  return fallbackRuleIdCounter.toString(16).padStart(8, "0").slice(-8);
}

/**
 * Classify the operation type from a permission request.
 *
 * Uses heuristics on the tool name to determine the operation class.
 * Includes workspace-specific operations (workspace.search, workspace.command.execute, etc.)
 * which hosts may define via MCP or custom tools.
 */
export function classifyOperation(request: RequestPermissionRequest): string {
  const toolName = request.toolCall?.title?.toLowerCase() ?? "";

  // Read-only shell-command branch -- recognize bare `cat foo.md`-style invocations
  // that arrive as terminal titles with the command as the first whitespace token.
  // Returns a `workspace.shell.<category>` operation class that the host-layer
  // auto-approve gate validates against the workspace root before approval.
  const firstToken = firstCommandToken(toolName);
  if (firstToken) {
    for (const category of ["read", "search", "list"] as const) {
      if (READ_ONLY_SHELL_COMMANDS[category].has(firstToken)) {
        return `workspace.shell.${category}`;
      }
    }
  }

  // Workspace operations -- check before generic terminal/command match
  // to avoid workspace commands being misclassified as terminal.create
  if (toolName.includes("workspace.search") || toolName.includes("workspace_search")) {
    return "workspace.search";
  }
  if (
    toolName.includes("workspace.command.execute") ||
    toolName.includes("workspace_command_execute")
  ) {
    return "workspace.command.execute";
  }
  if (toolName.includes("workspace.command.list") || toolName.includes("workspace_command_list")) {
    return "workspace.command.list";
  }
  if (toolName.includes("workspace.data-query") || toolName.includes("workspace_data_query")) {
    return "workspace.data-query";
  }
  if (toolName.includes("workspace.navigate") || toolName.includes("workspace_navigate")) {
    return "workspace.navigate";
  }

  // File operations
  if (toolName.includes("read") && toolName.includes("file")) return "file.read";
  if (toolName.includes("write") && toolName.includes("file")) return "file.write";
  if (toolName.includes("edit")) return "file.write";
  if (toolName.includes("terminal") || toolName.includes("exec") || toolName.includes("command")) {
    return "terminal.create";
  }
  if (toolName.includes("delete") || toolName.includes("remove")) return "file.delete";

  return `tool.${toolName || "unknown"}`;
}

/**
 * Extract the first whitespace-delimited token from a tool-call title, stripping
 * ACP cwd annotations (`[current working directory ...]`) and surrounding whitespace.
 * Returns null when no token is present.
 */
function firstCommandToken(toolName: string): string | null {
  const cleaned = toolName.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  if (cleaned.length === 0) return null;
  const token = cleaned.split(/\s+/, 1)[0];
  return token && token.length > 0 ? token : null;
}

/**
 * Extract path-like arguments from a shell-command permission request for
 * workspace-boundary checking. Prefers structured `args` in `rawInput`;
 * falls back to parsing `toolCall.title` for terminal-style invocations.
 * Filters out command word, flag args (`-x`, `--long`), and ACP cwd
 * annotations.
 *
 * Returns the list of candidate path arguments. Callers should treat an
 * empty array as "no path arguments to verify" and fall through to prompt.
 */
export function extractShellCommandPathArgs(request: RequestPermissionRequest): string[] {
  const raw = request.toolCall?.rawInput;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const structured = record.args;
    if (Array.isArray(structured)) {
      return structured
        .filter((value): value is string => typeof value === "string")
        .filter((value) => value.length > 0 && !value.startsWith("-"));
    }
  }

  const title = request.toolCall?.title ?? "";
  const cleaned = title.replace(/\s*\[[^\]]*\]\s*$/, "");
  const tokens = cleaned.split(/\s+/).slice(1);
  return tokens.filter((token) => token.length > 0 && !token.startsWith("-"));
}

/**
 * Returns true if the given operation class represents a read-only operation
 * that is safe to auto-approve without user confirmation.
 */
export function isReadOnly(operationClass: string): boolean {
  return READ_OPERATIONS.has(operationClass);
}

/**
 * Extract the resource scope from a permission request.
 * Looks for common path-like arguments or command names.
 */
export function extractResourceScope(request: RequestPermissionRequest): string {
  const args = request.toolCall?.rawInput;
  if (!args || typeof args !== "object") return "*";

  const record = args as Record<string, unknown>;
  const pathValue = record.path ?? record.file ?? record.filePath;
  if (typeof pathValue === "string") return pathValue;

  const command = record.command;
  if (typeof command === "string") return `cmd:${command}`;

  return "*";
}

/**
 * Heuristic: classify a path as likely-file or likely-directory.
 * Paths ending with `/` are definitively directories.
 * Basenames containing `.` (including dotfiles like `.env`) are files.
 * Basenames without `.` are likely directories.
 */
function isLikelyDirectory(path: string): boolean {
  if (path.endsWith("/")) return true;
  const base = posix.basename(path);
  return !base.includes(".");
}

/**
 * Generate an ordered list of scope candidates for a permission scope selection UI.
 *
 * Given an extracted resource scope (from {@link extractResourceScope}), produces
 * candidates from most specific (exact file/command) to broadest (wildcard).
 * Candidates are deduplicated by scope string.
 *
 * @param resourceScope - The scope string from extractResourceScope().
 * @param workspacePath - The workspace root path.
 */
export function generateScopeCandidates(
  resourceScope: string,
  workspacePath: string,
): ScopeCandidate[] {
  if (resourceScope === "*") {
    return [{ level: "wildcard", scope: "*", label: "Any file or command" }];
  }

  if (resourceScope.startsWith("cmd:")) {
    const command = resourceScope.slice(4);
    return [
      { level: "exact", scope: resourceScope, label: `Just this command: ${command}` },
      { level: "wildcard", scope: "*", label: "Any file or command" },
    ];
  }

  const normalized = posix.normalize(resourceScope);
  if (!normalized) {
    return [{ level: "wildcard", scope: "*", label: "Any file or command" }];
  }

  const candidates: ScopeCandidate[] = [];
  const seen = new Set<string>();

  const addCandidate = (level: ScopeLevel, scope: string, label: string): void => {
    if (!seen.has(scope)) {
      seen.add(scope);
      candidates.push({ level, scope, label });
    }
  };

  const basename = posix.basename(normalized);
  // Check both: resourceScope preserves trailing '/' that posix.normalize strips
  const dirLabel = isLikelyDirectory(resourceScope) || isLikelyDirectory(normalized);
  if (dirLabel) {
    addCandidate("exact", normalized, `Just this directory: ${basename}/`);
  } else {
    addCandidate("exact", normalized, `Just this file: ${basename}`);
  }

  // Parent directory (using closestParentFolder on workspace-relative portion)
  // closestParentFolder works on workspace-relative paths, so we need to
  // derive the relative path from the workspace root.
  const normalizedWorkspace = posix.normalize(workspacePath);
  const workspacePrefix = normalizedWorkspace.endsWith("/")
    ? normalizedWorkspace
    : `${normalizedWorkspace}/`;

  let relativePath = normalized;
  if (normalized.startsWith(workspacePrefix)) {
    relativePath = normalized.slice(workspacePrefix.length);
  } else if (normalized === normalizedWorkspace) {
    // Path IS the workspace root — only workspace + wildcard
    addCandidate("workspace", `${normalizedWorkspace}/`, "Entire workspace");
    addCandidate("wildcard", "*", "Any file or command");
    return candidates;
  }

  const parent = closestParentFolder(relativePath);
  if (parent) {
    const parentAbsolute = `${workspacePrefix}${parent}/`;
    const parentBasename = posix.basename(parent);
    addCandidate("parent_dir", parentAbsolute, `Folder: ${parentBasename}/`);

    // Walk up ancestor directories between parent and workspace root
    let current = posix.dirname(parent);
    while (current && current !== "." && current !== "") {
      const ancestorAbsolute = `${workspacePrefix}${current}/`;
      const ancestorBasename = posix.basename(current);
      addCandidate("ancestor_dir", ancestorAbsolute, `Folder: ${ancestorBasename}/`);
      const next = posix.dirname(current);
      if (next === current) break;
      current = next;
    }
  }

  addCandidate("workspace", workspacePrefix, "Entire workspace");
  addCandidate("wildcard", "*", "Any file or command");

  return candidates;
}

/**
 * Check if an operation is high-risk and should never match remembered rules.
 */
export function isHighRisk(operationClass: string, request: RequestPermissionRequest): boolean {
  if (HIGH_RISK_OPERATIONS.has(operationClass)) return true;

  if (operationClass === "terminal.create") {
    const args = request.toolCall?.rawInput;
    if (args && typeof args === "object") {
      const command = (args as Record<string, unknown>).command;
      if (typeof command === "string" && SHELL_COMMANDS.has(command.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if a rule's resource scope matches the request's resource scope.
 *
 * IMPORTANT: This performs raw string prefix matching. Callers must normalize
 * paths (resolve `..` and `.` segments) before storing them in rules or passing
 * them to this function, otherwise traversal sequences like `src/../../.env`
 * could match a rule scoped to `src/`.
 */
export function scopeMatches(ruleScope: string, requestScope: string): boolean {
  if (ruleScope === "*") return true;
  if (ruleScope === requestScope) return true;
  if (ruleScope.endsWith("/") && requestScope.startsWith(ruleScope)) return true;
  return false;
}

/**
 * Evaluate a permission request against stored rules.
 *
 * Returns both the match result and a new array of rules with expired entries
 * removed and consumed once-rules marked. The input array is not mutated.
 */
export function evaluatePermissionRules(
  request: RequestPermissionRequest,
  agentName: string,
  workspacePath: string,
  rules: readonly PermissionRule[],
): PermissionEvaluationResult {
  const operationClass = classifyOperation(request);
  const resourceScope = extractResourceScope(request);
  const now = Date.now();
  const activeRules = rules
    .filter((rule) => rule.expiresAt === null || rule.expiresAt > now)
    .map((rule) => ({ ...rule }));

  // High-risk operations can never be matched by remembered rules
  if (isHighRisk(operationClass, request)) {
    return {
      match: {
        matched: false,
        reason: `High-risk operation "${operationClass}" requires fresh approval`,
      },
      updatedRules: activeRules,
    };
  }

  // Find matching rule
  for (const rule of activeRules) {
    const workspaceMatches =
      rule.workspacePath === workspacePath ||
      rule.workspacePath === "*" ||
      rule.workspacePath === "global";
    if (
      rule.agentName === agentName &&
      workspaceMatches &&
      rule.operationClass === operationClass &&
      scopeMatches(rule.resourceScope, resourceScope)
    ) {
      if (rule.outcome === "allow") {
        if (!rule.selectedOptionId) {
          continue;
        }

        const optionStillAvailable = request.options?.some(
          (option) => option.optionId === rule.selectedOptionId,
        );
        if (!optionStillAvailable) {
          continue;
        }
      }

      // Update last used and mark once-rules as consumed
      rule.lastUsedAt = now;
      if (rule.lifetime === "once") {
        rule.consumed = true;
      }

      return {
        match: {
          matched: true,
          rule: { ...rule },
          reason: `Matched rule "${rule.id}": ${rule.outcome} ${rule.operationClass} on ${rule.resourceScope} (${rule.lifetime})`,
        },
        updatedRules: activeRules.filter((r) => r.lifetime !== "once" || !r.consumed),
      };
    }
  }

  return {
    match: {
      matched: false,
      reason: `No matching rule for ${operationClass} on ${resourceScope}`,
    },
    updatedRules: activeRules,
  };
}

/**
 * Create a permission rule from a request and user choice.
 */
export function createPermissionRule(
  request: RequestPermissionRequest,
  agentName: string,
  workspacePath: string,
  outcome: "allow" | "reject",
  lifetime: RememberedLifetime,
  selectedOptionId?: string,
  scopeOverride?: string,
): PermissionRule {
  const now = Date.now();
  const resourceScope = scopeOverride ?? extractResourceScope(request);
  return {
    id: `rule-${now}-${createRuleIdSuffix()}`,
    agentName,
    workspacePath,
    operationClass: classifyOperation(request),
    resourceScope,
    lifetime,
    outcome,
    selectedOptionId,
    createdAt: now,
    lastUsedAt: now,
    expiresAt: null,
    creationSource: "user_prompt",
  };
}

/**
 * Create a remembered rule from a permission request and response.
 * Returns null for "once" lifetime (once-rules are not remembered).
 */
export function createRememberedRule(
  request: RequestPermissionRequest,
  response: RequestPermissionResponse,
  remember: RememberedLifetime,
  agentName: string,
  workspacePath: string,
  scopeOverride?: string,
): PermissionRule | null {
  if (remember === "once") {
    return null;
  }

  const outcome = response.outcome.outcome === "selected" ? "allow" : "reject";
  const selectedOptionId =
    response.outcome.outcome === "selected" ? response.outcome.optionId : undefined;

  return createPermissionRule(
    request,
    agentName,
    workspacePath,
    outcome,
    remember,
    selectedOptionId,
    scopeOverride,
  );
}

// -- Rule filtering helpers ---------------------------------------------------

/** Filter to persistent rules only (removes session and once rules). */
export function filterSessionRules(rules: readonly PermissionRule[]): PermissionRule[] {
  return rules.filter((r) => r.lifetime === "persistent");
}

/** Remove consumed once-rules. */
export function filterConsumedOnceRules(rules: readonly PermissionRule[]): PermissionRule[] {
  return rules.filter((r) => r.lifetime !== "once" || !r.consumed);
}

/** Remove expired rules. */
export function filterExpiredRules(rules: readonly PermissionRule[]): PermissionRule[] {
  const now = Date.now();
  return rules.filter((r) => r.expiresAt === null || r.expiresAt > now);
}
