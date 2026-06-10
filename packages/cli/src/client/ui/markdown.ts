/**
 * Minimal markdown → opentui styled-text rendering for the client transcript.
 *
 * The terminal client previously printed agent text verbatim, so a reply
 * containing `**bold**`, `- bullets`, or `` `code` `` showed the raw markers.
 * This module parses a small, safe markdown subset into styled chunks so the
 * TUI renders it the way the web UI already does. Scope intentionally matches
 * the web tokenizer (`packages/ui-components/src/acp-message.ts`): inline
 * **bold**, *italic* / _italic_, `code`, plus `#` headings and `-`/`*` bullets.
 * Multi-line code fences and tables are out of scope (rendered as plain text).
 *
 * The parser ({@link parseMarkdownBlock}) is pure and unit-tested; the opentui
 * mapping ({@link markdownToStyledText}) is a thin adapter over the parsed
 * tokens so the styling logic stays testable without a renderer.
 */
import { bold, fg, italic, StyledText, type TextChunk } from "@opentui/core";

/** An inline run of text with at most the styles this subset supports. */
export interface MarkdownToken {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export interface MarkdownLine {
  kind: "text" | "bullet" | "heading";
  tokens: MarkdownToken[];
}

const INLINE_RE = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\*([^*]+)\*)|(_([^_]+)_)/g;

/**
 * Tokenize a single line's inline markdown. Unmatched text becomes plain
 * tokens; `**x**`→bold, `` `x` ``→code, `*x*`/`_x_`→italic. Always returns at
 * least one token (possibly empty) so callers can map 1:1 to chunks.
 */
export function parseInlineMarkdown(text: string): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  let lastIndex = 0;
  // Reset before use — the regex is module-level + stateful with the /g flag.
  INLINE_RE.lastIndex = 0;
  let match = INLINE_RE.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, match.index) });
    }
    if (match[2] !== undefined) {
      tokens.push({ text: match[2], bold: true });
    } else if (match[4] !== undefined) {
      tokens.push({ text: match[4], code: true });
    } else if (match[6] !== undefined) {
      tokens.push({ text: match[6], italic: true });
    } else if (match[8] !== undefined) {
      tokens.push({ text: match[8], italic: true });
    }
    lastIndex = INLINE_RE.lastIndex;
    match = INLINE_RE.exec(text);
  }
  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex) });
  }
  if (tokens.length === 0) {
    tokens.push({ text: "" });
  }
  return tokens;
}

/**
 * Parse a (possibly multi-line) markdown block into classified lines. Headings
 * (`#`..`######`) render bold with the markers stripped; bullets (`-`/`*` +
 * space) render with a `•` marker; everything else is inline-parsed text.
 */
export function parseMarkdownBlock(text: string): MarkdownLine[] {
  return text.split("\n").map((line): MarkdownLine => {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      return {
        kind: "heading",
        tokens: parseInlineMarkdown(heading[2] ?? "").map((token) => ({ ...token, bold: true })),
      };
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      return { kind: "bullet", tokens: parseInlineMarkdown(bullet[2] ?? "") };
    }
    return { kind: "text", tokens: parseInlineMarkdown(line) };
  });
}

const CODE_COLOR = "#e0af68";

function tokenToChunk(token: MarkdownToken, baseColor: string): TextChunk {
  if (token.code) {
    return fg(CODE_COLOR)(token.text);
  }
  const colored = fg(baseColor)(token.text);
  if (token.bold) {
    return bold(colored);
  }
  if (token.italic) {
    return italic(colored);
  }
  return colored;
}

/**
 * Render a markdown block as opentui {@link StyledText}, coloring plain text
 * with `baseColor` and applying bold/italic/code styling. Lines are joined with
 * newlines; bullets get a `•` prefix.
 */
export function markdownToStyledText(text: string, baseColor: string): StyledText {
  const lines = parseMarkdownBlock(text);
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      chunks.push(fg(baseColor)("\n"));
    }
    if (line.kind === "bullet") {
      chunks.push(fg(baseColor)("• "));
    }
    for (const token of line.tokens) {
      chunks.push(tokenToChunk(token, baseColor));
    }
  });
  return new StyledText(chunks);
}
