import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWrite,
  captureReadSnapshot,
  cleanupStagingDir,
  ensureStagingDir,
} from "../src/atomic-write.ts";

let tmpDir: string;
let stagingDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "atomic-write-test-"));
  stagingDir = join(tmpDir, "staging");
  await mkdir(stagingDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CAS tests
// ---------------------------------------------------------------------------
describe("atomicWrite", () => {
  test("succeeds when snapshot matches (mtime fast path)", async () => {
    const filePath = join(tmpDir, "target.txt");
    await writeFile(filePath, "original content", "utf-8");

    const snapshot = await captureReadSnapshot(filePath);
    await atomicWrite(filePath, "updated content", snapshot, stagingDir);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe("updated content");
  });

  test("succeeds for new file (null snapshot)", async () => {
    const filePath = join(tmpDir, "brand-new.txt");

    await atomicWrite(filePath, "new file content", null, stagingDir);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe("new file content");
  });

  test("creates parent directories for new file", async () => {
    const filePath = join(tmpDir, "deep", "nested", "file.txt");

    await atomicWrite(filePath, "deeply nested", null, stagingDir);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe("deeply nested");
  });

  test("detects content modification (CAS conflict)", async () => {
    const filePath = join(tmpDir, "modified.txt");
    await writeFile(filePath, "original", "utf-8");

    const snapshot = await captureReadSnapshot(filePath);

    // Externally modify the file content
    await writeFile(filePath, "externally changed", "utf-8");

    await expect(atomicWrite(filePath, "my update", snapshot, stagingDir)).rejects.toThrow(
      /CAS conflict/,
    );
  });

  test("detects content modification even when mtime is unchanged (coarse-mtime filesystems)", async () => {
    // Regression: filesystem mtime resolution can be coarser than the gap
    // between two writes (observed on Linux container runners). If atomicWrite
    // trusted mtime equality as "unchanged content", the CAS check was silently
    // bypassed. This test pins the invariant by forcing mtime equality after
    // an external content change.
    const filePath = join(tmpDir, "coarse-mtime.txt");
    await writeFile(filePath, "original", "utf-8");

    const snapshot = await captureReadSnapshot(filePath);

    await writeFile(filePath, "externally changed", "utf-8");

    // Pin the mtime back to the snapshot so an mtime-only check would pass.
    const pinned = new Date(snapshot.mtime);
    await utimes(filePath, pinned, pinned);

    await expect(atomicWrite(filePath, "my update", snapshot, stagingDir)).rejects.toThrow(
      /CAS conflict/,
    );
  });

  test("detects file deletion (CAS conflict)", async () => {
    const filePath = join(tmpDir, "doomed.txt");
    await writeFile(filePath, "will be deleted", "utf-8");

    const snapshot = await captureReadSnapshot(filePath);

    // Delete the file externally
    await rm(filePath);

    await expect(atomicWrite(filePath, "too late", snapshot, stagingDir)).rejects.toThrow(
      /CAS conflict.*deleted/,
    );
  });

  test("allows write when file touched but content unchanged", async () => {
    const filePath = join(tmpDir, "touched.txt");
    await writeFile(filePath, "same content", "utf-8");

    const snapshot = await captureReadSnapshot(filePath);

    // Touch the file: change mtime without changing content.
    // Shift mtime forward by 5 seconds so it differs from the snapshot.
    const now = new Date();
    const future = new Date(now.getTime() + 5000);
    await utimes(filePath, future, future);

    // Verify the mtime actually changed
    const info = await stat(filePath);
    expect(info.mtimeMs).not.toBe(snapshot.mtime);

    // Despite mtime change, content hash matches -- write should succeed
    await atomicWrite(filePath, "replacement content", snapshot, stagingDir);

    const result = await readFile(filePath, "utf-8");
    expect(result).toBe("replacement content");
  });

  test("rejects symlink targets", async () => {
    const realFile = join(tmpDir, "real.txt");
    const linkPath = join(tmpDir, "link.txt");
    await writeFile(realFile, "real content", "utf-8");
    await symlink(realFile, linkPath);

    // Capture a snapshot using the real file, then feed it with the symlink path
    const snapshot = await captureReadSnapshot(realFile);

    await expect(atomicWrite(linkPath, "via symlink", snapshot, stagingDir)).rejects.toThrow(
      /symlink/,
    );
  });

  test("cleans up staging file on conflict", async () => {
    const filePath = join(tmpDir, "conflict-cleanup.txt");
    await writeFile(filePath, "original", "utf-8");

    const snapshot = await captureReadSnapshot(filePath);
    await writeFile(filePath, "externally modified", "utf-8");

    try {
      await atomicWrite(filePath, "should fail", snapshot, stagingDir);
    } catch {
      // Expected to throw
    }

    // Verify no orphaned .tmp files in staging dir
    const { readdir } = await import("node:fs/promises");
    const remaining = await readdir(stagingDir);
    expect(remaining).toHaveLength(0);
  });

  test("cleans up staging file on write error", async () => {
    const filePath = join(tmpDir, "error-cleanup.txt");
    await writeFile(filePath, "original", "utf-8");

    const snapshot = await captureReadSnapshot(filePath);

    // Use a staging dir that is a file, not a directory, so the initial
    // writeFile inside atomicWrite will fail.
    const badStagingDir = join(tmpDir, "not-a-dir");
    await writeFile(badStagingDir, "I am a file", "utf-8");

    await expect(atomicWrite(filePath, "should fail", snapshot, badStagingDir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Snapshot tests
// ---------------------------------------------------------------------------
describe("captureReadSnapshot", () => {
  test("returns correct hash and mtime", async () => {
    const filePath = join(tmpDir, "snapshot-test.txt");
    const content = "hello world";
    await writeFile(filePath, content, "utf-8");

    const snapshot = await captureReadSnapshot(filePath);
    const info = await stat(filePath);

    // SHA-256 of "hello world" is a known value
    const { createHash } = await import("node:crypto");
    const expectedHash = createHash("sha256").update(content).digest("hex");

    expect(snapshot.contentHash).toBe(expectedHash);
    expect(snapshot.mtime).toBe(info.mtimeMs);
  });

  test("throws for non-existent file", async () => {
    const filePath = join(tmpDir, "does-not-exist.txt");

    await expect(captureReadSnapshot(filePath)).rejects.toThrow();
  });

  test("hash is deterministic", async () => {
    const fileA = join(tmpDir, "det-a.txt");
    const fileB = join(tmpDir, "det-b.txt");
    const content = "deterministic content\nwith multiple lines\n";

    await writeFile(fileA, content, "utf-8");
    await writeFile(fileB, content, "utf-8");

    const snapA = await captureReadSnapshot(fileA);
    const snapB = await captureReadSnapshot(fileB);

    expect(snapA.contentHash).toBe(snapB.contentHash);
  });
});

// ---------------------------------------------------------------------------
// Staging directory tests
// ---------------------------------------------------------------------------
describe("ensureStagingDir", () => {
  test("creates {scratchRoot}/{sessionId}/ directory", async () => {
    const sessionId = "test-session-123";
    const scratchRoot = join(tmpDir, ".tmp");
    const dir = await ensureStagingDir(scratchRoot, sessionId);

    expect(dir).toBe(join(scratchRoot, sessionId));

    const info = await stat(dir);
    expect(info.isDirectory()).toBe(true);
  });

  test("is idempotent", async () => {
    const sessionId = "idempotent-session";
    const scratchRoot = join(tmpDir, ".tmp");

    const dir1 = await ensureStagingDir(scratchRoot, sessionId);
    const dir2 = await ensureStagingDir(scratchRoot, sessionId);

    expect(dir1).toBe(dir2);

    const info = await stat(dir1);
    expect(info.isDirectory()).toBe(true);
  });
});

describe("cleanupStagingDir", () => {
  test("removes directory recursively", async () => {
    const sessionId = "cleanup-session";
    const scratchRoot = join(tmpDir, ".tmp");
    const dir = await ensureStagingDir(scratchRoot, sessionId);

    // Add some files inside
    await writeFile(join(dir, "a.tmp"), "a", "utf-8");
    await writeFile(join(dir, "b.tmp"), "b", "utf-8");

    await cleanupStagingDir(dir);

    // The directory should be gone
    await expect(stat(dir)).rejects.toThrow();
  });
});
