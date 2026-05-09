import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createStrictValidator, createStrictValidatorWith, loadSkill } from "../src/index.ts";

const FIXTURES = path.join(import.meta.dir, "fixtures");

function load(name: string) {
  return loadSkill(name, { searchPaths: [FIXTURES] });
}

describe("createStrictValidator", () => {
  const strict = createStrictValidator();

  test("accepts a skill that follows every authoring convention", () => {
    const result = strict(load("strict-ok"));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("flags descriptions below the 300-char floor", () => {
    const result = strict(load("strict-short-desc"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /\d+ chars/.test(e))).toBe(true);
  });

  test("flags missing anti-trigger clauses", () => {
    const result = strict(load("strict-no-antitrigger"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /anti-trigger/i.test(e))).toBe(true);
  });

  test("flags weak opening verbs", () => {
    const result = strict(load("strict-weak-verb"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /action verb/i.test(e))).toBe(true);
  });

  test("flags missing When NOT to Use section", () => {
    const result = strict(load("strict-missing-section"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /when not to use/i.test(e))).toBe(true);
  });
});

describe("createStrictValidatorWith", () => {
  test("respects a custom description-length lower bound", () => {
    const looseStrict = createStrictValidatorWith({ minDescriptionLength: 10 });
    const result = looseStrict(load("strict-short-desc"));
    // With a 10-char floor, the description-length rule stops firing,
    // so the only failures should be whatever else this fixture
    // breaks (it still has a '## When NOT to Use' section, anti-trigger,
    // and action-verb opener, so it should now pass).
    expect(result.valid).toBe(true);
  });
});
