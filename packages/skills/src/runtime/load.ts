import { readFileSync } from "node:fs";
import path from "node:path";
import { SKILL_FILENAME } from "../constants.ts";
import { normalizeFrontmatter } from "../core/normalize.ts";
import { parseSkillDocument } from "../core/parse.ts";
import type { LoadOptions, Skill, SkillMeta } from "../types.ts";
import { discoverSkillDirs, resolveSkillDir } from "./resolve.ts";

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLoadError";
  }
}

/**
 * Load a skill by name from the given search paths. Throws
 * {@link SkillLoadError} if the skill is not found or if SKILL.md
 * cannot be parsed.
 */
export function loadSkill(name: string, options: LoadOptions): Skill {
  const dir = resolveSkillDir(name, options.searchPaths);
  if (dir === null) {
    throw new SkillLoadError(
      `Skill '${name}' not found in any of ${options.searchPaths.length} search path(s): ${options.searchPaths.join(", ")}`,
    );
  }

  const skillFile = path.join(dir, SKILL_FILENAME);
  let content: string;
  try {
    content = readFileSync(skillFile, "utf8");
  } catch (err) {
    throw new SkillLoadError(`Failed to read SKILL.md at ${skillFile}: ${(err as Error).message}`);
  }

  const parsed = parseSkillDocument(content);
  if (parsed.kind === "no-fence") {
    throw new SkillLoadError(`SKILL.md at ${skillFile} is missing a YAML frontmatter fence`);
  }
  if (parsed.kind === "invalid-yaml") {
    throw new SkillLoadError(`SKILL.md at ${skillFile} has invalid YAML: ${parsed.error.message}`);
  }

  const frontmatter = normalizeFrontmatter(parsed.record);

  // Prefer the directory basename as the canonical name so that
  // on-disk location and in-memory identity agree.
  const canonicalName = frontmatter.name || path.basename(dir);

  return {
    name: canonicalName,
    description: frontmatter.description,
    dir,
    skillFile,
    frontmatter,
    body: parsed.body,
  };
}

/**
 * Enumerate every skill visible across the given search paths.
 * Produces lightweight {@link SkillMeta} records (no body). Skills
 * that fail to parse are silently skipped so a single malformed
 * skill cannot block enumeration — callers that need strict failure
 * should loadSkill each result separately.
 */
export function listSkills(searchPaths: string[]): SkillMeta[] {
  const out: SkillMeta[] = [];
  for (const { name, dir } of discoverSkillDirs(searchPaths)) {
    const skillFile = path.join(dir, SKILL_FILENAME);
    let content: string;
    try {
      content = readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }

    const parsed = parseSkillDocument(content);
    if (parsed.kind !== "ok") continue;

    const frontmatter = normalizeFrontmatter(parsed.record);
    out.push({
      name: frontmatter.name || name,
      description: frontmatter.description,
      dir,
      skillFile,
    });
  }
  return out;
}
