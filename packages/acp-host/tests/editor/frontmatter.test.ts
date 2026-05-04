import { describe, expect, test } from "bun:test";
import {
  detectFrontmatterOnlyWrite,
  splitMarkdownFrontmatter,
} from "../../src/editor/frontmatter.ts";

describe("splitMarkdownFrontmatter", () => {
  test("extracts frontmatter and body", () => {
    const result = splitMarkdownFrontmatter("---\ntitle: Hello\n---\nBody");
    expect(result.frontmatter).toBe("title: Hello");
    expect(result.body).toBe("Body");
  });

  test("returns null frontmatter for plain markdown", () => {
    const result = splitMarkdownFrontmatter("Body only");
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe("Body only");
  });

  test("handles CRLF line endings", () => {
    const result = splitMarkdownFrontmatter("---\r\ntitle: Hello\r\n---\r\nBody");
    expect(result.frontmatter).toBe("title: Hello");
    expect(result.body).toBe("Body");
  });

  test("handles empty frontmatter", () => {
    const result = splitMarkdownFrontmatter("---\n\n---\nBody");
    expect(result.frontmatter).toBe("");
    expect(result.body).toBe("Body");
  });
});

describe("detectFrontmatterOnlyWrite", () => {
  const parseFrontmatter = (yaml: string) => {
    const lines = yaml.split("\n");
    const result: Record<string, unknown> = {};
    let currentListKey: string | null = null;

    for (const line of lines) {
      if (line.startsWith("  - ") && currentListKey) {
        const currentValue = result[currentListKey];
        if (Array.isArray(currentValue)) {
          currentValue.push(line.slice(4));
        }
        continue;
      }

      const [rawKey, rawValue] = line.split(":", 2);
      if (!rawKey) {
        continue;
      }

      const key = rawKey.trim();
      const value = rawValue?.trim() ?? "";
      if (value.length === 0) {
        result[key] = [];
        currentListKey = key;
        continue;
      }

      result[key] = value;
      currentListKey = null;
    }

    return result;
  };

  test("returns the parsed frontmatter when only YAML changes", () => {
    const result = detectFrontmatterOnlyWrite(
      "---\ntitle: Old\n---\nBody",
      "---\ntitle: New\ntags:\n  - acp\n---\nBody",
      parseFrontmatter,
    );

    expect(result).not.toBeNull();
    expect(result?.nextFrontmatter).toEqual({
      tags: ["acp"],
      title: "New",
    });
  });

  test("returns null when the markdown body changes", () => {
    const result = detectFrontmatterOnlyWrite(
      "---\ntitle: Old\n---\nBody",
      "---\ntitle: New\n---\nDifferent body",
      parseFrontmatter,
    );

    expect(result).toBeNull();
  });

  test("returns null when the next content has no frontmatter", () => {
    const result = detectFrontmatterOnlyWrite(
      "---\ntitle: Old\n---\nBody",
      "Body",
      parseFrontmatter,
    );

    expect(result).toBeNull();
  });
});
