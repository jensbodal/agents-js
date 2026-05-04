import { describe, expect, test } from "bun:test";
import {
  buildInlineContext,
  filterFiles,
  getMentionAtCursor,
  type OpenFileEntry,
  parseMentions,
  resolveMentions,
} from "../../src/editor/mention-parser.ts";

const OPEN_FILES: OpenFileEntry[] = [
  { path: "daily/2026-03-24.md", name: "2026-03-24.md", basename: "2026-03-24" },
  { path: "hub/README.md", name: "README.md", basename: "README" },
  {
    path: "research/deep-research-report.md",
    name: "deep-research-report.md",
    basename: "deep-research-report",
  },
  { path: "agents/config.md", name: "config.md", basename: "config" },
];

describe("getMentionAtCursor", () => {
  test("returns query after @ at start of text", () => {
    expect(getMentionAtCursor("@read", 5)).toBe("read");
  });

  test("returns empty string when cursor is right after @", () => {
    expect(getMentionAtCursor("@", 1)).toBe("");
  });

  test("returns query after @ following a space", () => {
    expect(getMentionAtCursor("hello @rea", 10)).toBe("rea");
  });

  test("returns query after @ following a newline", () => {
    expect(getMentionAtCursor("hello\n@conf", 11)).toBe("conf");
  });

  test("returns null when no @ present", () => {
    expect(getMentionAtCursor("hello world", 5)).toBeNull();
  });

  test("returns null when @ is mid-word", () => {
    expect(getMentionAtCursor("email@test", 10)).toBeNull();
  });

  test("returns null when cursor is before @", () => {
    expect(getMentionAtCursor("hello @read", 3)).toBeNull();
  });

  test("handles @ with dots and slashes in file paths", () => {
    expect(getMentionAtCursor("@hub/README.md", 14)).toBe("hub/README.md");
  });
});

describe("parseMentions", () => {
  test("extracts single mention", () => {
    expect(parseMentions("check @README.md please")).toEqual(["README.md"]);
  });

  test("extracts multiple mentions", () => {
    expect(parseMentions("compare @README.md and @config.md")).toEqual(["README.md", "config.md"]);
  });

  test("extracts mention at start of text", () => {
    expect(parseMentions("@README.md is important")).toEqual(["README.md"]);
  });

  test("returns empty array when no mentions", () => {
    expect(parseMentions("no mentions here")).toEqual([]);
  });

  test("handles mention after newline", () => {
    expect(parseMentions("line1\n@config.md")).toEqual(["config.md"]);
  });

  test("does not match email-like patterns", () => {
    expect(parseMentions("send to user@example.com")).toEqual([]);
  });
});

describe("filterFiles", () => {
  test("returns all files for empty query", () => {
    expect(filterFiles(OPEN_FILES, "")).toEqual(OPEN_FILES);
  });

  test("filters by name substring", () => {
    const result = filterFiles(OPEN_FILES, "READ");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("README.md");
  });

  test("filters case-insensitively", () => {
    const result = filterFiles(OPEN_FILES, "readme");
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("README.md");
  });

  test("filters by basename", () => {
    const result = filterFiles(OPEN_FILES, "config");
    expect(result).toHaveLength(1);
    expect(result[0]?.basename).toBe("config");
  });

  test("returns empty array for no match", () => {
    expect(filterFiles(OPEN_FILES, "nonexistent")).toEqual([]);
  });

  test("matches partial name", () => {
    const result = filterFiles(OPEN_FILES, "deep");
    expect(result).toHaveLength(1);
    expect(result[0]?.basename).toBe("deep-research-report");
  });
});

describe("resolveMentions", () => {
  test("resolves by exact name", () => {
    const result = resolveMentions(["README.md"], OPEN_FILES);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("hub/README.md");
  });

  test("resolves by basename", () => {
    const result = resolveMentions(["config"], OPEN_FILES);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("agents/config.md");
  });

  test("resolves by full path", () => {
    const result = resolveMentions(["hub/README.md"], OPEN_FILES);
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("hub/README.md");
  });

  test("returns empty for unresolved mention", () => {
    expect(resolveMentions(["nonexistent.md"], OPEN_FILES)).toEqual([]);
  });

  test("deduplicates resolved files", () => {
    const result = resolveMentions(["README.md", "README.md"], OPEN_FILES);
    expect(result).toHaveLength(1);
  });

  test("resolves multiple different mentions", () => {
    const result = resolveMentions(["README.md", "config.md"], OPEN_FILES);
    expect(result).toHaveLength(2);
  });

  test("skips unresolved while keeping resolved", () => {
    const result = resolveMentions(["README.md", "missing.md", "config.md"], OPEN_FILES);
    expect(result).toHaveLength(2);
  });
});

describe("buildInlineContext", () => {
  test("wraps content in a fenced code block", () => {
    const result = buildInlineContext("test.md", "hello world");
    expect(result).toContain("File: test.md");
    expect(result).toContain("```\nhello world\n```");
  });

  test("truncates content exceeding 50KB", () => {
    const longContent = "a".repeat(60 * 1024);
    const result = buildInlineContext("big.md", longContent);
    expect(result).toContain("...[truncated]");
    expect(result.length).toBeLessThan(longContent.length);
  });
});
