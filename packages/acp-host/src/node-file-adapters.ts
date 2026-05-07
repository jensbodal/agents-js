/**
 * Node.js filesystem adapters for ACP host implementations.
 *
 * Provides a factory function that creates {@link HostFileAdapters} backed by
 * Node.js `fs` APIs with workspace-boundary enforcement and write-gate policy.
 *
 * Usage:
 * ```ts
 * const adapters = createNodeFileAdapters("/path/to/workspace");
 * ```
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { evaluateWriteGate, generateUnifiedDiff } from "@agents-js/policy";

import {
  atomicWrite,
  captureReadSnapshot,
  cleanupStagingDir,
  ensureStagingDir,
  type FileSnapshot,
} from "./atomic-write.ts";
import type { HostFileAdapters } from "./types/adapters.ts";
import {
  isWithinAnyWorkspaceRoot,
  resolveWorkspaceContext,
  resolveWorkspaceFilePath,
  toWorkspaceDisplayPath,
  type WorkspaceContextConfig,
} from "./workspace-context.ts";

export interface NodeFileAdapterOptions extends WorkspaceContextConfig {
  /** When provided, enables atomic CAS writes via a session-scoped staging directory. */
  sessionId?: string;
}

/**
 * Creates {@link HostFileAdapters} that use Node.js `fs` APIs for file I/O.
 *
 * Relative paths resolve against the session cwd. Reads and writes are then
 * enforced against the normalized read/write/scratch roots derived from the
 * workspace context. Writes outside the allowed roots are rejected.
 *
 * @param workspacePath - Legacy single-path workspace input. When explicit
 * context overrides are omitted, this path is used as both the workspace
 * identity root and the session cwd.
 * @param options - Optional configuration for session-scoped features and
 * explicit workspace-context overrides.
 *
 * @hostSurface
 */
export function createNodeFileAdapters(
  workspacePath: string,
  options?: NodeFileAdapterOptions,
): HostFileAdapters & { cleanup(): Promise<void> } {
  const workspaceContext = resolveWorkspaceContext({
    workspacePath,
    workspaceIdentityPath: options?.workspaceIdentityPath,
    sessionCwd: options?.sessionCwd,
    approvedReadRoots: options?.approvedReadRoots,
    approvedWriteRoots: options?.approvedWriteRoots,
    scratchRoots: options?.scratchRoots,
  });

  /** Snapshot cache: maps resolved absolute paths to their last-read snapshot. */
  const snapshotMap = new Map<string, FileSnapshot>();

  /** Lazily initialised staging directory (only created on first write when sessionId is set). */
  let stagingDir: string | null = null;
  let stagingDirPromise: Promise<string> | null = null;

  const sessionId = options?.sessionId ?? null;

  function resolvePath(filePath: string): string {
    return resolveWorkspaceFilePath(filePath, workspaceContext);
  }

  /** Lazily ensure the staging directory exists (once per session). */
  async function getStagingDir(): Promise<string> {
    if (stagingDir) return stagingDir;
    if (!sessionId) throw new Error("No sessionId for staging dir");
    const primaryScratchRoot = workspaceContext.scratchRoots[0];
    if (!primaryScratchRoot) {
      throw new Error("No scratch root configured for staging");
    }
    if (!stagingDirPromise) {
      stagingDirPromise = ensureStagingDir(primaryScratchRoot, sessionId).then((dir) => {
        stagingDir = dir;
        return dir;
      });
    }
    return stagingDirPromise;
  }

  return {
    async readTextFile(params) {
      const resolvedPath = resolvePath(params.path);

      if (
        !isWithinAnyWorkspaceRoot(resolvedPath, [
          ...workspaceContext.approvedReadRoots,
          ...workspaceContext.scratchRoots,
        ])
      ) {
        throw new Error(`Path is outside approved read roots: ${params.path}`);
      }

      const content = await readFile(resolvedPath, "utf-8");

      // Capture snapshot for later CAS comparison
      try {
        const snapshot = await captureReadSnapshot(resolvedPath);
        snapshotMap.set(resolvedPath, snapshot);
      } catch {
        // If snapshot capture fails (e.g., file deleted between read and lstat),
        // proceed without caching -- writes will skip CAS for this path.
      }

      return { content };
    },

    async writeTextFile(params, requestApproval) {
      const resolvedPath = resolvePath(params.path);
      const displayPath = toWorkspaceDisplayPath(resolvedPath, workspaceContext);

      if (
        !isWithinAnyWorkspaceRoot(resolvedPath, [
          ...workspaceContext.approvedWriteRoots,
          ...workspaceContext.scratchRoots,
        ])
      ) {
        throw new Error(`Path is outside approved write roots: ${params.path}`);
      }

      const decision = evaluateWriteGate(workspaceContext.workspaceIdentityPath, displayPath);
      if (decision.action === "block") {
        throw new Error(decision.reason);
      }

      // Read existing content for diff generation (empty string for new files)
      let existingContent = "";
      try {
        existingContent = await readFile(resolvedPath, "utf-8");
      } catch {
        // File does not exist yet -- treat as empty
      }

      const isScratchWrite = isWithinAnyWorkspaceRoot(resolvedPath, workspaceContext.scratchRoots);
      let approved = true;
      if (!isScratchWrite) {
        const diff = generateUnifiedDiff(existingContent, params.content);
        approved = await requestApproval({
          path: displayPath,
          diff,
          absolutePath: resolvedPath,
        });
      }

      if (!approved) {
        throw new Error("Write rejected by user");
      }

      // Use atomic CAS write when sessionId is available; fall back to direct write otherwise
      if (sessionId) {
        const dir = await getStagingDir();
        const snapshot = snapshotMap.get(resolvedPath) ?? null;
        await atomicWrite(resolvedPath, params.content, snapshot, dir);

        // Update snapshot after successful write
        try {
          const newSnapshot = await captureReadSnapshot(resolvedPath);
          snapshotMap.set(resolvedPath, newSnapshot);
        } catch {
          // If recapture fails, remove stale snapshot so next write skips CAS
          snapshotMap.delete(resolvedPath);
        }
      } else {
        await mkdir(dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, params.content, "utf-8");
      }

      return {};
    },

    /** Clean up the staging directory. Safe to call multiple times. */
    async cleanup() {
      if (stagingDir) {
        await cleanupStagingDir(stagingDir);
        stagingDir = null;
        stagingDirPromise = null;
      }
      snapshotMap.clear();
    },
  };
}
