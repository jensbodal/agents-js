/**
 * Types for the ACP permission policy kit.
 *
 * Scoped permission rules enable hosts to remember user decisions and
 * automatically resolve future permission requests that match stored rules.
 * High-risk operations are excluded from automatic matching.
 */

/** Lifetime of a remembered permission rule. */
export type RememberedLifetime = "once" | "session" | "persistent";

/** Granularity level for a permission scope candidate. */
export type ScopeLevel = "exact" | "parent_dir" | "ancestor_dir" | "workspace" | "wildcard";

/** A candidate scope that can be presented to the user for selection. */
export interface ScopeCandidate {
  /** The granularity level of this scope. */
  level: ScopeLevel;
  /** The scope string (path with trailing / for directories, "*" for wildcard). */
  scope: string;
  /** Human-readable label for UI display. */
  label: string;
}

/**
 * Scoped permission rule schema.
 * Rules are scoped by agent identity, workspace, operation class, and resource scope.
 * High-risk operations (shell execution, broad edits) are excluded from matching.
 */
export interface PermissionRule {
  id: string;
  agentName: string;
  /** Workspace path this rule applies to. */
  workspacePath: string;
  /** Operation class: e.g. "file.read", "file.write", "terminal.create". */
  operationClass: string;
  /** Resource scope: specific path, glob, or "*" for any. */
  resourceScope: string;
  /** Lifetime of the rule. */
  lifetime: RememberedLifetime;
  /** Outcome when the rule matches. */
  outcome: "allow" | "reject";
  /** Option id selected for allow rules. Reject rules always resolve as cancelled. */
  selectedOptionId?: string;
  /** When the rule was created (epoch ms). */
  createdAt: number;
  /** When the rule was last used for a match (epoch ms). */
  lastUsedAt: number;
  /** Expiry timestamp (null = no expiry). */
  expiresAt: number | null;
  /** How the rule was created. */
  creationSource: "user_prompt" | "settings";
  /** Whether this once-rule has been consumed (matched). */
  consumed?: boolean;
}

export interface RuleMatchResult {
  matched: boolean;
  rule?: PermissionRule;
  reason: string;
}

/**
 * Result of evaluating permission rules, including any mutations
 * (expired rules removed, once-rules marked consumed).
 * Hosts decide whether to apply the updated rules.
 */
export interface PermissionEvaluationResult {
  match: RuleMatchResult;
  /** Rules after removing expired entries and marking consumed once-rules. */
  updatedRules: PermissionRule[];
}

/**
 * Operation classes that can never be matched by remembered rules.
 *
 * Includes terminal operations, file deletion, and workspace command execution
 * due to their potential for destructive or irreversible side effects.
 */
export const HIGH_RISK_OPERATIONS = new Set([
  "terminal.shell",
  "terminal.create",
  "file.delete",
  "workspace.command.execute",
]);

/**
 * Operation classes that are always safe to auto-approve.
 * These represent read-only or navigational operations with no side effects.
 *
 * Note: `workspace.shell.*` classes are deliberately NOT in this set. They are
 * read-only by intent but require workspace-boundary verification at the
 * auto-approve gate (the classifier is context-free and cannot perform that
 * check). See `READ_ONLY_SHELL_COMMANDS` below and the workspace-shell
 * branch in `session-permissions.ts:evaluatePermission`.
 */
export const READ_OPERATIONS = new Set([
  "file.read",
  "workspace.search",
  "workspace.command.list",
  "workspace.data-query",
  "workspace.navigate",
]);

/**
 * Read-only shell commands grouped by intent category. When a terminal/tool
 * invocation's command word matches an entry here, `classifyOperation` returns
 * the corresponding `workspace.shell.<category>` operation class.
 *
 * Auto-approval requires an additional workspace-boundary check at the host
 * layer (see `session-permissions.ts`) because the classifier itself is
 * context-free and does not know the workspace root.
 *
 * Symlink-escape defense (in-workspace symlink → out-of-workspace target)
 * is enforced at the host layer via `fs.realpathSync` — see the
 * `workspace.shell.*` branch in
 * `@agents-js/acp-host/session-permissions.ts:evaluatePermission`. Both the
 * syntactic path-prefix check (`isWithinWorkspace`) AND the symlink-aware
 * `realpathSync` check must pass for auto-approve.
 */
