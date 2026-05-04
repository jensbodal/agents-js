/**
 * Pure functions for parsing `@agent-name` mentions from text content.
 *
 * Agent names are alphanumeric + hyphens (e.g. `knowledge-compiler`, `code-reviewer`).
 * A mention is valid when preceded by whitespace or start-of-string, which
 * prevents matching email addresses like `user@example.com`.
 */

export interface ParsedMention {
  /** The agent name without the leading `@`. */
  agentName: string;
  /** The full matched text including the `@` prefix. */
  fullMatch: string;
  /** The start index of the `@` character in the source text. */
  startIndex: number;
}

/**
 * Regex breakdown:
 *   (?:^|(?<=\s))   — must be at start-of-string or preceded by whitespace (lookbehind)
 *   @               — literal @ sign
 *   ([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)  — agent name: starts and ends with
 *                     alphanumeric, may contain hyphens in between; single-char names allowed
 */
const MENTION_REGEX = /(?:^|(?<=\s))@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)/g;

/**
 * Extracts `@agent-name` mentions from text content.
 *
 * Returns an array of {@link ParsedMention} objects describing each valid
 * mention found. Email addresses (e.g. `user@example.com`) are NOT matched
 * because the `@` must be preceded by whitespace or be at the start of the string.
 */
export function parseAgentMentions(text: string): ParsedMention[] {
  const results: ParsedMention[] = [];
  const regex = new RegExp(MENTION_REGEX.source, MENTION_REGEX.flags);

  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    const agentName = match[1];
    if (agentName) {
      const fullMatch = `@${agentName}`;
      // match[0] may include a leading whitespace char from the pattern;
      // the actual @ starts at (match.index + match[0].length - fullMatch.length)
      const startIndex = match.index + match[0].length - fullMatch.length;
      results.push({ agentName, fullMatch, startIndex });
    }
    match = regex.exec(text);
  }

  return results;
}

// ── Dispatch directives (`@@agent-name payload`) ────────────────────

export interface ParsedDispatchDirective {
  /** The agent name without the leading `@@`. */
  agentName: string;
  /** The remaining text after the `@@agent-name` token, trimmed. */
  payload: string;
  /** The full matched directive text including `@@` prefix. */
  fullMatch: string;
}

/**
 * Regex breakdown:
 *   ^              — must be at start of string
 *   \s*            — optional leading whitespace
 *   @@             — literal @@ prefix (distinguishes from single-@ mentions)
 *   ([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)  — agent name (same char class as @mentions)
 *   (?:\s+([\s\S]*))?  — optional whitespace + payload (rest of the message, including newlines)
 *   $              — end of string
 */
const DISPATCH_DIRECTIVE_REGEX =
  /^\s*@@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)(?:\s+([\s\S]*))?$/;

/**
 * Parses a `@@agent-name payload` dispatch directive from the user text.
 *
 * Unlike `@mentions` which are annotations that can appear anywhere,
 * `@@` is a deterministic routing directive: the entire message is consumed
 * and forwarded to the named agent. Only recognized when `@@` appears at
 * the start of the message.
 *
 * Returns `null` if the text does not start with a `@@` directive.
 */
export function parseDispatchDirective(text: string): ParsedDispatchDirective | null {
  const match = DISPATCH_DIRECTIVE_REGEX.exec(text);
  if (!match?.[1]) {
    return null;
  }

  const agentName = match[1];
  const payload = (match[2] ?? "").trim();
  const fullMatch = `@@${agentName}`;

  return { agentName, payload, fullMatch };
}

// ── Mention stripping ───────────────────────────────────────────────

/**
 * Removes a previously-parsed mention from the source text.
 *
 * Returns the text with the mention's `fullMatch` removed at the correct
 * position. Trailing whitespace immediately after the mention is collapsed
 * so the result reads naturally.
 */
export function stripMention(text: string, mention: ParsedMention): string {
  const before = text.slice(0, mention.startIndex);
  const after = text.slice(mention.startIndex + mention.fullMatch.length);

  // Collapse a single leading space in `after` when `before` already ends
  // with whitespace or is empty (avoids double spaces).
  if ((before.length === 0 || /\s$/.test(before)) && after.startsWith(" ")) {
    return before + after.slice(1);
  }

  return before + after;
}
