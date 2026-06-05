/**
 * Tests for `agents-js skill install` — the harness-native half of the skills
 * seam. Resolves a skill from a skills source (e.g. a skills-js checkout) via
 * `@agents-js/skills` and copies it into a target skills directory. Copy is
 * injected for determinism; resolution + validation run against a real tmp dir.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runSkillInstall } from "../src/skill.ts";

function makeSource(): { from: string; skillDir: string } {
  const from = mkdtempSync(path.join(tmpdir(), "ajs-skills-src-"));
  // Mirror the skills-js layout: projected claude form under .claude/skills.
  const skillDir = path.join(from, ".claude", "skills", "grill-me");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: grill-me\ndescription: Interview relentlessly about a plan.\n---\n\nBody.\n",
  );
  return { from, skillDir };
}

const sink = { write: () => true };

describe("agents-js skill install", () => {
  test("resolves a skill from a skills source and copies it into the target", () => {
    const { from, skillDir } = makeSource();
    const into = mkdtempSync(path.join(tmpdir(), "ajs-skills-into-"));
    const copied: Array<[string, string]> = [];
    const out: string[] = [];
    const code = runSkillInstall(["grill-me", "--from", from, "--into", into], {
      output: {
        write: (s: string) => {
          out.push(s);
          return true;
        },
      },
      copy: (src, dest) => {
        copied.push([src, dest]);
      },
    });
    expect(code).toBe(0);
    expect(copied).toEqual([[skillDir, path.join(into, "grill-me")]]);
    expect(out.join("")).toContain('skill install: "grill-me"');
  });

  test("defaults the target to ~/.claude/skills under home", () => {
    const { from } = makeSource();
    const home = mkdtempSync(path.join(tmpdir(), "ajs-home-"));
    const copied: Array<[string, string]> = [];
    const code = runSkillInstall(["grill-me", "--from", from], {
      home,
      output: sink,
      copy: (src, dest) => {
        copied.push([src, dest]);
      },
    });
    expect(code).toBe(0);
    expect(copied[0]?.[1]).toBe(path.join(home, ".claude", "skills", "grill-me"));
  });

  test("errors when the skill is not found in the source", () => {
    const from = mkdtempSync(path.join(tmpdir(), "ajs-skills-empty-"));
    const code = runSkillInstall(["nope", "--from", from], { output: sink, copy: () => {} });
    expect(code).not.toBe(0);
  });

  test("requires --from", () => {
    const code = runSkillInstall(["grill-me"], { output: sink, copy: () => {} });
    expect(code).not.toBe(0);
  });
});
