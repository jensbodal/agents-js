import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  readFile as fsReadFile,
  stat as fsStat,
  writeFile as fsWriteFile,
  mkdir,
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadTextFileRequest, WriteTextFileRequest } from "@agentclientprotocol/sdk";
import { createNodeFileAdapters } from "../src/node-file-adapters.ts";

const TEST_SESSION_ID = "test-session";

function read(path: string): ReadTextFileRequest {
  return { path, sessionId: TEST_SESSION_ID };
}

function write(path: string, content: string): WriteTextFileRequest {
  return { path, content, sessionId: TEST_SESSION_ID };
}

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "node-file-adapters-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("readTextFile", () => {
  test("reads a file within workspace", async () => {
    await fsWriteFile(join(workspace, "hello.txt"), "hello world", "utf-8");

    const adapters = createNodeFileAdapters(workspace);
    const result = await adapters.readTextFile(read("hello.txt"));

    expect(result.content).toBe("hello world");
  });

  test("rejects path outside workspace (traversal attack)", async () => {
    const adapters = createNodeFileAdapters(workspace);

    await expect(adapters.readTextFile(read("../etc/passwd"))).rejects.toThrow(
      /approved read roots/i,
    );
  });

  test("handles relative paths correctly", async () => {
    await fsWriteFile(join(workspace, "sub.txt"), "sub content", "utf-8");

    const adapters = createNodeFileAdapters(workspace);
    const result = await adapters.readTextFile(read("./sub.txt"));

    expect(result.content).toBe("sub content");
  });

  test("file not found returns appropriate error", async () => {
    const adapters = createNodeFileAdapters(workspace);

    await expect(adapters.readTextFile(read("nonexistent.txt"))).rejects.toThrow();
  });
});

describe("writeTextFile", () => {
  const approve = async () => true;
  const reject = async () => false;

  test("writes file when approval callback returns true", async () => {
    const adapters = createNodeFileAdapters(workspace);

    await adapters.writeTextFile(write("new.txt", "written"), approve);

    const ondisk = await fsReadFile(join(workspace, "new.txt"), "utf-8");
    expect(ondisk).toBe("written");
  });

  test("does NOT write when approval callback returns false", async () => {
    const adapters = createNodeFileAdapters(workspace);

    await expect(adapters.writeTextFile(write("blocked.txt", "nope"), reject)).rejects.toThrow(
      /rejected by user/i,
    );

    // File should not exist
    await expect(fsReadFile(join(workspace, "blocked.txt"), "utf-8")).rejects.toThrow();
  });

  test("creates parent directories if needed", async () => {
    const adapters = createNodeFileAdapters(workspace);

    await adapters.writeTextFile(write("a/b/c/deep.txt", "deep"), approve);

    const ondisk = await fsReadFile(join(workspace, "a/b/c/deep.txt"), "utf-8");
    expect(ondisk).toBe("deep");
  });

  test("rejects path outside workspace (write gate blocks)", async () => {
    const adapters = createNodeFileAdapters(workspace);

    await expect(adapters.writeTextFile(write("../../escape.txt", "bad"), approve)).rejects.toThrow(
      /approved write roots/i,
    );
  });

  test("passes correct diff to approval callback", async () => {
    await fsWriteFile(join(workspace, "existing.txt"), "old content", "utf-8");

    const adapters = createNodeFileAdapters(workspace);
    let capturedGate: { path: string; diff: string } | undefined;

    await adapters.writeTextFile(write("existing.txt", "new content"), async (gate) => {
      capturedGate = gate;
      return true;
    });

    expect(capturedGate).toBeDefined();
    expect(capturedGate?.path).toBe("existing.txt");
    expect(capturedGate?.diff).toContain("-old content");
    expect(capturedGate?.diff).toContain("+new content");
  });

  test("handles new file (no existing content)", async () => {
    const adapters = createNodeFileAdapters(workspace);
    let capturedGate: { path: string; diff: string } | undefined;

    await adapters.writeTextFile(write("brand-new.txt", "fresh"), async (gate) => {
      capturedGate = gate;
      return true;
    });

    expect(capturedGate).toBeDefined();
    expect(capturedGate?.diff).toContain("+fresh");

    const ondisk = await fsReadFile(join(workspace, "brand-new.txt"), "utf-8");
    expect(ondisk).toBe("fresh");
  });
});

