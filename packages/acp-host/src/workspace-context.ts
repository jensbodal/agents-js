import { isAbsolute, join, relative, resolve } from "node:path";
import { isWithinWorkspace } from "@agents-js/policy";

/**
 * Directory policy: what the agent is ALLOWED to read, write, and stage to,
 * plus the auto-approved write zones that bypass the write-gate modal.
 *
 * This is intentionally separate from {@link WorkspaceContextConfig.sessionCwd}
 * (where the agent process is spawned) and
 * {@link WorkspaceContextConfig.workspaceIdentityPath} (the stable workspace
 * identity used by permission rules and display paths).
 *
 * Hosts that need a folder-scoped session cwd while keeping a broader
 * directory policy (e.g. read-all-vault, write-only-folder) pass these
 * concerns separately:
 *
 * ```ts
 * controller.start({
 *   workspaceIdentityPath: "/vault",
 *   sessionCwd: "/vault/projects/alpha",
 *   directoryPolicy: {
 *     approvedReadRoots: ["/vault"],
 *     approvedWriteRoots: ["/vault/projects/alpha"],
 *     autoApprovedWriteFolders: ["projects/alpha/scratch"],
 *   },
 * });
 * ```
 */
export interface DirectoryPolicy {
  /**
   * Absolute or workspace-identity-relative roots the agent may read from.
   * Defaults to the workspace identity root.
   */
  approvedReadRoots?: string[];
  /**
   * Absolute or workspace-identity-relative roots the agent may write to.
   * Defaults to the workspace identity root.
   */
  approvedWriteRoots?: string[];
  /**
   * Always-writable scratch roots for staging and host-owned transient
   * artifacts. Defaults to `<workspaceIdentityPath>/.tmp`.
   */
  scratchRoots?: string[];
  /**
   * Workspace-identity-relative folders where writes auto-approve without
   * surfacing the write-gate modal. Distinct from `approvedWriteRoots`,
   * which are the absolute roots a write must fall within at all; this
   * is the per-folder allowlist that suppresses the approval prompt.
   */
  autoApprovedWriteFolders?: string[];
}

export interface WorkspaceContextConfig extends DirectoryPolicy {
  /** Stable workspace identity/root used for permission rules and relative display paths. */
  workspaceIdentityPath?: string;
  /** Effective working directory sent to ACP runtimes and used for resolving relative file paths. */
  sessionCwd?: string;
  /**
   * Optional grouped directory policy. When provided, its fields take
   * precedence over the inline `approvedReadRoots`/`approvedWriteRoots`/
   * `scratchRoots`/`autoApprovedWriteFolders` fields. Inline fields are
   * preserved for backward compatibility with hosts that have not yet
   * migrated to the grouped shape.
   */
  directoryPolicy?: DirectoryPolicy;
}

export interface ResolvedWorkspaceContext {
  workspaceIdentityPath: string;
  sessionCwd: string;
  approvedReadRoots: string[];
  approvedWriteRoots: string[];
  scratchRoots: string[];
  /** Resolved auto-approved write folders (workspace-identity-relative, traversal-validated). */
  autoApprovedWriteFolders: string[];
}

interface ResolveWorkspaceContextInput extends WorkspaceContextConfig {
  workspacePath: string;
}

function normalizePath(path: string): string {
  return resolve(path);
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

function resolveRootList(
  roots: string[] | undefined,
  fallback: string[],
  workspaceIdentityPath: string,
  label: string,
): string[] {
  const resolvedRoots = dedupePaths(
    (roots && roots.length > 0 ? roots : fallback).map((root) =>
      normalizePath(isAbsolute(root) ? root : resolve(workspaceIdentityPath, root)),
    ),
  );

  for (const root of resolvedRoots) {
    if (!isWithinWorkspace(workspaceIdentityPath, root)) {
      throw new Error(`${label} must stay within the workspace identity root: ${root}`);
    }
  }

  return resolvedRoots;
}

function resolveAutoApprovedWriteFolders(folders: string[] | undefined, label: string): string[] {
  if (!folders || folders.length === 0) return [];
  const validated: string[] = [];
  for (const folder of folders) {
    if (!folder || folder.includes("..") || folder.startsWith("/") || isAbsolute(folder)) {
      throw new Error(
        `${label} must be a non-empty workspace-identity-relative path without traversal: ${folder}`,
      );
    }
    // Normalize separators / strip trailing slash for stable comparisons.
    const normalized = folder.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized.length === 0) {
      throw new Error(`${label} must be a non-empty workspace-identity-relative path: ${folder}`);
    }
    validated.push(normalized);
  }
  return [...new Set(validated)];
}

/**
 * Pick a {@link DirectoryPolicy} field from either the grouped policy or the
 * inline (legacy) field. The grouped policy wins when defined; otherwise the
 * inline field is used. This lets callers migrate to the grouped shape one
 * field at a time without losing values that were already set inline.
 */
function pickPolicyField<K extends keyof DirectoryPolicy>(
  policy: DirectoryPolicy | undefined,
  inlineValue: DirectoryPolicy[K] | undefined,
  key: K,
): DirectoryPolicy[K] | undefined {
  if (policy && policy[key] !== undefined) {
    return policy[key];
  }
  return inlineValue;
}

export function resolveWorkspaceContext(
  input: ResolveWorkspaceContextInput,
): ResolvedWorkspaceContext {
  const workspaceIdentityPath = normalizePath(input.workspaceIdentityPath ?? input.workspacePath);
  const sessionCwd = normalizePath(input.sessionCwd ?? input.workspacePath);

  if (!isWithinWorkspace(workspaceIdentityPath, sessionCwd)) {
    throw new Error(
      `Session cwd must stay within the workspace identity root (${workspaceIdentityPath}). Received: ${sessionCwd}`,
    );
  }

  const policy = input.directoryPolicy;

  const approvedReadRoots = resolveRootList(
    pickPolicyField(policy, input.approvedReadRoots, "approvedReadRoots"),
    [workspaceIdentityPath],
    workspaceIdentityPath,
    "Approved read roots",
  );
  const approvedWriteRoots = resolveRootList(
    pickPolicyField(policy, input.approvedWriteRoots, "approvedWriteRoots"),
    [workspaceIdentityPath],
    workspaceIdentityPath,
    "Approved write roots",
  );
  const scratchRoots = resolveRootList(
    pickPolicyField(policy, input.scratchRoots, "scratchRoots"),
    [join(workspaceIdentityPath, ".tmp")],
    workspaceIdentityPath,
    "Scratch roots",
  );
  const autoApprovedWriteFolders = resolveAutoApprovedWriteFolders(
    pickPolicyField(policy, input.autoApprovedWriteFolders, "autoApprovedWriteFolders"),
    "Auto-approved write folders",
  );

  return {
    workspaceIdentityPath,
    sessionCwd,
    approvedReadRoots,
    approvedWriteRoots,
    scratchRoots,
    autoApprovedWriteFolders,
  };
}

export function isWithinAnyWorkspaceRoot(candidatePath: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithinWorkspace(root, candidatePath));
}

export function resolveWorkspaceFilePath(
  path: string,
  context: Pick<ResolvedWorkspaceContext, "sessionCwd">,
): string {
  return resolve(context.sessionCwd, path);
}

export function toWorkspaceDisplayPath(
  path: string,
  context: Pick<ResolvedWorkspaceContext, "workspaceIdentityPath">,
): string {
  const relativePath = relative(context.workspaceIdentityPath, path);
  return relativePath.length > 0 ? relativePath : ".";
}