export const READ_ONLY_SHELL_COMMANDS: Readonly<
  Record<"read" | "search" | "list", ReadonlySet<string>>
> = {
  read: new Set(["cat", "head", "tail", "wc", "file", "stat"]),
  search: new Set(["find", "grep", "rg", "fd"]),
  list: new Set(["ls", "tree"]),
};

/** Operation classes produced by the read-only shell-command branch of `classifyOperation`. */
export const WORKSPACE_SHELL_OPERATIONS: ReadonlySet<string> = new Set([
  "workspace.shell.read",
  "workspace.shell.search",
  "workspace.shell.list",
]);

/**
 * Canonical, typed union of every operation class that
 * {@link import("./permission-engine.ts").classifyOperation} can emit, excluding
 * the open-ended `tool.<name>` fallback.
 *
 * Single source of truth for downstream switches that need to be exhaustive
 * against the classifier's vocabulary (e.g. `describeOperationClass`, the
 * unattended-gateway auto-approve matrix). Adding a branch to
 * `classifyOperation` requires:
 *   1. extending {@link OperationClass},
 *   2. adding the entry to {@link KNOWN_OPERATION_CLASSES_RECORD} (typecheck
 *      catches this — the record must cover every union member),
 *   3. handling the new class in any exhaustive switch (typecheck via
 *      {@link assertNever} catches this too).
 */
export type OperationClass =
  | "file.read"
  | "file.write"
  | "file.delete"
  | "terminal.create"
  | "workspace.search"
  | "workspace.command.execute"
  | "workspace.command.list"
  | "workspace.data-query"
  | "workspace.navigate"
  | "workspace.shell.read"
  | "workspace.shell.search"
  | "workspace.shell.list";

/**
 * Type-checked record mapping every {@link OperationClass} member to `true`.
 *
 * Exists so {@link KNOWN_OPERATION_CLASSES} cannot drift from the union:
 * `Record<OperationClass, true>` forces TypeScript to error on any missing
 * member when this object literal is constructed. The set is then derived
 * from this record's keys.
 */
const KNOWN_OPERATION_CLASSES_RECORD: Record<OperationClass, true> = {
  "file.read": true,
  "file.write": true,
  "file.delete": true,
  "terminal.create": true,
  "workspace.search": true,
  "workspace.command.execute": true,
  "workspace.command.list": true,
  "workspace.data-query": true,
  "workspace.navigate": true,
  "workspace.shell.read": true,
  "workspace.shell.search": true,
  "workspace.shell.list": true,
};

/**
 * Canonical set of operation-class strings emitted by
 * {@link import("./permission-engine.ts").classifyOperation}, derived from
 * {@link KNOWN_OPERATION_CLASSES_RECORD} so adding a class to
 * {@link OperationClass} forces the record (and therefore this set) to widen
 * in lockstep.
 */
export const KNOWN_OPERATION_CLASSES: ReadonlySet<OperationClass> = new Set(
  Object.keys(KNOWN_OPERATION_CLASSES_RECORD) as OperationClass[],
);

/**
 * @deprecated Use {@link OperationClass}. Retained as a type alias for one
 * release cycle to keep external imports compiling unchanged.
 */
export type KnownOperationClass = OperationClass;

/** Narrow an arbitrary string to {@link OperationClass} via set membership. */
export function isKnownOperationClass(value: string): value is OperationClass {
  return KNOWN_OPERATION_CLASSES.has(value as OperationClass);
}

/**
 * Exhaustive-switch helper. Use as the `default:` arm of a switch over a
 * discriminated union to force a typecheck error when a new variant is added
 * without a corresponding case. Throws at runtime if reached, which only
 * happens when a typecheck escape (e.g. `as unknown as`) bypassed the union.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled discriminant: ${JSON.stringify(x)}`);
}

/**
 * Commands that are always considered shell wrappers.
 * Used by both the permission high-risk check and the terminal validation policy.
 */
export const SHELL_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "csh",
  "tcsh",
  "dash",
  "ksh",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
  "powershell.exe",
  "pwsh.exe",
]);
