import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { SKILL_FILENAME } from "../constants.ts";
import type { ValidationResult } from "../types.ts";
import { parseSkillDocument } from "./parse.ts";

/**
 * Known SKILL.md frontmatter keys. The parser preserves any extra
 * keys on the `extra` field, so this list governs the tolerant
 * validator's "unexpected key" warnings rather than hard rejection.
 *
 * Sourced from the SKILL.md authoring conventions used across the
 * agents-js ecosystem. Keep in sync if new fields are blessed.
 */
export const SKILL_KNOWN_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "license",
  "allowed-tools",
  "metadata",
  "compatibility",
  "aliases",
  "depends-on",
  "variables",
  "role",
  "inputs",
  "outputs",
  "model-hint",
  "orchestrator-output",
  "user-invocable",
]);

/** Tolerant validator limits. Strict mode tightens the lower bound. */
export const NAME_MAX_LENGTH = 64;
export const DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Tolerant SKILL.md validator. Runs parse-correctness and required-field
 * checks. Authoring-convention concerns (length thresholds,
 * anti-triggers, etc) live in the strict validator.
 *
 * Accepts either a directory path (expected to contain `SKILL.md`) or
 * a path to a `SKILL.md` file directly.
 */
export function validateSkill(skillPath: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  let skillFile: string;
  try {
    const stat = statSync(skillPath);
    skillFile = stat.isDirectory() ? path.join(skillPath, SKILL_FILENAME) : skillPath;
  } catch {
    return {
      valid: false,
      errors: [`Skill path does not exist: ${skillPath}`],
      warnings: [],
    };
  }

  let content: string;
  try {
    content = readFileSync(skillFile, "utf8");
  } catch {
    return {
      valid: false,
      errors: [`SKILL.md not found at ${skillFile}`],
      warnings: [],
    };
  }

  const parsed = parseSkillDocument(content);

  if (parsed.kind === "no-fence") {
    return {
      valid: false,
      errors: ["SKILL.md is missing a YAML frontmatter fence (--- ... ---)"],
      warnings: [],
    };
  }

  if (parsed.kind === "invalid-yaml") {
    return {
      valid: false,
      errors: [`Invalid YAML in frontmatter: ${parsed.error.message}`],
      warnings: [],
    };
  }

  const record = parsed.record;
  const keys = Object.keys(record);

  if (keys.length === 0) {
    return {
      valid: false,
      errors: ["SKILL.md frontmatter is empty"],
      warnings: [],
    };
  }

  // Required fields.
  if (!("name" in record)) {
    errors.push("Missing required 'name' field in frontmatter");
  }
  if (!("description" in record)) {
    errors.push("Missing required 'description' field in frontmatter");
  }

  // Field shape checks.
  const name = record.name;
  if (name !== undefined) {
    if (typeof name !== "string") {
      errors.push(`'name' must be a string, got ${typeof name}`);
    } else {
      const trimmed = name.trim();
      if (!/^[a-z0-9-]+$/.test(trimmed)) {
        errors.push(
          `'name' value '${trimmed}' must be kebab-case (lowercase letters, digits, hyphens)`,
        );
      }
      if (trimmed.startsWith("-") || trimmed.endsWith("-") || trimmed.includes("--")) {
        errors.push(
          `'name' value '${trimmed}' cannot start/end with hyphen or contain consecutive hyphens`,
        );
      }
      if (trimmed.length > NAME_MAX_LENGTH) {
        errors.push(`'name' is too long (${trimmed.length} chars, max ${NAME_MAX_LENGTH})`);
      }
    }
  }

  const description = record.description;
  if (description !== undefined) {
    if (typeof description !== "string") {
      errors.push(`'description' must be a string, got ${typeof description}`);
    } else {
      const trimmed = description.trim();
      if (trimmed.length === 0) {
        errors.push("'description' cannot be empty");
      }
      if (trimmed.includes("<") || trimmed.includes(">")) {
        errors.push("'description' cannot contain angle brackets (< or >)");
      }
      if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
        errors.push(
          `'description' is too long (${trimmed.length} chars, max ${DESCRIPTION_MAX_LENGTH})`,
        );
      }
    }
  }

  // Shape checks for optional array-typed fields.
  const aliases = record.aliases;
  if (aliases !== undefined && !Array.isArray(aliases)) {
    errors.push("'aliases' must be an array");
  }
  const dependsOn = record["depends-on"];
  if (dependsOn !== undefined && !Array.isArray(dependsOn)) {
    errors.push("'depends-on' must be an array");
  }
  const allowedTools = record["allowed-tools"];
  if (allowedTools !== undefined && !Array.isArray(allowedTools)) {
    errors.push("'allowed-tools' must be an array");
  }

  // Body non-empty check.
  if (parsed.body.trim().length === 0) {
    errors.push("SKILL.md body is empty");
  }

  // Unexpected-keys warning (non-fatal for tolerant validation).
  const unexpected = keys.filter((k) => !SKILL_KNOWN_KEYS.has(k));
  if (unexpected.length > 0) {
    warnings.push(
      `Unexpected frontmatter key(s): ${unexpected.join(", ")}. Known keys: ${[...SKILL_KNOWN_KEYS].sort().join(", ")}`,
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
