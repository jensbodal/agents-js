import type { Skill, ValidationResult } from "../types.ts";

/**
 * Strict-mode validator. Applies the authoring conventions captured
 * in the SKILL.md authoring guide to a fully-loaded Skill object.
 *
 * These checks are advisory — they layer on top of the tolerant
 * {@link validateSkill} pass and report as errors when they fail.
 * Callers that want warnings-only strict behavior can inspect the
 * result and treat a non-empty `errors` array as warnings.
 *
 * Rules enforced (distilled from authoring-conventions):
 *
 *  1. description length within 300–900 chars (target band for a
 *     triggerable, anti-triggered description).
 *  2. description contains an anti-trigger clause ("Not for …",
 *     "Do not use for …", "Skip …").
 *  3. description opens with a strong action verb (Perform, Audit,
 *     Generate, Stabilize, Enforce, Review, Survey, Interview,
 *     Interact, Build, Manage, Convert, Run, Create, Guide, Reflect,
 *     Diagnose, Orchestrate, Download).
 *  4. body is present and non-trivial (>= 200 chars).
 *  5. body includes a `## When NOT to Use` (or equivalent
 *     "When not ...") section — the single most commonly skipped
 *     authoring section.
 *  6. body has a top-level H1 title.
 *
 * Returns a validator function so callers can bind strict mode
 * once and reuse the closure across multiple skills.
 */
export function createStrictValidator(): (skill: Skill) => ValidationResult {
  return (skill) => runStrictChecks(skill);
}

export interface StrictOptions {
  /** Lower bound for description length. Default 300. */
  minDescriptionLength?: number;
  /** Upper bound for description length. Default 900. */
  maxDescriptionLength?: number;
}

/**
 * Options-accepting variant of the strict validator for callers
 * that want to tune the description-length band.
 */
export function createStrictValidatorWith(
  options: StrictOptions = {},
): (skill: Skill) => ValidationResult {
  const min = options.minDescriptionLength ?? 300;
  const max = options.maxDescriptionLength ?? 900;
  return (skill) => runStrictChecks(skill, min, max);
}

const ACTION_VERBS = new Set([
  "perform",
  "audit",
  "generate",
  "stabilize",
  "enforce",
  "review",
  "survey",
  "interview",
  "interact",
  "build",
  "manage",
  "convert",
  "run",
  "create",
  "guide",
  "reflect",
  "diagnose",
  "orchestrate",
  "download",
  "compare",
  "reorganize",
  "analyze",
  "detect",
]);

/**
 * Patterns that signal a description has an explicit anti-trigger clause
 * ("Not for X", "Skip: X", etc.).
 *
 * Uses regex with `\b` word boundaries instead of `.includes()` to avoid
 * false positives. The `\bskip\b.*:` pattern matches "skip" used as a
 * leading word followed (anywhere on the same line) by a colon — e.g.
 * "Skip: format-only diffs" — but NOT incidental occurrences in
 * "skipper", "skipped", or "skipping". The `\bnot for\b` pattern likewise
 * matches the phrase as written rather than as a substring inside an
 * unrelated sentence. Substring matching here would silently accept
 * descriptions whose authors never actually wrote an anti-trigger clause.
 */
const ANTI_TRIGGER_PATTERNS = [
  /\bnot for\b/i,
  /\bdo not use for\b/i,
  /\bskip\b.*:/i,
  /\bavoid\b.*:/i,
];

const WHEN_NOT_PATTERNS = [
  /^##\s+when not to use\b/im,
  /^##\s+when\s+not\s+\(/im,
  /^##\s+anti[-\s]?triggers\b/im,
];

function runStrictChecks(skill: Skill, min = 300, max = 900): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const description = skill.description.trim();
  const body = skill.body.trim();

  // (1) description length band
  if (description.length < min) {
    errors.push(
      `description is ${description.length} chars; strict mode requires >= ${min} (target band ${min}-${max})`,
    );
  } else if (description.length > max) {
    warnings.push(
      `description is ${description.length} chars; strict-mode target band is ${min}-${max}`,
    );
  }

  // (2) anti-trigger clause
  if (!ANTI_TRIGGER_PATTERNS.some((p) => p.test(description))) {
    errors.push(
      "description lacks an anti-trigger clause (expected 'Not for ...', 'Do not use for ...', or 'Skip: ...')",
    );
  }

  // (3) action-verb opener
  const firstWord = description.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  if (!ACTION_VERBS.has(firstWord.replace(/[^a-z]/g, ""))) {
    errors.push(
      `description should open with a strong action verb (got '${firstWord}'); examples: ${[...ACTION_VERBS].slice(0, 6).join(", ")}`,
    );
  }

  // (4) body length
  if (body.length < 200) {
    errors.push(`body is ${body.length} chars; strict mode requires >= 200`);
  }

  // (5) When NOT to Use section
  if (!WHEN_NOT_PATTERNS.some((p) => p.test(body))) {
    errors.push(
      "body is missing a '## When NOT to Use' section (strict-mode authoring convention)",
    );
  }

  // (6) H1 title
  if (!/^#\s+\S/m.test(body)) {
    errors.push("body is missing a top-level H1 title");
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
