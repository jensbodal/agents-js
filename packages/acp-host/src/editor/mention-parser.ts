/**
 * Pure functions for parsing inline mention tokens and resolving them to files.
 * Extracted from earlier host mention-handling code.
 * Only framework-agnostic functions are included here; host-native discovery and
 * resource rendering stay with the consumer.
 */

const MAX_RESOURCE_SIZE = 50 * 1024; // 50KB truncation limit

export interface OpenFileEntry {
  path: string;
  name: string;
  basename: string;
}

/**
 * Filters open files by a query string (fuzzy match against name and basename).
 */
export function filterFiles(files: OpenFileEntry[], query: string): OpenFileEntry[] {
  if (!query) return files;
  const lower = query.toLowerCase();
  return files.filter(
    (f) => f.name.toLowerCase().includes(lower) || f.basename.toLowerCase().includes(lower),
  );
}

/**
 * Mention pattern: `@note.md` only at word boundaries (start-of-string,
 * whitespace, or newline). Uses regex because the alternative is a
 * manual scan that finds every `@`, walks back one char to verify the
 * boundary, then walks forward to greedily collect the path token —
 * three explicit steps for what `\b`-style anchoring expresses inline.
 */
const MENTION_PATTERN = /(?:^|[\s\n])@([\w\-./]+)/g;

/**
 * Extracts mention tokens from text. Only matches tokens like `@note.md`
 * at word boundaries (after whitespace, start of line, or after newline).
 */
export function parseMentions(text: string): string[] {
  const matches: string[] = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    if (match[1]) matches.push(match[1]);
  }
  return matches;
}

/**
 * Resolves mention tokens to open file paths.
 */
export function resolveMentions(mentions: string[], openFiles: OpenFileEntry[]): OpenFileEntry[] {
  const resolved: OpenFileEntry[] = [];
  const seen = new Set<string>();

  for (const mention of mentions) {
    const lower = mention.toLowerCase();
    const match = openFiles.find(
      (f) =>
        f.name.toLowerCase() === lower ||
        f.basename.toLowerCase() === lower ||
        f.path.toLowerCase() === lower ||
        f.path.toLowerCase().endsWith(`/${lower}`),
    );
    if (match && !seen.has(match.path)) {
      seen.add(match.path);
      resolved.push(match);
    }
  }

  return resolved;
}

/**
 * Builds inline text with file content embedded in a fenced code block.
 */
export function buildInlineContext(filePath: string, content: string): string {
  const text =
    content.length > MAX_RESOURCE_SIZE
      ? `${content.slice(0, MAX_RESOURCE_SIZE)}\n...[truncated]`
      : content;
  return `\n\nFile: ${filePath}\n\`\`\`\n${text}\n\`\`\``;
}

/**
 * Finds the mention token being typed at the cursor position in a textarea.
 * Returns the query text after `@` (empty string if the user just typed `@`),
 * or `null` if the cursor is not currently inside a mention.
 */
export function getMentionAtCursor(text: string, cursorPos: number): string | null {
  // Walk backwards from cursor to find @
  let i = cursorPos - 1;
  while (i >= 0) {
    const ch = text[i];
    if (!ch || !/[\w\-./]/.test(ch)) break;
    i--;
  }

  if (i < 0 || text[i] !== "@") return null;

  // @ must be at start or after whitespace
  const prev = i > 0 ? text[i - 1] : undefined;
  if (prev && !/\s/.test(prev)) return null;

  return text.slice(i + 1, cursorPos);
}
