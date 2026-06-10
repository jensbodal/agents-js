/**
 * Learning tests for the client transcript markdown tokenizer. Covers the
 * subset the terminal renders so agent replies stop showing raw `**markers**`:
 * inline bold/italic/code, `#` headings, and `-`/`*` bullets.
 */
import { describe, expect, test } from "bun:test";
import {
  type MarkdownToken,
  markdownToStyledText,
  parseInlineMarkdown,
  parseMarkdownBlock,
} from "../src/client/ui/markdown.ts";

// Reconstruct the plain text from tokens (markers stripped).
const flat = (tokens: MarkdownToken[]) => tokens.map((t) => t.text).join("");

describe("parseInlineMarkdown", () => {
  test("splits bold/code/italic out of surrounding plain text, markers stripped", () => {
    const tokens = parseInlineMarkdown("a **b** c `d` e *f* g");
    expect(flat(tokens)).toBe("a b c d e f g");
    expect(tokens.find((t) => t.text === "b")?.bold).toBe(true);
    expect(tokens.find((t) => t.text === "d")?.code).toBe(true);
    expect(tokens.find((t) => t.text === "f")?.italic).toBe(true);
  });

  test("plain text yields a single plain token", () => {
    const tokens = parseInlineMarkdown("just text");
    expect(tokens).toEqual([{ text: "just text" }]);
  });

  test("underscore italics are recognized", () => {
    const tokens = parseInlineMarkdown("_em_");
    expect(tokens).toEqual([{ text: "em", italic: true }]);
  });

  test("empty string yields one empty token (1:1 chunk mapping)", () => {
    expect(parseInlineMarkdown("")).toEqual([{ text: "" }]);
  });
});

describe("parseMarkdownBlock", () => {
  test("classifies headings, bullets, and text; strips markers", () => {
    const lines = parseMarkdownBlock("# Title\n- one\n* two\nplain **bold**");
    expect(lines[0]?.kind).toBe("heading");
    expect(flat(lines[0]?.tokens ?? [])).toBe("Title");
    expect(lines[0]?.tokens.every((t) => t.bold)).toBe(true);
    expect(lines[1]?.kind).toBe("bullet");
    expect(flat(lines[1]?.tokens ?? [])).toBe("one");
    expect(lines[2]?.kind).toBe("bullet");
    expect(lines[3]?.kind).toBe("text");
    expect(lines[3]?.tokens.find((t) => t.bold)?.text).toBe("bold");
  });

  test("a `*italic*` line is text, not a bullet (marker needs trailing space)", () => {
    const lines = parseMarkdownBlock("*italic*");
    expect(lines[0]?.kind).toBe("text");
    expect(lines[0]?.tokens).toEqual([{ text: "italic", italic: true }]);
  });
});

describe("markdownToStyledText", () => {
  test("produces a StyledText whose chunks reconstruct the stripped text", () => {
    const styled = markdownToStyledText("# H\n- **b** x", "#ffffff");
    const text = styled.chunks.map((c) => c.text).join("");
    // heading "H", newline, bullet "• ", "b", " x"
    expect(text).toContain("H");
    expect(text).toContain("• ");
    expect(text).toContain("b");
    expect(text).not.toContain("**");
    expect(text).not.toContain("# ");
  });
});