describe("workspace-context-aware file boundaries", () => {
  const approve = async () => true;

  test("resolves relative paths from session cwd and reports gate paths relative to workspace identity", async () => {
    const scopedCwd = join(workspace, "projects", "alpha");
    await mkdir(scopedCwd, { recursive: true });
    await fsWriteFile(join(scopedCwd, ".keep"), "", "utf-8");

    const adapters = createNodeFileAdapters(workspace, {
      sessionCwd: scopedCwd,
    });
    let capturedGate: { path: string; diff: string; absolutePath?: string } | undefined;

    await adapters.writeTextFile(write("note.md", "scoped write"), async (gate) => {
      capturedGate = gate;
      return true;
    });

    const ondisk = await fsReadFile(join(scopedCwd, "note.md"), "utf-8");
    expect(ondisk).toBe("scoped write");
    expect(capturedGate?.path).toBe("projects/alpha/note.md");
    expect(capturedGate?.absolutePath).toBe(join(scopedCwd, "note.md"));
  });

  test("rejects reads outside approved read roots even when they stay inside the workspace identity", async () => {
    const scopedCwd = join(workspace, "projects", "alpha");
    await mkdir(scopedCwd, { recursive: true });
    await fsWriteFile(join(workspace, "elsewhere.txt"), "blocked", "utf-8");

    const adapters = createNodeFileAdapters(workspace, {
      sessionCwd: scopedCwd,
      approvedReadRoots: [scopedCwd],
    });

    await expect(adapters.readTextFile(read("../../elsewhere.txt"))).rejects.toThrow(
      /approved read roots/i,
    );
  });

  test("rejects writes outside approved write roots even when they stay inside the workspace identity", async () => {
    const scopedCwd = join(workspace, "projects", "alpha");
    await mkdir(scopedCwd, { recursive: true });
    const adapters = createNodeFileAdapters(workspace, {
      sessionCwd: scopedCwd,
      approvedWriteRoots: [scopedCwd],
    });

    await expect(adapters.writeTextFile(write("../../escape.md", "nope"), approve)).rejects.toThrow(
      /approved write roots/i,
    );
  });

  test("allows scratch-root writes without invoking the approval callback", async () => {
    const scopedCwd = join(workspace, "projects", "alpha");
    const scratchRoot = join(workspace, ".scratch");
    await mkdir(scopedCwd, { recursive: true });
    const adapters = createNodeFileAdapters(workspace, {
      sessionCwd: scopedCwd,
      approvedWriteRoots: [scopedCwd],
      scratchRoots: [scratchRoot],
    });
    let approvalCalls = 0;

    await adapters.writeTextFile(
      write(join(scratchRoot, "session-artifact.txt"), "scratch"),
      async () => {
        approvalCalls++;
        return false;
      },
    );

    const ondisk = await fsReadFile(join(scratchRoot, "session-artifact.txt"), "utf-8");
    expect(ondisk).toBe("scratch");
    expect(approvalCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Atomic write integration (with sessionId)
// ---------------------------------------------------------------------------
describe("atomic write integration", () => {
  const approve = async () => true;

  test("read populates snapshot cache for subsequent atomic write", async () => {
    await fsWriteFile(join(workspace, "cas-read.txt"), "initial", "utf-8");

    const adapters = createNodeFileAdapters(workspace, { sessionId: "sess-1" });
    try {
      // Read first -- populates the internal snapshot cache
      await adapters.readTextFile(read("cas-read.txt"));

      // Write back with modified content -- should succeed because snapshot matches
      await adapters.writeTextFile(write("cas-read.txt", "updated via adapter"), approve);

      const ondisk = await fsReadFile(join(workspace, "cas-read.txt"), "utf-8");
      expect(ondisk).toBe("updated via adapter");
    } finally {
      await adapters.cleanup();
    }
  });

  test("write without prior read creates new file atomically", async () => {
    const adapters = createNodeFileAdapters(workspace, { sessionId: "sess-2" });
    try {
      await adapters.writeTextFile(write("atomic-new.txt", "brand new atomic"), approve);

      const ondisk = await fsReadFile(join(workspace, "atomic-new.txt"), "utf-8");
      expect(ondisk).toBe("brand new atomic");
    } finally {
      await adapters.cleanup();
    }
  });

  test("CAS conflict propagates through adapter writeTextFile", async () => {
    await fsWriteFile(join(workspace, "cas-conflict.txt"), "original", "utf-8");

    const adapters = createNodeFileAdapters(workspace, { sessionId: "sess-3" });
    try {
      // Read to populate snapshot
      await adapters.readTextFile(read("cas-conflict.txt"));

      // Externally modify the file
      await fsWriteFile(join(workspace, "cas-conflict.txt"), "externally changed", "utf-8");

      // Attempt to write through the adapter -- should fail with CAS conflict
      await expect(
        adapters.writeTextFile(write("cas-conflict.txt", "my change"), approve),
      ).rejects.toThrow(/CAS conflict/);
    } finally {
      await adapters.cleanup();
    }
  });

  test("adapter without sessionId uses direct write (no CAS)", async () => {
    await fsWriteFile(join(workspace, "direct-write.txt"), "original", "utf-8");

    // No sessionId -- should use the non-atomic code path
    const adapters = createNodeFileAdapters(workspace);

    // Read, then externally modify, then write -- should NOT conflict because CAS is disabled
    await adapters.readTextFile(read("direct-write.txt"));
    await fsWriteFile(join(workspace, "direct-write.txt"), "externally changed", "utf-8");

    await adapters.writeTextFile(write("direct-write.txt", "overwritten without CAS"), approve);

    const ondisk = await fsReadFile(join(workspace, "direct-write.txt"), "utf-8");
    expect(ondisk).toBe("overwritten without CAS");
  });

  test("cleanup removes staging directory", async () => {
    const sessionId = "sess-cleanup";
    const adapters = createNodeFileAdapters(workspace, { sessionId });

    // Perform a write to trigger staging directory creation
    await adapters.writeTextFile(write("cleanup-test.txt", "trigger staging"), approve);

    // The staging dir should exist
    const stagingPath = join(workspace, ".tmp", sessionId);
    const info = await fsStat(stagingPath);
    expect(info.isDirectory()).toBe(true);

    // Cleanup should remove it
    await adapters.cleanup();

    await expect(fsStat(stagingPath)).rejects.toThrow();
  });

  test("uses the configured scratch root for session staging", async () => {
    const sessionId = "sess-scratch-root";
    const scratchRoot = join(workspace, ".scratch");
    const adapters = createNodeFileAdapters(workspace, {
      sessionId,
      scratchRoots: [scratchRoot],
    });

    await adapters.writeTextFile(write("scratch-root-test.txt", "trigger staging"), approve);

    const stagingPath = join(scratchRoot, sessionId);
    const info = await fsStat(stagingPath);
    expect(info.isDirectory()).toBe(true);

    await adapters.cleanup();
    await expect(fsStat(stagingPath)).rejects.toThrow();
  });
});
