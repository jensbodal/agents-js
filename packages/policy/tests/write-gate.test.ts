import { describe, expect, test } from "bun:test";
import { policyError, validationError } from "../src/errors.ts";
import { evaluateWriteGate, generateUnifiedDiff } from "../src/write-gate.ts";

describe("evaluateWriteGate", () => {
  test("returns allow_to_review for valid path within workspace", () => {
    const decision = evaluateWriteGate("/workspace", "test.md");
    expect(decision.action).toBe("allow_to_review");
    expect(decision.reasonCode).toBe("requires_review");
  });

  test("blocks paths that escape workspace via traversal", () => {
    const decision = evaluateWriteGate("/workspace", "../etc/passwd");
    expect(decision.action).toBe("block");
    if (decision.action === "block") {
      expect(decision.reasonCode).toBe("outside_workspace");
      expect(decision.reason).toContain("outside the workspace");
    }
  });

  test("allows nested paths within workspace", () => {
    const decision = evaluateWriteGate("/workspace", "subdir/file.md");
    expect(decision.action).toBe("allow_to_review");
  });

  test("requests more context when workspaceRoot is missing", () => {
    const decision = evaluateWriteGate("", "file.md");
    expect(decision.action).toBe("needs_more_context");
    if (decision.action === "needs_more_context") {
      expect(decision.reasonCode).toBe("missing_workspace_root");
    }
  });

  test("requests more context when relativePath is missing", () => {
    const decision = evaluateWriteGate("/workspace", "");
    expect(decision.action).toBe("needs_more_context");
    if (decision.action === "needs_more_context") {
      expect(decision.reasonCode).toBe("missing_relative_path");
    }
  });

  test("works correctly when workspaceRoot already has a trailing slash", () => {
    const decision = evaluateWriteGate("/workspace/", "file.md");
    expect(decision.action).toBe("allow_to_review");
  });

  test("accepts Windows child paths within workspace", () => {
    const decision = evaluateWriteGate("C:\\workspace", "subdir\\file.md");
    expect(decision.action).toBe("allow_to_review");
  });

  test("blocks Windows sibling paths with shared prefix", () => {
    const decision = evaluateWriteGate("C:\\workspace", "..\\workspace-evil\\file.md");
    expect(decision.action).toBe("block");
  });
});

describe("generateUnifiedDiff", () => {
  test("returns empty string for identical content", () => {
    expect(generateUnifiedDiff("hello", "hello")).toBe("");
  });

  test("shows added lines", () => {
    const diff = generateUnifiedDiff("line1", "line1\nline2");
    expect(diff).toContain("+line2");
  });

  test("shows removed lines", () => {
    const diff = generateUnifiedDiff("line1\nline2", "line1");
    expect(diff).toContain("-line2");
  });

  test("shows both added and removed lines", () => {
    const diff = generateUnifiedDiff("old line", "new line");
    expect(diff).toContain("-old line");
    expect(diff).toContain("+new line");
  });

  test("includes unified diff header", () => {
    const diff = generateUnifiedDiff("a", "b");
    expect(diff).toContain("--- a/file");
    expect(diff).toContain("+++ b/file");
    expect(diff).toContain("@@");
  });

  test("handles multiline content with context", () => {
    const old = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8";
    const updated = "line1\nline2\nline3\nchanged4\nline5\nline6\nline7\nline8";
    const diff = generateUnifiedDiff(old, updated);
    expect(diff).toContain("-line4");
    expect(diff).toContain("+changed4");
    // Should include context lines around the change
    expect(diff).toContain(" line3");
    expect(diff).toContain(" line5");
  });

  test("handles empty old content (new file)", () => {
    const diff = generateUnifiedDiff("", "new content");
    expect(diff).toContain("+new content");
  });

  test("handles empty new content (deleted file)", () => {
    const diff = generateUnifiedDiff("old content", "");
    expect(diff).toContain("-old content");
  });
});

describe("policyError", () => {
  test("returns -32000 with the provided reason", () => {
    const e = policyError("blocked by policy");
    expect(e.code).toBe(-32000);
    expect(e.message).toBe("blocked by policy");
  });
});

describe("validationError", () => {
  test("returns -32602 with the provided reason", () => {
    const e = validationError("invalid params");
    expect(e.code).toBe(-32602);
    expect(e.message).toBe("invalid params");
  });
});
