import { describe, expect, test } from "bun:test";
import {
  closestParentFolder,
  isWithinDirectory,
  isWithinWorkspace,
  usesWindowsPaths,
} from "../src/path-utils.ts";

describe("usesWindowsPaths", () => {
  test("detects drive letter paths", () => {
    expect(usesWindowsPaths("C:\\workspace")).toBe(true);
  });

  test("detects backslash paths", () => {
    expect(usesWindowsPaths("foo\\bar")).toBe(true);
  });

  test("returns false for POSIX paths", () => {
    expect(usesWindowsPaths("/home/user/workspace")).toBe(false);
  });

  test("returns true if any value is Windows", () => {
    expect(usesWindowsPaths("/posix/path", "C:\\windows")).toBe(true);
  });
});

describe("isWithinWorkspace", () => {
  test("path equal to workspace root is within", () => {
    expect(isWithinWorkspace("/workspace", "/workspace")).toBe(true);
  });

  test("child path is within", () => {
    expect(isWithinWorkspace("/workspace", "subdir/file.md")).toBe(true);
  });

  test("absolute child path is within", () => {
    expect(isWithinWorkspace("/workspace", "/workspace/subdir/file.md")).toBe(true);
  });

  test("parent path is not within", () => {
    expect(isWithinWorkspace("/workspace", "../etc/passwd")).toBe(false);
  });

  test("sibling path with shared prefix is not within", () => {
    expect(isWithinWorkspace("/workspace", "/workspace-evil/file.md")).toBe(false);
  });

  test("handles trailing separator on workspace root", () => {
    expect(isWithinWorkspace("/workspace/", "file.md")).toBe(true);
  });

  test("handles Windows paths", () => {
    expect(isWithinWorkspace("C:\\workspace", "C:\\workspace\\subdir")).toBe(true);
  });

  test("blocks Windows sibling", () => {
    expect(isWithinWorkspace("C:\\workspace", "C:\\workspace-evil")).toBe(false);
  });
});

describe("isWithinDirectory", () => {
  test("nested file is within target directory", () => {
    expect(isWithinDirectory("hub/obsidian-acp", "hub/obsidian-acp/file.md")).toBe(true);
  });

  test("deeply nested file is within target directory", () => {
    expect(isWithinDirectory("hub/obsidian-acp", "hub/obsidian-acp/sub/deep/file.md")).toBe(true);
  });

  test("exact match (the directory itself) is within", () => {
    expect(isWithinDirectory("hub/obsidian-acp", "hub/obsidian-acp")).toBe(true);
  });

  test("rejects prefix attack (shared prefix but different dir)", () => {
    expect(isWithinDirectory("hub/acp", "hub/acp-evil/x.md")).toBe(false);
  });

  test("rejects sibling directory", () => {
    expect(isWithinDirectory("projects", "daily-notes/file.md")).toBe(false);
  });

  test("rejects parent directory", () => {
    expect(isWithinDirectory("hub/obsidian-acp/sub", "hub/obsidian-acp/file.md")).toBe(false);
  });

  test("handles trailing slash on target", () => {
    expect(isWithinDirectory("hub/acp/", "hub/acp/file.md")).toBe(true);
  });

  test("handles trailing slash on candidate", () => {
    expect(isWithinDirectory("hub/acp", "hub/acp/subdir/")).toBe(true);
  });

  test("handles leading slash on both", () => {
    expect(isWithinDirectory("/hub/acp", "/hub/acp/file.md")).toBe(true);
  });

  test("empty target always returns false", () => {
    expect(isWithinDirectory("", "any/path.md")).toBe(false);
  });

  test("empty candidate returns false", () => {
    expect(isWithinDirectory("hub", "")).toBe(false);
  });

  test("handles backslash paths (Windows-style)", () => {
    expect(isWithinDirectory("hub\\acp", "hub\\acp\\file.md")).toBe(true);
  });

  test("handles mixed separators", () => {
    expect(isWithinDirectory("hub/acp", "hub\\acp\\file.md")).toBe(true);
  });

  test("single-segment directory", () => {
    expect(isWithinDirectory("projects", "projects/note.md")).toBe(true);
  });

  test("root-level file is not within a subdirectory", () => {
    expect(isWithinDirectory("hub", "file.md")).toBe(false);
  });

  test("rejects traversal in candidate path", () => {
    expect(isWithinDirectory("hub", "hub/../etc/passwd")).toBe(false);
  });

  test("rejects traversal in target directory", () => {
    expect(isWithinDirectory("hub/../etc", "hub/../etc/file")).toBe(false);
  });

  test("rejects bare traversal", () => {
    expect(isWithinDirectory("..", "file.md")).toBe(false);
  });

  test("rejects trailing traversal", () => {
    expect(isWithinDirectory("hub", "hub/sub/..")).toBe(false);
  });
});

describe("closestParentFolder", () => {
  test("returns parent for nested path", () => {
    expect(closestParentFolder("projects/daily/note.md")).toBe("projects/daily");
  });

  test("returns empty string for root-level file", () => {
    expect(closestParentFolder("note.md")).toBe("");
  });

  test("returns parent for single-level nesting", () => {
    expect(closestParentFolder("projects/note.md")).toBe("projects");
  });

  test("handles trailing slash (treats as dir name)", () => {
    expect(closestParentFolder("a/b/c/")).toBe("a/b");
  });

  test("handles backslashes", () => {
    expect(closestParentFolder("a\\b\\file.md")).toBe("a/b");
  });

  test("handles leading slash", () => {
    expect(closestParentFolder("/projects/note.md")).toBe("projects");
  });

  test("empty string returns empty", () => {
    expect(closestParentFolder("")).toBe("");
  });

  test("deeply nested path", () => {
    expect(closestParentFolder("a/b/c/d/e.md")).toBe("a/b/c/d");
  });
});
