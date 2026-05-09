/**
 * Cross-platform path utilities for workspace boundary enforcement.
 *
 * Consolidated from write-gate and terminal-policy to eliminate duplication.
 * Handles both POSIX and Windows path formats.
 */

import { posix, win32 } from "node:path";

/**
 * Detect whether any of the provided path strings use Windows path conventions.
 * Returns true if any value starts with a drive letter (C:\) or contains backslashes.
 */
export function usesWindowsPaths(...values: string[]): boolean {
  return values.some((value) => /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\"));
}

/**
 * Check whether a candidate path is equal to or within a workspace root.
 *
 * Handles both POSIX and Windows paths automatically. Resolves relative segments
 * (`.`, `..`) and normalizes case on Windows before comparison.
 *
 * @param workspaceRoot - The workspace root directory (absolute path).
 * @param candidatePath - The path to check. Can be relative (resolved against workspaceRoot)
 *                        or absolute.
 */
export function isWithinWorkspace(workspaceRoot: string, candidatePath: string): boolean {
  const pathApi = usesWindowsPaths(workspaceRoot, candidatePath) ? win32 : posix;
  const resolvedRoot = pathApi.resolve(workspaceRoot);
  const resolvedCandidate = pathApi.resolve(resolvedRoot, candidatePath);
  const normalizedRoot = pathApi === win32 ? resolvedRoot.toLowerCase() : resolvedRoot;
  const normalizedCandidate =
    pathApi === win32 ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const rootPrefix = normalizedRoot.endsWith(pathApi.sep)
    ? normalizedRoot
    : `${normalizedRoot}${pathApi.sep}`;

  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootPrefix);
}

// -- Relative path helpers ----------------------------------------------------

/**
 * Normalize a workspace-relative path for comparison: strip leading/trailing
 * slashes and collapse backslashes to forward slashes.
 */
function normalizeRelative(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Returns true if the normalized path contains a `..` segment (traversal attempt). */
function containsTraversal(normalized: string): boolean {
  return (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  );
}

/**
 * Check whether a candidate path is equal to or nested within a target directory.
 * Both paths are workspace-relative (not absolute).
 *
 * Examples:
 * - `isWithinDirectory("hub/acp", "hub/acp/file.md")` → true
 * - `isWithinDirectory("hub/acp", "hub/acp")` → true (exact match = the directory itself)
 * - `isWithinDirectory("hub/acp", "hub/acp-evil/x")` → false (prefix attack)
 * - `isWithinDirectory("", "anything")` → false (empty target = no match)
 */
export function isWithinDirectory(targetDir: string, candidatePath: string): boolean {
  const target = normalizeRelative(targetDir);
  if (target.length === 0) return false;

  const candidate = normalizeRelative(candidatePath);
  if (candidate.length === 0) return false;

  // Reject traversal segments — callers should pre-normalize, but defense-in-depth
  if (containsTraversal(target) || containsTraversal(candidate)) return false;

  return candidate === target || candidate.startsWith(`${target}/`);
}

/**
 * Return the closest parent folder for a workspace-relative file path.
 *
 * Examples:
 * - `closestParentFolder("projects/daily/note.md")` → `"projects/daily"`
 * - `closestParentFolder("note.md")` → `""` (root)
 * - `closestParentFolder("a/b/c/")` → `"a/b"` (trailing dir treated as dir name)
 */
export function closestParentFolder(relativePath: string): string {
  const normalized = normalizeRelative(relativePath);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}
