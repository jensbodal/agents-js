/**
 * Atomic CAS (compare-and-swap) write infrastructure.
 *
 * Provides conflict-safe file writes using a staging directory and
 * mtime + content-hash comparison. Used by node-file-adapters to
 * ensure that writes do not silently overwrite externally modified
 * files during an ACP session.
 */

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Snapshot of a file's content hash and modification time,
 * captured after a read for later CAS comparison.
 */
export interface FileSnapshot {
  /** SHA-256 hex digest of the file content at read time */
  contentHash: string;
  /** File mtime in milliseconds (from lstat) */
  mtime: number;
}

/**
 * Capture a snapshot of a file for later CAS comparison.
 *
 * @param resolvedPath - Absolute path to the file (already resolved).
 * @returns A snapshot containing the content hash and mtime.
 */
export async function captureReadSnapshot(resolvedPath: string): Promise<FileSnapshot> {
  const [content, stats] = await Promise.all([
    readFile(resolvedPath, "utf-8"),
    lstat(resolvedPath),
  ]);
  const contentHash = createHash("sha256").update(content).digest("hex");
  return {
    contentHash,
    mtime: stats.mtimeMs,
  };
}

/**
 * Atomic CAS write: stages content to a temp file, verifies the target
 * is unchanged since the last read, then renames the staging file into place.
 *
 * If `snapshot` is null (file was never read, or is a new file), the CAS
 * check is skipped and the write proceeds unconditionally.
 *
 * @param resolvedPath - Absolute target file path.
 * @param content - New file content to write.
 * @param snapshot - Snapshot from the last read, or null to skip CAS.
 * @param stagingDir - Absolute path to the staging directory for temp files.
 * @throws On CAS conflict, symlink target, or I/O errors.
 */
export async function atomicWrite(
  resolvedPath: string,
  content: string,
  snapshot: FileSnapshot | null,
  stagingDir: string,
): Promise<void> {
  const stagingFile = join(stagingDir, `${randomUUID()}.tmp`);

  try {
    // 1. Write content to staging file
    await writeFile(stagingFile, content, "utf-8");

    // 2. If no snapshot, skip CAS -- just ensure parent dir and rename
    if (snapshot === null) {
      await mkdir(dirname(resolvedPath), { recursive: true });
      await rename(stagingFile, resolvedPath);
      return;
    }

    // 3. CAS check
    let targetStats: Awaited<ReturnType<typeof lstat>>;
    try {
      targetStats = await lstat(resolvedPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("CAS conflict: file deleted since last read");
      }
      throw err;
    }

    // 3a. Reject symlinks
    if (targetStats.isSymbolicLink()) {
      throw new Error("symlink target not allowed");
    }

    // 3b. Always compare content hashes. An earlier version short-circuited
    // on mtimeMs equality, but filesystem mtime resolution can be coarser
    // than the time between two writes (observed on Linux container runners
    // where two successive writeFile calls land in the same mtime tick),
    // so mtime equality is not a safe proxy for "content unchanged".
    const currentContent = await readFile(resolvedPath, "utf-8");
    const currentHash = createHash("sha256").update(currentContent).digest("hex");

    if (currentHash !== snapshot.contentHash) {
      throw new Error("CAS conflict: file modified externally");
    }

    await rename(stagingFile, resolvedPath);
    return;
  } catch (err) {
    // 5. Clean up staging file on ANY error
    try {
      await unlink(stagingFile);
    } catch {
      // Staging file may not exist if writeFile itself failed
    }
    throw err;
  }
}

/**
 * Create the staging directory for a session under the configured scratch root.
 * Idempotent -- safe to call multiple times.
 *
 * @param scratchRoot - Absolute path to the scratch root (for example `<workspace>/.tmp`).
 * @param sessionId - Session identifier for scoping the staging area.
 * @returns Absolute path to the created staging directory.
 */
export async function ensureStagingDir(scratchRoot: string, sessionId: string): Promise<string> {
  const dir = join(scratchRoot, sessionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Remove a session's staging directory.
 *
 * @param stagingDir - Absolute path to the staging directory to remove.
 */
export async function cleanupStagingDir(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}
