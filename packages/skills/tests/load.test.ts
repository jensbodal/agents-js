import { describe, expect, test } from "bun:test";
import path from "node:path";
import { listSkills, loadSkill, SkillLoadError } from "../src/index.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const FIXTURES_ALT = path.join(import.meta.dir, "fixtures-alt");

describe("loadSkill", () => {
  test("resolves a skill by name from the first matching search path", () => {
    const skill = loadSkill("valid-skill", { searchPaths: [FIXTURES] });
    expect(skill.name).toBe("valid-skill");
    expect(skill.dir).toBe(path.join(FIXTURES, "valid-skill"));
    expect(skill.frontmatter.aliases).toEqual(["valid", "fixture-ok"]);
    expect(skill.frontmatter.allowedTools).toEqual(["Read", "Write"]);
    expect(skill.frontmatter.license).toBe("MIT");
    expect(skill.body).toContain("Valid Skill");
  });

  test("throws SkillLoadError with a useful message when not found", () => {
    expect(() => loadSkill("does-not-exist", { searchPaths: [FIXTURES] })).toThrow(SkillLoadError);
  });

  test("throws SkillLoadError when SKILL.md has invalid YAML", () => {
    expect(() => loadSkill("malformed-yaml", { searchPaths: [FIXTURES] })).toThrow(SkillLoadError);
  });

  test("honors search-path precedence: earlier entries win", () => {
    // FIXTURES first -> primary valid-skill wins.
    const primary = loadSkill("valid-skill", {
      searchPaths: [FIXTURES, FIXTURES_ALT],
    });
    expect(primary.dir).toBe(path.join(FIXTURES, "valid-skill"));

    // FIXTURES_ALT first -> alt copy wins.
    const alt = loadSkill("valid-skill", {
      searchPaths: [FIXTURES_ALT, FIXTURES],
    });
    expect(alt.dir).toBe(path.join(FIXTURES_ALT, "valid-skill"));
    expect(alt.body).toContain("Alt");
  });

  test("finds a skill that exists only in a secondary search path", () => {
    const skill = loadSkill("only-in-alt", {
      searchPaths: [FIXTURES, FIXTURES_ALT],
    });
    expect(skill.name).toBe("only-in-alt");
  });
});

describe("listSkills", () => {
  test("enumerates all valid skills across a single path, skipping malformed ones", () => {
    const skills = listSkills([FIXTURES]);
    const names = skills.map((s) => s.name);
    // valid-skill is the only one that parses cleanly in FIXTURES.
    expect(names).toContain("valid-skill");
    // malformed-yaml, missing-name (has no name), no-fence, empty-body
    // and bad-name all fail to produce an OK parse result so they
    // should not appear.
    expect(names).not.toContain("malformed-yaml");
    expect(names).not.toContain("no-fence");
  });

  test("dedupes by skill name across search paths (first wins)", () => {
    const skills = listSkills([FIXTURES, FIXTURES_ALT]);
    const valid = skills.filter((s) => s.name === "valid-skill");
    expect(valid.length).toBe(1);
    expect(valid[0]?.dir).toBe(path.join(FIXTURES, "valid-skill"));
    // only-in-alt must still show up.
    expect(skills.map((s) => s.name)).toContain("only-in-alt");
  });

  test("is resilient to non-existent search paths", () => {
    const skills = listSkills(["/definitely/not/a/real/path", FIXTURES]);
    expect(skills.map((s) => s.name)).toContain("valid-skill");
  });
});
