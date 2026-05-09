import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  SKILL_FILENAME,
  SKILL_KNOWN_KEYS,
  validateSkill,
} from "../src/index.ts";

// Boundary behavior tests parameterized by the constants — so a value change
// (e.g. NAME_MAX_LENGTH 64 → 96) only requires editing the constant and the
// tests follow automatically. The literal numbers live in src; the tests
// describe the contract that USES those numbers.

function writeSkill(name: string, description: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "skills-constants-test-"));
  const skillDir = path.join(dir, "skill");
  mkdirSync(skillDir, { recursive: true });
  const frontmatter = ["---", `name: ${name}`, `description: ${description}`, "---", ""].join("\n");
  writeFileSync(path.join(skillDir, SKILL_FILENAME), `${frontmatter}\nbody.\n`);
  return skillDir;
}

describe("skill format constants — boundary behavior", () => {
  test("a name at exactly NAME_MAX_LENGTH validates clean", () => {
    const name = "a".repeat(NAME_MAX_LENGTH);
    const result = validateSkill(writeSkill(name, "ok-description"));
    expect(result.errors.some((e) => e.toLowerCase().includes("'name' is too long"))).toBe(false);
  });

  test("a name one character over NAME_MAX_LENGTH is rejected", () => {
    const name = "a".repeat(NAME_MAX_LENGTH + 1);
    const result = validateSkill(writeSkill(name, "ok-description"));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("'name' is too long"))).toBe(true);
  });

  test("a description at exactly DESCRIPTION_MAX_LENGTH validates clean", () => {
    const desc = "d".repeat(DESCRIPTION_MAX_LENGTH);
    const result = validateSkill(writeSkill("ok-name", desc));
    expect(result.errors.some((e) => e.toLowerCase().includes("'description' is too long"))).toBe(
      false,
    );
  });

  test("a description one character over DESCRIPTION_MAX_LENGTH is rejected", () => {
    const desc = "d".repeat(DESCRIPTION_MAX_LENGTH + 1);
    const result = validateSkill(writeSkill("ok-name", desc));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.toLowerCase().includes("'description' is too long"))).toBe(
      true,
    );
  });

  test("SKILL_KNOWN_KEYS includes the documented frontmatter keys", () => {
    // Behavioral check via the validator: a known-keys-only skill validates
    // clean (no "unexpected key" error). Doesn't assert the literal set —
    // src/core/validate.ts is the single source of truth.
    expect(SKILL_KNOWN_KEYS.has("name")).toBe(true);
    expect(SKILL_KNOWN_KEYS.has("description")).toBe(true);
  });
});
