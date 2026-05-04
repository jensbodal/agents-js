import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { SKILL_FILENAME } from "../constants.ts";

/**
 * Resolve a skill directory by name against an ordered list of
 * search paths. Earlier entries in `searchPaths` take precedence —
 * the first hit wins. Returns `null` if no search path contains a
 * matching directory with a `SKILL.md` file.
 */
export function resolveSkillDir(name: string, searchPaths: string[]): string | null {
  for (const root of searchPaths) {
    const candidate = path.join(root, name);
    if (hasSkillFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Enumerate every subdirectory across the given search paths that
 * contains a `SKILL.md`. Deduplicates by skill directory-basename:
 * if the same name appears in multiple paths, the first (highest
 * precedence) wins and subsequent hits are dropped.
 */
export function discoverSkillDirs(searchPaths: string[]): Array<{ name: string; dir: string }> {
  const seen = new Set<string>();
  const results: Array<{ name: string; dir: string }> = [];

  for (const root of searchPaths) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (seen.has(entry)) continue;
      const candidate = path.join(root, entry);
      if (!hasSkillFile(candidate)) continue;
      seen.add(entry);
      results.push({ name: entry, dir: candidate });
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

function hasSkillFile(dir: string): boolean {
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }

  try {
    const fileStat = statSync(path.join(dir, SKILL_FILENAME));
    return fileStat.isFile();
  } catch {
    return false;
  }
}
