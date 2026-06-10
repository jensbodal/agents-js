/**
 * Quote-safe shell-style argument tokenizer (shlex-like, intentionally lenient).
 *
 * Splits a single command/flags string into argv tokens, honoring single
 * quotes, double quotes, and backslash escapes the way a POSIX shell does for
 * word-splitting — but WITHOUT throwing. The call sites that use this parse
 * best-effort, partly-trusted input (env vars, ACP tool-call titles, sigil
 * tails), so an unterminated quote or trailing escape captures to end-of-input
 * rather than raising; that preserves the resilience of the naive
 * `split(/\s+/)` code it replaces while fixing the "splits inside quotes" bug.
 *
 * Rules:
 *  - Unquoted whitespace (space, tab, CR, LF, form-feed, vertical-tab)
 *    separates tokens; runs of whitespace collapse and never yield empty
 *    tokens.
 *  - Single quotes: every character is literal until the next `'` — no escape
 *    processing inside (POSIX single-quote semantics).
 *  - Double quotes: literal except `\"` and `\\`, which unescape to `"` and
 *    `\`; a backslash before any other character is preserved literally.
 *  - A backslash outside quotes escapes the next character (including
 *    whitespace and quote characters).
 *  - A quoted empty string (`''` or `""`) produces an explicit empty token.
 *    Most call sites then `.filter(Boolean)`, so empties are dropped there —
 *    keep that filter to preserve existing behavior.
 *  - Unterminated quote / trailing backslash: capture what is present and
 *    stop, never throw.
 *
 * Implemented as a single character scan (no regex): a tokenizer's state
 * machine is clearer and less error-prone expressed imperatively than as a
 * regex, and it sidesteps catastrophic-backtracking and partial-match
 * footguns.
 */
export function tokenizeShellArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  // Distinguishes "no token started" (whitespace run) from "token is the empty
  // string" (an explicit `''`/`""`), so quoted-empty survives but whitespace
  // never fabricates an empty token.
  let started = false;
  const length = input.length;
  let i = 0;

  const isWhitespace = (ch: string): boolean =>
    ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v";

  // `charAt` returns "" past end-of-input (never undefined), which keeps the
  // scan total without `noUncheckedIndexedAccess` casts and lets unterminated
  // quotes/escapes fall through to a clean end-of-input close.
  while (i < length) {
    const ch = input.charAt(i);

    if (ch === "'") {
      started = true;
      i += 1;
      while (i < length && input.charAt(i) !== "'") {
        current += input.charAt(i);
        i += 1;
      }
      i += 1; // consume the closing quote (or step past end-of-input)
      continue;
    }

    if (ch === '"') {
      started = true;
      i += 1;
      while (i < length && input.charAt(i) !== '"') {
        const next = input.charAt(i + 1);
        if (input.charAt(i) === "\\" && i + 1 < length && (next === '"' || next === "\\")) {
          current += next;
          i += 2;
        } else {
          current += input.charAt(i);
          i += 1;
        }
      }
      i += 1; // consume the closing quote (or step past end-of-input)
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < length) {
        current += input.charAt(i + 1);
        started = true;
        i += 2;
      } else {
        i += 1; // trailing backslash: drop it
      }
      continue;
    }

    if (isWhitespace(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      i += 1;
      continue;
    }

    current += ch;
    started = true;
    i += 1;
  }

  if (started) {
    tokens.push(current);
  }

  return tokens;
}
