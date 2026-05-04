/**
 * Minimum viable agent-name normalizer — strips invisible / default-ignorable
 * Unicode code points that have no legitimate role in an agent name and are
 * typically formatting artifacts from upstream tooling (sort-prefix hacks,
 * BOMs, zero-width joiners leaked from copy-paste, etc.).
 *
 * Everything else passes through unchanged. This is deliberately narrow:
 *   - emoji preserved
 *   - international letters preserved
 *   - mixed case preserved
 *   - spaces / dashes / parens / punctuation preserved
 *
 * The set below covers the standard zero-width and bidirectional-formatting
 * control chars. Expand via a follow-up once the approach is validated in
 * tests — do not add code points speculatively.
 *
 * TODO: ZERO WIDTH JOINER (U+200D) is legitimate inside emoji sequences
 * (e.g. family glyphs like 👨‍👩‍👧). This normalizer strips it at the name
 * level because agent names today do not use ZWJ emoji sequences; revisit
 * if a future test/fixture exercises ZWJ-joined emoji names.
 */

// Named code points — comments describe *why each is in the set*, not just its
// name. All are zero-width or default-ignorable and have no legitimate role in
// an agent name. Moved from a character-class regex to a `Set<number>` so every
// code point carries human-readable intent at the definition site.
const INVISIBLE_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200b, // ZERO WIDTH SPACE — oh-my-openagent sort-prefix hack (the bug we hit)
  0x200c, // ZERO WIDTH NON-JOINER
  0x200d, // ZERO WIDTH JOINER (see TODO above — legit inside emoji sequences)
  0x200e, // LEFT-TO-RIGHT MARK
  0x200f, // RIGHT-TO-LEFT MARK
  0x202a, // LEFT-TO-RIGHT EMBEDDING (bidi formatting control)
  0x202b, // RIGHT-TO-LEFT EMBEDDING (bidi formatting control)
  0x202c, // POP DIRECTIONAL FORMATTING (bidi formatting control)
  0x202d, // LEFT-TO-RIGHT OVERRIDE (bidi formatting control)
  0x202e, // RIGHT-TO-LEFT OVERRIDE (bidi formatting control)
  0x2060, // WORD JOINER
  0x2061, // FUNCTION APPLICATION (invisible math operator)
  0x2062, // INVISIBLE TIMES (invisible math operator)
  0x2063, // INVISIBLE SEPARATOR (invisible math operator)
  0x2064, // INVISIBLE PLUS (invisible math operator)
  0x206a, // INHIBIT SYMMETRIC SWAPPING (deprecated formatting control)
  0x206b, // ACTIVATE SYMMETRIC SWAPPING (deprecated formatting control)
  0x206c, // INHIBIT ARABIC FORM SHAPING (deprecated formatting control)
  0x206d, // ACTIVATE ARABIC FORM SHAPING (deprecated formatting control)
  0x206e, // NATIONAL DIGIT SHAPES (deprecated formatting control)
  0x206f, // NOMINAL DIGIT SHAPES (deprecated formatting control)
  0xfeff, // BOM / ZERO WIDTH NO-BREAK SPACE
]);

export interface NormalizedAgentName {
  /** Cleaned name suitable for use internally and for downstream consumers. */
  readonly name: string;
  /** True if any characters were stripped. Callers should log when true. */
  readonly normalized: boolean;
  /** Original input, preserved for round-tripping to upstream systems. */
  readonly original: string;
}

export function normalizeAgentName(input: string): NormalizedAgentName {
  let cleaned = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || !INVISIBLE_CODE_POINTS.has(cp)) {
      cleaned += ch;
    }
  }
  return {
    name: cleaned,
    normalized: cleaned !== input,
    original: input,
  };
}
