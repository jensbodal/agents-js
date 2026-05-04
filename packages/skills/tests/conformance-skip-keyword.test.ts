import { describe, expect, test } from "bun:test";
import { createStrictValidator } from "../src/index.ts";
import type { Skill } from "../src/types.ts";

/**
 * Conformance / strict-mode skip-keyword pin test.
 *
 * `packages/skills/src/conformance/strict.ts` declares
 * `ANTI_TRIGGER_PATTERNS` with three patterns; one of them is
 * `/\bskip\b.*:/i`. The word-boundary anchor is load-bearing — a
 * future "simplify" sweep that drops the `\b` to `.includes("skip")`
 * would silently broaden matches across `"skipper"`, `"skipped"`,
 * `"skipping"`, and any incidental occurrence of the substring `skip`,
 * accepting descriptions that never wrote a real anti-trigger clause.
 *
 * Same regression class as the `STALE_SOURCE_MARKER` pin test that
 * shipped earlier in this sweep
 * (packages/trial-agent/tests/readiness-gates.test.ts, commit 32116ce).
 *
 * The contract under test: only true anti-trigger phrasings — `skip`
 * as a leading word followed (anywhere on the same line) by a colon,
 * e.g. "Skip: format-only diffs" — count toward the strict-mode
 * anti-trigger requirement. Substring matches like `"skipper"`,
 * `"skipped"`, `"skipping"`, or `"skip"` without a colon must NOT
 * satisfy the requirement.
 */

/**
 * Build a Skill object that satisfies every strict-mode rule EXCEPT
 * possibly the anti-trigger clause — the description is the only knob
 * the caller varies. The body is a fixed template with a
 * `## When NOT to Use` section and >= 200 chars; the action-verb
 * opener and 300-char description floor are the caller's
 * responsibility (helper enforces neither, so test bodies surface the
 * full failure on a malformed input rather than masking it).
 */
function buildSkill(description: string): Skill {
  return {
    name: "skip-keyword-fixture",
    description,
    dir: "/virtual/skip-keyword-fixture",
    skillFile: "/virtual/skip-keyword-fixture/SKILL.md",
    frontmatter: {
      name: "skip-keyword-fixture",
      description,
      extra: {},
    },
    body: [
      "# Skip Keyword Fixture",
      "",
      "Inline fixture body for word-boundary-pin tests. Exists only to",
      "satisfy the body-length rule (>= 200 chars) and the When-NOT-to-Use",
      "section requirement. Pads the body with a brief explanation so the",
      "test surface is description-only.",
      "",
      "## When NOT to Use",
      "",
      "- production load",
      "- as a generic anti-trigger fixture (it isn't)",
    ].join("\n"),
  };
}

const strict = createStrictValidator();

function hasAntiTriggerError(errors: string[]): boolean {
  return errors.some((e) => /anti-trigger/i.test(e));
}

