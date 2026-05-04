/**
 * Canonical SKILL.md frontmatter shape after parsing. Unknown keys are
 * preserved on the `extra` field so downstream consumers can read
 * skill-system-specific metadata without forcing us to bless every
 * field here.
 */
export interface SkillFrontmatter {
  /** kebab-case skill identifier. */
  name: string;
  /** Free-form description used for orchestrator trigger matching. */
  description: string;
  /** Optional SPDX-ish license string. */
  license?: string;
  /** Optional allow-list of tools the skill may use. */
  allowedTools?: string[];
  /** Optional compatibility string describing target runtimes/versions. */
  compatibility?: string;
  /** Optional list of aliases an orchestrator may match against. */
  aliases?: string[];
  /** Optional list of dependency skill names. */
  dependsOn?: string[];
  /** Raw frontmatter keys that did not map to a recognised field. */
  extra: Record<string, unknown>;
}

/** Lightweight metadata for listing/enumeration. Does NOT include the body. */
export interface SkillMeta {
  name: string;
  description: string;
  /** Absolute path to the directory containing the SKILL.md file. */
  dir: string;
  /** Absolute path to the SKILL.md file itself. */
  skillFile: string;
}

/** A fully-loaded skill: metadata, frontmatter, and body. */
export interface Skill extends SkillMeta {
  frontmatter: SkillFrontmatter;
  /** The markdown body following the closing `---` frontmatter delimiter. */
  body: string;
}

/**
 * Result of a validation pass. `valid` is the aggregate verdict; `errors`
 * are blocking issues; `warnings` are advisory.
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Options for {@link loadSkill}. */
export interface LoadOptions {
  /**
   * Ordered list of directories to search. Earlier entries take
   * precedence over later entries when the same skill name appears in
   * multiple search paths.
   */
  searchPaths: string[];
}
