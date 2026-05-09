import { describe, expect, test } from "bun:test";
import path from "node:path";
import { validateSkill } from "../src/index.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures");

describe("validateSkill (tolerant)", () => {
  test("accepts a well-formed skill", () => {
    const result = validateSkill(path.join(FIXTURES, "valid-skill"));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("reports malformed YAML with a useful error", () => {
    const result = validateSkill(path.join(FIXTURES, "malformed-yaml"));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/invalid yaml/i);
  });

  test("reports missing required field by name", () => {
    const result = validateSkill(path.join(FIXTURES, "missing-name"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("'name'"))).toBe(true);
  });

  test("reports no-fence as a distinct error", () => {
    const result = validateSkill(path.join(FIXTURES, "no-fence"));
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/frontmatter/i);
  });

  test("rejects an empty body", () => {
    const result = validateSkill(path.join(FIXTURES, "empty-body"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("body"))).toBe(true);
  });

  test("rejects non-kebab-case names", () => {
    const result = validateSkill(path.join(FIXTURES, "bad-name"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("kebab"))).toBe(true);
  });

  test("returns a useful error for a missing path", () => {
    const result = validateSkill(path.join(FIXTURES, "definitely-does-not-exist"));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/does not exist/);
  });

  test("accepts a direct path to SKILL.md (not just a directory)", () => {
    const result = validateSkill(path.join(FIXTURES, "valid-skill", "SKILL.md"));
    expect(result.valid).toBe(true);
  });
});