describe("packages/skills/tests/conformance-skip-keyword.test.ts", () => {
  /**
   * WHAT: A description containing `Skip:` as a leading word followed
   *       by a colon satisfies the anti-trigger check (no anti-trigger
   *       error).
   * WHY: Pins the canonical happy-path form documented in the strict.ts
   *       JSDoc and the validator's error message ("expected 'Not for
   *       ...', 'Do not use for ...', or 'Skip: ...'").
   */
  test("anti-trigger SATISFIED by 'Skip: ...' (canonical happy path)", () => {
    const description =
      "Perform a documented operation that pins the strict-mode anti-trigger contract by exercising the canonical Skip-colon happy path. Use when asked to verify the word-boundary pin behavior. Skip: tolerant-mode validation, MCP integration, runtime execution. Padding text so the description clears the 300-char floor without leaning on the Skip phrase to do the heavy lifting on length.";
    const result = strict(buildSkill(description));
    expect(hasAntiTriggerError(result.errors)).toBe(false);
  });

  /**
   * WHAT: A description containing `skip` as a leading word followed
   *       by other text and a colon ("skip these cases:") satisfies
   *       the anti-trigger check.
   * WHY: Pins the more-permissive shape of the regex (`\bskip\b.*:`,
   *       not literal `skip:`) so the test fails if a future edit
   *       narrows the pattern to a literal-only string match.
   */
  test("anti-trigger SATISFIED by 'skip ... :' (interior text before colon)", () => {
    const description =
      "Perform a documented operation that pins the more-permissive shape of the strict-mode skip pattern by separating the verb from the colon with interior text. Use when asked to validate that the regex tolerates 'skip these cases:' and similar phrasings. Padding text follows so the description clears the 300-char floor without leaning on the skip phrase: this padding sentence has the colon further from the word.";
    const result = strict(buildSkill(description));
    expect(hasAntiTriggerError(result.errors)).toBe(false);
  });

  /**
   * WHAT: A description whose only `skip`-adjacent substring is
   *       `"skipper"` does NOT satisfy the anti-trigger check (the
   *       anti-trigger error is present).
   * WHY: Pins the `\b` word-boundary anchor against a future
   *       "simplify" pass dropping it. Without the anchor,
   *       `.test("skipper")` would return true and silently accept
   *       descriptions that never wrote a real anti-trigger clause.
   */
  test("anti-trigger NOT SATISFIED by 'skipper' (substring-only match)", () => {
    // Description deliberately contains a colon further down the prose
    // ("the following: ships, decks") so a regression that drops the \b
    // anchors — turning the regex into /skip.*:/i — would WRONGLY match
    // the substring inside 'skipper' through to that colon. With the
    // \b anchors intact, no word-boundary form exists, so the anti-trigger
    // error is correctly emitted. Crucially, no incidental word-bounded
    // forms appear (no hyphen forms, no bare-word forms, no comma forms),
    // so the false-positive is purely the inflected token.
    const description =
      "Perform a documented operation whose only relevant token is the noun skipper, used in unrelated nautical prose about pre-Edwardian sailing crews. The padding text mentions the following: ships, decks, and rigging. None of this constitutes a real anti-trigger clause; the description exercises the substring-vs-word-boundary distinction by relying entirely on the inflected form.";
    const result = strict(buildSkill(description));
    expect(hasAntiTriggerError(result.errors)).toBe(true);
  });

  /**
   * WHAT: A description whose only `skip`-adjacent substring is
   *       `"skipped"` does NOT satisfy the anti-trigger check.
   * WHY: Same word-boundary class as the `skipper` case; past-tense
   *       inflection is the most common false-positive surface in
   *       descriptions about "skipped sections" or "skipped tests".
   */
  test("anti-trigger NOT SATISFIED by 'skipped' (past-tense inflection)", () => {
    // Same regression-pin shape as the skipper case: a colon appears
    // further in the prose ("two reasons: testing, drift"). A regression
    // dropping \b would match 'skip' inside 'skipped' through to that
    // colon and silently accept the description. No incidental
    // word-bounded forms appear (no hyphen, no bare word, no
    // comma-trailing form), so the only test surface is the past-tense
    // inflection.
    const description =
      "Perform a documented operation whose only relevant token is the past-tense form skipped, used in prose about previously skipped sections of an unrelated codebase. The padding text mentions two reasons: testing, drift. None of this constitutes a real anti-trigger clause; the description exercises the past-tense substring trap.";
    const result = strict(buildSkill(description));
    expect(hasAntiTriggerError(result.errors)).toBe(true);
  });

  /**
   * WHAT: A description whose only `skip`-adjacent substring is
   *       `"skipping"` does NOT satisfy the anti-trigger check.
   * WHY: Continuous-tense inflection; same word-boundary class as
   *       above. Tests for "skipping CI" or "skipping format" are the
   *       common drift surface.
   */
  test("anti-trigger NOT SATISFIED by 'skipping' (continuous-tense inflection)", () => {
    // Same regression-pin shape as the skipper / skipped cases. A colon
    // appears further in the prose ("noted as follows: A, B") so a
    // regression dropping \b would match 'skip' inside 'skipping'
    // through to that colon. Surrounding prose avoids any incidental
    // word-bounded forms.
    const description =
      "Perform a documented operation whose only relevant token is the continuous-tense form skipping, used in prose about previously skipping unrelated steps in pipelines. The padding text mentions phases noted as follows: A, B, C. None of this constitutes a real anti-trigger clause; the description exercises the continuous-tense substring trap.";
    const result = strict(buildSkill(description));
    expect(hasAntiTriggerError(result.errors)).toBe(true);
  });

  /**
   * WHAT: A description containing `skip` as a leading word but no
   *       colon anywhere on the same logical statement does NOT
   *       satisfy the anti-trigger check.
   * WHY: Pins the colon requirement (the `.*:` portion of the regex).
   *       A bare `skip` reads as casual prose, not as an explicit
   *       anti-trigger clause; the colon is the syntactic marker for
   *       "what follows is the list of cases to skip."
   */
  test("anti-trigger NOT SATISFIED by 'skip' as a bare word (no colon)", () => {
    const description =
      "Perform a documented operation that mentions skip as a bare word in casual prose without a colon anywhere — the regex requires a colon somewhere after the word for the clause to count as an explicit anti-trigger declaration. Padding text follows to clear the 300-char floor while keeping the description colon-free.";
    const result = strict(buildSkill(description));
    expect(hasAntiTriggerError(result.errors)).toBe(true);
  });
});
